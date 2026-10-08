import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt, hashPassword } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { processOutreach } from '../../lib/worker.ts';
import { handleProviderEvent } from '../../lib/webhooks.ts';
import { outreachWaitReason } from '../../lib/policy.ts';
import { GET as getOutreach, PATCH as approveOutreach } from '../../app/api/outreach/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('Use an isolated database and TEST_DATABASE_CONFIRM=isolated');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.OUTBOUND_ENABLED = 'true';
process.env.SENDER_HEALTH_AUTO = 'off';
process.env.TEMP_QA_FOLLOWUP_MINUTES = '5';

// Approving the first message of a sequence now also approves the messages it produces. Before
// this, every follow-up in REVIEW_BEFORE_SEND sat at awaiting_approval and needed a second
// click, so a five-minute reminder could never leave on schedule.
test('a follow-up inherits the approval of the message that produced it', async t => {
  const sent = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/send') {
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end(JSON.stringify({ messageId: `m-${sent.length}` }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const savedGateway = process.env.PROVIDER_GATEWAY_URL;
  process.env.PROVIDER_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    if (savedGateway === undefined) delete process.env.PROVIDER_GATEWAY_URL; else process.env.PROVIDER_GATEWAY_URL = savedGateway;
  });

  await db.outreachEvent.updateMany({ where: { status: { in: ['QUEUED', 'SENDING'] } }, data: { scheduledAt: new Date('2099-01-01') } });
  await db.campaign.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'PAUSED' } });

  async function build(name, automationMode) {
    const tenant = await db.tenant.create({
      data: {
        name, slug: `${name.toLowerCase().replace(/\W/g, '')}-${randomUUID()}`,
        settings: { create: { automationEnabled: true, postalAddress: '123 Test Street', dailySendCap: 25, weeklyProspectCap: 50, gatewayKey: encrypt('g'), webhookSecret: encrypt('w'.repeat(40)) } },
        users: { create: { email: `admin-${randomUUID()}@example.com`, role: 'TENANT_ADMIN', passwordHash: hashPassword('long-test-password-123') } }
      }, include: { users: true }
    });
    const senderEmail = `${name.toLowerCase().replace(/\W/g, '')}@sender.example`;
    const lead = await db.lead.create({ data: { tenantId: tenant.id, company: 'Buyer', domain: `b-${randomUUID()}.example` } });
    const contact = await db.contact.create({ data: { tenantId: tenant.id, leadId: lead.id, fullName: 'Buyer One', email: `b-${randomUUID()}@buyer.example`, verification: 'VALID', lastVerifiedAt: new Date() } });
    const icp = await db.iCP.create({ data: { tenantId: tenant.id, name: 'ICP', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['P'] } });
    const campaign = await db.campaign.create({
      data: {
        tenantId: tenant.id, icpId: icp.id, name, senderName: 'Sender', senderEmail, calendlyUrl: 'https://calendly.com/test',
        status: 'ACTIVE', automationMode, businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24,
        weeklyProspectCap: 50, dailySendCap: 25, holidays: [],
        sequenceSteps: { create: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Hello', body: 'Hi {{firstName}}' }, { stepOrder: 2, waitBusinessDays: 3, subject: 'Following up', body: 'Still relevant, {{firstName}}?' }] }
      }
    });
    await db.enrollment.create({ data: { tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: { synthetic: true } } });
    await db.deliverabilityProfile.create({ data: { tenantId: tenant.id, senderEmail, domain: 'sender.example', status: 'HEALTHY', dailyCap: 25, lastCheckedAt: new Date() } });
    await handleProviderEvent(tenant.id, { id: `h-${randomUUID()}`, type: 'sender.health', occurredAt: new Date().toISOString(), senderEmail, status: 'HEALTHY', dailyCap: 25, bounceRate: 0, complaintRate: 0 });
    const cookie = `${sessionCookie}=${await createSession(tenant.users[0].id)}`;
    const call = (method, payload) => new Request('http://localhost:3000/api/outreach', { method, headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    return { tenant, campaign, contact, senderEmail, call };
  }

  await t.test('REVIEW_BEFORE_SEND: the first message still waits for approval', async () => {
    const ctx = await build('InheritRbs', 'REVIEW_BEFORE_SEND');
    await db.outreachEvent.create({ data: { tenantId: ctx.tenant.id, campaignId: ctx.campaign.id, contactId: ctx.contact.id, leadId: ctx.contact.leadId, stepOrder: 1, idempotencyKey: `ir-${randomUUID()}`, scheduledAt: new Date(Date.now() - 1000) } });
    await processOutreach();
    const row = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: ctx.campaign.id, stepOrder: 1 } });
    assert.equal(row.status, 'QUEUED', 'the first message is not sent without approval');
    assert.equal(row.error, 'awaiting_approval');
    assert.equal(row.approvedAt, null);
  });

  await t.test('once approved and sent, the follow-up inherits that approval', async () => {
    const ctx = await build('InheritFlow', 'REVIEW_BEFORE_SEND');
    const first = await db.outreachEvent.create({ data: { tenantId: ctx.tenant.id, campaignId: ctx.campaign.id, contactId: ctx.contact.id, leadId: ctx.contact.leadId, stepOrder: 1, idempotencyKey: `if-${randomUUID()}`, scheduledAt: new Date(Date.now() - 1000) } });

    await processOutreach();
    const queued = await db.outreachEvent.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(queued.error, 'awaiting_approval', 'it first waits for the operator');

    const rawGet = await getOutreach(ctx.call("GET"));
    const listedText = await rawGet.text();
    assert.equal(rawGet.status, 200, `GET outreach status ${rawGet.status}: ${listedText.slice(0,200)}`);
    const listed = JSON.parse(listedText);
    const review = listed.find(r => r.id === first.id);
    assert.ok(review.reviewToken, 'the queue exposes the reviewed token');
    const approval = await approveOutreach(ctx.call("PATCH", { id: first.id, reviewToken: review.reviewToken }));
    const approvalText = await approval.text();
    assert.equal(approval.status, 200, `approval succeeds; got ${approvalText.slice(0,200)}`);
    const approved = await db.outreachEvent.findUniqueOrThrow({ where: { id: first.id } });
    assert.ok(approved.approvedAt, 'the operator approval is recorded');

    await db.outreachEvent.update({ where: { id: first.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    await processOutreach();
    const sent = await db.outreachEvent.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(sent.status, 'SENT', `the approved first message sends; error=${sent.error ?? 'none'}`);

    const follow = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: ctx.campaign.id, stepOrder: 2 } });
    assert.ok(follow.approvedAt, 'the follow-up inherits the approval instead of demanding a second click');
    assert.equal(follow.approvedAt.getTime(), sent.approvedAt.getTime(), 'it inherits the same approval, not a fresh one');
    assert.equal((follow.scheduledAt.getTime() - sent.sentAt.getTime()) / 60000, 5, 'still due exactly five minutes after the send');

    const reason = outreachWaitReason({
      campaign: { status: 'ACTIVE', automationMode: 'REVIEW_BEFORE_SEND', timezone: 'UTC', businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24, holidays: [] },
      settings: { automationEnabled: true, suspended: false, gatewayKey: 'k', postalAddress: '123 Test Street' },
      health: { status: 'HEALTHY', lastCheckedAt: new Date() },
      approvedAt: follow.approvedAt, mailboxBlocked: false, stale: false, now: new Date()
    });
    assert.notEqual(reason, 'awaiting_approval', 'the follow-up is not parked waiting for approval');

    // And it genuinely goes out on the next due pass, with no second click.
    await db.outreachEvent.update({ where: { id: follow.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    await processOutreach();
    const delivered = await db.outreachEvent.findUniqueOrThrow({ where: { id: follow.id } });
    assert.equal(delivered.status, 'SENT', `the inherited follow-up sends unattended; error=${delivered.error ?? 'none'}`);
  });

  await t.test('FULLY_AUTOMATIC is unchanged: nothing to inherit, nothing fabricated', async () => {
    const ctx = await build('InheritAuto', 'FULLY_AUTOMATIC');
    const first = await db.outreachEvent.create({ data: { tenantId: ctx.tenant.id, campaignId: ctx.campaign.id, contactId: ctx.contact.id, leadId: ctx.contact.leadId, stepOrder: 1, idempotencyKey: `ia-${randomUUID()}`, scheduledAt: new Date(Date.now() - 1000) } });
    await processOutreach();
    const sent = await db.outreachEvent.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(sent.status, 'SENT', `automatic send still works; error=${sent.error ?? 'none'}`);
    assert.equal(sent.approvedAt, null, 'an automatic send records no approval');
    const follow = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: ctx.campaign.id, stepOrder: 2 } });
    assert.equal(follow.approvedAt, null, 'no approval is invented where none was given');
    assert.equal((follow.scheduledAt.getTime() - sent.sentAt.getTime()) / 60000, 5);
  });
});