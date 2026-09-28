import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const { attributionToken, parseAttributionToken, schedulingUrl, verifyCalendlySignature, normalizeCalendlyEvent } = await import('../lib/calendly.ts');

const sign = (raw, key, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${raw}`).digest('hex')}`;
const envelope = (event, utm, extra = {}) => ({ event, created_at: '2026-09-18T12:00:00.000Z', payload: { uri: 'https://api.calendly.com/scheduled_events/E1/invitees/I1', email: 'Buyer@Example.com', timezone: 'America/New_York', tracking: { utm_content: utm }, scheduled_event: { uri: 'https://api.calendly.com/scheduled_events/E1', start_time: '2026-09-25T15:00:00.000000Z', end_time: '2026-09-25T15:30:00.000000Z' }, ...extra } });

test('attribution token binds tenant, campaign and contact and rejects tampering', () => {
  const token = attributionToken('t1', 'camp1', 'con1');
  assert.deepEqual(parseAttributionToken('t1', token), { campaignId: 'camp1', contactId: 'con1' });
  assert.equal(parseAttributionToken('t2', token), null, 'another tenant cannot reuse a token');
  assert.equal(parseAttributionToken('t1', token.replace('con1', 'con2')), null, 'edited contact rejected');
  assert.equal(parseAttributionToken('t1', 'camp1.con1.forged'), null);
  assert.equal(parseAttributionToken('t1', undefined), null);
  assert.equal(parseAttributionToken('t1', token + '.extra'), null);
});
test('scheduling URL keeps the calendar link and adds signed attribution', () => {
  const url = new URL(schedulingUrl('https://calendly.com/pm-mechlintech/30min', 't1', 'camp1', 'con1'));
  assert.equal(url.origin + url.pathname, 'https://calendly.com/pm-mechlintech/30min');
  assert.equal(url.searchParams.get('utm_source'), 'leadmelo');
  assert.ok(parseAttributionToken('t1', url.searchParams.get('utm_content')));
});
test('webhook signature is verified over exact bytes with a replay window', () => {
  const raw = '{"event":"invitee.created"}', key = 'calendly-signing-key';
  assert.equal(verifyCalendlySignature(raw, sign(raw, key), key), true);
  assert.equal(verifyCalendlySignature(raw + ' ', sign(raw, key), key), false, 'body change');
  assert.equal(verifyCalendlySignature(raw, sign(raw, 'other'), key), false, 'wrong key');
  assert.equal(verifyCalendlySignature(raw, sign(raw, key, Math.floor(Date.now() / 1000) - 3600), key), false, 'replay');
  assert.equal(verifyCalendlySignature(raw, sign(raw, key, Math.floor(Date.now() / 1000) - 170), key), true, 'inside the 3 minute tolerance Calendly recommends');
  assert.equal(verifyCalendlySignature(raw, sign(raw, key, Math.floor(Date.now() / 1000) - 200), key), false, 'outside it');
  assert.equal(verifyCalendlySignature(raw, '', key), false);
  assert.equal(verifyCalendlySignature(raw, 'garbage', key), false);
});
test('invitee.created becomes a booking only when attribution verifies', () => {
  const token = attributionToken('t1', 'camp1', 'con1');
  const ok = normalizeCalendlyEvent('t1', envelope('invitee.created', token), id => id === 'con1' ? 'buyer@example.com' : null);
  assert.equal(ok.ignored, undefined);
  assert.equal(ok.event.type, 'booking.created');
  assert.equal(ok.event.campaignId, 'camp1');
  assert.equal(ok.event.email, 'buyer@example.com');
  assert.equal(ok.event.start, '2026-09-25T15:00:00.000Z');
  assert.equal(ok.event.bookingId, 'https://api.calendly.com/scheduled_events/E1/invitees/I1');
  assert.equal(ok.inviteeEmail, 'buyer@example.com');
  assert.equal(normalizeCalendlyEvent('t1', envelope('invitee.created', 'camp1.con1.forged'), () => 'x@y.com').reason, 'unattributed_booking');
  assert.equal(normalizeCalendlyEvent('t1', envelope('invitee.created', undefined), () => 'x@y.com').reason, 'unattributed_booking');
  assert.equal(normalizeCalendlyEvent('t2', envelope('invitee.created', token), () => 'x@y.com').reason, 'unattributed_booking', 'cross-tenant token');
  assert.equal(normalizeCalendlyEvent('t1', envelope('routing_form_submission.created', token), () => 'x@y.com').reason, 'unsupported_event');
});
test('cancellation uses provider cancel time and event ids differ from creation', () => {
  const token = attributionToken('t1', 'camp1', 'con1');
  const created = normalizeCalendlyEvent('t1', envelope('invitee.created', token), () => 'buyer@example.com');
  const canceled = normalizeCalendlyEvent('t1', envelope('invitee.canceled', token, { cancellation: { canceled_by: 'Buyer', reason: null, canceler_type: 'invitee', created_at: '2026-09-19T08:00:00.000Z' } }), () => 'buyer@example.com');
  assert.equal(canceled.event.type, 'booking.canceled');
  assert.equal(canceled.event.occurredAt, '2026-09-19T08:00:00.000Z');
  assert.notEqual(canceled.event.id, created.event.id);
  assert.equal(canceled.event.bookingId, created.event.bookingId);
});
test('malformed payloads and unknown contacts are rejected', () => {
  const token = attributionToken('t1', 'camp1', 'con1');
  assert.throws(() => normalizeCalendlyEvent('t1', { event: 'invitee.created' }, () => 'x@y.com'));
  assert.throws(() => normalizeCalendlyEvent('t1', envelope('invitee.created', token, { scheduled_event: {} }), () => 'x@y.com'));
  assert.throws(() => normalizeCalendlyEvent('t1', envelope('invitee.created', token), () => null), /campaign_contact_not_found/);
});
