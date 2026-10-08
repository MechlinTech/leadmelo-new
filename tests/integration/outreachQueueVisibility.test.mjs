import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { processRun, tick } from '../../lib/worker.ts';
import { GET as getOutreach } from '../../app/api/outreach/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('Use an isolated database and TEST_DATABASE_CONFIRM=isolated');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://leadmelo.example.com';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.OUTBOUND_ENABLED = 'true';
process.env.SENDER_HEALTH_AUTO = 'off';
delete process.env.TEMP_QA_FOLLOWUP_MINUTES;

// The dummy gateway returns the same few prospects on every discovery run. Re-qualifying one
// reuses its outreach row by idempotency key instead of inserting a new one, so createdAt was
// left at the original insertion time. The queue is ordered by createdAt and only the newest 25
// rows render, so a re-queued message stayed invisible even though the run reported
// messagesQueued > 0.
test('a re-queued message becomes the newest row in the outreach queue', async t => {
  let server;
  t.after(() => server?.close());
  const tenant = await db.tenant.create({
    data: {
      name: 'Requeue', slug: `rq-${randomUUID()}`,
      settings: { create: { automationEnabled: true, postalAddress: '221B Test Street', dailySendCap: 50, weeklyProspectCap: 100, gatewayKey: encrypt('requeue-gateway'), webhookSecret: encrypt('w'.repeat(40)) } },
      users: { create: { email: `a-${randomUUID()}@example.com`, role: 'TENANT_ADMIN' } }
    }
  });
  t.after(() => db.tenant.delete({ where: { id: tenant.id } }).catch(() => {}));

  const parked = new Date('2099-01-01');
  await db.outreachEvent.updateMany({ where: { status: { in: ['QUEUED', 'SENDING'] } }, data: { scheduledAt: parked } });
  await db.campaign.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'PAUSED' } });

  // One prospect, re-discovered on every run.
  const dummyProspect = {
    company: 'Requeue Co', domain: 'requeue.example', fullName: 'RQ Buyer', title: 'CTO',
    email: `rq-${randomUUID()}@requeue.example`,
    industry: 'SaaS', companySize: '50-1000', geography: 'US', technologies: ['Playwright'], signals: ['Hiring QA'],
    verification: 'VALID', verifiedAt: new Date().toISOString(),
    evidenceUrl: 'https://requeue.example/jobs',
    evidenceSummary: 'Dummy discovery prospect for development. ICP-aligned title "CTO".'
  };
  server = createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ prospects: [dummyProspect] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.PROVIDER_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;

  const icp = await db.iCP.create({ data: { tenantId: tenant.id, name: 'ICP', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['Playwright'] } });
  const campaign = await db.campaign.create({
    data: {
      tenantId: tenant.id, icpId: icp.id, name: 'Requeue', offer: 'QA', senderName: 'Sam', senderEmail: `rq-${randomUUID()}@sender.example`,
      calendlyUrl: 'https://calendly.com/sam/30min', status: 'ACTIVE', automationMode: 'FULLY_AUTOMATIC',
      timezone: 'America/Los_Angeles', businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24,
      weeklyProspectCap: 100, dailySendCap: 50, holidays: [],
      sequenceSteps: { create: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Hi {{firstName}}', body: 'Hello {{firstName}}.' }] }
    }
  });

  const admin = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const cookie = `${sessionCookie}=${await createSession(admin.id)}`;
  const cookieHeader = { cookie, origin: 'https://leadmelo.example.com', 'content-type': 'application/json' };
  const queueRows = async () => (await (await getOutreach(new Request('https://leadmelo.example.com/api/outreach', { headers: cookieHeader }))).json());

  // Filler rows, as in a real tenant, so the 25-row window would hide anything stale.
  for (let i = 0; i < 30; i++) {
    await db.outreachEvent.create({
      data: {
        tenantId: tenant.id, campaignId: campaign.id, stepOrder: 1, purpose: 'SEQUENCE',
        idempotencyKey: `filler-${tenant.id}-${i}`, scheduledAt: parked,
        status: i % 2 ? 'SENT' : 'CANCELED', sentAt: new Date(2000, 0, 1), createdAt: new Date(2000, 0, 1 + i)
      }
    });
  }

  const queueRun = () => db.automationRun.create({
    data: { tenantId: tenant.id, campaignId: campaign.id, status: 'QUEUED', availableAt: new Date(), idempotencyKey: `run-${randomUUID()}` }
  });

  await t.test('the first discovery queues a visible message', async () => {
    await queueRun();
    await processRun();
    const row = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, contactId: { not: null } } });
    assert.equal(row.status, 'QUEUED');
    const rows = await queueRows();
    assert.ok(rows.find(r => r.id === row.id), 'the newly queued message is inside the rendered window');
  });

  await t.test('re-discovering the same prospect makes it the newest row again', async () => {
    const before = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, contactId: { not: null } } });
    assert.ok(before.createdAt < new Date(), 'it starts old enough to be pushed out of the window');
    // A second run re-qualifies the same prospect and re-queues the same idempotency key.
    await new Promise(r => setTimeout(r, 15));
    await queueRun();
    await processRun();

    const after = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, contactId: { not: null } } });
    assert.equal(after.id, before.id, 'the same row is reused rather than duplicated');
    assert.equal(after.status, 'QUEUED');
    assert.ok(after.createdAt > before.createdAt, `createdAt must advance on re-queue (was ${before.createdAt.toISOString()}, now ${after.createdAt.toISOString()})`);

    const rows = await queueRows();
    const position = rows.findIndex(r => r.id === after.id);
    assert.ok(position >= 0, 'the re-queued message is rendered');
    assert.ok(position < 25, `and is inside the 25-row window (position ${position})`);
    assert.equal(rows[0].id, after.id, 'it sorts as the newest row');
  });

  await t.test('the run still reports the message, and no duplicate row appears', async () => {
    const run = await db.automationRun.findFirstOrThrow({ where: { campaignId: campaign.id }, orderBy: { createdAt: 'desc' } });
    assert.equal(run.status, 'SUCCEEDED');
    assert.ok(run.messagesQueued >= 1, `the run reports queued messages, got ${run.messagesQueued}`);
    assert.equal(await db.outreachEvent.count({ where: { campaignId: campaign.id, contactId: { not: null } } }), 1, 'exactly one outreach row for the prospect');
  });
});