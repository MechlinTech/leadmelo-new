import { db } from './db';
import { HttpError } from './http';
import { SENDER_HEALTH_AUTO, refreshSenderHealth } from './senderHealth';
// Sender health is reported but does not block activation. A BLOCKED or stale sender is enforced
// at send time (policy.ts `sender_health_not_ready`), so allowing a campaign to be activated lets
// an operator build and approve the campaign while the sender recovers, instead of hard-blocking
// setup behind a condition that only clears when real outreach resumes. Activation used to 409
// with fresh_sender_health, which left the campaign stuck in DRAFT for weeks.
// Same reasoning applies to the tenant automation switch, and more strongly. `automationEnabled`
// defaults to FALSE in the schema, so a brand-new workspace could never activate its first campaign
// without first finding a checkbox on a settings page -- and the 409 said only "tenant automation is
// off", naming nothing actionable. It was also redundant: the worker already refuses to schedule or
// run anything for a tenant with automation off (scheduleRuns and processRun both check it), so
// activation-blocking bought no safety while making the button look broken.
//
// Tenant automation and operator outbound are therefore reported as warnings, not blockers. The
// genuinely structural problems stay blocking, because no amount of operator action inside those
// rows makes them go away: a missing ICP, an empty sequence, no postal address (legally required
// before any send), a missing gateway credential, an unsynced mailbox, or an unscheduled campaign.
export async function campaignReady(tenantId: string, campaignId: string, opts: { allowUnhealthySender?: boolean } = {}) {
  const c = await db.campaign.findFirst({ where: { id: campaignId, tenantId }, include: { icp: true, sequenceSteps: true } });
  if (!c) throw new HttpError(404, 'campaign_not_found');
  const s = await db.tenantSetting.findUnique({ where: { tenantId } });
  if (SENDER_HEALTH_AUTO()) { try { await refreshSenderHealth(tenantId, c.senderEmail); } catch { /* a DNS problem must not crash the readiness check */ } }
  const d = await db.deliverabilityProfile.findUnique({ where: { tenantId_senderEmail: { tenantId, senderEmail: c.senderEmail } } });
  const missing = [];
  const m = await db.m365Connection.findUnique({where:{tenantId}});
  if (m) {
    const cursor = await db.mailCursor.findUnique({where:{tenantId_mailbox:{tenantId,mailbox:c.senderEmail}}});
    if (!m.enabled || !m.mailboxes.includes(c.senderEmail) || cursor?.error || !cursor?.lastSuccessAt || Date.now()-cursor.lastSuccessAt.getTime()>300000) missing.push('m365_sender_and_reply_sync');
  }
  if (!c.icp?.active || c.icp.tenantId !== tenantId) missing.push('active_icp');
  if (!c.sequenceSteps.length) missing.push('sequence');
  if (!s?.gatewayKey || !s?.webhookSecret || !process.env.PROVIDER_GATEWAY_URL) missing.push('provider_gateway');
  if (!s?.postalAddress) missing.push('postal_address');
  if (missing.length) throw new HttpError(409, `campaign_not_ready:${missing.join(',')}`);
  const senderHealthReady = !!d && d.status === 'HEALTHY' && !!d.lastCheckedAt && Date.now() - d.lastCheckedAt.getTime() <= 86400000;
  if (!senderHealthReady && !opts.allowUnhealthySender) throw new HttpError(409, 'campaign_not_ready:fresh_sender_health');
  // Reported, never thrown. The campaign is genuinely ready to be built and approved; the worker
  // holds sending until these clear, so telling the operator here would only block setup.
  const warnings = [
    ...(!s?.automationEnabled ? ['tenant_automation_enabled'] : []),
    ...(process.env.OUTBOUND_ENABLED !== 'true' ? ['operator_outbound_enabled'] : [])
  ];
  return { campaign: c, senderHealthReady, warnings };
}
