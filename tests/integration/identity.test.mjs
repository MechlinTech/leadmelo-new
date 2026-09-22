import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { hashPassword } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { hotp, base32Decode, totpStep } from '../../lib/totp.ts';
import { GET as listInvites, POST as createInvite, DELETE as revokeInvite } from '../../app/api/invites/route.ts';
import { POST as acceptInvite } from '../../app/api/invites/accept/route.ts';
import { POST as login } from '../../app/api/auth/login/route.ts';
import { POST as resetPassword } from '../../app/api/auth/reset/route.ts';
import { POST as issueReset } from '../../app/api/users/[id]/reset/route.ts';
import { POST as mfaSetup } from '../../app/api/auth/mfa/setup/route.ts';
import { POST as mfaEnable } from '../../app/api/auth/mfa/enable/route.ts';
import { POST as mfaDisable } from '../../app/api/auth/mfa/disable/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';

const strong = 'a-long-test-password-1';
test('invitations, MFA and password reset', async t => {
  const mkTenant = async (name, role = 'TENANT_ADMIN') => {
    const email = `${name}-${randomUUID()}@example.com`;
    const tenant = await db.tenant.create({ data: { name, slug: `${name}-${randomUUID()}`, users: { create: { email, role, passwordHash: hashPassword(strong) } } }, include: { users: true } });
    return { tenant, user: tenant.users[0], email, cookie: `${sessionCookie}=${await createSession(tenant.users[0].id)}` };
  };
  const A = await mkTenant('ia'), B = await mkTenant('ib');
  const member = await db.user.create({ data: { tenantId: A.tenant.id, email: `m-${randomUUID()}@example.com`, role: 'MEMBER', passwordHash: hashPassword(strong) } });
  const manager = await db.user.create({ data: { tenantId: A.tenant.id, email: `mg-${randomUUID()}@example.com`, role: 'MANAGER', passwordHash: hashPassword(strong) } });
  const memberCookie = `${sessionCookie}=${await createSession(member.id)}`, managerCookie = `${sessionCookie}=${await createSession(manager.id)}`;
  const req = (path, method, body, cookie = '') => new Request(`http://localhost:3000/api/${path}`, { method, headers: { cookie, origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const params = id => ({ params: Promise.resolve({ id }) });
  const tokenOf = url => new URL(url).searchParams.get('token');
  const doLogin = (email, password, code) => login(req('auth/login', 'POST', { email, password, ...(code ? { code } : {}) }));

  await t.test('only tenant admins invite; roles are limited; existing users are never linked', async () => {
    const body = { email: `new-${randomUUID()}@example.com`, role: 'MEMBER' };
    assert.equal((await createInvite(req('invites', 'POST', body, memberCookie))).status, 403);
    assert.equal((await createInvite(req('invites', 'POST', body, managerCookie))).status, 403);
    assert.equal((await createInvite(req('invites', 'POST', { ...body, role: 'SUPER_ADMIN' }, A.cookie))).status, 400);
    assert.equal((await createInvite(req('invites', 'POST', { ...body, email: B.email }, A.cookie))).status, 409, 'email owned by another tenant is not linked');
    assert.equal((await createInvite(req('invites', 'POST', body, ''))).status, 401);
    assert.equal((await createInvite(req('invites', 'POST', body, A.cookie))).status, 201);
    assert.equal((await (await listInvites(req('invites', 'GET', undefined, A.cookie))).json()).length, 1);
    assert.equal((await (await listInvites(req('invites', 'GET', undefined, B.cookie))).json()).length, 0, 'other tenant sees nothing');
  });
  await t.test('accept is single use, expiring, revocable and creates the user in the inviting tenant', async () => {
    const email = `join-${randomUUID()}@example.com`;
    const { acceptUrl } = await (await createInvite(req('invites', 'POST', { email, role: 'MANAGER' }, A.cookie))).json();
    const token = tokenOf(acceptUrl);
    assert.equal((await db.invite.findFirst({ where: { tokenHash: token } })), null, 'raw token is not stored');
    assert.equal((await acceptInvite(req('invites/accept', 'POST', { token, password: 'short' }))).status, 400);
    assert.equal((await acceptInvite(req('invites/accept', 'POST', { token: 'x'.repeat(64), password: strong }))).status, 400);
    assert.equal((await acceptInvite(req('invites/accept', 'POST', { token, password: strong, name: 'Joiner' }))).status, 201);
    const u = await db.user.findUnique({ where: { email } });
    assert.equal(u.tenantId, A.tenant.id); assert.equal(u.role, 'MANAGER');
    assert.equal((await acceptInvite(req('invites/accept', 'POST', { token, password: strong }))).status, 400, 'second use refused');
    assert.equal((await doLogin(email, strong)).status, 200);
    // expired
    const e2 = `exp-${randomUUID()}@example.com`;
    const t2 = tokenOf((await (await createInvite(req('invites', 'POST', { email: e2, role: 'MEMBER' }, A.cookie))).json()).acceptUrl);
    await db.invite.updateMany({ where: { email: e2 }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await acceptInvite(req('invites/accept', 'POST', { token: t2, password: strong }))).status, 400);
    // revoked, and re-inviting supersedes the earlier link
    const e3 = `rev-${randomUUID()}@example.com`;
    const t3 = tokenOf((await (await createInvite(req('invites', 'POST', { email: e3, role: 'MEMBER' }, A.cookie))).json()).acceptUrl);
    const t3b = tokenOf((await (await createInvite(req('invites', 'POST', { email: e3, role: 'MEMBER' }, A.cookie))).json()).acceptUrl);
    assert.equal((await acceptInvite(req('invites/accept', 'POST', { token: t3, password: strong }))).status, 400, 'older link superseded');
    const open = await db.invite.findFirst({ where: { email: e3, acceptedAt: null, expiresAt: { gt: new Date() } } });
    assert.equal((await revokeInvite(req(`invites?id=${open.id}`, 'DELETE', undefined, B.cookie))).status, 404, 'other tenant cannot revoke');
    assert.equal((await revokeInvite(req(`invites?id=${open.id}`, 'DELETE', undefined, A.cookie))).status, 200);
    assert.equal((await acceptInvite(req('invites/accept', 'POST', { token: t3b, password: strong }))).status, 400, 'revoked link refused');
  });
  await t.test('MFA: enrolment, login enforcement, replay protection, single-use recovery codes, disable', async () => {
    const u = await mkTenant('mfa');
    const setup = await (await mfaSetup(req('auth/mfa/setup', 'POST', {}, u.cookie))).json();
    assert.match(setup.otpauthUri, /^otpauth:\/\/totp\//);
    const secret = base32Decode(setup.secret), S = totpStep();
    assert.notEqual((await db.user.findUnique({ where: { id: u.user.id } })).totpSecret, setup.secret, 'secret stored encrypted');
    assert.equal((await doLogin(u.email, strong)).status, 200, 'MFA not yet active until confirmed');
    assert.equal((await mfaEnable(req('auth/mfa/enable', 'POST', { code: '000000' }, u.cookie))).status, 400);
    const enabled = await mfaEnable(req('auth/mfa/enable', 'POST', { code: hotp(secret, S) }, u.cookie));
    assert.equal(enabled.status, 200);
    const { recoveryCodes } = await enabled.json();
    assert.equal(recoveryCodes.length, 8);
    assert.ok(!(await db.user.findUnique({ where: { id: u.user.id } })).recoveryHashes.includes(recoveryCodes[0]), 'recovery codes stored hashed');
    assert.equal((await mfaSetup(req('auth/mfa/setup', 'POST', {}, u.cookie))).status, 409, 'cannot silently re-seed an enabled factor');

    const missing = await doLogin(u.email, strong);
    assert.equal(missing.status, 401); assert.equal((await missing.json()).error, 'mfa_required');
    assert.equal((await doLogin(u.email, 'wrong-password-123', hotp(secret, S + 1))).status, 401);
    assert.equal((await doLogin(u.email, strong, '111111')).status, 401);
    assert.equal((await doLogin(u.email, strong, hotp(secret, S))).status, 401, 'enrolment code cannot be reused');
    const code = hotp(secret, S + 1);
    const ok = await doLogin(u.email, strong, code);
    assert.equal(ok.status, 200); assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await doLogin(u.email, strong, code)).status, 401, 'TOTP replay refused');
    assert.equal((await doLogin(u.email, strong, recoveryCodes[0])).status, 200);
    assert.equal((await doLogin(u.email, strong, recoveryCodes[0])).status, 401, 'recovery code is single use');
    assert.equal((await mfaDisable(req('auth/mfa/disable', 'POST', { password: 'wrong-password-123', code: recoveryCodes[1] }, u.cookie))).status, 401);
    assert.equal((await mfaDisable(req('auth/mfa/disable', 'POST', { password: strong, code: recoveryCodes[1] }, u.cookie))).status, 200);
    assert.equal((await doLogin(u.email, strong)).status, 200, 'login works without a code once disabled');
    assert.equal((await db.auditEvent.count({ where: { tenantId: u.tenant.id, action: { in: ['mfa_enabled', 'mfa_disabled'] } } })), 2);
  });
  await t.test('admin-issued password reset: scoped, single use, expiring, revokes sessions', async () => {
    const victim = await mkTenant('rv', 'MEMBER');
    const other = await mkTenant('ro');
    assert.equal((await issueReset(req('x', 'POST', {}, victim.cookie), params(victim.user.id))).status, 403, 'members cannot issue resets');
    assert.equal((await issueReset(req('x', 'POST', {}, other.cookie), params(victim.user.id))).status, 404, 'other tenant admin cannot reset');
    // A tenant admin inside the same tenant as the victim.
    const target = await db.user.create({ data: { tenantId: A.tenant.id, email: `t-${randomUUID()}@example.com`, role: 'MEMBER', passwordHash: hashPassword(strong) } });
    const targetCookie = `${sessionCookie}=${await createSession(target.id)}`;
    assert.equal((await listInvites(req('invites', 'GET', undefined, targetCookie))).status, 200);
    const first = tokenOf((await (await issueReset(req('x', 'POST', {}, A.cookie), params(target.id))).json()).resetUrl);
    const second = tokenOf((await (await issueReset(req('x', 'POST', {}, A.cookie), params(target.id))).json()).resetUrl);
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: first, password: 'new-long-password-9' }))).status, 400, 'earlier reset superseded');
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: second, password: 'short' }))).status, 400);
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: second, password: 'new-long-password-9' }))).status, 200);
    assert.equal((await listInvites(req('invites', 'GET', undefined, targetCookie))).status, 401, 'existing sessions revoked');
    assert.equal((await doLogin(target.email, strong)).status, 401, 'old password no longer works');
    assert.equal((await doLogin(target.email, 'new-long-password-9')).status, 200);
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: second, password: 'another-long-pass-1' }))).status, 400, 'single use');
    const third = tokenOf((await (await issueReset(req('x', 'POST', {}, A.cookie), params(target.id))).json()).resetUrl);
    await db.passwordReset.updateMany({ where: { usedAt: null, userId: target.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await resetPassword(req('auth/reset', 'POST', { token: third, password: 'another-long-pass-1' }))).status, 400, 'expired');
  });
});
