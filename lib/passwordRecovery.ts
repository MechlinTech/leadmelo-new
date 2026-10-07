import { z } from 'zod';
import { db } from './db';
import { rateLimit } from './auth';
import { HttpError } from './http';
import { hashToken } from './security';
import { issueResetLink } from './identity';
import { sendPlatformNotice } from './m365/send';

// Self-service password recovery: the sign-in page's "Forgot password?" link.
//
// Two rules drive the whole module. The answer never depends on whether an account
// exists, and no password, token or credential is ever logged.

// The only answer this flow gives for a well-formed address, registered or not.
export const RESET_REQUEST_ANSWER = 'If an account exists for this email address, you’ll receive a password-reset link shortly.';

// Per-address budget, applied before the account lookup so an unknown address and a
// registered one are throttled identically (and neither is distinguishable).
export const RESET_REQUESTS_PER_ADDRESS = 3;
// Per-caller and installation-wide budgets, enforced by the endpoint.
export const RESET_REQUESTS_PER_CALLER = 5;
export const RESET_REQUESTS_TOTAL = 100;

export const resetRequestEmail = z.string().trim().toLowerCase().email().max(254);

// Shape check only, so the endpoint can reject a malformed address before it spends a
// rate-limit write. It says nothing about whether the account exists.
export function requireResetEmail(rawEmail: unknown) {
  const parsed = resetRequestEmail.safeParse(typeof rawEmail === 'string' ? rawEmail.trim() : rawEmail);
  if (!parsed.success) throw new HttpError(400, 'invalid_email');
  return parsed.data;
}

function passwordResetEmail(email: string, resetUrl: string) {
  return `A password reset was requested for your LeadMelo account (${email}).\n\nSet a new password here (single use, expires in 1 hour):\n${resetUrl}\n\nLeadMelo sign-in page: ${process.env.APP_URL}/auth/signin\n\nIf you did not ask for this, ignore this email: nothing changes until you open the link. Sign in keeps working until then. Never share this link, and never send your password to anyone.`;
}

// Requests a reset link. `send` is injectable so tests can observe the delivery
// without touching the Microsoft 365 transport.
//
// Returns the same shape for every address. A delivery failure is recorded and
// swallowed rather than reported, because a 502 here would tell an attacker that the
// address is registered.
export async function requestPasswordReset(rawEmail: unknown, now = new Date(), send: typeof sendPlatformNotice = sendPlatformNotice) {
  const email = requireResetEmail(rawEmail);
  await rateLimit(`password-reset-request:email:${hashToken(email)}`, RESET_REQUESTS_PER_ADDRESS, 60);

  const user = await db.user.findUnique({ where: { email }, select: { id: true, tenantId: true, disabled: true, passwordHash: true } });
  // No account, a disabled account, or one that never set a password (it still uses the
  // onboarding setup email). All three answer exactly like an unknown address.
  if (!user || user.disabled || !user.passwordHash) return { ok: true as const, sent: false };

  // A fresh link supersedes the previous unused one, so at most one link is ever valid.
  const { resetUrl, expiresAt } = await issueResetLink(user.id, now);
  try {
    const sent = await send(email, 'Reset your LeadMelo password', passwordResetEmail(email, resetUrl));
    if (!sent) await recordFailure(user, 'm365_not_connected', now);
    else if (user.tenantId) await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'password_reset_requested', entityId: user.id, metadata: { expiresAt: expiresAt.toISOString() } } });
    return { ok: true as const, sent: Boolean(sent) };
  } catch (error) {
    // Never the token, never the password: only a truncated provider reason.
    await recordFailure(user, error instanceof Error ? error.message.slice(0, 120) : 'send_failed', now);
    return { ok: true as const, sent: false };
  }
}

async function recordFailure(user: { id: string; tenantId: string | null }, reason: string, now: Date) {
  if (!user.tenantId) return;
  await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'password_reset_email_failed', entityId: user.id, metadata: { reason, at: now.toISOString() } } });
}

// Read-only: what the reset-password page needs to tell an expired, already used or
// unknown link apart from a good one. Returns a state, never the account or the token.
export async function resetLinkState(token: string, now = new Date()): Promise<'valid' | 'invalid'> {
  if (!/^[a-f0-9]{64}$/.test(token)) return 'invalid';
  const reset = await db.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, select: { usedAt: true, expiresAt: true, user: { select: { disabled: true } } } });
  if (!reset || reset.usedAt || reset.expiresAt <= now || reset.user.disabled) return 'invalid';
  return 'valid';
}