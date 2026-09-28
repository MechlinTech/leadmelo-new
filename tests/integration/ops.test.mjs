import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { detectOperationalIssues } from '../../lib/alerts.ts';
import { buildDigest } from '../../lib/digest.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { GET as digestRoute } from '../../app/api/digest/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';

test('operational detectors and tenant digest', async t => {
  const mk = async (name) => {
    const tenant = await db.tenant.create({ data: { name, slug: `${name}-${randomUUID()}`, users: { create: { email: `${name}-${randomUUID()}@example.com`, role: 'TENANT_ADMIN' } } }, include: { users: true } });
    return { tenant, cookie: `${sessionCookie}=${await createSession(tenant.users[0].id)}` };
  };
  const A = await mk('oa'), B = await mk('ob');
  const campaign = (tenantId, senderEmail, extra = {}) => db.campaign.create({ data: { tenantId, name: 'C', senderName: 'S', senderEmail, calendlyUrl: 'https://calendly.com/x', status: 'ACTIVE', automationMode: 'FULLY_AUTOMATIC', sequenceSteps: { create: [{ stepOrder: 1, subject: 's', body: 'b' }] }, ...extra } });
  const codes = async tenantId => (await db.operationalAlert.findMany({ where: { tenantId }, select: { code: true } })).map(a => a.code).sort();

  await t.test('healthy fresh sender with synced mailbox raises nothing', async () => {
    await campaign(B.tenant.id, 'ok@example.com');
    await db.deliverabilityProfile.create({ data: { tenantId: B.tenant.id, senderEmail: 'ok@example.com', domain: 'example.com', status: 'HEALTHY', lastCheckedAt: new Date() } });
    await db.mailCursor.create({ data: { tenantId: B.tenant.id, mailbox: 'ok@example.com', lastSuccessAt: new Date() } });
    await detectOperationalIssues();
    assert.deepEqual(await codes(B.tenant.id), []);
  });
  await t.test('missing, degraded and stale sender health and a failing mailbox each raise one alert', async () => {
    const missing = await campaign(A.tenant.id, 'missing@example.com');
    await detectOperationalIssues();
    assert.deepEqual(await codes(A.tenant.id), ['sender_health_missing']);
    await db.campaign.update({ where: { id: missing.id }, data: { status: 'PAUSED' } });
    await campaign(A.tenant.id, 'bad@example.com');
    await db.deliverabilityProfile.create({ data: { tenantId: A.tenant.id, senderEmail: 'bad@example.com', domain: 'example.com', status: 'THROTTLED', lastCheckedAt: new Date(Date.now() - 2 * 86400000) } });
    await db.mailCursor.create({ data: { tenantId: A.tenant.id, mailbox: 'bad@example.com', lastSuccessAt: new Date(Date.now() - 3600000), error: 'graph_401' } });
    await detectOperationalIssues();
    assert.deepEqual(await codes(A.tenant.id), ['reply_sync_stale', 'sender_degraded', 'sender_health_missing', 'sender_health_stale']);
    await detectOperationalIssues();
    assert.equal((await codes(A.tenant.id)).length, 4, 'repeat detection is deduplicated');
    assert.deepEqual(await codes(B.tenant.id), [], 'other tenant unaffected');
  });
  await t.test('acknowledged conditions that persist are re-raised on the next day only', async () => {
    await db.operationalAlert.updateMany({ where: { tenantId: A.tenant.id }, data: { acknowledgedAt: new Date() } });
    await detectOperationalIssues();
    assert.equal(await db.operationalAlert.count({ where: { tenantId: A.tenant.id, acknowledgedAt: null } }), 0, 'same day: stays acknowledged');
    await detectOperationalIssues(new Date(Date.now() + 86400000 + 60000));
    assert.ok(await db.operationalAlert.count({ where: { tenantId: A.tenant.id, acknowledgedAt: null } }) >= 3, 'next day: raised again');
  });
  await t.test('a worker that died mid-send leaves a stuck-send alert; live leases do not', async () => {
    const lead = await db.lead.create({ data: { tenantId: A.tenant.id, company: 'Co', domain: `co-${randomUUID()}.example` } });
    const contact = await db.contact.create({ data: { tenantId: A.tenant.id, leadId: lead.id, fullName: 'X Y', email: `x-${randomUUID()}@example.com` } });
    const stuck = await db.outreachEvent.create({ data: { tenantId: A.tenant.id, contactId: contact.id, leadId: lead.id, status: 'SENDING', leaseUntil: new Date(Date.now() - 600000), idempotencyKey: randomUUID() } });
    const live = await db.outreachEvent.create({ data: { tenantId: A.tenant.id, contactId: contact.id, leadId: lead.id, status: 'SENDING', leaseUntil: new Date(Date.now() + 60000), idempotencyKey: randomUUID() } });
    await detectOperationalIssues();
    const stuckAlerts = await db.operationalAlert.findMany({ where: { tenantId: A.tenant.id, code: 'send_stuck' } });
    assert.deepEqual(stuckAlerts.map(a => a.entityId), [stuck.id]);
    assert.notEqual(live.id, stuck.id);
  });
  await t.test('digest reports only this tenant\'s last 24 hours; route requires authentication', async () => {
    const lead = await db.lead.create({ data: { tenantId: B.tenant.id, company: 'Co', domain: `d-${randomUUID()}.example` } });
    const contact = await db.contact.create({ data: { tenantId: B.tenant.id, leadId: lead.id, fullName: 'D E', email: `d-${randomUUID()}@example.com` } });
    const c = await db.campaign.findFirstOrThrow({ where: { tenantId: B.tenant.id } });
    const mkEvent = (data) => db.outreachEvent.create({ data: { tenantId: B.tenant.id, contactId: contact.id, leadId: lead.id, idempotencyKey: randomUUID(), ...data } });
    await mkEvent({ status: 'SENT', sentAt: new Date() });
    await mkEvent({ status: 'SENT', sentAt: new Date(Date.now() - 3 * 86400000) });
    await mkEvent({ status: 'FAILED' });
    await db.reply.create({ data: { tenantId: B.tenant.id, contactId: contact.id, intent: 'POSITIVE', rawSnippet: 'yes' } });
    await db.reply.create({ data: { tenantId: B.tenant.id, contactId: contact.id, intent: 'NEGATIVE', rawSnippet: 'no' } });
    await db.appointment.create({ data: { tenantId: B.tenant.id, campaignId: c.id, contactId: contact.id, providerEventId: randomUUID(), status: 'BOOKED', scheduledStart: new Date(Date.now() + 86400000), scheduledEnd: new Date(Date.now() + 88200000) } });
    await db.operationalAlert.deleteMany({ where: { tenantId: B.tenant.id } }); // clear alerts from the simulated "next day" run above
    await raiseOne(B.tenant.id);
    const d = await buildDigest(B.tenant.id);
    assert.deepEqual(d.activity, { emailsSent: 1, emailsFailed: 1, replies: 2, positiveReplies: 1, meetingsBooked: 1, meetingsCancelled: 0 });
    assert.equal((await buildDigest(B.tenant.id, new Date(), 168)).activity.emailsSent, 2, '7-day window includes older sends');
    assert.equal(d.upcomingMeetings, 1); assert.equal(d.activeCampaigns, 1);
    assert.deepEqual(d.openAlerts, { reply_review: 1 }); assert.equal(d.needsAttention, 1);
    assert.equal((await buildDigest(A.tenant.id)).activity.meetingsBooked, 0, 'no leakage across tenants');
    const res = await digestRoute(new Request('http://localhost:3000/api/digest', { headers: { cookie: B.cookie } }));
    assert.equal(res.status, 200); assert.equal((await res.json()).activity.replies, 2);
    assert.equal((await digestRoute(new Request('http://localhost:3000/api/digest'))).status, 401);
  });
  async function raiseOne(tenantId) { await db.operationalAlert.create({ data: { tenantId, key: `${tenantId}:reply_review:x`, code: 'reply_review', entityId: 'x' } }); }
});
