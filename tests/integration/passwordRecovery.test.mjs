import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { hashPassword } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { POST as login } from '../../app/api/auth/login/route.ts';
import { POST as resetPassword } from '../../app/api/auth/reset/route.ts';
import { POST as forgotPassword } from '../../app/api/auth/forgot-password/route.ts';
import { GET as listInvites } from '../../app/api/invites/route.ts';
import { RESET_REQUEST_ANSWER, requestPasswordReset, resetLinkState } from '../../lib/passwordRecovery.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';

const strong = 'a-long-test-password-1';
const fresh = 'a-brand-new-password-7';
const GENERIC = 'If an account exists for this email address, you’ll receive a password-reset link shortly.';

// Each subtest gets its own client address and its own account, so the per-caller and
// per-address budgets of one scenario cannot bleed into the next.
let callers = 0;
const caller = () => `203.0.113.${(callers += 1)}`;
const req = (path, method, body, cookie = '', ip = caller(), origin = 'http://localhost:3000') => new Request(`http://localhost:3000/api/${path}`, { method, headers: { cookie, origin, 'x-forwarded-for': ip, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const tokenOf = url => new URL(url).searchParams.get('token');
const linkIn = text => tokenOf(text.match(/https?:\/\/\S+/)?.[0] ?? '');

test('self-service forgot password: generic answers, secure links, and a working reset', async t => {
  const tenant = await db.tenant.create({ data: { name: `fp-${randomUUID()}`, slug: `fp-${randomUUID()}` } });
  const mkUser = async (prefix, extra = {}) => {
    const email = `${prefix}-${randomUUID()}@example.com`;
    const user = await db.user.create({ data: { tenantId: tenant.id, email, role: 'MEMBER', passwordHash: hashPassword(strong), ...extra } });
    return { user, email };
  };
  // Collects what would have gone out through Microsoft 365, without touching the transport.
  const capture = () => { const sent = []; return { sent, send: async (to, subject, text) => { sent.push({ to, subject, text }); return true; } }; };
  const doLogin = (email, password) => login(req('auth/login', 'POST', { email, password }));

  await t.test('the request answers identically for a registered and an unknown address', async () => {
    const owner = await mkUser('known');
    const ip = caller();
    const known = await forgotPassword(req('auth/forgot-password', 'POST', { email: owner.email }, '', ip));
    const notKnown = await forgotPassword(req('auth/forgot-password', 'POST', { email: `nobody-${randomUUID()}@example.com` }, '', ip));
    assert.equal(known.status, 200);
    assert.equal(notKnown.status, 200);
    const knownBody = await known.json(), notKnownBody = await notKnown.json();
    assert.deepEqual(knownBody, notKnownBody, 'the response must not depend on the account');
    assert.equal(knownBody.message, GENERIC);
    assert.equal(RESET_REQUEST_ANSWER, GENERIC);
    const body = JSON.stringify(knownBody);
    for (const leak of ['known-', 'nobody', '"sent"', '"user', '"token', '"exists"'])
      assert.ok(!body.includes(leak), `the answer never mentions "${leak}": ${body}`);
  });

  await t.test('malformed addresses are refused, and cross-site requests are blocked', async () => {
    for (const bad of ['not-an-email', '', 'no@', 42, null]) {
      const response = await forgotPassword(req('auth/forgot-password', 'POST', { email: bad }));
      assert.equal(response.status, 400, `${JSON.stringify(bad)} is refused`);
      assert.equal((await response.json()).error, 'invalid_email');
    }
    const owner = await mkUser('origin');
    const foreign = await forgotPassword(req('auth/forgot-password', 'POST', { email: owner.email }, '', caller(), 'https://evil.example'));
    assert.equal(foreign.status, 403, 'cross-site requests are blocked');
    assert.equal(await db.passwordReset.count({ where: { userId: owner.user.id } }), 0, 'nothing was minted');
  });

  await t.test('the emailed link uses the app URL, is single use, expiring, and stored only as a hash', async () => {
    const owner = await mkUser('link');
    const { sent, send } = capture();
    const result = await requestPasswordReset(owner.email, new Date(), send);
    assert.equal(result.sent, true);
    assert.equal(sent.length, 1, 'exactly one mail per request');
    assert.equal(sent[0].to, owner.email);
    assert.equal(sent[0].subject, 'Reset your LeadMelo password');
    assert.ok(sent[0].text.includes(`${process.env.APP_URL}/auth/reset?token=`), 'the link uses the configured app URL');
    assert.ok(sent[0].text.includes(`${process.env.APP_URL}/auth/signin`), 'the mail points back at sign in');
    assert.ok(!sent[0].text.includes(strong) && !sent[0].text.includes(fresh), 'no password ever appears in the email');
    const link = linkIn(sent[0].text);
    assert.match(link, /^[a-f0-9]{64}$/, 'the token is 256 bits of hex');
    const stored = await db.passwordReset.findFirst({ where: { userId: owner.user.id, usedAt: null } });
    assert.ok(stored, 'a reset row exists');
    assert.notEqual(stored.tokenHash, link, 'only the token hash is stored');
    const ttl = stored.expiresAt.getTime() - Date.now();
    assert.ok(ttl > 55 * 60000 && ttl <= 60 * 60000, `the link expires in about an hour, got ${ttl}ms`);
    assert.equal(await resetLinkState(link), 'valid');
    assert.equal(await resetLinkState('x'.repeat(64)), 'invalid');
    assert.equal(await resetLinkState('not-a-token'), 'invalid');
    assert.equal(await db.auditEvent.count({ where: { tenantId: tenant.id, actorUserId: owner.user.id, action: 'password_reset_requested' } }), 1, 'the request is audited');
  });

  await t.test('a second request supersedes the first link', async () => {
    const owner = await mkUser('supersede');
    const tokens = [];
    for (let i = 0; i < 2; i++) await requestPasswordReset(owner.email, new Date(), async (to, subject, text) => { tokens.push(linkIn(text)); return true; });
    assert.notEqual(tokens[0], tokens[1]);
    assert.equal(await resetLinkState(tokens[0]), 'invalid', 'the earlier link is spent');
    assert.equal(await resetLinkState(tokens[1]), 'valid');
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: tokens[0], password: fresh }))).status, 400, 'and is refused by the reset endpoint');
    assert.equal(await db.user.count({ where: { id: owner.user.id } }), 1);
    owner.pendingToken = tokens[1];
  });

  await t.test('the new password signs in, the old one is rejected, and open sessions are revoked', async () => {
    const owner = await mkUser('signin');
    let link = '';
    await requestPasswordReset(owner.email, new Date(), async (to, subject, text) => { link = linkIn(text); return true; });
    const open = await db.passwordReset.findFirstOrThrow({ where: { userId: owner.user.id, usedAt: null } });
    assert.match(link, /^[a-f0-9]{64}$/);

    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: link, password: 'short' }))).status, 400, 'the password policy still applies');
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: link, password: '           ' }))).status, 400, 'a blank password is refused');
    assert.equal(await db.session.count({ where: { userId: owner.user.id } }), 0, 'a rejected attempt changed nothing');
    assert.equal((await doLogin(owner.email, strong)).status, 200, 'the old password still works before the reset');
    // Sign in first: logging in replaces any earlier session for this account.
    const cookie = `${sessionCookie}=${await createSession(owner.user.id)}`;
    assert.equal(await db.session.count({ where: { userId: owner.user.id } }), 1, 'nothing changed while the link was unused');
    assert.equal((await listInvites(req('invites', 'GET', undefined, cookie))).status, 200, 'the session works before the reset');

    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: link, password: fresh }))).status, 200);
    assert.equal(await db.session.count({ where: { userId: owner.user.id } }), 0, 'every session is invalidated');
    assert.equal((await listInvites(req('invites', 'GET', undefined, cookie))).status, 401, 'the old session cookie stops working');
    assert.equal((await doLogin(owner.email, strong)).status, 401, 'the old password is rejected');
    assert.equal((await doLogin(owner.email, fresh)).status, 200, 'the new password signs in');

    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: link, password: 'yet-another-pass-9' }))).status, 400, 'the link cannot be replayed');
    assert.equal(await resetLinkState(link), 'invalid');
    assert.equal((await doLogin(owner.email, fresh)).status, 200, 'a replayed link did not change the password');
    assert.ok(open.expiresAt > new Date(), 'the consumed row keeps its original expiry');
  });

  await t.test('expired and unknown links are refused', async () => {
    const owner = await mkUser('expired');
    let link = '';
    await requestPasswordReset(owner.email, new Date(), async (to, subject, text) => { link = linkIn(text); return true; });
    await db.passwordReset.updateMany({ where: { userId: owner.user.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await resetLinkState(link), 'invalid');
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: link, password: fresh }))).status, 400);
    assert.equal((await doLogin(owner.email, strong)).status, 200, 'an expired link leaves the password untouched');
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: 'f'.repeat(64), password: fresh }))).status, 400, 'an unknown token is refused');
  });

  await t.test('every registered account is covered: a passwordless one gets its first password', async () => {
    // Provisioned but never finished onboarding: passwordHash is null, so it cannot sign in
    // yet. It must still be able to recover through "Forgot password?" on its own.
    const pending = await mkUser('pending', { passwordHash: null });
    const { sent, send } = capture();
    assert.deepEqual(await requestPasswordReset(pending.email, new Date(), send), { ok: true, sent: true }, 'the link is sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, pending.email);
    assert.match(sent[0].text, /is ready/, 'a first-time account is told to set its password');
    assert.ok(sent[0].text.includes(`${process.env.APP_URL}/auth/reset?token=`), 'the link uses the app URL');
    const link = linkIn(sent[0].text);
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: link, password: fresh }))).status, 200, 'the link sets the first password');
    assert.equal((await doLogin(pending.email, fresh)).status, 200, 'and the account can then sign in');
    assert.ok((await db.user.findUniqueOrThrow({ where: { id: pending.user.id } })).passwordHash, 'a password now exists');
  });

  await t.test('a disabled account is never mailed and answers like an unknown address', async () => {
    const disabled = await mkUser('off', { disabled: true });
    const { sent, send } = capture();
    assert.deepEqual(await requestPasswordReset(disabled.email, new Date(), send), { ok: true, sent: false });
    assert.deepEqual(sent, [], 'a deprovisioned account is not emailed');
    assert.equal(await db.passwordReset.count({ where: { userId: disabled.user.id } }), 0, 'no reset token is minted for it');
  });

  await t.test('a delivery failure is swallowed and never becomes an account hint', async () => {
    const owner = await mkUser('undelivered');
    const ip = caller();
    await requestPasswordReset(owner.email, new Date(), async () => false);
    await requestPasswordReset(owner.email, new Date(), async () => { throw new Error('m365_unreachable'); });
    assert.equal(await db.auditEvent.count({ where: { tenantId: tenant.id, action: 'password_reset_email_failed' } }) > 0, true, 'the failure is recorded');
    const response = await forgotPassword(req('auth/forgot-password', 'POST', { email: owner.email }, '', ip));
    assert.equal(response.status, 200, 'the endpoint still answers normally');
    assert.equal((await response.json()).message, GENERIC, 'a delivery failure is never reported as such');
  });

  await t.test('requests are rate limited per address and per caller', async () => {
    const owner = await mkUser('limited');
    const ip = caller();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await forgotPassword(req('auth/forgot-password', 'POST', { email: owner.email }, '', ip))).status);
    assert.deepEqual(statuses, [200, 200, 200, 429], 'the fourth request for one address is refused');
    assert.equal((await (await forgotPassword(req('auth/forgot-password', 'POST', { email: owner.email }, '', ip))).json()).error, 'rate_limit_exceeded');
    // The per-address budget is enforced before the lookup, so an unknown address is
    // throttled identically and cannot be used as an existence oracle.
    const other = caller();
    const stranger = `nolimit-${randomUUID()}@example.com`;
    const unknown = [];
    for (let i = 0; i < 4; i++) unknown.push((await forgotPassword(req('auth/forgot-password', 'POST', { email: stranger }, '', other))).status);
    assert.deepEqual(unknown, statuses, 'an unknown address is throttled in exactly the same way');
    // And the per-caller budget still applies on its own.
    const burst = caller();
    const burstStatuses = [];
    for (let i = 0; i < 7; i++) burstStatuses.push((await forgotPassword(req('auth/forgot-password', 'POST', { email: `burst-${randomUUID()}@example.com` }, '', burst))).status);
    assert.equal(burstStatuses.filter(s => s === 200).length, 5, 'a single caller gets five requests an hour');
    assert.ok(burstStatuses.slice(5).every(s => s === 429));
  });

  await t.test('no password, token or credential is logged', async () => {
    const owner = await mkUser('quiet');
    const lines = [];
    const originalLog = console.log, originalError = console.error;
    console.log = (...a) => lines.push(a.map(String).join(' '));
    console.error = (...a) => lines.push(a.map(String).join(' '));
    let link = '';
    try {
      await requestPasswordReset(owner.email, new Date(), async (to, subject, text) => { link = linkIn(text); return true; });
      await resetPassword(req('auth/reset', 'POST', { token: link, password: fresh }));
      await forgotPassword(req('auth/forgot-password', 'POST', { email: owner.email }));
      await requestPasswordReset(owner.email, new Date(), async () => { throw new Error('m365_unreachable'); });
    } finally {
      console.log = originalLog; console.error = originalError;
    }
    const joined = lines.join('\n');
    for (const secret of [fresh, strong, link]) assert.ok(secret && !joined.includes(secret), `nothing sensitive was logged: ${joined.slice(0, 300)}`);
  });
});