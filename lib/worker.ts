import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { gateway, discoveredSchema, sentSchema } from './providers';
import { qualifyProspect, withinSendWindow, addBusinessDays, renderTemplate, outreachWaitReason, followUpDueAt, qaFollowUpDelayMinutes } from './policy';
import { unsubscribeToken } from './unsubscribe';
import { sendMicrosoft } from './m365/send';
import { MailInput } from './m365/graph';
import { pollMicrosoft } from './m365/sync';
import { processReverification } from './reverification';
import { collectAlerts, deliverAlert, raiseAlert } from './alerts';
import { schedulingUrl } from './calendly';
import { reserveProviderSpend, settleProviderSpend } from './usage';
import { applyRetention } from './privacy';
import { pickVariant, evaluateExperiments } from './experiments';
import { sendAllowance } from './entitlements';
import { runSenderHealth } from './senderHealth';
import { reconcileAllCalendly } from './calendlyReconcile';

// A run is attempted at most this many times. Retries share the run's idempotency key, so a retry
// must send the same discover body or the gateway rejects it with 422; reserve must therefore
// return the ORIGINAL reservation and settle may only run after enrollment.
const MAX_RUN_ATTEMPTS = 3;

export async function scheduleRuns(now = new Date()) {
  if (process.env.OUTBOUND_ENABLED !== 'true') return;
  const campaigns = await db.campaign.findMany({ where: { status: 'ACTIVE', automationMode: { not: 'PAUSED' }, nextRunAt: { lte: now }, tenant: { settings: { automationEnabled: true } } }, take: 100, orderBy: { nextRunAt: 'asc' } });
  for (const c of campaigns) {
    await db.$transaction(async tx => {
      const claimed = await tx.campaign.updateMany({ where: { id: c.id, nextRunAt: c.nextRunAt, status: 'ACTIVE' }, data: { nextRunAt: new Date(now.getTime() + 3600000) } });
      if (!claimed.count) return;
      const pending = await tx.automationRun.count({ where: { campaignId: c.id, status: { in: ['RUNNING', 'QUEUED'] } } });
      // Debounce double-activate / overlapping ticks: at most one new run per campaign per minute.
      const recent = await tx.automationRun.findFirst({ where: { campaignId: c.id, createdAt: { gte: new Date(now.getTime() - 60_000) } }, select: { id: true } });
      if (!pending && !recent) await tx.automationRun.create({ data: { tenantId: c.tenantId, campaignId: c.id, idempotencyKey: `scheduled:${c.id}:${c.nextRunAt.toISOString()}` } });
    });
  }
}

export async function processRun(now = new Date()) {
  const token = randomUUID();
  const claimed = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "AutomationRun" SET status='RUNNING', "leaseToken"=${token}, "leaseUntil"=(${new Date(now.getTime() + 120000)}::timestamptz AT TIME ZONE 'UTC'), "startedAt"=(${now}::timestamptz AT TIME ZONE 'UTC'), attempts=attempts+1, errors=NULL
    WHERE id=(SELECT id FROM "AutomationRun" WHERE attempts<3 AND (status='QUEUED' AND "availableAt"<=(${now}::timestamptz AT TIME ZONE 'UTC') OR status='RUNNING' AND "leaseUntil"<(${now}::timestamptz AT TIME ZONE 'UTC')) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`;
  if (!claimed.length) return false;
  const run = await db.automationRun.findUniqueOrThrow({ where: { id: claimed[0].id } });
  try {
    const c = await db.campaign.findUniqueOrThrow({ where: { id: run.campaignId }, include: { icp: true } });
    const s = await db.tenantSetting.findUnique({ where: { tenantId: run.tenantId } });
    if (process.env.OUTBOUND_ENABLED !== 'true' || c.status !== 'ACTIVE' || c.automationMode === 'PAUSED' || !s?.automationEnabled || s.suspended || !s.gatewayKey || !c.icp?.active || c.icp.tenantId !== run.tenantId) {
      await db.automationRun.updateMany({ where: { id: run.id, leaseToken: token }, data: { status: 'CANCELED', finishedAt: now, leaseUntil: null } });
      return true;
    }
    const week = new Date(now.getTime() - 7 * 86400000);
    const tenantUsed = await db.enrollment.count({ where: { tenantId: c.tenantId, createdAt: { gte: week } } });
    const campaignUsed = await db.enrollment.count({ where: { campaignId: c.id, createdAt: { gte: week } } });
    const limit = Math.max(0, Math.min(100, c.weeklyProspectCap - campaignUsed, s.weeklyProspectCap - tenantUsed));
    // Reserve provider spend before purchasing; the reservation is the hard cap.
    const spend = limit ? await reserveProviderSpend(c.tenantId, c.id, `discover:${run.idempotencyKey}`, limit, now) : { quantity: 0, reason: 'ok' as const };
    const allowed = spend.quantity;
    if (limit && !allowed && spend.reason !== 'ok') {
      const key = `${c.tenantId}:${spend.reason}:${now.toISOString().slice(0, 7)}`;
      await db.operationalAlert.upsert({ where: { key }, update: {}, create: { tenantId: c.tenantId, key, code: spend.reason, entityId: c.id } });
    }
    const result = allowed ? await gateway(s.gatewayKey, 'discover', run.idempotencyKey, { tenantId: c.tenantId, campaignId: c.id, icp: c.icp, limit: allowed }, discoveredSchema) : { prospects: [] };
    if (result.prospects.length > allowed) throw new Error('provider_exceeded_limit');
    let enrolled = 0;
    for (const p of result.prospects) {
      const q = qualifyProspect(c.icp, p, new Date());
      if (!q.eligible || q.score < c.minScore) continue;
      const added = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${c.tenantId} FOR UPDATE`;
        const current = await tx.automationRun.findUniqueOrThrow({ where: { id: run.id } });
        if (current.leaseToken !== token || current.status !== 'RUNNING') return false;
        const settings = await tx.tenantSetting.findUniqueOrThrow({ where: { tenantId: c.tenantId } });
        const currentCampaign = await tx.campaign.findUniqueOrThrow({ where: { id: c.id } });
        if (!settings.automationEnabled || currentCampaign.status !== 'ACTIVE' || currentCampaign.automationMode === 'PAUSED') return false;
        if (await tx.suppression.findUnique({ where: { tenantId_email: { tenantId: c.tenantId, email: p.email } } })) return false;
        if (await tx.enrollment.count({ where: { tenantId: c.tenantId, createdAt: { gte: week } } }) >= settings.weeklyProspectCap) return false;
        if (await tx.enrollment.count({ where: { campaignId: c.id, createdAt: { gte: week } } }) >= currentCampaign.weeklyProspectCap) return false;
        const lead = await tx.lead.upsert({ where: { tenantId_domain: { tenantId: c.tenantId, domain: p.domain } }, update: {}, create: { tenantId: c.tenantId, company: p.company, domain: p.domain, contactName: p.fullName, contactEmail: p.email, score: q.score, qualification: 'QUALIFIED', source: p.evidenceUrl, signalSummary: p.evidenceSummary } });
        const contact = await tx.contact.upsert({ where: { tenantId_email: { tenantId: c.tenantId, email: p.email } }, update: { verification: p.verification, lastVerifiedAt: new Date(p.verifiedAt) }, create: { tenantId: c.tenantId, leadId: lead.id, fullName: p.fullName, title: p.title, email: p.email, verification: p.verification, lastVerifiedAt: new Date(p.verifiedAt) } });
        const dummy = typeof p.evidenceSummary === 'string' && p.evidenceSummary.includes('Dummy discovery prospect');
        const first = await tx.sequenceStep.findFirstOrThrow({ where: { campaignId: c.id }, orderBy: { stepOrder: 'asc' } });
        const outreachKey = `${c.id}:${contact.id}:${first.stepOrder}`;
        const scheduledAt = addBusinessDays(now, first.waitBusinessDays, c.timezone, c.holidays);
        // Dummy gateway prospects must re-queue on every activate/discover for QA.
        // Skip the normal 30-day ownership cooldown and reopen the same campaign enrollment.
        if (dummy) {
          await tx.enrollment.updateMany({ where: { tenantId: c.tenantId, contactId: contact.id, campaignId: { not: c.id }, stoppedAt: null }, data: { stoppedAt: now, stopReason: 'dummy_rediscover' } });
          const mine = await tx.enrollment.findUnique({ where: { campaignId_contactId: { campaignId: c.id, contactId: contact.id } } });
          if (mine) await tx.enrollment.update({ where: { id: mine.id }, data: { stoppedAt: null, stopReason: null, score: q.score, hasBuyer: q.hasBuyer, hasPainSignal: q.hasPainSignal, evidence: p } });
          else await tx.enrollment.create({ data: { tenantId: c.tenantId, campaignId: c.id, contactId: contact.id, score: q.score, hasBuyer: q.hasBuyer, hasPainSignal: q.hasPainSignal, evidence: p } });
          await tx.outreachEvent.upsert({
            where: { idempotencyKey: outreachKey },
            create: { tenantId: c.tenantId, campaignId: c.id, contactId: contact.id, leadId: lead.id, stepOrder: first.stepOrder, scheduledAt, idempotencyKey: outreachKey },
            update: { status: 'QUEUED', scheduledAt, approvedAt: null, error: null, attempts: 0, leaseUntil: null, leaseToken: null, reservedAt: null, providerMessageId: null, sentAt: null, subject: null, body: null }
          });
          // The outreach key is reused. A prior MailReceipt would reject the new body
          // with m365_idempotency_conflict, or return the old ACCEPTED send and skip it.
          await tx.mailReceipt.deleteMany({ where: { tenantId: c.tenantId, key: outreachKey } });
          return true;
        }
        // One contact is owned by one campaign during a sequence, with a 30-day cooldown.
        if (await tx.enrollment.findFirst({ where: { tenantId: c.tenantId, contactId: contact.id, OR: [{ stoppedAt: null }, { stoppedAt: { gt: new Date(now.getTime() - 30 * 86400000) } }, { campaignId: c.id }] } })) return false;
        await tx.enrollment.create({ data: { tenantId: c.tenantId, campaignId: c.id, contactId: contact.id, score: q.score, hasBuyer: q.hasBuyer, hasPainSignal: q.hasPainSignal, evidence: p } });
        await tx.outreachEvent.create({ data: { tenantId: c.tenantId, campaignId: c.id, contactId: contact.id, leadId: lead.id, stepOrder: first.stepOrder, scheduledAt, idempotencyKey: outreachKey } });
        return true;
      });
      if (added) enrolled++;
    }
    // Settle only after enrollment. Settling first shrinks the reserved limit, so a
    // queued retry sends a different discover body and the gateway returns 422.
    if (allowed) await settleProviderSpend(c.tenantId, `discover:${run.idempotencyKey}`, result.prospects.length);
    await db.automationRun.updateMany({ where: { id: run.id, leaseToken: token }, data: { status: 'SUCCEEDED', finishedAt: new Date(), leaseToken: null, leaseUntil: null, prospectsFound: result.prospects.length, contactsVerified: result.prospects.filter(p => p.verification === 'VALID').length, messagesQueued: enrolled, errors: Prisma.DbNull } });
  } catch (error) {
    // Full detail (stack, message, run, campaign) stays in the worker log; the run row keeps
    // only a safe code so the UI can explain the next action without leaking internals.
    console.error(JSON.stringify({ event: 'automation_run_failed', runId: run.id, campaignId: run.campaignId, tenantId: run.tenantId, attempt: run.attempts, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
    const code = safeError(error);
    // attempts is already incremented by the claim above, so >= MAX_RUN_ATTEMPTS means this
    // was the last try. A terminal state always records finishedAt and drops the lease, so a
    // run can never be left looking half-finished (or leased forever) in the Runs table.
    const terminal = run.attempts >= MAX_RUN_ATTEMPTS;
    await db.automationRun.updateMany({ where: { id: run.id, leaseToken: token }, data: { status: terminal ? 'FAILED' : 'QUEUED', availableAt: new Date(Date.now() + 60000 * 2 ** run.attempts), finishedAt: terminal ? new Date() : null, leaseToken: null, leaseUntil: null, errors: { code } } });
    if (terminal) await raiseAlert(run.tenantId, 'discovery_failed', run.id).catch(() => undefined);
  }
  return true;
}

// Only codes that are safe to show a user and actionable are stored on the run. Anything else
// (a bug, a constraint violation, a stack trace) is logged in full and reported as the
// generic integration/database failure.
export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'unknown';
  const SAFE = /^(gateway_http_\d{3}|gateway_requires_https|gateway_not_configured|gateway_unreachable|gateway_timeout|gateway_invalid_response|m365_[a-z_0-9]+|provider_exceeded_limit|unknown_template_variable)$/;
  return SAFE.test(message) ? message : 'integration_or_database_error';
}

export async function recheckOutreachBeforeSend(eventId: string, leaseToken: string, recipientEmail: string, now = new Date()) {
  return db.$transaction(async tx => {
    const reservation = await tx.outreachEvent.findUnique({ where: { id: eventId }, select: { tenantId: true } });
    if (!reservation) return false;
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${reservation.tenantId} FOR UPDATE`;
    const event = await tx.outreachEvent.findUnique({ where: { id: eventId } });
    if (!event || event.status !== 'SENDING' || event.leaseToken !== leaseToken) return false;

    const campaign = event.campaignId ? await tx.campaign.findFirst({ where: { id: event.campaignId, tenantId: event.tenantId } }) : null;
    const contact = event.contactId ? await tx.contact.findFirst({ where: { id: event.contactId, tenantId: event.tenantId } }) : null;
    const enrollment = campaign && contact && event.purpose === 'SEQUENCE'
      ? await tx.enrollment.findUnique({ where: { campaignId_contactId: { campaignId: campaign.id, contactId: contact.id } } })
      : null;
    const finish = async (status: 'QUEUED' | 'CANCELED', error: string | null) => {
      await tx.outreachEvent.updateMany({
        where: { id: event.id, status: 'SENDING', leaseToken },
        data: { status, error, leaseToken: null, leaseUntil: null, ...(status === 'QUEUED' ? { scheduledAt: new Date(now.getTime() + 900000) } : {}) }
      });
    };

    if (!campaign || !contact?.email || contact.email.toLowerCase() !== recipientEmail.toLowerCase()) {
      await finish('CANCELED', 'send_target_unavailable');
      return false;
    }
    if (await tx.suppression.findUnique({ where: { tenantId_email: { tenantId: event.tenantId, email: contact.email.toLowerCase() } } })) {
      await finish('CANCELED', 'suppressed_before_send');
      return false;
    }
    if (event.purpose === 'SEQUENCE' && (!enrollment || enrollment.stoppedAt)) {
      await finish('CANCELED', 'sequence_stopped');
      return false;
    }
    if (event.purpose === 'BOOKING_INVITATION' && await tx.appointment.findFirst({ where: { tenantId: event.tenantId, campaignId: campaign.id, contactId: contact.id, status: 'BOOKED' }, select: { id: true } })) {
      await finish('CANCELED', 'booking_already_confirmed');
      return false;
    }

    const settings = await tx.tenantSetting.findUnique({ where: { tenantId: event.tenantId } });
    const health = await tx.deliverabilityProfile.findUnique({ where: { tenantId_senderEmail: { tenantId: event.tenantId, senderEmail: campaign.senderEmail } } });
    const microsoft = await tx.m365Connection.findUnique({ where: { tenantId: event.tenantId } });
    const cursor = microsoft ? await tx.mailCursor.findUnique({ where: { tenantId_mailbox: { tenantId: event.tenantId, mailbox: campaign.senderEmail } } }) : null;
    const mailboxBlocked = !!microsoft && (!microsoft.enabled || !microsoft.mailboxes.includes(campaign.senderEmail) || !!cursor?.error || !cursor?.lastSuccessAt || now.getTime() - cursor.lastSuccessAt.getTime() > 300000);
    const stale = contact.verification !== 'VALID' || !contact.lastVerifiedAt || now.getTime() - contact.lastVerifiedAt.getTime() > 7 * 86400000;
    const wait = process.env.OUTBOUND_ENABLED === 'true'
      ? outreachWaitReason({ campaign, settings, health, approvedAt: event.approvedAt, mailboxBlocked, stale, now })
      : 'outbound_disabled';
    if (wait) {
      await finish('QUEUED', wait);
      return false;
    }
    return true;
  }, { timeout: 10000, maxWait: 5000 });
}

export async function processOutreach(now = new Date()) {
  if (process.env.OUTBOUND_ENABLED !== 'true') return false;
  const candidate = await db.outreachEvent.findFirst({ where: { attempts: { lt: 5 }, scheduledAt: { lte: now }, OR: [{ status: 'QUEUED' }, { status: 'SENDING', leaseUntil: { lt: now } }] }, orderBy: { scheduledAt: 'asc' } });
  if (!candidate?.campaignId || !candidate.contactId) return false;
  const leaseToken = randomUUID();
  try {
    const prepared = await db.$transaction(async tx => {
      let c = await tx.campaign.findUniqueOrThrow({ where: { id: candidate.campaignId! } });
      // Serialize shared sender and tenant reservations, including across worker processes.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${c.senderEmail}))`;
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${candidate.tenantId} FOR UPDATE`;
      c = await tx.campaign.findUniqueOrThrow({ where: { id: candidate.campaignId! } });
      const e = await tx.outreachEvent.findUniqueOrThrow({ where: { id: candidate.id } });
      if (!['QUEUED', 'SENDING'].includes(e.status) || (e.leaseUntil && e.leaseUntil > now) || e.attempts >= 5) return false;
      const s = await tx.tenantSetting.findUnique({ where: { tenantId: e.tenantId } });
      const contact = await tx.contact.findFirst({ where: { id: e.contactId!, tenantId: e.tenantId } });
      const enrollment = await tx.enrollment.findUnique({ where: { campaignId_contactId: { campaignId: c.id, contactId: e.contactId! } } });
      const stoppedSequence = enrollment?.stoppedAt && e.purpose === 'SEQUENCE';
      if (!contact?.email || !enrollment || stoppedSequence || await tx.suppression.findUnique({ where: { tenantId_email: { tenantId: e.tenantId, email: contact.email } } })) {
        await tx.outreachEvent.update({ where: { id: e.id }, data: { status: 'CANCELED' } });
        return true;
      }
      const health = await tx.deliverabilityProfile.findUnique({ where: { tenantId_senderEmail: { tenantId: e.tenantId, senderEmail: c.senderEmail } } });
      const microsoft = await tx.m365Connection.findUnique({where:{tenantId:e.tenantId}});
      const cursor = microsoft ? await tx.mailCursor.findUnique({where:{tenantId_mailbox:{tenantId:e.tenantId,mailbox:c.senderEmail}}}) : null;
      const mailboxBlocked = !!microsoft && (!microsoft.enabled || !microsoft.mailboxes.includes(c.senderEmail) || !!cursor?.error || !cursor?.lastSuccessAt || now.getTime()-cursor.lastSuccessAt.getTime()>300000);
      const stale = contact.verification !== 'VALID' || !contact.lastVerifiedAt || now.getTime() - contact.lastVerifiedAt.getTime() > 7 * 86400000;
      const wait = outreachWaitReason({ campaign: c, settings: s, health, approvedAt: e.approvedAt, mailboxBlocked, stale, now });
      if (wait) {
        if (stale && !contact.reverifyRequestedAt) await tx.contact.update({where:{id:contact.id},data:{reverifyRequestedAt:now,verificationAttempts:0,verificationNextAt:now}});
        await tx.outreachEvent.update({ where: { id: e.id }, data: { scheduledAt: new Date(now.getTime() + 900000), error: wait } });
        return false;
      }
      const day = new Date(now.getTime() - 86400000);
      const used = { reservedAt: { gte: day }, id: { not: e.id } };
      const tenantCount = await tx.outreachEvent.count({ where: { ...used, tenantId: e.tenantId } });
      const senderCount = await tx.outreachEvent.count({ where: { ...used, campaign: { senderEmail: c.senderEmail } } });
      const campaignCount = await tx.outreachEvent.count({ where: { ...used, campaignId: c.id } });
      if (tenantCount >= s!.dailySendCap || senderCount >= health!.dailyCap || campaignCount >= c.dailySendCap) {
        await tx.outreachEvent.update({ where: { id: e.id }, data: { scheduledAt: new Date(now.getTime() + 3600000), error: 'daily_cap' } });
        return false;
      }
      if (e.purpose === 'SEQUENCE') {
        const gate = await sendAllowance(tx, e.tenantId, now);
        if (!gate.allowed) { await tx.outreachEvent.update({ where: { id: e.id }, data: { scheduledAt: new Date(now.getTime() + 3600000), error: gate.reason } }); return false; }
      }
      const step = e.purpose === 'SEQUENCE' ? await tx.sequenceStep.findUniqueOrThrow({ where: { campaignId_stepOrder: { campaignId: c.id, stepOrder: e.stepOrder! } } }) : null;
      const lead = contact.leadId ? await tx.lead.findUnique({ where: { id: contact.leadId } }) : null;
      const token = unsubscribeToken(e.tenantId, contact.email);
      const unsubscribeUrl = `${process.env.APP_URL}/unsubscribe?token=${encodeURIComponent(token)}`;
      const calendlyUrl = schedulingUrl(c.calendlyUrl, e.tenantId, c.id, contact.id);
      const vars = { firstName: contact.fullName.trim().split(/\s+/)[0] || 'there', company: lead?.company ?? '', senderName: c.senderName, calendlyUrl, offer: c.offer ?? '' };
      // A running experiment may substitute this step's copy; the choice is persisted with the send.
      const variant = step ? await pickVariant(tx, e.tenantId, c.id, enrollment.id, step.stepOrder) : null;
      const subject = e.subject ?? renderTemplate(variant?.subject ?? step?.subject ?? '', vars);
      const content = e.body ?? renderTemplate(variant?.body ?? step?.body ?? '', vars);
      const body = content.includes('\nUnsubscribe: ') ? content : `${content}\n\n${s!.postalAddress}\nUnsubscribe: ${unsubscribeUrl}`;
      await tx.outreachEvent.update({ where: { id: e.id }, data: { status: 'SENDING', attempts: { increment: 1 }, leaseToken, leaseUntil: new Date(now.getTime() + 120000), reservedAt: now, subject, body } });
      const input: MailInput = { tenantId: e.tenantId, campaignId: c.id, contactId: contact.id, from: c.senderEmail, fromName: c.senderName, to: contact.email, subject, body, headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, calendlyUrl };
      return {e,c,contact,enrollment,step,input,key:s!.gatewayKey!,microsoft:!!microsoft};
    }, { timeout: 10000, maxWait: 5000 });
    if (typeof prepared === 'boolean') return prepared;
    const {e,c,contact,enrollment,step,input} = prepared;
    try {
      // A reply, suppression, booking, pause or approval change may arrive while the send is
      // prepared. Serialize this final check with tenant-scoped suppression before network I/O.
      if (!await recheckOutreachBeforeSend(e.id, leaseToken, input.to, now)) return true;
      const result = prepared.microsoft ? await sendMicrosoft(e.tenantId,e.idempotencyKey,input) : await gateway(prepared.key,'send',e.idempotencyKey,input,sentSchema);
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${e.tenantId} FOR UPDATE`;
        const fresh = await tx.outreachEvent.findUniqueOrThrow({where:{id:e.id}});
        if (fresh.leaseToken!==leaseToken) return;
        const sentAt = new Date();
        await tx.outreachEvent.update({ where: { id: e.id }, data: { status: 'SENT', providerMessageId: result.messageId, sentAt, leaseUntil: null, error: fresh.status==='CANCELED'?'accepted_during_stop':null } });
        await tx.usageLedger.upsert({ where: { tenantId_idempotencyKey: { tenantId: e.tenantId, idempotencyKey: `email:${e.id}` } }, update: {}, create: { tenantId: e.tenantId, campaignId: c.id, kind: 'EMAIL_SENT', quantity: 1, costCents: 0, idempotencyKey: `email:${e.id}` } });
        const activeEnrollment = await tx.enrollment.findUniqueOrThrow({where:{id:enrollment.id}});
        if (step && !activeEnrollment.stoppedAt) {
          const next = await tx.sequenceStep.findFirst({ where: { campaignId: c.id, stepOrder: { gt: step.stepOrder } }, orderBy: { stepOrder: 'asc' } });
          if (next) {
            // Count from the SENT timestamp of this email, not from run start or approval.
            // upsert with an empty update keeps an already-queued/sent step untouched, so a
            // re-send or a duplicate worker tick cannot create a second follow-up.
            const scheduledAt = followUpDueAt({ from: sentAt, waitBusinessDays: next.waitBusinessDays, timezone: c.timezone, holidays: c.holidays, qaMinutes: qaFollowUpDelayMinutes() });
            await tx.outreachEvent.upsert({ where: { idempotencyKey: `${c.id}:${contact.id}:${next.stepOrder}` }, update: {}, create: { tenantId: e.tenantId, campaignId: c.id, contactId: contact.id, leadId: e.leadId, stepOrder: next.stepOrder, idempotencyKey: `${c.id}:${contact.id}:${next.stepOrder}`, scheduledAt } });
          }
          else await tx.enrollment.update({ where: { id: enrollment.id }, data: { stoppedAt: now, stopReason: 'sequence_complete' } });
        }
      });
    } catch (error) {
      await db.outreachEvent.updateMany({ where: { id: e.id, status:'SENDING', leaseToken }, data: { status: e.attempts + 1 >= 5 ? 'FAILED' : 'QUEUED', scheduledAt: new Date(now.getTime() + 60000 * 2 ** e.attempts), leaseUntil: null, error: safeError(error) } });
    }
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'outreach_transaction_failed', code: safeError(error) }));
    return false;
  }
}

export async function tick() {
  await db.workerHeartbeat.upsert({ where: { id: 'scheduler' }, update: { updatedAt: new Date() }, create: { id: 'scheduler' } });
  const now = new Date();
  await db.automationRun.updateMany({ where: { status: 'RUNNING', attempts: { gte: MAX_RUN_ATTEMPTS }, leaseUntil: { lt: now } }, data: { status: 'FAILED', finishedAt: now, leaseToken: null, leaseUntil: null, errors: { code: 'lease_expired_after_max_attempts' } } });
  // A queued run that has used up its attempts can never be claimed again (the claim requires
  // attempts < MAX), so without this it sat in QUEUED forever showing a stale error.
  await db.automationRun.updateMany({ where: { status: 'QUEUED', attempts: { gte: MAX_RUN_ATTEMPTS } }, data: { status: 'FAILED', finishedAt: now, errors: { code: 'max_attempts_exhausted' } } });
  // A queued run whose campaign was deleted or deactivated while it waited can never be
  // processed; release it so the campaign is not blocked by a permanently pending run.
  await db.automationRun.updateMany({ where: { status: 'QUEUED', campaign: { status: { not: 'ACTIVE' } } }, data: { status: 'CANCELED', finishedAt: now, errors: Prisma.DbNull } });
  await db.outreachEvent.updateMany({where:{status:'SENDING',attempts:{gte:5},leaseUntil:{lt:new Date()}},data:{status:'FAILED',error:'send_lease_exhausted'}});
  await pollMicrosoft();
  await processReverification();
  await scheduleRuns();
  await processRun();
  for (let i = 0; i < 10; i++) {
    await db.workerHeartbeat.update({ where: { id: 'scheduler' }, data: { updatedAt: new Date() } });
    if (!await processOutreach()) break;
  }
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.rateLimit.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await runSenderHealth();
  await reconcileAllCalendly();
  await applyRetention();
  await evaluateExperiments();
  await collectAlerts();
  await deliverAlert();
}
