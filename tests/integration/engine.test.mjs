import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt, hashPassword } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { processRun, scheduleRuns, processOutreach } from '../../lib/worker.ts';
import { handleProviderEvent } from '../../lib/webhooks.ts';
import { unsubscribeToken } from '../../lib/unsubscribe.ts';
import { createExperiment, setExperimentStatus } from '../../lib/experiments/index.ts';
import { GET as getICPs, POST as createICP } from '../../app/api/icps/route.ts';
import { POST as createCampaign, PATCH as patchCampaign } from '../../app/api/campaigns/route.ts';
import { POST as login } from '../../app/api/auth/login/route.ts';
import { POST as webhook } from '../../app/api/webhooks/provider/[tenantId]/route.ts';
import { POST as unsubscribe } from '../../app/unsubscribe/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('Use an isolated database and TEST_DATABASE_CONFIRM=isolated');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.OUTBOUND_ENABLED = 'true';
process.env.SENDER_HEALTH_AUTO = 'off'; // these flows post signed health events; automatic health is tested in growth.test.mjs
const webhookSecret = randomBytes(32).toString('hex');
let cookie = '', tenant, other, campaign, icp, contact, discoveredCalls = 0, delivered = new Map(), failAfterAcceptance = true;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/discover') {
    discoveredCalls++;
    const prospects = [1, 2].slice(0, body.limit).map(i => ({ company: `Buyer ${i}`, domain: `buyer${i}.example`, fullName: `Buyer ${i}`, title: 'CTO', email: `buyer${i}@example.com`, industry: 'SaaS', companySize: '50-1000', geography: 'US', technologies: ['Playwright'], signals: ['Hiring QA'], verification: 'VALID', verifiedAt: new Date(Date.now() - 1000).toISOString(), evidenceUrl: `https://buyer${i}.example/jobs`, evidenceSummary: 'QA hiring page' }));
    res.end(JSON.stringify({ prospects }));
  } else if (req.url === '/send') {
    const key = req.headers['idempotency-key'];
    if (!delivered.has(key)) delivered.set(key, body);
    if (failAfterAcceptance) { failAfterAcceptance = false; res.statusCode = 500; res.end('{}'); return; }
    res.end(JSON.stringify({ messageId: `message-${key}` }));
  } else { res.statusCode = 404; res.end('{}'); }
});

function request(path, method = 'GET', body, auth = cookie, origin = process.env.APP_URL) {
  return new Request(`${process.env.APP_URL}/api/${path}`, { method, headers: { cookie: auth, origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
}

test('persisted multi-tenant campaign-to-booking flow', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.PROVIDER_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    tenant = await db.tenant.create({ data: { name: 'Integration A', slug: `test-a-${Date.now()}`, settings: { create: { automationEnabled: true, postalAddress: '123 Test Street, Test City', dailySendCap: 1, weeklyProspectCap: 3, gatewayKey: encrypt('test-gateway-credential'), webhookSecret: encrypt(webhookSecret) } }, users: { create: { email: `admin-${Date.now()}@example.com`, role: 'TENANT_ADMIN', passwordHash: hashPassword('long-test-password-123') } } }, include: { users: true } });
    other = await db.tenant.create({ data: { name: 'Integration B', slug: `test-b-${Date.now()}` } });
    cookie = `${sessionCookie}=${await createSession(tenant.users[0].id)}`;

    await t.test('real login, malformed JSON, authorization and CSRF', async () => {
      const response = await login(request('auth/login', 'POST', { email: tenant.users[0].email, password: 'long-test-password-123' }, ''));
      assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /HttpOnly/);
      assert.equal((await login(request('auth/login', 'POST', { email: tenant.users[0].email, password: 'wrong' }, ''))).status, 401);
      assert.equal((await getICPs(request('icps', 'GET', undefined, ''))).status, 401);
      assert.equal((await createICP(request('icps', 'POST', '{'))).status, 400);
      assert.equal((await createICP(request('icps', 'POST', {}, cookie, 'https://evil.example'))).status, 403);
    });

    await t.test('ICP and campaign APIs persist; client cannot pick tenant', async () => {
      const input = { name: 'QA', offer: 'QA automation', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['Playwright'] };
      assert.equal((await createICP(request('icps', 'POST', { ...input, tenantId: other.id }))).status, 400);
      const response = await createICP(request('icps', 'POST', input));
      assert.equal(response.status, 201); icp = await response.json();
      assert.equal((await db.iCP.findUnique({ where: { id: icp.id } })).tenantId, tenant.id);
      const foreign = await db.iCP.create({ data: { ...input, tenantId: other.id } });
      const inputCampaign = { name: 'QA campaign', icpId: icp.id, senderName: 'Test Sender', senderEmail: 'sender@example.com', calendlyUrl: 'https://calendly.com/pm-mechlintech/30min', automationMode: 'FULLY_AUTOMATIC', businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24, sequenceSteps: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'QA help', body: 'Hi {{firstName}}, {{calendlyUrl}}' }, { stepOrder: 2, waitBusinessDays: 2, subject: 'Following up', body: 'Still relevant, {{firstName}}?' }] };
      assert.equal((await createCampaign(request('campaigns', 'POST', { ...inputCampaign, icpId: foreign.id }))).status, 404);
      const created = await createCampaign(request('campaigns', 'POST', inputCampaign));
      assert.equal(created.status, 201); campaign = await created.json();
      assert.equal((await patchCampaign(request('campaigns', 'PATCH', { id: campaign.id, status: 'ACTIVE' }))).status, 409);
      await handleProviderEvent(tenant.id, { id: 'health', type: 'sender.health', occurredAt: new Date().toISOString(), senderEmail: campaign.senderEmail, status: 'HEALTHY', dailyCap: 25, bounceRate: 0, complaintRate: 0 });
      assert.equal((await patchCampaign(request('campaigns', 'PATCH', { id: campaign.id, status: 'ACTIVE' }))).status, 200);
      const inline = await createCampaign(request('campaigns', 'POST', { ...inputCampaign, name: 'Inline ICP campaign', icpId: undefined, icp: { ...input, name: 'Inline campaign ICP' }, startImmediately: true }));
      assert.equal(inline.status, 201);
      const inlineCampaign = await inline.json();
      assert.equal(inlineCampaign.activation.started, true);
      assert.equal((await db.iCP.findUnique({ where: { id: inlineCampaign.icpId } })).tenantId, tenant.id);
      await db.campaign.update({ where: { id: inlineCampaign.id }, data: { status: 'PAUSED' } });
      const list = await (await getICPs(request('icps'))).json();
      assert.ok(!list.some(x => x.tenantId === other.id));
    });

    await t.test('database independently rejects cross-tenant relationships', async () => {
      await assert.rejects(db.campaign.create({ data: { tenantId: other.id, icpId: icp.id, name: 'Bad', senderName: 'Bad', senderEmail: 'bad@example.com', calendlyUrl: 'https://example.com' } }), /cross-tenant reference rejected/);
      // PGlite's TCP adapter closes an extended-query connection after a raised trigger error.
      if (process.env.TEST_PGLITE === 'true') await db.$disconnect();
    });

    await t.test('scheduler persists one run, discovers and queues unique verified contacts', async () => {
      await scheduleRuns(); await scheduleRuns();
      assert.equal(await db.automationRun.count({ where: { campaignId: campaign.id } }), 1);
      assert.ok(await processRun());
      assert.equal(discoveredCalls, 1);
      assert.equal(await db.enrollment.count({ where: { campaignId: campaign.id } }), 2);
      assert.equal(await db.outreachEvent.count({ where: { campaignId: campaign.id } }), 2);
      assert.equal((await db.automationRun.findFirst({ where: { campaignId: campaign.id } })).status, 'SUCCEEDED');
    });

    await t.test('ambiguous provider acceptance retries with same key, respects cap and schedules follow-up once', async () => {
      // A running experiment (variant weighted ~100000:1) must decide the copy that is really sent.
      const actor = { id: tenant.users[0].id, role: 'TENANT_ADMIN' };
      const experiment = await createExperiment(tenant.id, actor, { campaignId: campaign.id, stepOrder: 1, name: 'Engine test', controlWeight: 1, variants: [{ label: 'B', subject: 'Experiment subject', body: 'Experiment body {{firstName}} {{calendlyUrl}}', weight: 100000 }] });
      await setExperimentStatus(tenant.id, actor, experiment.id, 'RUNNING');
      assert.ok(await processOutreach());
      const retry = await db.outreachEvent.findFirst({ where: { campaignId: campaign.id, attempts: 1 } });
      assert.equal(retry.status, 'QUEUED');
      assert.equal(retry.error, 'gateway_http_500');
      assert.equal(delivered.size, 1);
      await db.outreachEvent.update({ where: { id: retry.id }, data: { scheduledAt: new Date(0) } });
      assert.ok(await processOutreach());
      await processOutreach();
      assert.equal(delivered.size, 1);
      const sent = await db.outreachEvent.findFirst({ where: { campaignId: campaign.id, status: 'SENT' } });
      assert.ok(sent);
      contact = await db.contact.findUnique({ where: { id: sent.contactId } });
      const next = await db.outreachEvent.findFirst({ where: { contactId: contact.id, stepOrder: 2 } });
      assert.ok(next.scheduledAt > sent.sentAt);
      assert.match([...delivered.values()][0].body, /Unsubscribe:/);
      assert.ok([...delivered.values()][0].headers['List-Unsubscribe-Post']);
      assert.match([...delivered.values()][0].body, /utm_content=/, 'scheduling link carries signed attribution');
      const assignment = await db.experimentAssignment.findFirst({ where: { experimentId: experiment.id }, include: { variant: true } });
      assert.ok(assignment, 'the send recorded which arm it used');
      const sentMessage = [...delivered.values()][0];
      if (assignment.variant.isControl) assert.equal(sentMessage.subject, 'QA help');
      else { assert.equal(sentMessage.subject, 'Experiment subject'); assert.match(sentMessage.body, /Experiment body Buyer/); }
      assert.equal(await db.experimentAssignment.count({ where: { experimentId: experiment.id } }), 1, 'the ambiguous retry did not assign twice');
      await setExperimentStatus(tenant.id, actor, experiment.id, 'STOPPED'); // do not affect later steps of this scenario
      assert.equal(await db.usageLedger.count({ where: { tenantId: tenant.id, kind: 'EMAIL_SENT' } }), 1, 'ambiguous retry metered once');
    });

    await t.test('reply deduplicates, suppresses negative buyer and cancels follow-ups', async () => {
      const event = { id: 'negative-1', type: 'reply', occurredAt: new Date().toISOString(), campaignId: campaign.id, email: contact.email, text: 'not interested in a call' };
      assert.equal((await handleProviderEvent(tenant.id, event)).duplicate, false);
      assert.equal((await handleProviderEvent(tenant.id, event)).duplicate, true);
      assert.equal(await db.reply.count({ where: { tenantId: tenant.id } }), 1);
      assert.ok(await db.suppression.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: contact.email } } }));
      assert.equal(await db.outreachEvent.count({ where: { contactId: contact.id, status: 'QUEUED' } }), 0);
    });

    await t.test('signed webhook rejects forged tenant payloads; bookings deduplicate and preserve newer cancellation', async () => {
      const second = await db.contact.findFirst({ where: { tenantId: tenant.id, id: { not: contact.id } } });
      await handleProviderEvent(tenant.id, { id: 'positive-1', type: 'reply', occurredAt: new Date().toISOString(), campaignId: campaign.id, email: second.email, text: 'Yes please, schedule a meeting' });
      const invitation = await db.outreachEvent.findUnique({ where: { idempotencyKey: `booking-invite:${campaign.id}:${second.id}` } });
      assert.equal(invitation.purpose, 'BOOKING_INVITATION');
      assert.match(invitation.body, /calendly\.com\/pm-mechlintech\/30min/);
      assert.equal(await db.outreachEvent.count({ where: { contactId: second.id, purpose: 'SEQUENCE', status: 'QUEUED' } }), 0);
      await db.tenantSetting.update({ where: { tenantId: tenant.id }, data: { dailySendCap: 3 } });
      assert.ok(await processOutreach());
      const sentInvitation = await db.outreachEvent.findUnique({ where: { id: invitation.id } });
      assert.equal(sentInvitation.status, 'SENT');
      assert.match(delivered.get(invitation.idempotencyKey).body, /Unsubscribe:/);
      const event = { id: 'booking-created', type: 'booking.created', campaignId: campaign.id, email: second.email, occurredAt: new Date(Date.now() - 10000).toISOString(), bookingId: 'booking-1', start: '2026-10-01T16:00:00Z', end: '2026-10-01T16:30:00Z', timezone: 'America/Los_Angeles', eventUrl: 'https://api.calendly.com/scheduled_events/test' };
      const raw = JSON.stringify(event), timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', webhookSecret).update(`${timestamp}.${raw}`).digest('hex');
      const call = sig => webhook(new Request('http://localhost/api/webhooks/provider/' + tenant.id, { method: 'POST', headers: { 'x-leadmelo-timestamp': timestamp, 'x-leadmelo-signature': sig }, body: raw }), { params: Promise.resolve({ tenantId: tenant.id }) });
      assert.equal((await call('invalid')).status, 401);
      assert.equal((await call(signature)).status, 200);
      assert.equal((await call(signature)).status, 200);
      assert.equal(await db.appointment.count({ where: { tenantId: tenant.id } }), 1);
      assert.equal((await db.appointment.findFirst({ where: { tenantId: tenant.id } })).qualified, true);
      await handleProviderEvent(tenant.id, { ...event, id: 'canceled', type: 'booking.canceled', occurredAt: new Date().toISOString() });
      await handleProviderEvent(tenant.id, { ...event, id: 'old-created' });
      assert.equal((await db.appointment.findFirst({ where: { tenantId: tenant.id } })).status, 'CANCELED');
    });

    await t.test('one-click unsubscribe is idempotent and respects tenant', async () => {
      const url = `http://localhost/unsubscribe?token=${unsubscribeToken(tenant.id, 'new@example.com')}`;
      assert.equal((await unsubscribe(new Request(url, { method: 'POST' }))).status, 200);
      assert.equal((await unsubscribe(new Request(url, { method: 'POST' }))).status, 200);
      assert.equal(await db.suppression.count({ where: { tenantId: tenant.id, email: 'new@example.com' } }), 1);
      assert.equal(await db.suppression.count({ where: { tenantId: other.id } }), 0);
    });

    await t.test('paused campaign and operator kill switch prevent further discovery', async () => {
      await db.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED', nextRunAt: new Date(0) } });
      process.env.OUTBOUND_ENABLED = 'false';
      await scheduleRuns();
      assert.equal(await processOutreach(), false);
      assert.equal(discoveredCalls, 1);
    });
  } finally {
    await db.$disconnect();
    await new Promise(resolve => server.close(resolve));
  }
});
