import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthEvent, signBody } from '../scripts/post-sender-health.mjs';
import { verifyWebhook, webhookInput } from '../lib/webhooks.ts';

const args = (o = {}) => Object.entries({ sender: 'Sam@Example.com', status: 'HEALTHY', 'daily-cap': '25', 'bounce-rate': '0.01', 'complaint-rate': '0', ...o }).flatMap(([k, v]) => [`--${k}`, v]);

test('the sender-health tool builds an event LeadMelo accepts, signed the way LeadMelo verifies', () => {
  const now = new Date('2026-09-18T12:00:00Z');
  const event = buildHealthEvent(args(), now);
  const parsed = webhookInput.parse(event); // the production schema
  assert.equal(parsed.type, 'sender.health'); assert.equal(parsed.senderEmail, 'sam@example.com');
  const raw = JSON.stringify(event), { timestamp, signature } = signBody('a'.repeat(32), raw, now);
  assert.equal(verifyWebhook(raw, timestamp, signature, 'a'.repeat(32), now.getTime()), true);
  assert.equal(verifyWebhook(raw + ' ', timestamp, signature, 'a'.repeat(32), now.getTime()), false);
  assert.equal(verifyWebhook(raw, timestamp, signature, 'b'.repeat(32), now.getTime()), false);
});
test('the tool refuses malformed or out-of-range measurements instead of guessing', () => {
  assert.throws(() => buildHealthEvent(args({ sender: 'nope' })), /sender/);
  assert.throws(() => buildHealthEvent(args({ status: 'GREAT' })), /status/);
  assert.throws(() => buildHealthEvent(args({ 'daily-cap': '900' })), /daily-cap/);
  assert.throws(() => buildHealthEvent(args({ 'bounce-rate': '5' })), /bounce-rate/);
  assert.throws(() => buildHealthEvent(args({ 'complaint-rate': 'abc' })), /complaint-rate/);
  assert.throws(() => buildHealthEvent(['--sender', 'a@b.co']), /status/);
});
