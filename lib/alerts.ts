import { createHmac, randomUUID } from 'node:crypto';
import { db } from './db';
import { readWorkspaceConfig } from './workspaceConfig';
import { applyRulesForAlert, shouldRaise } from './automationRules';

export async function raiseAlert(tenantId: string, code: string, entityId: string) {
  const config = await readWorkspaceConfig(tenantId);
  if (!shouldRaise(code, config)) {
    return await db.operationalAlert.findUnique({ where: { key: `${tenantId}:${code}:${entityId}` } }) ?? { id: '', tenantId, key: `${tenantId}:${code}:${entityId}`, code, entityId };
  }
  const alert = await db.operationalAlert.upsert({where:{key:`${tenantId}:${code}:${entityId}`},update:{},create:{tenantId,key:`${tenantId}:${code}:${entityId}`,code,entityId}});
  await applyRulesForAlert(tenantId, code, config);
  return alert;
}
// State-based detectors. The entity id carries a UTC day so a condition that persists after
// acknowledgement is re-raised at most once a day, instead of never (or every tick).
export async function detectOperationalIssues(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const active = await db.campaign.findMany({ where: { status: 'ACTIVE', automationMode: { not: 'PAUSED' } }, select: { id: true, tenantId: true, senderEmail: true }, take: 1000 });
  const senders = new Map<string, { tenantId: string; senderEmail: string; campaignId: string }>();
  for (const c of active) senders.set(`${c.tenantId}|${c.senderEmail}`, { tenantId: c.tenantId, senderEmail: c.senderEmail, campaignId: c.id });
  for (const { tenantId, senderEmail, campaignId } of senders.values()) {
    const profile = await db.deliverabilityProfile.findUnique({ where: { tenantId_senderEmail: { tenantId, senderEmail } } });
    if (!profile) { await raiseAlert(tenantId, 'sender_health_missing', `${campaignId}:${day}`); continue; }
    if (profile.status !== 'HEALTHY') await raiseAlert(tenantId, 'sender_degraded', `${profile.id}:${profile.status}:${day}`);
    if (!profile.lastCheckedAt || now.getTime() - profile.lastCheckedAt.getTime() > 86400000) await raiseAlert(tenantId, 'sender_health_stale', `${profile.id}:${day}`);
    const cursor = await db.mailCursor.findUnique({ where: { tenantId_mailbox: { tenantId, mailbox: senderEmail } } });
    if (cursor && (cursor.error || !cursor.lastSuccessAt || now.getTime() - cursor.lastSuccessAt.getTime() > 600000)) await raiseAlert(tenantId, 'reply_sync_stale', `${cursor.id}:${day}`);
  }
  // A lease that expired long ago on a message still marked SENDING means a worker died mid-send.
  for (const e of await db.outreachEvent.findMany({ where: { status: 'SENDING', leaseUntil: { lt: new Date(now.getTime() - 300000) } }, select: { id: true, tenantId: true }, take: 100 })) await raiseAlert(e.tenantId, 'send_stuck', e.id);
}
export async function collectAlerts() {
  await detectOperationalIssues();
  for (const r of await db.automationRun.findMany({where:{status:'FAILED'},take:100,orderBy:{createdAt:'desc'}})) await raiseAlert(r.tenantId,'discovery_failed',r.id);
  for (const r of await db.outreachEvent.findMany({where:{status:'FAILED'},take:100,orderBy:{createdAt:'desc'}})) await raiseAlert(r.tenantId,'outreach_failed',r.id);
  for (const r of await db.contact.findMany({where:{reverifyRequestedAt:{not:null},verificationAttempts:{gte:3}},take:100})) await raiseAlert(r.tenantId,'verification_exhausted',r.id);
  for (const r of await db.mailReceipt.findMany({where:{status:{in:['CREATING','SUBMITTING','AMBIGUOUS']},updatedAt:{lt:new Date(Date.now()-120000)}},take:100})) await raiseAlert(r.tenantId,'m365_send_needs_reconciliation',r.id);
}
export async function deliverAlert(now = new Date(), transport: typeof fetch = fetch) {
  const alert = await db.operationalAlert.findFirst({where:{deliveredAt:null,acknowledgedAt:null,attempts:{lt:6},nextAttemptAt:{lte:now},OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]},orderBy:{createdAt:'asc'}});
  if (!alert) return false;
  const config = await readWorkspaceConfig(alert.tenantId);
  const target = process.env.ALERT_WEBHOOK_URL || config.alerts.webhookUrl;
  const secret = process.env.ALERT_WEBHOOK_SECRET;
  if (!target || !secret) return false;
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('alert_url_requires_https');
  const token = randomUUID();
  const claim = await db.operationalAlert.updateMany({where:{id:alert.id,attempts:alert.attempts,OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]},data:{attempts:{increment:1},leaseToken:token,leaseUntil:new Date(now.getTime()+60000)}});
  if (!claim.count) return false;
  const body = JSON.stringify({id:alert.id,tenantId:alert.tenantId,code:alert.code,entityId:alert.entityId,createdAt:alert.createdAt});
  const timestamp = String(Math.floor(now.getTime()/1000));
  try {
    const response = await transport(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','Idempotency-Key':alert.id,'X-LeadMelo-Timestamp':timestamp,'X-LeadMelo-Signature':createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')},body});
    if (!response.ok) throw new Error('alert_not_accepted');
    await db.operationalAlert.updateMany({where:{id:alert.id,leaseToken:token},data:{deliveredAt:now,leaseUntil:null}});
  } catch {
    await db.operationalAlert.updateMany({where:{id:alert.id,leaseToken:token},data:{leaseUntil:null,nextAttemptAt:new Date(now.getTime()+60000*2**alert.attempts)}});
  }
  return true;
}
