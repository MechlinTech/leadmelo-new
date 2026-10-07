import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt, hashPassword } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { processRun, tick, scheduleRuns } from '../../lib/worker.ts';
import { POST as queueRun, GET as listRuns } from '../../app/api/automation-runs/route.ts';
import { handleProviderEvent } from '../../lib/webhooks.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('Use an isolated database and TEST_DATABASE_CONFIRM=isolated');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.OUTBOUND_ENABLED = 'true';
process.env.SENDER_HEALTH_AUTO = 'off';
delete process.env.TEMP_QA_FOLLOWUP_MINUTES;

let tenant, campaign, cookie, server, discoverBodies = [], discoverStatus = 200, discoverBody;
const request = (path, method = 'GET', body, headers = {}) => new Request(`http://localhost:3000/api/${path}`, {
  method,
  headers: { cookie, origin: 'http://localhost:3000', 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const prospect = i => ({
  company: `Buyer ${i}`, domain: `buyer${i}.example`, fullName: `Buyer ${i}`, title: 'CTO', email: `buyer${i}@buyer.example`,
  industry: 'SaaS', companySize: '50-1000', geography: 'US', technologies: ['Playwright'], signals: ['Hiring QA'],
  verification: 'VALID', verifiedAt: new Date().toISOString(), evidenceUrl: `https://buyer${i}.example/jobs`, evidenceSummary: 'QA hiring page'
});

async function freshCampaign(name) {
  const icp = await db.iCP.create({ data: { tenantId: tenant.id, name: `${name} ICP`, offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['Playwright'] } });
  return db.campaign.create({
    data: {
      tenantId: tenant.id, icpId: icp.id, name, senderName: 'Sender', senderEmail: `${name.toLowerCase().replace(/\W/g, '')}@sender.example`,
      calendlyUrl: 'https://calendly.com/test', status: 'ACTIVE', automationMode: 'FULLY_AUTOMATIC', businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24, weeklyProspectCap: 50, dailySendCap: 25,
      sequenceSteps: { create: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Hello', body: 'Hi {{firstName}}' }] }
    }
  });
}

test('automation run status, error codes and retry safety', async t => {
  server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/discover') {
      discoverBodies.push(body);
      res.statusCode = discoverStatus;
      res.end(JSON.stringify(discoverBody ?? { prospects: [prospect(1), prospect(2)] }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousGatewayUrl = process.env.PROVIDER_GATEWAY_URL;
  process.env.PROVIDER_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    tenant = await db.tenant.create({
      data: {
        name: 'Runs', slug: `runs-${randomUUID()}`, settings: { create: { automationEnabled: true, postalAddress: '123 Test Street', dailySendCap: 25, weeklyProspectCap: 50, gatewayKey: encrypt('runs-gateway-credential'), webhookSecret: encrypt('w'.repeat(40)) } },
        users: { create: { email: `admin-${randomUUID()}@example.com`, role: 'TENANT_ADMIN', passwordHash: hashPassword('long-test-password-123') } }
      }, include: { users: true }
    });
    cookie = `${sessionCookie}=${await createSession(tenant.users[0].id)}`;

    await t.test('a discovery that succeeds reports real counts and no error', async () => {
      discoverBodies = []; discoverStatus = 200;
      campaign = await freshCampaign('Healthy');
      // campaignReady (used by the retry endpoint) needs a fresh HEALTHY sender profile.
      await db.deliverabilityProfile.create({ data: { tenantId: tenant.id, senderEmail: campaign.senderEmail, domain: 'sender.example', status: 'HEALTHY', dailyCap: 25, lastCheckedAt: new Date() } });
      await scheduleRuns();
      assert.ok(await processRun());
      const run = await db.automationRun.findFirstOrThrow({ where: { campaignId: campaign.id } });
      assert.equal(run.status, 'SUCCEEDED');
      assert.equal(run.prospectsFound, 2);
      assert.equal(run.messagesQueued, 2);
      assert.equal(run.errors, null);
      assert.ok(run.finishedAt, 'a finished run records when it finished');
      assert.equal(run.leaseToken, null);
      assert.equal(await db.enrollment.count({ where: { campaignId: campaign.id } }), 2);
      assert.equal(await db.outreachEvent.count({ where: { campaignId: campaign.id } }), 2);
    });

    await t.test('a queued retry is not a duplicate: same prospects, same emails, no second row', async () => {
      discoverBodies = [];
      const run = await db.automationRun.findFirstOrThrow({ where: { campaignId: campaign.id } });
      // Re-queue exactly like the UI retry button does.
      const response = await queueRun(request('automation-runs', 'POST', { campaignId: campaign.id }, { 'idempotency-key': `retry-${run.id}` }));
      assert.equal(response.status, 202);
      const queued = await response.json();
      assert.equal(queued.status, 'QUEUED');
      assert.equal(queued.errors, null, 'a queued retry must not keep the previous error');
      assert.ok(await processRun());
      const after = await db.automationRun.findUniqueOrThrow({ where: { id: queued.id } });
      assert.equal(after.status, 'SUCCEEDED');
      assert.equal(await db.enrollment.count({ where: { campaignId: campaign.id } }), 2, 'no duplicate enrollments');
      assert.equal(await db.outreachEvent.count({ where: { campaignId: campaign.id } }), 2, 'no duplicate queued emails');
      assert.equal(await db.lead.count({ where: { tenantId: tenant.id } }), 2);
      // A retry must send the same discover body, or the gateway rejects the reused key with 422.
      assert.deepEqual(discoverBodies[0], discoverBodies[discoverBodies.length - 1]);
    });

    await t.test('an unreachable gateway names the cause instead of a generic database error', async () => {
      const broken = await freshCampaign('Unreachable');
      await db.automationRun.create({ data: { tenantId: tenant.id, campaignId: broken.id, idempotencyKey: `unreachable-${randomUUID()}` } });
      const deadUrl = process.env.PROVIDER_GATEWAY_URL;
      process.env.PROVIDER_GATEWAY_URL = 'http://127.0.0.1:1';
      try { await processRun(); } finally { process.env.PROVIDER_GATEWAY_URL = deadUrl; }
      const run = await db.automationRun.findFirstOrThrow({ where: { campaignId: broken.id } });
      assert.equal(run.errors.code, 'gateway_unreachable', 'a refused connection must be reported as such');
      assert.equal(run.status, 'QUEUED', 'a retryable failure stays queued for another attempt');
      assert.equal(run.finishedAt, null);
    });

    await t.test('an unconfigured gateway URL is reported as configuration, not as a crash', async () => {
      const broken = await freshCampaign('Unconfigured');
      await db.automationRun.create({ data: { tenantId: tenant.id, campaignId: broken.id, idempotencyKey: `unconfigured-${randomUUID()}` } });
      const saved = process.env.PROVIDER_GATEWAY_URL;
      process.env.PROVIDER_GATEWAY_URL = '   ';
      try { await processRun(); } finally { process.env.PROVIDER_GATEWAY_URL = saved; }
      const run = await db.automationRun.findFirstOrThrow({ where: { campaignId: broken.id } });
      assert.equal(run.errors.code, 'gateway_not_configured');
    });

    await t.test('a 200 with an unreadable body is a provider contract problem', async () => {
      const broken = await freshCampaign('BadShape');
      await db.automationRun.create({ data: { tenantId: tenant.id, campaignId: broken.id, idempotencyKey: `badshape-${randomUUID()}` } });
      discoverBody = { prospects: [{ company: 'No schema fields at all' }] }; discoverStatus = 200;
      try { await processRun(); } finally { discoverBody = undefined; }
      const run = await db.automationRun.findFirstOrThrow({ where: { campaignId: broken.id } });
      assert.equal(run.errors.code, 'gateway_invalid_response');
    });

    await t.test('exhausted attempts end as FAILED with a timestamp, never stuck in QUEUED', async () => {
      const broken = await freshCampaign('Exhausted');
      const run = await db.automationRun.create({ data: { tenantId: tenant.id, campaignId: broken.id, idempotencyKey: `exhausted-${randomUUID()}` } });
      const saved = process.env.PROVIDER_GATEWAY_URL;
      process.env.PROVIDER_GATEWAY_URL = 'http://127.0.0.1:1';
      try {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await db.automationRun.update({ where: { id: run.id }, data: { availableAt: new Date(0) } });
          await processRun();
          const current = await db.automationRun.findUniqueOrThrow({ where: { id: run.id } });
          assert.equal(current.attempts, attempt);
          assert.equal(current.status, attempt < 3 ? 'QUEUED' : 'FAILED', `attempt ${attempt}`);
          if (attempt < 3) assert.equal(current.finishedAt, null);
        }
      } finally { process.env.PROVIDER_GATEWAY_URL = saved; }
      const failed = await db.automationRun.findUniqueOrThrow({ where: { id: run.id } });
      assert.equal(failed.status, 'FAILED');
      assert.ok(failed.finishedAt, 'a failed run is finished, not left open');
      assert.equal(failed.leaseToken, null);
      assert.equal(failed.errors.code, 'gateway_unreachable');
      assert.equal(await db.operationalAlert.count({ where: { tenantId: tenant.id, code: 'discovery_failed', entityId: run.id } }), 1, 'a failed discovery raises an operational alert');
    });

    await t.test('a queued run that used up its attempts is failed by the scheduler, not left pending', async () => {
      const orphan = await freshCampaign('Orphan');
      await db.automationRun.create({ data: { tenantId: tenant.id, campaignId: orphan.id, idempotencyKey: `orphan-${randomUUID()}`, status: 'QUEUED', attempts: 3, errors: { code: 'integration_or_database_error' } } });
      await tick();
      const swept = await db.automationRun.findFirstOrThrow({ where: { campaignId: orphan.id } });
      assert.equal(swept.status, 'FAILED');
      assert.equal(swept.errors.code, 'max_attempts_exhausted');
      assert.ok(swept.finishedAt);
    });

    await t.test('a queued run for a campaign that is no longer active is released', async () => {
      const paused = await freshCampaign('Paused');
      await db.campaign.update({ where: { id: paused.id }, data: { status: 'PAUSED' } });
      await db.automationRun.create({ data: { tenantId: tenant.id, campaignId: paused.id, idempotencyKey: `paused-${randomUUID()}`, status: 'QUEUED', attempts: 1 } });
      await tick();
      const released = await db.automationRun.findFirstOrThrow({ where: { campaignId: paused.id } });
      assert.equal(released.status, 'CANCELED');
      assert.equal(released.errors, null);
    });

    await t.test('the Runs list is scoped to the tenant and carries the campaign name', async () => {
      const body = await (await listRuns(request('automation-runs'))).json();
      assert.ok(body.length > 0);
      assert.ok(body.every(r => r.tenantId === tenant.id));
      const healthy = body.find(r => r.campaignId === campaign.id);
      assert.equal(healthy.campaign.name, 'Healthy');
      assert.equal(healthy.errors, null, 'a succeeded run shows no error');
      // Nothing sensitive from the worker log is exposed through the API.
      const text = JSON.stringify(body);
      assert.ok(!text.includes('runs-gateway-credential'));
      assert.ok(!/postgres:\/\//.test(text));
    });

    await t.test('health events still flow so a healthy campaign is not cancelled by the sweeper', async () => {
      await handleProviderEvent(tenant.id, { id: `health-${randomUUID()}`, type: 'sender.health', occurredAt: new Date().toISOString(), senderEmail: campaign.senderEmail, status: 'HEALTHY', dailyCap: 25, bounceRate: 0, complaintRate: 0 });
      await tick();
      assert.equal((await db.automationRun.findFirstOrThrow({ where: { campaignId: campaign.id } })).status, 'SUCCEEDED');
    });
  } finally {
    server.close();
    if (previousGatewayUrl === undefined) delete process.env.PROVIDER_GATEWAY_URL;
    else process.env.PROVIDER_GATEWAY_URL = previousGatewayUrl;
  }
});