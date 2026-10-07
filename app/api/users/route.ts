import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
import { z } from 'zod';

// Team list for administrators (used by the Team table and password-reset issuance). Tenant-scoped; no hashes or secrets.
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  if (!['TENANT_ADMIN', 'SUPER_ADMIN'].includes(user.role)) throw new HttpError(403, 'admin_required');
  const rows = await db.user.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'asc' }, take: 200, select: { id: true, email: true, name: true, role: true, disabled: true, mfaEnabledAt: true, createdAt: true } });
  return Response.json(rows.map(r => ({ id: r.id, email: r.email, name: r.name, role: r.role, disabled: r.disabled, mfaEnabled: !!r.mfaEnabledAt, you: r.id === user.id })));
});

export const PATCH = endpoint(async req => {
  const actor = await authenticate(req, true);
  if (!['TENANT_ADMIN', 'SUPER_ADMIN'].includes(actor.role)) throw new HttpError(403, 'admin_required');
  const body = z.object({ id: z.string().min(1), disabled: z.boolean() }).strict().parse(await jsonBody(req, 1024));
  if (body.id === actor.id && body.disabled) throw new HttpError(409, 'cannot_disable_self');

  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${actor.tenantId} FOR UPDATE`;
    const target = await tx.user.findFirst({ where: { id: body.id, tenantId: actor.tenantId } });
    if (!target || (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN')) throw new HttpError(404, 'user_not_found');
    if (body.disabled && target.role === 'TENANT_ADMIN') {
      const activeAdmins = await tx.user.count({ where: { tenantId: actor.tenantId, role: 'TENANT_ADMIN', disabled: false } });
      if (activeAdmins <= 1) throw new HttpError(409, 'cannot_disable_last_admin');
    }
    await tx.user.update({ where: { id: target.id }, data: { disabled: body.disabled } });
    if (body.disabled) await tx.session.deleteMany({ where: { userId: target.id } });
    await tx.auditEvent.create({ data: { tenantId: actor.tenantId, actorUserId: actor.id, action: body.disabled ? 'user_disabled' : 'user_enabled', entityId: target.id } });
  });
  return Response.json({ ok: true });
});
