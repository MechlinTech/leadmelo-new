import { z } from 'zod';
import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.outreachEvent.findMany({ where: { tenantId: user.tenantId }, include: { contact: true, campaign: { include: { sequenceSteps: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }));
});
export const PATCH = endpoint(async req => {
  const user = await authenticate(req, true);
  const { id } = z.object({ id: z.string() }).strict().parse(await jsonBody(req));
  const result = await db.outreachEvent.updateMany({ where: { tenantId: user.tenantId, id, status: 'QUEUED' }, data: { approvedAt: new Date(), scheduledAt: new Date() } });
  if (!result.count) throw new HttpError(404, 'queued_message_not_found');
  await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'outreach_approved', entityId: id } });
  return Response.json({ ok: true });
});
