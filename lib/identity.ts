import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from './db';
import { HttpError } from './http';
import { hashToken } from './security';
import { hashPassword, verifyPassword, encrypt, decrypt } from './crypto';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp';
import { assertCanAddSeat } from './entitlements';

export const passwordSchema = z.string().min(12).max(256);
export const INVITE_ROLES = ['TENANT_ADMIN', 'MANAGER', 'MEMBER'] as const;
const isAdmin = (role: string) => role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';
const newToken = () => randomBytes(32).toString('hex');

type Actor = { id: string; tenantId: string; role: string };

// Invitations and resets return a one-time token to the administrator: the platform has no
// mail service configured, so delivery is the administrator's responsibility.
export async function createInvite(actor: Actor, email: string, role: (typeof INVITE_ROLES)[number], now = new Date()) {
  if (!isAdmin(actor.role)) throw new HttpError(403, 'admin_required');
  if (role === 'TENANT_ADMIN' && actor.role !== 'TENANT_ADMIN' && actor.role !== 'SUPER_ADMIN') throw new HttpError(403, 'admin_required');
  email = email.trim().toLowerCase();
  if (await db.user.findUnique({ where: { email }, select: { id: true } })) throw new HttpError(409, 'user_exists');
  await assertCanAddSeat(actor.tenantId);
  const token = newToken();
  await db.$transaction(async tx => {
    await tx.invite.updateMany({ where: { tenantId: actor.tenantId, email, acceptedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
    await tx.invite.create({ data: { tenantId: actor.tenantId, email, role, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + 72 * 3600000) } });
    await tx.auditEvent.create({ data: { tenantId: actor.tenantId, actorUserId: actor.id, action: 'invite_created', metadata: { role } } });
  });
  return { token, expiresAt: new Date(now.getTime() + 72 * 3600000) };
}
export async function revokeInvite(actor: Actor, id: string, now = new Date()) {
  if (!isAdmin(actor.role)) throw new HttpError(403, 'admin_required');
  const r = await db.invite.updateMany({ where: { id, tenantId: actor.tenantId, acceptedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
  if (!r.count) throw new HttpError(404, 'invite_not_found');
  await db.auditEvent.create({ data: { tenantId: actor.tenantId, actorUserId: actor.id, action: 'invite_revoked', entityId: id } });
}
export async function listInvites(tenantId: string, now = new Date()) {
  return db.invite.findMany({ where: { tenantId, acceptedAt: null, expiresAt: { gt: now } }, select: { id: true, email: true, role: true, expiresAt: true }, orderBy: { expiresAt: 'desc' }, take: 100 });
}
// Never links to an existing account: an invite for an email that already has a user fails.
export async function acceptInvite(token: string, password: string, name: string | undefined, now = new Date()) {
  const invite = await db.invite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invite || invite.acceptedAt || invite.expiresAt <= now) throw new HttpError(400, 'invalid_invite');
  const passwordHash = hashPassword(password);
  return db.$transaction(async tx => {
    const claimed = await tx.invite.updateMany({ where: { id: invite.id, acceptedAt: null, expiresAt: { gt: now } }, data: { acceptedAt: now } });
    if (!claimed.count) throw new HttpError(400, 'invalid_invite');
    if (await tx.user.findUnique({ where: { email: invite.email }, select: { id: true } })) throw new HttpError(409, 'user_exists');
    const user = await tx.user.create({ data: { email: invite.email, name: name?.trim() || null, role: invite.role, tenantId: invite.tenantId, passwordHash } });
    await tx.auditEvent.create({ data: { tenantId: invite.tenantId, actorUserId: user.id, action: 'invite_accepted' } });
    return { userId: user.id };
  });
}

export async function createReset(actor: Actor, userId: string, now = new Date()) {
  if (!isAdmin(actor.role)) throw new HttpError(403, 'admin_required');
  const target = await db.user.findFirst({ where: { id: userId, tenantId: actor.tenantId } });
  if (!target || (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN')) throw new HttpError(404, 'user_not_found');
  const token = newToken();
  await db.$transaction(async tx => {
    await tx.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
    await tx.passwordReset.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + 3600000) } });
    await tx.auditEvent.create({ data: { tenantId: actor.tenantId, actorUserId: actor.id, action: 'password_reset_issued', entityId: userId } });
  });
  return { token, expiresAt: new Date(now.getTime() + 3600000) };
}
// Single use. Revokes every existing session; MFA stays enabled.
export async function consumeReset(token: string, password: string, now = new Date()) {
  const reset = await db.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!reset || reset.usedAt || reset.expiresAt <= now || reset.user.disabled) throw new HttpError(400, 'invalid_reset');
  const passwordHash = hashPassword(password);
  await db.$transaction(async tx => {
    const claimed = await tx.passwordReset.updateMany({ where: { id: reset.id, usedAt: null }, data: { usedAt: now } });
    if (!claimed.count) throw new HttpError(400, 'invalid_reset');
    await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: reset.userId } });
    if (reset.user.tenantId) await tx.auditEvent.create({ data: { tenantId: reset.user.tenantId, actorUserId: reset.userId, action: 'password_reset_completed' } });
  });
}

// ---- TOTP MFA ----
export async function setupMfa(userId: string, email: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.mfaEnabledAt) throw new HttpError(409, 'mfa_already_enabled');
  const secret = newTotpSecret();
  await db.user.update({ where: { id: userId }, data: { totpSecret: encrypt(secret), totpLastStep: null } });
  return { secret, otpauthUri: otpauthUri(email, secret) };
}
export async function enableMfa(userId: string, code: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.mfaEnabledAt) throw new HttpError(409, 'mfa_already_enabled');
  if (!user.totpSecret) throw new HttpError(409, 'mfa_setup_required');
  const step = verifyTotp(decrypt(user.totpSecret), code, null);
  if (step === null) throw new HttpError(400, 'invalid_code');
  const codes = Array.from({ length: 8 }, () => { const h = randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
  await db.user.update({ where: { id: userId }, data: { mfaEnabledAt: new Date(), totpLastStep: step, recoveryHashes: codes.map(c => hashToken(c)) } });
  if (user.tenantId) await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: userId, action: 'mfa_enabled' } });
  return { recoveryCodes: codes };
}
// Consumes a TOTP step or a recovery code atomically so neither can be replayed.
export async function verifyMfaCode(user: { id: string; totpSecret: string | null; totpLastStep: number | null }, code: string): Promise<boolean> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    if (!user.totpSecret) return false;
    const step = verifyTotp(decrypt(user.totpSecret), trimmed, user.totpLastStep);
    if (step === null) return false;
    const r = await db.user.updateMany({ where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
    return r.count === 1;
  }
  const hash = hashToken(trimmed.toLowerCase());
  const removed = await db.$executeRaw`UPDATE "User" SET "recoveryHashes"=array_remove("recoveryHashes", ${hash}) WHERE id=${user.id} AND ${hash}=ANY("recoveryHashes")`;
  return removed === 1;
}
export async function disableMfa(userId: string, password: string, code: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaEnabledAt) throw new HttpError(409, 'mfa_not_enabled');
  if (!user.passwordHash || !verifyPassword(password, user.passwordHash) || !await verifyMfaCode(user, code)) throw new HttpError(401, 'invalid_credentials');
  await db.user.update({ where: { id: userId }, data: { mfaEnabledAt: null, totpSecret: null, totpLastStep: null, recoveryHashes: [] } });
  if (user.tenantId) await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: userId, action: 'mfa_disabled' } });
}
