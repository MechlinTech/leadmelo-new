import { z } from 'zod';
import { db } from '../../../../lib/db';
import { assertOrigin, createSession, cookieHeader, rateLimit } from '../../../../lib/auth';
import { verifyPassword, hashPassword } from '../../../../lib/crypto';
import { hashToken } from '../../../../lib/security';
import { verifyMfaCode } from '../../../../lib/identity';
import { isThemeId, themeCookieHeader } from '../../../../lib/themes';
import { endpoint, HttpError, jsonBody } from '../../../../lib/http';

const input = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256), code: z.string().min(6).max(32).optional() }).strict();
const dummyHash = hashPassword('not-a-real-user-password');
export const POST = endpoint(async req => {
  assertOrigin(req);
  const body = input.parse(await jsonBody(req, 4096));
  const email = body.email.trim().toLowerCase();
  await rateLimit(`login:${hashToken(email)}`, 10, 15);
  await rateLimit('login:global', 200, 1);
  const user = await db.user.findUnique({ where: { email } });
  const valid = verifyPassword(body.password, user?.passwordHash ?? dummyHash);
  if (!valid || !user || user.disabled) throw new HttpError(401, 'invalid_credentials');
  if (user.mfaEnabledAt) {
    if (!body.code) throw new HttpError(401, 'mfa_required');
    if (!await verifyMfaCode(user, body.code)) throw new HttpError(401, 'invalid_mfa_code');
  }
  const token = await createSession(user.id);
  const headers = new Headers({ 'Set-Cookie': cookieHeader(token) });
  if (isThemeId(user.theme)) headers.append('Set-Cookie', themeCookieHeader(user.theme)); // first paint uses the saved theme on any device
  return Response.json({ ok: true }, { headers });
});
