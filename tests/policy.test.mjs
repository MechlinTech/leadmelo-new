import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { classifyReply } from '../lib/replies.ts';
import { qualifyProspect, withinSendWindow, addBusinessDays, renderTemplate } from '../lib/policy.ts';
import { verifyWebhook } from '../lib/webhooks.ts';
import { encrypt, decrypt, hashPassword, verifyPassword } from '../lib/crypto.ts';
import { unsubscribeToken, parseUnsubscribe } from '../lib/unsubscribe.ts';
import { campaignInput } from '../lib/validation.ts';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET = 'test-only-secret-'.repeat(4);
test('negative intent always takes precedence over meeting keywords', () => {
  for (const text of ['not interested', 'unsubscribe but thanks for the call', "don't schedule a meeting", 'no thanks']) assert.equal(classifyReply(text), 'NEGATIVE');
  assert.equal(classifyReply('out of office, interested next month'), 'OUT_OF_OFFICE');
  assert.equal(classifyReply('can we talk? not sure'), 'UNSURE');
  assert.equal(classifyReply('yes please, schedule a meeting'), 'POSITIVE');
});
test('authenticated encryption rejects tampering and passwords are salted', () => {
  const encrypted = encrypt('tenant credential');
  assert.equal(decrypt(encrypted), 'tenant credential');
  const parts = encrypted.split('.'); parts[1] = Buffer.alloc(16).toString('base64');
  assert.throws(() => decrypt(parts.join('.')));
  const a = hashPassword('correct password'), b = hashPassword('correct password');
  assert.notEqual(a, b); assert.ok(verifyPassword('correct password', a)); assert.ok(!verifyPassword('incorrect', a));
});
test('webhook accepts authentic current body and rejects replay-age, tampering and malformed signatures', () => {
  const raw = '{"type":"reply"}', ts = '1789750800', secret = 'signing-secret';
  const signature = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  assert.ok(verifyWebhook(raw, ts, signature, secret, Number(ts) * 1000));
  assert.ok(!verifyWebhook(raw + ' ', ts, signature, secret, Number(ts) * 1000));
  assert.ok(!verifyWebhook(raw, ts, signature, secret, Number(ts) * 1000 + 301000));
  assert.ok(!verifyWebhook(raw, ts, 'x', secret, Number(ts) * 1000));
});
test('unsubscribe token cannot be changed to suppress another tenant', () => {
  const token = unsubscribeToken('tenant-a', 'Buyer@Example.com');
  assert.deepEqual(parseUnsubscribe(token), { tenantId: 'tenant-a', email: 'buyer@example.com' });
  assert.throws(() => parseUnsubscribe('a' + token));
});
test('send window honors recipient timezone, weekends and daylight saving', () => {
  const c = { timezone: 'America/Los_Angeles', businessDaysOnly: true, sendStartHour: 9, sendEndHour: 17 };
  assert.ok(withinSendWindow(c, new Date('2026-09-18T16:00:00Z')));
  assert.ok(!withinSendWindow(c, new Date('2026-09-19T16:00:00Z')));
  assert.ok(!withinSendWindow(c, new Date('2026-09-18T15:59:00Z')));
  assert.ok(withinSendWindow(c, new Date('2026-12-18T17:00:00Z')));
  assert.equal(addBusinessDays(new Date('2026-09-18T16:00:00Z'), 1, c.timezone).toISOString(), '2026-09-21T16:00:00.000Z');
});
test('generic ICP qualification requires fresh verified buyer, evidence and exact target dimensions', () => {
  const icp = { industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['Playwright'], exclusionRules: ['competitor.example'], minScore: 75 };
  const now = new Date('2026-09-18T17:00:00Z');
  const p = { domain: 'buyer.example', company: 'Buyer', industry: 'SaaS', companySize: '50-1000', geography: 'US', title: 'CTO', signals: ['Hiring QA'], technologies: ['Playwright'], verification: 'VALID', verifiedAt: now.toISOString() };
  assert.equal(qualifyProspect(icp, p, now).score, 100);
  for (const change of [{ signals: [] }, { verification: 'RISKY' }, { title: 'Student' }, { geography: 'Elsewhere' }, { domain: 'competitor.example' }, { verifiedAt: '2025-01-01T00:00:00Z' }, { verifiedAt: '2027-01-01T00:00:00Z' }]) assert.equal(qualifyProspect(icp, { ...p, ...change }, now).eligible, false);
});
test('template rendering rejects undefined variables', () => {
  assert.equal(renderTemplate('Hi {{firstName}}', { firstName: 'Alex' }), 'Hi Alex');
  assert.throws(() => renderTemplate('{{inventedEvidence}}', {}));
});
test('campaign validation rejects a client-supplied tenant and duplicate steps', () => {
  const c = { name: 'QA', icpId: 'icp', senderName: 'Sam', senderEmail: 'sam@example.com', calendlyUrl: 'https://calendly.com/example/30min', sequenceSteps: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Hello', body: 'Hello' }] };
  assert.ok(campaignInput.safeParse(c).success);
  const { icpId, ...withoutICP } = c;
  assert.ok(campaignInput.safeParse({ ...withoutICP, icp: { name: 'Inline ICP', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyingSignals: ['Hiring QA'], buyerTitles: ['CTO'] } }).success);
  assert.ok(!campaignInput.safeParse({ ...c, icp: { name: 'Duplicate', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyingSignals: ['Hiring QA'], buyerTitles: ['CTO'] } }).success);
  assert.ok(!campaignInput.safeParse({ ...c, tenantId: 'victim' }).success);
  assert.ok(!campaignInput.safeParse({ ...c, sequenceSteps: [...c.sequenceSteps, ...c.sequenceSteps] }).success);
  assert.ok(!campaignInput.safeParse({ ...c, sendStartHour: 18, sendEndHour: 9 }).success);
});
