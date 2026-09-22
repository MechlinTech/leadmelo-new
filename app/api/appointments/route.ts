import { z } from 'zod';
import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.appointment.findMany({ where: { tenantId: user.tenantId }, include: { contact: true, campaign: true }, orderBy: { scheduledStart: 'desc' }, take: 100 }));
});
export const PATCH = endpoint(async req => {
  const user = await authenticate(req, true);
  const body = z.union([
    z.object({ id: z.string(), status: z.enum(['COMPLETED', 'NO_SHOW', 'DISQUALIFIED', 'WON', 'LOST']), outcomeReason: z.string().min(1).max(2000) }).strict(),
    z.object({ id: z.string(), qualified: z.literal(true), outcomeReason: z.string().min(1).max(2000) }).strict()
  ]).parse(await jsonBody(req));
  if ('qualified' in body) {
    const appointment = await db.appointment.findFirst({ where: { id: body.id, tenantId: user.tenantId, status: 'BOOKED' }, include: { campaign: true } });
    if (!appointment?.campaign || !appointment.contactId) throw new HttpError(404, 'booked_appointment_not_found');
    const enrollment = await db.enrollment.findUnique({ where: { campaignId_contactId: { campaignId: appointment.campaign.id, contactId: appointment.contactId } } });
    if (!enrollment || !enrollment.hasBuyer || !enrollment.hasPainSignal || enrollment.score < appointment.campaign.minAppointmentQualityScore) throw new HttpError(409, 'qualification_requirements_not_met');
    await db.appointment.update({ where: { id: appointment.id }, data: { qualified: true, qualificationNotes: body.outcomeReason } });
    await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'appointment_qualified', entityId: body.id } });
    return Response.json({ ok: true });
  }
  const updated = await db.appointment.updateMany({ where: { id: body.id, tenantId: user.tenantId, status: { not: 'CANCELED' } }, data: { status: body.status, outcomeReason: body.outcomeReason } });
  if (!updated.count) throw new HttpError(404, 'appointment_not_found');
  return Response.json({ ok: true });
});
