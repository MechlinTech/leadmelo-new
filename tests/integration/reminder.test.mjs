import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt } from '../../lib/crypto.ts';
import { tick, processOutreach, recheckOutreachBeforeSend } from '../../lib/worker.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('Use an isolated database and TEST_DATABASE_CONFIRM=isolated');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.OUTBOUND_ENABLED = 'true';
process.env.SENDER_HEALTH_AUTO = 'off';
process.env.TEMP_QA_FOLLOWUP_MINUTES = '5';

// An inbox the test controls: every message the gateway was asked to deliver.
const inbox = [];
let gatewayMode = 'ok';
const prospect = {
  company: 'Buyer', domain: 'buyer.example', fullName: 'Buyer One', title: 'CTO', email: 'buyer@buyer.example',
  industry: 'SaaS', companySize: '50-1000', geography: 'US', technologies: ['Playwright'], signals: ['Hiring QA'],
  verification: 'VALID', verifiedAt: new Date().toISOString(), evidenceUrl: 'https://buyer.example/jobs', evidenceSummary: 'QA hiring page'
};

async function startGateway() {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/discover') { res.end(JSON.stringify({ prospects: [prospect] })); return; }
    if (req.url === '/send') {
      if (gatewayMode === 'unavailable') { res.statusCode = 503; res.end('{"error":"temporarily_unavailable"}'); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString());
      inbox.push({ receivedAt: new Date().toISOString(), ...message });
      res.end(JSON.stringify({ messageId: `msg-${inbox.length}` }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.PROVIDER_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  return server;
}

async function scenario(name, campaignOverrides = {}) {
  const tenant = await db.tenant.create({
    data: {
      name, slug: `${name.toLowerCase().replace(/\W/g, '')}-${randomUUID()}`,
      settings: { create: { automationEnabled: true, postalAddress: '123 Test Street', dailySendCap: 25, weeklyProspectCap: 50, gatewayKey: encrypt(`${name}-gateway`), webhookSecret: encrypt('w'.repeat(40)) } },
      users: { create: { email: `admin-${randomUUID()}@example.com`, role: 'TENANT_ADMIN' } }
    }
  });
  const senderEmail = `${name.toLowerCase().replace(/\W/g, '')}@sender.example`;
  const icp = await db.iCP.create({ data: { tenantId: tenant.id, name: 'ICP', offer: 'QA automation for {{company}}', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['Playwright'] } });
  const campaign = await db.campaign.create({
    data: {
      tenantId: tenant.id, icpId: icp.id, name, senderName: 'Sender', senderEmail, calendlyUrl: 'https://calendly.com/test',
      status: 'ACTIVE', automationMode: 'FULLY_AUTOMATIC', businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24, weeklyProspectCap: 50, dailySendCap: 25,
      holidays: [],
      sequenceSteps: { create: [
        { stepOrder: 1, waitBusinessDays: 0, subject: 'Quick question for {{firstName}}', body: 'Hi {{firstName}}, quick question about QA at {{company}}.' },
        { stepOrder: 2, waitBusinessDays: 3, subject: 'Following up, {{firstName}}', body: 'Still relevant, {{firstName}}? Pick a time: {{calendlyUrl}}' }
      ] },
      ...campaignOverrides
    }
  });
  await db.deliverabilityProfile.create({ data: { tenantId: tenant.id, senderEmail, domain: 'sender.example', status: 'HEALTHY', dailyCap: 25, lastCheckedAt: new Date() } });
  return { tenant, campaign, senderEmail };
}

const makeDue = (tenantId, stepOrder) => db.outreachEvent.updateMany({ where: { tenantId, stepOrder, status: { in: ['QUEUED', 'SENDING'] } }, data: { scheduledAt: new Date(Date.now() - 1000) } });

test('scheduled reminders are queued, sent once, and delivered with correct content', async t => {
  const server = await startGateway();
  // The due queue is global and picks the oldest row first. Rows left by other test files in
  // this shared database would otherwise be claimed first, so park them out of the way.
  const parked = new Date('2099-01-01');
  await db.outreachEvent.updateMany({ where: { status: { in: ['QUEUED', 'SENDING'] } }, data: { scheduledAt: parked, leaseUntil: null, leaseToken: null } });
  await db.campaign.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'PAUSED' } });
  try {
    await t.test('a reminder scheduled five minutes after the previous send is picked up, sent and received', async () => {
      const { tenant, campaign } = await scenario('Remfive');
      const before = inbox.length;
      await tick();
      const first = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 1 } });
      assert.equal(first.status, 'SENT', `the first email should send; error=${first.error ?? 'none'}`);
      const reminder = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      assert.equal(reminder.status, 'QUEUED', 'the reminder is queued, not sent early');
      assert.equal(reminder.scheduledAt.getTime() - first.sentAt.getTime(), 5 * 60 * 1000, 'the reminder is due five minutes after the previous email was SENT');

      await makeDue(tenant.id, 2);
      await tick();
      const sent = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      assert.equal(sent.status, 'SENT', `the reminder should send when due; error=${sent.error ?? 'none'}`);
      assert.ok(sent.sentAt, 'SENT is stamped only after the provider accepted the message');
      assert.ok(sent.providerMessageId, 'the provider message id is recorded');
      // Never marked SENT before acceptance.
      const ledger = await db.usageLedger.findFirstOrThrow({ where: { tenantId: tenant.id, idempotencyKey: `email:${sent.id}` } });
      assert.equal(ledger.kind, 'EMAIL_SENT');

      const delivered = inbox.slice(before);
      assert.equal(delivered.length, 2, 'exactly two messages reached the provider');
      const reminderMail = delivered[1];
      assert.equal(reminderMail.to, prospect.email, 'the reminder went to the enrolled contact');
      assert.equal(reminderMail.subject, 'Following up, Buyer', 'the subject is the rendered reminder subject');
      assert.match(reminderMail.body, /^Still relevant, Buyer\? Pick a time: https:\/\/calendly\.com\/test\?utm_source=leadmelo&utm_content=/);
      assert.match(reminderMail.body, /123 Test Street/, 'the postal address is present');
      assert.match(reminderMail.body, /Unsubscribe: http:\/\/localhost:3000\/unsubscribe\?/, 'the unsubscribe link is present');
      assert.ok(reminderMail.body.trim().length > 40, 'the body is not effectively empty');
    });

    await t.test('extra worker ticks never resend a delivered reminder', async () => {
      const { tenant, campaign } = await scenario('Remonce');
      await tick();
      await makeDue(tenant.id, 2);
      await tick();
      const before = inbox.length;
      for (let i = 0; i < 4; i++) {
        await makeDue(tenant.id, 2);
        assert.equal(await processOutreach(), false, 'nothing is left to do');
      }
      assert.equal(inbox.length - before, 0, 'a delivered reminder is never sent twice');
      assert.equal(await db.outreachEvent.count({ where: { campaignId: campaign.id, stepOrder: 2 } }), 1, 'the reminder row is reused, not duplicated');
    });

    await t.test('a temporary provider fault retries with backoff, then delivers', async () => {
      gatewayMode = 'unavailable';
      const { tenant, campaign } = await scenario('Remretry');
      await tick();
      const queued = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 1 } });
      assert.equal(queued.status, 'QUEUED', 'a temporary provider fault re-queues instead of failing');
      assert.equal(queued.error, 'gateway_http_503', 'the failure reason names the provider status');
      const firstBackoff = queued.scheduledAt.getTime() - Date.now();
      gatewayMode = 'ok';
      await makeDue(tenant.id, 1);
      await tick();
      const retried = await db.outreachEvent.findFirstOrThrow({ where: { id: queued.id } });
      assert.equal(retried.status, 'SENT', 'the retry delivers the same message');
      assert.ok(firstBackoff > 0, 'the retry is delayed, not hot-looped');
    });

    await t.test('retries are bounded and a permanently failing reminder ends FAILED with its reason', async () => {
      gatewayMode = 'unavailable';
      const { tenant, campaign } = await scenario('Rembounded');
      await tick();
      const queued = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 1 } });
      for (let attempt = 1; attempt <= 8; attempt++) {
        await makeDue(tenant.id, 1);
        await tick();
      }
      const final = await db.outreachEvent.findFirstOrThrow({ where: { id: queued.id } });
      assert.equal(final.status, 'FAILED', 'the retry budget is finite');
      assert.equal(final.attempts, 5, 'at most five send attempts are made');
      assert.equal(final.error, 'gateway_http_503', 'the terminal reason is recorded');
      gatewayMode = 'ok';
      await makeDue(tenant.id, 1);
      assert.equal(await processOutreach(), false, 'an exhausted message is never claimed again');
      assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: queued.id } })).status, 'FAILED');
    });

    await t.test('a queued message whose target was detached is canceled with a reason and never blocks the queue', async () => {
      const { tenant, campaign } = await scenario('Remorphan');
      // The oldest due row: no campaign and no contact, so it can never be sent.
      const orphan = await db.outreachEvent.create({
        data: { tenantId: tenant.id, stepOrder: 1, status: 'QUEUED', scheduledAt: new Date(Date.now() - 600000), idempotencyKey: `orphan:${randomUUID()}` }
      });
      const before = inbox.length;
      await tick();
      const resolved = await db.outreachEvent.findUniqueOrThrow({ where: { id: orphan.id } });
      assert.equal(resolved.status, 'CANCELED', 'an undeliverable row is resolved, not left at the head of the queue');
      assert.equal(resolved.error, 'send_target_unavailable', 'the reason is recorded');
      const step1 = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 1 } });
      assert.equal(step1.status, 'SENT', 'the campaign behind it still sends');
      assert.equal(inbox.length - before, 1);
      const reminder = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      assert.equal(reminder.status, 'QUEUED', 'its reminder is queued as usual');
    });

    await t.test('a queued step whose sequence step was removed fails visibly and never blocks the queue', async () => {
      const { tenant, campaign } = await scenario('Remstep');
      await tick();
      const reminder = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      // Versioning removes a step whose copy changed; a queued reminder for it can no longer render.
      await db.sequenceStep.deleteMany({ where: { campaignId: campaign.id, stepOrder: 2 } });
      // A second campaign that must still be able to send.
      const other = await scenario('Remstepother');
      await makeDue(tenant.id, 2);
      await tick();
      const stranded = await db.outreachEvent.findUniqueOrThrow({ where: { id: reminder.id } });
      assert.equal(stranded.status, 'FAILED', 'a message that can never render is failed, not retried forever');
      assert.equal(stranded.error, 'sequence_step_missing');
      const behind = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: other.campaign.id, stepOrder: 1 } });
      assert.equal(behind.status, 'SENT', 'the message queued behind it still sends');
    });

    await t.test('waiting on a send gate does not consume the retry budget', async () => {
      const { tenant, campaign } = await scenario('Remwait');
      await tick();
      const reminder = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      // The final send gate is reached with the row already leased to SENDING and its attempt
      // spent. A suspension is a wait, not a delivery failure, so the attempt is given back.
      for (let round = 0; round < 7; round++) {
        await db.tenantSetting.update({ where: { tenantId: tenant.id }, data: { suspended: true } });
        const lease = `wait-round-${round}`;
        await db.outreachEvent.update({ where: { id: reminder.id }, data: { status: 'SENDING', attempts: { increment: 1 }, leaseToken: lease, leaseUntil: new Date(Date.now() + 120000) } });
        assert.equal(await recheckOutreachBeforeSend(reminder.id, lease, prospect.email), false, 'the gate stops the send');
        const after = await db.outreachEvent.findUniqueOrThrow({ where: { id: reminder.id } });
        assert.equal(after.status, 'QUEUED');
        assert.equal(after.error, 'tenant_suspended', 'the wait reason is visible in the queue');
        assert.equal(after.attempts, 0, 'a wait never spends a send attempt');
      }
      await db.tenantSetting.update({ where: { tenantId: tenant.id }, data: { suspended: false } });
      await makeDue(tenant.id, 2);
      await tick();
      assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: reminder.id } })).status, 'SENT', 'the reminder still sends after repeated waits');
    });

    await t.test('a queued message that used up its attempts is failed with a reason instead of lingering', async () => {
      const { tenant, campaign } = await scenario('Remstalled');
      await tick();
      const reminder = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      await db.outreachEvent.update({ where: { id: reminder.id }, data: { attempts: 5 } });
      const other = await scenario('Remstalledother');
      await tick();
      const stalled = await db.outreachEvent.findUniqueOrThrow({ where: { id: reminder.id } });
      assert.equal(stalled.status, 'FAILED', 'a row the due query can never claim is resolved');
      assert.equal(stalled.error, 'send_attempts_exhausted');
      assert.equal((await db.outreachEvent.findFirstOrThrow({ where: { campaignId: other.campaign.id, stepOrder: 1 } })).status, 'SENT');
    });

    await t.test('a reminder held by another worker does not stall the messages behind it', async () => {
      const { tenant, campaign } = await scenario('Remleased');
      const other = await scenario('Remleasedother');
      // A real, sendable reminder that another worker currently holds under a live lease. It
      // is the oldest due row, so it must not end the pass for the rows behind it.
      const contact = await db.contact.create({ data: { tenantId: tenant.id, fullName: 'Leased Buyer', email: `leased-${randomUUID()}@buyer.example`, verification: 'VALID', lastVerifiedAt: new Date() } });
      await db.enrollment.create({ data: { tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: { synthetic: true } } });
      await db.outreachEvent.create({
        data: {
          tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, stepOrder: 1,
          status: 'SENDING', scheduledAt: new Date(Date.now() - 600000), leaseToken: 'other-worker',
          leaseUntil: new Date(Date.now() + 120000), idempotencyKey: `leased:${randomUUID()}`
        }
      });
      await tick();
      await tick();
      const held = await db.outreachEvent.findFirstOrThrow({ where: { tenantId: tenant.id, contactId: contact.id } });
      assert.equal(held.status, 'SENDING', 'a lease held by another worker is not stolen');
      assert.equal(held.attempts, 0, 'and its send budget is not spent');
      const otherFirst = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: other.campaign.id, stepOrder: 1 } });
      assert.equal(otherFirst.status, 'SENT', 'a sendable message queued behind a leased one still goes out');
    });
  } finally {
    await db.outreachEvent.updateMany({ where: { status: { in: ['QUEUED', 'SENDING'] } }, data: { scheduledAt: parked } });
    await db.campaign.updateMany({ where: { status: 'PAUSED' }, data: { status: 'ACTIVE' } });
    server.close();
  }
});