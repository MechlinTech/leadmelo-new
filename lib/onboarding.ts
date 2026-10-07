import { randomBytes } from 'node:crypto';
import { db } from './db';
import { HttpError } from './http';
import { hashToken } from './security';
import { sendPlatformNotice } from './m365/send';
import { PLANS, type PlanId } from './plans';

type Actor = { id: string; tenantId: string; role: string };
const RESET_TTL_MS = 3600000;
const RESEND_COOLDOWN_MS = 60000;

const slugBase = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';

async function issueSetupLink(userId: string, now: Date) {
  const token = randomBytes(32).toString('hex');
  await db.$transaction(async tx => {
    // A fresh link supersedes any earlier unused one, so at most one setup link is valid.
    await tx.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
    await tx.passwordReset.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + RESET_TTL_MS) } });
  });
  return `${process.env.APP_URL}/auth/reset?token=${token}`;
}

function accountReadyEmail(email: string, setPasswordUrl: string) {
  return `Your LeadMelo account is ready.\n\nRegistered login email: ${email}\n\nSet your password here (single use, expires in 1 hour):\n${setPasswordUrl}\n\nLeadMelo login page: ${process.env.APP_URL}/auth/signin\n\nNever share this link, and never send your password to anyone. If the link expired or was already used, request a new setup email from the sign-in page.`;
}

// Grant access: create the workspace and admin account exactly once, then deliver the setup email.
// The raw token only ever travels in the email; the database keeps its hash. No plaintext password.
export async function approveAccessRequest(id: string, actor: Actor, now = new Date(), send: typeof sendPlatformNotice = sendPlatformNotice) {
  if (actor.role !== 'SUPER_ADMIN') throw new HttpError(403, 'super_admin_required');
  const request = await db.accessRequest.findUnique({ where: { id } });
  if (!request) throw new HttpError(404, 'request_not_found');
  if (request.status !== 'PENDING') throw new HttpError(409, 'request_already_processed');
  if (await db.user.findUnique({ where: { email: request.email }, select: { id: true } })) throw new HttpError(409, 'user_exists');
  const plan: PlanId = request.plan && request.plan in PLANS ? (request.plan as PlanId) : 'FREE';
  const base = slugBase(request.company || request.name || request.email.split('@')[0]);
  const payload = await db.$transaction(async tx => {
    // Claim the request atomically so a retried approval cannot create a second account.
    const claimed = await tx.accessRequest.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'APPROVED', handledAt: now } });
    if (!claimed.count) throw new HttpError(409, 'request_already_processed');
    const tenant = await tx.tenant.create({ data: { name: request.company?.trim() || request.name, slug: `${base}-${randomBytes(3).toString('hex')}`, plan } });
    const user = await tx.user.create({ data: { email: request.email, name: request.name, role: 'TENANT_ADMIN', tenantId: tenant.id } });
    await tx.accessRequest.update({ where: { id }, data: { userId: user.id } });
    await tx.auditEvent.create({ data: { tenantId: tenant.id, actorUserId: actor.id, action: 'access_request_approved', entityId: id } });
    return { user, email: user.email };
  });
  const setPasswordUrl = await issueSetupLink(payload.user.id, now);
  let emailed = false;
  let emailError = '';
  try {
    emailed = await send(payload.email, 'Your LeadMelo account is ready', accountReadyEmail(payload.email, setPasswordUrl));
    emailError = emailed ? '' : 'm365_not_connected';
  } catch (error) {
    emailError = error instanceof Error ? error.message.slice(0, 200) : 'send_failed';
  }
  await db.accessRequest.update({ where: { id }, data: emailed ? { lastEmailAt: now, emailError: null } : { emailError } });
  return { ok: true, tenantId: payload.user.tenantId, emailed, emailError };
}

// Public resend of the setup link, keyed only on the registered email. Cooldowns and a
// per-IP rate limit keep it from spamming the inbox or letting an attacker probe accounts.
export async function resendSetupEmail(rawEmail: unknown, now = new Date(), send: typeof sendPlatformNotice = sendPlatformNotice) {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid_email');
  const request = await db.accessRequest.findFirst({ where: { email, status: 'APPROVED' }, orderBy: { createdAt: 'desc' } });
  if (!request?.userId) return { ok: true, sent: false }; // no eligible account; generic answer
  if (request.lastEmailAt && now.getTime() - request.lastEmailAt.getTime() < RESEND_COOLDOWN_MS) throw new HttpError(429, 'resend_too_soon');
  const user = await db.user.findUnique({ where: { id: request.userId } });
  if (!user || user.disabled) throw new HttpError(404, 'user_not_found');
  const setPasswordUrl = await issueSetupLink(user.id, now);
  let emailed = false;
  let emailError = '';
  try {
    emailed = await send(email, 'Your LeadMelo account is ready', accountReadyEmail(email, setPasswordUrl));
    emailError = emailed ? '' : 'm365_not_connected';
  } catch (error) {
    emailError = error instanceof Error ? error.message.slice(0, 200) : 'send_failed';
  }
  await db.accessRequest.update({ where: { id: request.id }, data: emailed ? { lastEmailAt: now, emailError: null } : { emailError } });
  if (!emailed) throw new HttpError(502, 'email_delivery_failed');
  return { ok: true, sent: true };
}
