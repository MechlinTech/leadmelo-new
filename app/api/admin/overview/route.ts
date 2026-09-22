import { z } from 'zod';
import { db } from '../../../../lib/db';
import { authenticate } from '../../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../../lib/http';

// Platform operator console data: tenants (with plan/suspension), access requests, questions the assistant could not answer.
async function operator(req: Request, write = false) {
  const user = await authenticate(req, write);
  if (user.role !== 'SUPER_ADMIN') throw new HttpError(403, 'super_admin_required');
  return user;
}
export const GET = endpoint(async req => {
  await operator(req);
  const [tenants, requests, questions] = await Promise.all([
    db.tenant.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, name: true, slug: true, plan: true, createdAt: true, settings: { select: { suspended: true, automationEnabled: true } }, _count: { select: { users: true, campaigns: true } } } }),
    db.accessRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
    db.assistantQuestion.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
  ]);
  return Response.json({ tenants, requests, questions });
});
export const PATCH = endpoint(async req => {
  const user = await operator(req, true);
  const { id, handled } = z.object({ id: z.string(), handled: z.boolean() }).strict().parse(await jsonBody(req, 1024));
  const r = await db.accessRequest.updateMany({ where: { id }, data: { handledAt: handled ? new Date() : null } });
  if (!r.count) throw new HttpError(404, 'request_not_found');
  await db.auditEvent.create({ data: { actorUserId: user.id, action: handled ? 'access_request_handled' : 'access_request_reopened', entityId: id } });
  return Response.json({ ok: true });
});
