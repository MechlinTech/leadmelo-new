import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { gateway, discoveredSchema, sentSchema } from './providers';
import { qualifyProspect, withinSendWindow, addBusinessDays, outreachWaitReason } from './policy';
import { unsubscribeToken } from './unsubscribe';
import { renderOutreachContent } from './outreachContent';
import { sendMicrosoft } from './m365/send';
import { MailInput, emailBodyContentType, hasVisibleText, mailInput } from './m365/graph';
import { pollMicrosoft } from './m365/sync';
import { processReverification } from './reverification';
import { collectAlerts, deliverAlert } from './alerts';
import { schedulingUrl } from './calendly';
import { reserveProviderSpend, settleProviderSpend } from './usage';
import { applyRetention } from './privacy';
import { pickVariant, evaluateExperiments } from './experiments';
import { sendAllowance } from './entitlements';
import { runSenderHealth } from './senderHealth';
import { reconcileAllCalendly } from './calendlyReconcile';

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
    await db.automationRun.updateMany({ where: { id: run.id, leaseToken: token }, data: { status: 'SUCCEEDED', finishedAt: new Date(), leaseUntil: null, prospectsFound: result.prospects.length, contactsVerified: result.prospects.filter(p => p.verification === 'VALID').length, messagesQueued: enrolled, errors: Prisma.DbNull } });
  } catch (error) {
    console.error(JSON.stringify({ event: 'automation_run_failed', runId: run.id, campaignId: run.campaignId, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
    await db.automationRun.updateMany({ where: { id: run.id, leaseToken: token }, data: { status: run.attempts >= 3 ? 'FAILED' : 'QUEUED', availableAt: new Date(Date.now() + 60000 * 2 ** run.attempts), leaseUntil: null, errors: { code: safeError(error) } } });
  }
  return true;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'unknown';
  return /^(gateway_http_\d+|gateway_requires_https|gateway_not_configured|m365_[a-z_0-9]+|provider_exceeded_limit|unknown_template_variable|mail_(subject|body)_[a-z_]+)$/.test(message) ? message : 'integration_or_database_error';
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
      // A running experiment may substitute this step's copy; the choice is persisted with the send.
      const variant = step ? await pickVariant(tx, e.tenantId, c.id, enrollment.id, step.stepOrder) : null;
      const rendered = renderOutreachContent({
        existingSubject: e.subject,
        existingBody: e.body,
        subjectTemplate: variant?.subject ?? step?.subject ?? '',
        bodyTemplate: variant?.body ?? step?.body ?? '',
        variables: { firstName: contact.fullName.trim().split(/\s+/)[0] || 'there', company: lead?.company ?? '', senderName: c.senderName, calendlyUrl, offer: c.offer ?? '' },
        postalAddress: s?.postalAddress ?? '',
        unsubscribeUrl
      });
      const { subject, body } = rendered;
      // Diagnostics only: id, lengths, content type. Never the body text or any credential.
      console.log(JSON.stringify({ event: 'outreach_prepared', id: e.id, messageKey: e.idempotencyKey, purpose: e.purpose, stepOrder: e.stepOrder, subjectLength: subject.length, bodyLength: body.length, contentType: rendered.contentType, variant: !!variant, storedBody: e.body !== null }));
      await tx.outreachEvent.update({ where: { id: e.id }, data: { status: 'SENDING', attempts: { increment: 1 }, leaseToken, leaseUntil: new Date(now.getTime() + 120000), reservedAt: now, subject, body } });
      const input: MailInput = { tenantId: e.tenantId, campaignId: c.id, contactId: contact.id, from: c.senderEmail, fromName: c.senderName, to: contact.email, subject, body, headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, calendlyUrl };
      return {e,c,contact,enrollment,step,input,key:s!.gatewayKey!,microsoft:!!microsoft};
    }, { timeout: 10000, maxWait: 5000 });
    if (typeof prepared === 'boolean') return prepared;
    const {e,c,contact,enrollment,step,input} = prepared;
    try {
      // Commit the reservation before network I/O. Check reply/pause gates again
      // immediately before submission; an already accepted request cannot be recalled.
      const latest = await db.outreachEvent.findUniqueOrThrow({where:{id:e.id}});
      const settings = await db.tenantSetting.findUniqueOrThrow({where:{tenantId:e.tenantId}});
      const campaign = await db.campaign.findUniqueOrThrow({where:{id:c.id}});
      if (latest.status!=='SENDING' || latest.leaseToken!==leaseToken) return true;
      if (process.env.OUTBOUND_ENABLED!=='true' || !settings.automationEnabled || campaign.status!=='ACTIVE' || campaign.automationMode==='PAUSED') {
        await db.outreachEvent.updateMany({where:{id:e.id,status:'SENDING',leaseToken},data:{status:'QUEUED',leaseUntil:null,scheduledAt:new Date(now.getTime()+900000)}}); return true;
      }
      if (!input.subject.trim()) throw new Error('mail_subject_blank');
      if (!hasVisibleText(input.body)) throw new Error('mail_body_effectively_empty');
      mailInput.parse(input);
      console.log(JSON.stringify({ event: 'email_send_start', messageId: e.id, jobId: e.idempotencyKey, subjectLength: input.subject.length, bodyLength: input.body.length, contentType: emailBodyContentType(input.body) }));
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
            const testDelayMinutes = process.env.TEMP_QA_FOLLOWUP_MINUTES ? parseInt(process.env.TEMP_QA_FOLLOWUP_MINUTES, 10) : null;
            const scheduledAt = (testDelayMinutes !== null && !isNaN(testDelayMinutes) && testDelayMinutes >= 0)
              ? new Date(sentAt.getTime() + testDelayMinutes * 60 * 1000)
              : addBusinessDays(sentAt, next.waitBusinessDays, c.timezone, c.holidays);
            await tx.outreachEvent.upsert({ where: { idempotencyKey: `${c.id}:${contact.id}:${next.stepOrder}` }, update: {}, create: { tenantId: e.tenantId, campaignId: c.id, contactId: contact.id, leadId: e.leadId, stepOrder: next.stepOrder, idempotencyKey: `${c.id}:${contact.id}:${next.stepOrder}`, scheduledAt } });
          }
          else await tx.enrollment.update({ where: { id: enrollment.id }, data: { stoppedAt: now, stopReason: 'sequence_complete' } });
        }
      });
    } catch (error) {
      const code = safeError(error);
      const invalidContent = /^mail_(subject|body)_/.test(code);
      await db.outreachEvent.updateMany({ where: { id: e.id, status:'SENDING', leaseToken }, data: { status: invalidContent || e.attempts + 1 >= 5 ? 'FAILED' : 'QUEUED', scheduledAt: new Date(now.getTime() + 60000 * 2 ** e.attempts), leaseUntil: null, error: code } });
    }
    return true;
  } catch (error) {
    const code = safeError(error);
    // A message with no readable copy cannot succeed on retry, so stop it now with a visible
    // reason instead of re-queuing it forever. Never mark it SENT.
    if (/^mail_(subject|body)_/.test(code) && candidate) {
      await db.outreachEvent.updateMany({ where: { id: candidate.id, status: { in: ['QUEUED', 'SENDING'] } }, data: { status: 'FAILED', error: code, leaseUntil: null } });
    }
    console.error(JSON.stringify({ event: 'outreach_transaction_failed', code }));
    return false;
  }
}

export async function tick() {
  await db.workerHeartbeat.upsert({ where: { id: 'scheduler' }, update: { updatedAt: new Date() }, create: { id: 'scheduler' } });
  await db.automationRun.updateMany({ where: { status: 'RUNNING', attempts: { gte: 3 }, leaseUntil: { lt: new Date() } }, data: { status: 'FAILED', errors: { code: 'lease_expired_after_max_attempts' } } });
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
