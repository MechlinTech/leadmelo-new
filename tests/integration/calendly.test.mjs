import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt } from '../../lib/crypto.ts';
import { attributionToken } from '../../lib/calendly.ts';
import { POST as calendlyWebhook } from '../../app/api/webhooks/calendly/[tenantId]/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';
const signingKey = 'synthetic-calendly-signing-key';

test('Calendly webhook creates, dedupes, orders and cancels bookings with signed attribution', async t => {
  const tenant = await db.tenant.create({ data: { name: 'Cal A', slug: `cal-a-${randomUUID()}`, settings: { create: { calendlySigningKey: encrypt(signingKey), postalAddress: '123 Test Street' } } } });
  const other = await db.tenant.create({ data: { name: 'Cal B', slug: `cal-b-${randomUUID()}`, settings: { create: { calendlySigningKey: encrypt(signingKey) } } } });
  const lead = await db.lead.create({ data: { tenantId: tenant.id, company: 'Synthetic', domain: 'synthetic.example' } });
  const contact = await db.contact.create({ data: { tenantId: tenant.id, leadId: lead.id, fullName: 'Test Buyer', email: 'buyer@example.com', verification: 'VALID', lastVerifiedAt: new Date() } });
  const campaign = await db.campaign.create({ data: { tenantId: tenant.id, name: 'Cal campaign', senderName: 'Sender', senderEmail: 'sender@example.com', calendlyUrl: 'https://calendly.com/test', status: 'ACTIVE', automationMode: 'FULLY_AUTOMATIC', sequenceSteps: { create: [{ stepOrder: 1, subject: 'Hello', body: 'Hello buyer' }] } } });
  await db.enrollment.create({ data: { tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: { synthetic: true } } });
  const token = attributionToken(tenant.id, campaign.id, contact.id);
  const send = (tenantId, body, { key = signingKey, header } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = header ?? `t=${ts},v1=${createHmac('sha256', key).update(`${ts}.${raw}`).digest('hex')}`;
    return calendlyWebhook(new Request(`http://localhost:3000/api/webhooks/calendly/${tenantId}`, { method: 'POST', headers: { 'calendly-webhook-signature': sig, 'content-type': 'application/json' }, body: raw }), { params: Promise.resolve({ tenantId }) });
  };
  const inviteeUri = 'https://api.calendly.com/scheduled_events/E1/invitees/I1';
  const env = (event, at, extra = {}, utm = token, email = 'buyer@example.com') => ({ event, created_at: at, payload: { uri: inviteeUri, email, timezone: 'America/New_York', tracking: { utm_content: utm }, scheduled_event: { uri: 'https://api.calendly.com/scheduled_events/E1', start_time: '2026-09-25T15:00:00.000000Z', end_time: '2026-09-25T15:30:00.000000Z' }, ...extra } });
  const appointment = () => db.appointment.findMany({ where: { tenantId: tenant.id } });

  await t.test('bad signature, wrong key, unconfigured tenant and oversize body are rejected', async () => {
    assert.equal((await send(tenant.id, env('invitee.created', '2026-09-18T12:00:00.000Z'), { key: 'wrong' })).status, 401);
    assert.equal((await send(tenant.id, env('invitee.created', '2026-09-18T12:00:00.000Z'), { header: 'garbage' })).status, 401);
    assert.equal((await send('no-such-tenant', env('invitee.created', '2026-09-18T12:00:00.000Z'))).status, 401);
    assert.equal((await send(tenant.id, 'x'.repeat(70000))).status, 413);
    assert.equal((await appointment()).length, 0);
  });
  await t.test('unattributed or forged-attribution bookings never create an appointment', async () => {
    const forged = await send(tenant.id, env('invitee.created', '2026-09-18T12:00:00.000Z', {}, `${campaign.id}.${contact.id}.forged`));
    assert.equal((await forged.json()).ignored, true);
    const none = await send(tenant.id, { ...env('invitee.created', '2026-09-18T12:00:00.000Z'), payload: { ...env('invitee.created', '2026-09-18T12:00:00.000Z').payload, tracking: {} } });
    assert.equal((await none.json()).reason, 'unattributed_booking');
    // A valid token for tenant A presented to tenant B's webhook is not honoured.
    assert.equal((await (await send(other.id, env('invitee.created', '2026-09-18T12:00:00.000Z'))).json()).reason, 'unattributed_booking');
    assert.equal((await appointment()).length, 0);
  });
  await t.test('signed attributed booking creates exactly one appointment; retries are duplicates', async () => {
    const payload = env('invitee.created', new Date(Date.now() - 3600000).toISOString());
    assert.equal((await send(tenant.id, payload)).status, 200);
    assert.equal((await (await send(tenant.id, payload)).json()).duplicate, true);
    const rows = await appointment();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'BOOKED'); assert.equal(rows[0].campaignId, campaign.id); assert.equal(rows[0].contactId, contact.id);
    assert.equal(rows[0].qualified, true);
    assert.equal(rows[0].scheduledStart.toISOString(), '2026-09-25T15:00:00.000Z');
  });
  await t.test('cancellation applies; a late-delivered older creation cannot resurrect it', async () => {
    const cancelAt = new Date(Date.now() - 60000).toISOString(), lateCreatedAt = new Date(Date.now() - 3600000 + 1000).toISOString();
    assert.equal((await send(tenant.id, env('invitee.canceled', cancelAt, { cancellation: { canceled_by: 'Buyer', reason: null, canceler_type: 'invitee', created_at: cancelAt } }))).status, 200);
    assert.equal((await appointment())[0].status, 'CANCELED');
    assert.equal((await send(tenant.id, env('invitee.created', lateCreatedAt))).status, 200);
    const rows = await appointment();
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'CANCELED');
  });
  await t.test('invitee email that differs from the contact raises one alert but keeps signed attribution', async () => {
    await send(tenant.id, env('invitee.created', new Date(Date.now() - 30000).toISOString(), { uri: 'https://api.calendly.com/scheduled_events/E2/invitees/I2' }, token, 'colleague@example.com'));
    assert.equal(await db.operationalAlert.count({ where: { tenantId: tenant.id, code: 'booking_invitee_mismatch' } }), 1);
    assert.equal((await appointment()).length, 2);
  });
});
