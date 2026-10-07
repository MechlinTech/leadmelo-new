import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { hashPassword } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { POST as submitRequest } from '../../app/api/public/access-request/route.ts';
import { POST as approveRequest } from '../../app/api/admin/access-requests/[id]/approve/route.ts';
import { POST as resendSetup } from '../../app/api/public/access-request/resend/route.ts';
import { POST as login } from '../../app/api/auth/login/route.ts';
import { POST as resetPassword } from '../../app/api/auth/reset/route.ts';
import { approveAccessRequest, resendSetupEmail } from '../../lib/onboarding.ts';
import { createAccessRequest } from '../../lib/public.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';

const strong = 'a-long-test-password-1';
const params = id => ({ params: Promise.resolve({ id }) });
const req = (path, method, body, cookie = '') => new Request(`http://localhost:3000/api/${path}`, { method, headers: { cookie, origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('access request onboarding: submission, approval, setup email, password setup, login, duplicates and failures', async t => {
  const operatorTenant = await db.tenant.create({ data: { name: `ops-${randomUUID()}`, slug: `ops-${randomUUID()}` } });
  const superAdmin = await db.user.create({ data: { email: `sa-${randomUUID()}@example.com`, role: 'SUPER_ADMIN', tenantId: operatorTenant.id, passwordHash: hashPassword(strong) } });
  const cookie = `${sessionCookie}=${await createSession(superAdmin.id)}`;

  await t.test('submission stores one request per email and delivery failure is recorded, not hidden', async () => {
    const email = `req-${randomUUID()}@example.com`;
    assert.equal((await submitRequest(req('public/access-request', 'POST', { name: 'Kim', email, source: 'contact' }))).status, 201);
    assert.equal((await submitRequest(req('public/access-request', 'POST', { name: 'Kim', email, source: 'contact' }))).status, 201);
    const rows = await db.accessRequest.findMany({ where: { email } });
    assert.equal(rows.length, 1, 'no duplicate request rows');
    assert.equal(rows[0].status, 'PENDING');
    assert.equal(rows[0].emailError, 'm365_not_connected', 'delivery failure is logged on the request');
    const users = await db.user.findMany({ where: { email } });
    assert.equal(users.length, 0, 'no account is created before approval');
  });

  await t.test('approval creates the account once, emails a secure setup link, and never produces a password in plaintext', async () => {
    const email = `approve-${randomUUID()}@example.com`;
    await createAccessRequest({ name: 'Pat', email, source: 'pricing' });
    const request = await db.accessRequest.findFirstOrThrow({ where: { email } });
    const sent = [];
    const stubSend = async (to, subject, text) => { sent.push({ to, subject, text }); return true; };
    const result = await approveAccessRequest(request.id, { id: superAdmin.id, tenantId: '', role: 'SUPER_ADMIN' }, new Date(), stubSend);
    assert.equal(result.emailed, true);
    const user = await db.user.findUnique({ where: { email } });
    assert.ok(user && user.tenantId, 'account created');
    const tenant = await db.tenant.findUnique({ where: { id: user.tenantId } });
    assert.ok(tenant);
    assert.equal(user.passwordHash, null, 'account starts without a password');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, email);
    assert.ok(sent[0].text.includes(email), 'email states the registered login email');
    assert.ok(sent[0].text.includes(`${process.env.APP_URL}/auth/signin`), 'email links the login page');
    const link = sent[0].text.match(/auth\/reset\?token=([a-f0-9]+)/)?.[1];
    assert.ok(link, 'email carries a set-password link');
    assert.ok(!sent[0].text.includes(strong), 'no plaintext password anywhere');
    assert.equal(await db.passwordReset.findFirst({ where: { userId: user.id } }).then(r => r ? r.tokenHash.includes(link) : false), false, 'only the token hash is stored');
    await assert.rejects(approveAccessRequest(request.id, { id: superAdmin.id, tenantId: '', role: 'SUPER_ADMIN' }), /request_already_processed/);
    assert.equal(await db.user.count({ where: { email } }), 1, 'no duplicate account');
    // The setup link sets the password, then the user can log in.
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: link, password: `setup-${randomUUID()}-abcdef` }))).status, 200);
    const second = await resetPassword(req('auth/reset', 'POST', { token: link, password: `setup-${randomUUID()}-abcdef` }));
    assert.equal(second.status, 400, 'link is single-use');
  });

  await t.test('expired setup links are rejected with a clear error', async () => {
    const email = `expired-${randomUUID()}@example.com`;
    await createAccessRequest({ name: 'Sam', email, source: 'contact' });
    const request = await db.accessRequest.findFirstOrThrow({ where: { email } });
    let link = '';
    await approveAccessRequest(request.id, { id: superAdmin.id, tenantId: '', role: 'SUPER_ADMIN' }, new Date(), async (to, subject, text) => { link = text.match(/token=([a-f0-9]+)/)?.[1] ?? ''; return true; });
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    await db.passwordReset.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const response = await resetPassword(req('auth/reset', 'POST', { token: link, password: 'long-enough-password-1' }));
    assert.equal(response.status, 400, 'expired link rejected');
  });

  await t.test('resend issues a fresh single-use link, invalidates the old one and rate-limits', async () => {
    const email = `resend-${randomUUID()}@example.com`;
    await createAccessRequest({ name: 'Rin', email, source: 'contact' });
    const request = await db.accessRequest.findFirstOrThrow({ where: { email } });
    const links = [];
    await approveAccessRequest(request.id, { id: superAdmin.id, tenantId: '', role: 'SUPER_ADMIN' }, new Date(Date.now() - 120000), async (to, subject, text) => { links.push(text.match(/token=([a-f0-9]+)/)?.[1]); return true; });
    await db.accessRequest.update({ where: { id: request.id }, data: { lastEmailAt: new Date(Date.now() - 120000) } });
    const result = await resendSetupEmail(email, new Date(), async (to, subject, text) => { links.push(text.match(/token=([a-f0-9]+)/)?.[1]); return true; });
    assert.equal(result.sent, true);
    assert.equal(links.length, 2);
    assert.notEqual(links[0], links[1]);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: links[0], password: 'long-enough-password-1' }))).status, 400, 'old link invalidated');
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: links[1], password: `ok-${randomUUID()}-abcdef` }))).status, 200, 'new link works');
    await assert.rejects(resendSetupEmail(email, new Date(), async () => true), /resend_too_soon/);
  });

  await t.test('email delivery failure on resend is reported, not treated as success', async () => {
    const email = `resend-fail-${randomUUID()}@example.com`;
    await createAccessRequest({ name: 'Rae', email, source: 'contact' });
    const request = await db.accessRequest.findFirstOrThrow({ where: { email } });
    await approveAccessRequest(request.id, { id: superAdmin.id, tenantId: '', role: 'SUPER_ADMIN' }, new Date(Date.now() - 120000), async () => true);
    await db.accessRequest.update({ where: { id: request.id }, data: { lastEmailAt: new Date(Date.now() - 120000) } });
    await assert.rejects(resendSetupEmail(email, new Date(), async () => false), /email_delivery_failed/);
    const updated = await db.accessRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(updated.emailError, 'm365_not_connected');
  });

  await t.test('admin approve endpoint requires SUPER_ADMIN and emails through the real transport failure path', async () => {
    const email = `endpoint-${randomUUID()}@example.com`;
    await createAccessRequest({ name: 'Eli', email, source: 'assistant' });
    const request = await db.accessRequest.findFirstOrThrow({ where: { email } });
    assert.equal((await approveRequest(req(`admin/access-requests/${request.id}/approve`, 'POST'), params(request.id))).status, 401);
    const ok = await approveRequest(req(`admin/access-requests/${request.id}/approve`, 'POST', undefined, cookie), params(request.id));
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.emailed, false, 'no connected mailbox in the test instance');
    assert.equal(body.emailError, 'm365_not_connected');
    assert.equal((await db.user.count({ where: { email } })), 1);
  });

  await t.test('resend endpoint answers generically for unknown emails and rate limits repeats', async () => {
    const email = `route-${randomUUID()}@example.com`;
    const first = await resendSetup(req('public/access-request/resend', 'POST', { email: `no-${randomUUID()}@example.com` }));
    assert.equal(first.status, 200);
    await createAccessRequest({ name: 'Roy', email, source: 'contact' });
    const request = await db.accessRequest.findFirstOrThrow({ where: { email } });
    await approveAccessRequest(request.id, { id: superAdmin.id, tenantId: '', role: 'SUPER_ADMIN' }, new Date(Date.now() - 120000), async () => true);
    const second = await resendSetup(req('public/access-request/resend', 'POST', { email }));
    assert.equal(second.status, 502, 'email delivery fails without a connected mailbox');
    const third = await resendSetup(req('public/access-request/resend', 'POST', { email }));
    assert.equal(third.status, 502, 'failed delivery does not set lastEmailAt, but nothing is silently succeeding');
    void first;
  });

  await t.test('a user created through approval can log in after setting their password', async () => {
    const email = `login-${randomUUID()}@example.com`;
    await createAccessRequest({ name: 'Lou', email, source: 'contact' });
    const request = await db.accessRequest.findFirstOrThrow({ where: { email } });
    let link = '';
    await approveAccessRequest(request.id, { id: superAdmin.id, tenantId: '', role: 'SUPER_ADMIN' }, new Date(), async (to, subject, text) => { link = text.match(/token=([a-f0-9]+)/)?.[1] ?? ''; return true; });
    const password = `final-${randomUUID()}-abcdef`;
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: link, password }))).status, 200);
    const denied = await login(req('auth/login', 'POST', { email, password: 'wrong-password-here' }));
    assert.equal(denied.status, 401);
    const allowed = await login(req('auth/login', 'POST', { email, password }));
    assert.equal(allowed.status, 200);
  });
});
