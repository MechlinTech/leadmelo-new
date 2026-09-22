import { db } from './db';
import { HttpError } from './http';
import { SENDER_HEALTH_AUTO, refreshSenderHealth } from './senderHealth';
export async function campaignReady(tenantId: string, campaignId: string) {
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
  if (!s?.automationEnabled) missing.push('tenant_automation_enabled');
  if (!s?.gatewayKey || !s?.webhookSecret || !process.env.PROVIDER_GATEWAY_URL) missing.push('provider_gateway');
  if (!s?.postalAddress) missing.push('postal_address');
  if (!d || d.status !== 'HEALTHY' || !d.lastCheckedAt || Date.now() - d.lastCheckedAt.getTime() > 86400000) missing.push('fresh_sender_health');
  if (process.env.OUTBOUND_ENABLED !== 'true') missing.push('operator_outbound_enabled');
  if (missing.length) throw new HttpError(409, `campaign_not_ready:${missing.join(',')}`);
  return c;
}
