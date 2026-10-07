import { z } from 'zod';
import { authenticate, assertOrigin, cookieHeader, rateLimit } from '../../../../lib/auth';
import { hashPassword, verifyPassword } from '../../../../lib/crypto';
import { endpoint, HttpError, jsonBody } from '../../../../lib/http';
import { passwordSchema } from '../../../../lib/identity';
import { db } from '../../../../lib/db';

export const POST = endpoint(async req => {
  const user = await authenticate(req);
  assertOrigin(req);
  await rateLimit(`password-change:${user.id}`, 5, 15);
  const body = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }).strict().parse(await jsonBody(req, 4096));
  if (body.currentPassword === body.newPassword) throw new HttpError(400, 'password_unchanged');

  const current = await db.user.findUnique({ where: { id: user.id } });
  if (!current?.passwordHash || !verifyPassword(body.currentPassword, current.passwordHash)) throw new HttpError(401, 'invalid_credentials');
  const passwordHash = hashPassword(body.newPassword);
  await db.$transaction(async tx => {
    const changed = await tx.user.updateMany({ where: { id: user.id, passwordHash: current.passwordHash, disabled: false }, data: { passwordHash } });
    if (!changed.count) throw new HttpError(409, 'password_change_conflict');
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'password_changed' } });
  });
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookieHeader('', 0) } });
});