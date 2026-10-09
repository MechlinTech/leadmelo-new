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

// A newly queued message must be visible in the outreach queue. The queue is ordered by createdAt
// and only the newest 25 rows render, so anything that does not sort as the newest row can be
// invisible even though the run reported messagesQueued > 0. Filler rows below reproduce that window.
//
// This used to also cover re-queuing the same prospect, which the removed dummy-discovery mode made
// possible (it bypassed the 30-day ownership cooldown and upserted the same outreach row). That path
// is gone, so a re-discovered contact is now correctly skipped as already owned and there is no
// re-queue behaviour left to test.
test('a newly queued message appears in the outreach queue', async t => {
  let server;
  t.after(() => server?.close());
  const tenant = await db.tenant.create({
    data: {
      name: 'Visibility', slug: `vis-${randomUUID()}`,
      settings: { create: { automationEnabled: true, postalAddress: '221B Test Street', dailySendCap: 50, weeklyProspectCap: 100, gatewayKey: encrypt('requeue-gateway'), webhookSecret: encrypt('w'.repeat(40)) } },
      users: { create: { email: `a-${randomUUID()}@example.com`, role: 'TENANT_ADMIN' } }
    }
  });
  t.after(() => db.tenant.delete({ where: { id: tenant.id } }).catch(() => {}));

  const parked = new Date('2099-01-01');
  await db.outreachEvent.updateMany({ where: { status: { in: ['QUEUED', 'SENDING'] } }, data: { scheduledAt: parked } });
  await db.campaign.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'PAUSED' } });

  // One prospect from the stub gateway, which stands in for the real vendor.
  const stubProspect = {
    company: 'Visibility Co', domain: 'visibility.example', fullName: 'Vis Buyer', title: 'CTO',
    email: `vis-${randomUUID()}@visibility.example`,
    industry: 'SaaS', companySize: '50-1000', geography: 'US', technologies: ['Playwright'], signals: ['Hiring QA'],
    verification: 'VALID', verifiedAt: new Date().toISOString(),
    evidenceUrl: 'https://visibility.example/jobs',
    evidenceSummary: 'QA role listed on the company\'s hiring page.'
  };
  server = createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ prospects: [stubProspect] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.PROVIDER_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;

  const icp = await db.iCP.create({ data: { tenantId: tenant.id, name: 'ICP', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['Playwright'] } });
  const campaign = await db.campaign.create({
    data: {
      tenantId: tenant.id, icpId: icp.id, name: 'Visibility', offer: 'QA', senderName: 'Sam', senderEmail: `vis-${randomUUID()}@sender.example`,
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

  await t.test('a queued message sorts as the newest row and is inside the 25-row window', async () => {
    await queueRun();
    await processRun();
    const row = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, contactId: { not: null } } });
    assert.equal(row.status, 'QUEUED');
    const rows = await queueRows();
    const position = rows.findIndex(r => r.id === row.id);
    assert.ok(position >= 0, 'the newly queued message is rendered');
    assert.ok(position < 25, `and is inside the 25-row window (position ${position})`);
    assert.equal(rows[0].id, row.id, 'it sorts as the newest row');
  });

  await t.test('re-discovering the same contact does not queue a second message', async () => {
    const before = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, contactId: { not: null } } });
    // The contact is already owned by this campaign. Re-running discovery must not duplicate it.
    await new Promise(r => setTimeout(r, 15));
    await queueRun();
    await processRun();
    const after = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: campaign.id, contactId: { not: null } } });
    assert.equal(after.id, before.id, 'the same row is reused rather than duplicated');
    assert.equal(await db.outreachEvent.count({ where: { campaignId: campaign.id, contactId: { not: null } } }), 1, 'exactly one outreach row for the prospect');
  });

  await t.test('the first run reports the message, and the re-discovery reports nothing', async () => {
    const runs = await db.automationRun.findMany({ where: { campaignId: campaign.id }, orderBy: { createdAt: 'asc' } });
    for (const r of runs) assert.equal(r.status, 'SUCCEEDED');
    assert.ok(runs[0].messagesQueued >= 1, `the first run reports queued messages, got ${runs[0].messagesQueued}`);
    // The contact is already owned, so the second run must queue nothing. It still succeeds: a
    // discovery that finds the prospect already enrolled is a clean no-op, not a failure.
    assert.equal(runs[runs.length - 1].messagesQueued, 0, 'the re-discovery run queues nothing');
    assert.equal(await db.outreachEvent.count({ where: { campaignId: campaign.id, contactId: { not: null } } }), 1, 'exactly one outreach row for the prospect');
  });
});