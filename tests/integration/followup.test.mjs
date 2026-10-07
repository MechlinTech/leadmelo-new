import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt, hashPassword } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { scheduleRuns, processRun, processOutreach, recheckOutreachBeforeSend } from '../../lib/worker.ts';
import { handleProviderEvent } from '../../lib/webhooks.ts';
import { PATCH as patchReply } from '../../app/api/replies/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('Use an isolated database and TEST_DATABASE_CONFIRM=isolated');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.OUTBOUND_ENABLED = 'true';
process.env.SENDER_HEALTH_AUTO = 'off';

const sent = [];
const prospect = {
  company: 'Buyer', domain: 'buyer.example', fullName: 'Buyer One', title: 'CTO', email: 'buyer@buyer.example',
  industry: 'SaaS', companySize: '50-1000', geography: 'US', technologies: ['Playwright'], signals: ['Hiring QA'],
  verification: 'VALID', verifiedAt: new Date().toISOString(), evidenceUrl: 'https://buyer.example/jobs', evidenceSummary: 'QA hiring page'
};

async function scenario(t, name, qaMinutes) {
  if (qaMinutes === null) delete process.env.TEMP_QA_FOLLOWUP_MINUTES;
  else process.env.TEMP_QA_FOLLOWUP_MINUTES = String(qaMinutes);
  const tenant = await db.tenant.create({
    data: {
      name, slug: `${name.toLowerCase().replace(/\W/g, '')}-${randomUUID()}`,
      settings: { create: { automationEnabled: true, postalAddress: '123 Test Street', dailySendCap: 25, weeklyProspectCap: 50, gatewayKey: encrypt(`${name}-gateway`), webhookSecret: encrypt('w'.repeat(40)) } },
      users: { create: { email: `admin-${randomUUID()}@example.com`, role: 'TENANT_ADMIN', passwordHash: hashPassword('long-test-password-123') } }
    }, include: { users: true }
  });
  const senderEmail = `${name.toLowerCase().replace(/\W/g, '')}@sender.example`;
  const icp = await db.iCP.create({ data: { tenantId: tenant.id, name: 'ICP', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['Playwright'] } });
  const campaign = await db.campaign.create({
    data: {
      tenantId: tenant.id, icpId: icp.id, name, senderName: 'Sender', senderEmail, calendlyUrl: 'https://calendly.com/test',
      status: 'ACTIVE', automationMode: 'FULLY_AUTOMATIC', businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24, weeklyProspectCap: 50, dailySendCap: 25,
      holidays: [], sequenceSteps: { create: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Hello', body: 'Hi {{firstName}}' }, { stepOrder: 2, waitBusinessDays: 3, subject: 'Following up', body: 'Still relevant, {{firstName}}?' }] }
    }
  });
  await db.deliverabilityProfile.create({ data: { tenantId: tenant.id, senderEmail, domain: 'sender.example', status: 'HEALTHY', dailyCap: 25, lastCheckedAt: new Date() } });
  await handleProviderEvent(tenant.id, { id: `health-${randomUUID()}`, type: 'sender.health', occurredAt: new Date().toISOString(), senderEmail, status: 'HEALTHY', dailyCap: 25, bounceRate: 0, complaintRate: 0 });
  void (await createSession(tenant.users[0].id));
  void sessionCookie;
  return { tenant, campaign, senderEmail };
}

test('follow-up reminders honour the QA delay, the sent timestamp and cancellation', async t => {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/discover') { res.end(JSON.stringify({ prospects: [prospect] })); return; }
    if (req.url === '/send') { const body = JSON.parse(Buffer.concat(chunks).toString()); sent.push(body); res.end(JSON.stringify({ messageId: `m-${sent.length}` })); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = process.env.PROVIDER_GATEWAY_URL;
  process.env.PROVIDER_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  const originalQa = process.env.TEMP_QA_FOLLOWUP_MINUTES;
  try {
    await t.test('with TEMP_QA_FOLLOWUP_MINUTES=5 the follow-up is due 5 minutes after the email was SENT', async () => {
      const { campaign } = await scenario(t, 'Qafive', 5);
      await scheduleRuns();
      assert.ok(await processRun());
      const step1 = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 1 } });
      assert.equal(step1.status, 'QUEUED');
      // The worker loop is the scheduler: no browser, no open page is involved.
      assert.ok(await processOutreach());
      const sentStep1 = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 1 } });
      assert.equal(sentStep1.status, 'SENT');
      assert.ok(sentStep1.sentAt);
      const step2 = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      assert.equal(step2.status, 'QUEUED');
      const offsetMs = step2.scheduledAt.getTime() - sentStep1.sentAt.getTime();
      assert.equal(offsetMs, 5 * 60 * 1000, 'the countdown starts at the SENT timestamp of the previous email');
      // It must not be counted from the run/scheduling time: step 1 was queued before it was sent.
      assert.ok(step2.scheduledAt.getTime() > step1.scheduledAt.getTime(), 'follow-up is later than the first send time');
    });

    await t.test('the scheduler sends the follow-up when it is due, exactly once', async () => {
      const { campaign } = await scenario(t, 'Qadue', 5);
      const before = sent.length;
      await scheduleRuns();
      assert.equal(await processRun(), true, 'the campaign discovery run should be claimable');
      await processOutreach();
      const step1 = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 1 } });
      assert.equal(step1.status, 'SENT', `first step should send before its follow-up is scheduled; error=${step1.error ?? 'none'}`);
      const step2 = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      // Not due yet: the scheduler must leave it alone.
      await processOutreach();
      assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: step2.id } })).status, 'QUEUED');
      assert.equal(sent.length, before + 1, 'only the first email has gone out');
      // Move the clock past the due time instead of sleeping five minutes.
      await db.outreachEvent.update({ where: { id: step2.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
      assert.ok(await processOutreach());
      assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: step2.id } })).status, 'SENT');
      // Extra ticks must not resend or re-queue it.
      for (let i = 0; i < 3; i++) assert.equal(await processOutreach(), false);
      assert.equal(sent.length, before + 2, 'the follow-up was sent exactly once');
      assert.equal(sent[before + 1].subject, 'Following up');
      assert.match(sent[before + 1].body, /^Still relevant, Buyer\?\n\n/);
      assert.match(sent[before + 1].body, /Unsubscribe: http:\/\/localhost:3000\/unsubscribe\?/);
      assert.equal(await db.outreachEvent.count({ where: { campaignId: campaign.id, stepOrder: 2 } }), 1);
      const enrollment = await db.enrollment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      assert.equal(enrollment.stopReason, 'sequence_complete', 'the sequence ends after the last step');
    });

    await t.test('a reply after the first email cancels the queued reminder', async () => {
      const { tenant, campaign } = await scenario(t, 'Qareply', 5);
      await scheduleRuns(); await processRun(); await processOutreach();
      const step2 = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      await handleProviderEvent(tenant.id, { id: `reply-${randomUUID()}`, type: 'reply', occurredAt: new Date().toISOString(), campaignId: campaign.id, email: prospect.email, text: 'Not interested, stop emailing me.' });
      assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: step2.id } })).status, 'CANCELED');
      await db.outreachEvent.update({ where: { id: step2.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
      assert.equal(await processOutreach(), false, 'a canceled reminder is never sent');
      assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: step2.id } })).status, 'CANCELED');
    });

    await t.test('manual suppression cancels queued messages and is enforced again at the final send gate', async () => {
      const { tenant, campaign } = await scenario(t, 'Qasuppress', 5);
      await db.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });
      const lead = await db.lead.create({ data: { tenantId: tenant.id, company: 'Buyer', domain: `buyer-${randomUUID()}.example` } });
      const contact = await db.contact.create({ data: { tenantId: tenant.id, leadId: lead.id, fullName: 'Buyer One', email: `buyer-${randomUUID()}@buyer.example`, verification: 'VALID', lastVerifiedAt: new Date() } });
      await db.enrollment.create({ data: { tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: { source: 'test fixture' } } });
      const queued = await db.outreachEvent.create({ data: { tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, leadId: lead.id, stepOrder: 1, idempotencyKey: `queued-suppression:${randomUUID()}`, scheduledAt: new Date() } });
      const reply = await db.reply.create({ data: { tenantId: tenant.id, contactId: contact.id, rawSnippet: 'Please stop', intent: 'UNSURE', recommendedAction: 'Review' } });
      const admin = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'TENANT_ADMIN' } });
      const cookie = `${sessionCookie}=${await createSession(admin.id)}`;
      const response = await patchReply(new Request('http://localhost:3000/api/replies', {
        method: 'PATCH',
        headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ id: reply.id, action: 'suppress' })
      }));
      assert.equal(response.status, 200);
      assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: queued.id } })).status, 'CANCELED');

      const second = await db.outreachEvent.create({ data: {
        tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, leadId: queued.leadId,
        stepOrder: 1, status: 'SENDING', leaseToken: 'final-gate-test', leaseUntil: new Date(Date.now() + 120000),
        idempotencyKey: `late-suppression:${randomUUID()}`, scheduledAt: new Date()
      } });
      await db.suppression.upsert({ where: { tenantId_email: { tenantId: tenant.id, email: contact.email } }, update: {}, create: { tenantId: tenant.id, email: contact.email, reason: 'unsubscribe' } });
      assert.equal(await recheckOutreachBeforeSend(second.id, 'final-gate-test', contact.email), false);
      const canceled = await db.outreachEvent.findUniqueOrThrow({ where: { id: second.id } });
      assert.equal(canceled.status, 'CANCELED');
      assert.equal(canceled.error, 'suppressed_before_send');
    });

    await t.test('without the override the follow-up uses normal production timing', async () => {
      const { campaign } = await scenario(t, 'Prod', null);
      await scheduleRuns();
      assert.equal(await processRun(), true, 'the campaign discovery run should be claimable');
      await processOutreach();
      const sentStep1 = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 1 } });
      assert.equal(sentStep1.status, 'SENT', `first step should send; error=${sentStep1.error ?? 'none'}`);
      const step2 = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, stepOrder: 2 } });
      const days = (step2.scheduledAt.getTime() - sentStep1.sentAt.getTime()) / 86400000;
      assert.ok(days >= 3 && days <= 5, `expected ~3 business days, got ${days}`);
      assert.equal(step2.status, 'QUEUED');
    });
  } finally {
    server.close();
    if (originalQa === undefined) delete process.env.TEMP_QA_FOLLOWUP_MINUTES; else process.env.TEMP_QA_FOLLOWUP_MINUTES = originalQa;
    if (saved === undefined) delete process.env.PROVIDER_GATEWAY_URL; else process.env.PROVIDER_GATEWAY_URL = saved;
  }
});