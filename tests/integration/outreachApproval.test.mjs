import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt } from '../../lib/crypto.ts';
import { GET as getOutreach, PATCH as approveOutreach } from '../../app/api/outreach/route.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('Use an isolated database and TEST_DATABASE_CONFIRM=isolated');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://leadmelo.example.com';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');

test('approving a queued message from the outreach queue', async t => {
  const tenant = await db.tenant.create({
    data: {
      name: 'Approve', slug: `ap-${randomUUID()}`,
      settings: { create: { automationEnabled: true, postalAddress: '221B Test Street', dailySendCap: 25, weeklyProspectCap: 50, gatewayKey: encrypt('g'), webhookSecret: encrypt('w'.repeat(40)) } },
      users: { create: { email: `a-${randomUUID()}@example.com`, role: 'TENANT_ADMIN' } }
    }
  });
  t.after(() => db.tenant.delete({ where: { id: tenant.id } }).catch(() => {}));

  const lead = await db.lead.create({ data: { tenantId: tenant.id, company: 'Acme Robotics', domain: `acme-${randomUUID()}.example` } });
  const contact = await db.contact.create({ data: { tenantId: tenant.id, leadId: lead.id, fullName: 'Pat Buyer', email: `p-${randomUUID()}@acme.example`, verification: 'VALID', lastVerifiedAt: new Date() } });
  const icp = await db.iCP.create({ data: { tenantId: tenant.id, name: 'ICP', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['P'] } });
  const campaign = await db.campaign.create({
    data: {
      tenantId: tenant.id, icpId: icp.id, name: 'Approve', offer: 'QA', senderName: 'Sam Seller', senderEmail: `a-${randomUUID()}@sender.example`,
      calendlyUrl: 'https://calendly.com/sam/30min', status: 'ACTIVE', automationMode: 'REVIEW_BEFORE_SEND',
      businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24, weeklyProspectCap: 50, dailySendCap: 25, holidays: [],
      sequenceSteps: { create: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Question for {{firstName}}', body: 'Hi {{firstName}},\n\nQuestion about {{company}}.\n\n{{calendlyUrl}}' }] }
    }
  });
  await db.enrollment.create({ data: { tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: { synthetic: true } } });

  const admin = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const cookie = `${sessionCookie}=${await createSession(admin.id)}`;
  const request = (method, payload) => new Request('https://leadmelo.example.com/api/outreach', {
    method, headers: { cookie, origin: 'https://leadmelo.example.com', 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const queueRow = async id => (await (await getOutreach(request('GET'))).json()).find(r => r.id === id);
  const queued = async () => db.outreachEvent.create({
    data: { tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, leadId: lead.id, stepOrder: 1, idempotencyKey: `ap-${randomUUID()}`, scheduledAt: new Date() }
  });

  await t.test('the queue row carries the token of the content the operator reviewed', async () => {
    const event = await queued();
    const row = await queueRow(event.id);
    assert.ok(row.reviewToken, 'a QUEUED row exposes a review token');
    assert.equal(row.reviewToken.length, 64, 'the token is a sha256 hex digest');
    assert.equal(row.reviewSubject, 'Question for Pat');
    assert.match(row.reviewBody, /Hi Pat,/);
    assert.equal(row.reviewError, undefined, 'the preview renders without an error');
  });

  await t.test('the Approve send request the UI sends is accepted', async () => {
    // Regression: components/Workspace.tsx sent only { id }, but this endpoint requires the
    // 64-character reviewToken, so the Zod parse failed and "Approve send" always answered
    // 400 invalid_request. The button now sends the token it was rendered with.
    const event = await queued();
    const { reviewToken } = await queueRow(event.id);
    const response = await approveOutreach(request('PATCH', { id: event.id, reviewToken }));
    assert.equal(response.status, 200, 'approving from the queue succeeds');
    const approved = await db.outreachEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.ok(approved.approvedAt, 'the message is approved');
    assert.equal(approved.subject, 'Question for Pat', 'the approved subject is persisted');
    assert.equal(approved.body, (await queueRow(event.id)) && approved.body, 'the approved body is persisted');
    assert.ok(approved.body.includes('Hi Pat,'), 'the approved body is the rendered content');
  });

  await t.test('approval without the reviewed token is refused', async () => {
    const event = await queued();
    const missing = await approveOutreach(request('PATCH', { id: event.id }));
    assert.equal(missing.status, 400, 'a bare id is not enough to approve');
    const short = await approveOutreach(request('PATCH', { id: event.id, reviewToken: 'abc' }));
    assert.equal(short.status, 400, 'a malformed token is refused');
    assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: event.id } })).approvedAt, null, 'nothing was approved');
  });

  await t.test('a token for different content is refused, so a changed message must be re-reviewed', async () => {
    const event = await queued();
    const before = await queueRow(event.id);
    // The operator edits the campaign step, so the content they reviewed is no longer current.
    await db.sequenceStep.update({ where: { campaignId_stepOrder: { campaignId: campaign.id, stepOrder: 1 } }, data: { body: 'Completely different copy for {{firstName}}.' } });
    const after = await queueRow(event.id);
    assert.notEqual(after.reviewBody, before.reviewBody, 'the preview now differs from what was reviewed');
    const stale = await approveOutreach(request('PATCH', { id: event.id, reviewToken: before.reviewToken }));
    assert.equal(stale.status, 409, 'the stale token is rejected');
    assert.equal(stale.headers.get('content-type'), 'application/json');
    // Re-reading the queue gives a fresh token, which does work.
    assert.equal((await approveOutreach(request('PATCH', { id: event.id, reviewToken: after.reviewToken }))).status, 200, 'the fresh token approves');
  });

  await t.test('a message that is not queued cannot be approved', async () => {
    const event = await queued();
    const { reviewToken } = await queueRow(event.id);
    await db.outreachEvent.update({ where: { id: event.id }, data: { status: 'SENT', sentAt: new Date() } });
    const response = await approveOutreach(request('PATCH', { id: event.id, reviewToken }));
    assert.equal(response.status, 404);
  });
});