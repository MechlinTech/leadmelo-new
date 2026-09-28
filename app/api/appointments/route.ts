import { z } from 'zod';
import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  const hours = Number(new URL(req.url).searchParams.get('hours') ?? 0);
  const since = hours > 0 ? new Date(Date.now() - hours * 3600000) : undefined;
  return Response.json(await db.appointment.findMany({
    where: { tenantId: user.tenantId, ...(since ? { OR: [{ scheduledStart: { gte: since } }, { createdAt: { gte: since } }] } : {}) },
    include: { contact: true, campaign: true },
    orderBy: { scheduledStart: 'desc' },
    take: 500
  }));
});
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  const body = z.object({
    buyerName: z.string().trim().min(1).max(200),
    buyerEmail: z.string().email(),
    scheduledStart: z.string().min(1).refine(v => !Number.isNaN(Date.parse(v)), 'Not a real date'),
    campaignId: z.string().optional(),
    notes: z.string().trim().max(2000).optional()
  }).strict().parse(await jsonBody(req));
  const email = body.buyerEmail.toLowerCase();
  const contact = await db.contact.upsert({
    where: { tenantId_email: { tenantId: user.tenantId, email } },
    update: { fullName: body.buyerName },
    create: { tenantId: user.tenantId, fullName: body.buyerName, email }
  });
  if (body.campaignId && !await db.campaign.findFirst({ where: { id: body.campaignId, tenantId: user.tenantId } })) throw new HttpError(404, 'campaign_not_found');
  const start = new Date(body.scheduledStart);
  const appointment = await db.appointment.create({
    data: {
      tenantId: user.tenantId,
      contactId: contact.id,
      campaignId: body.campaignId,
      status: 'BOOKED',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * 60000),
      qualificationNotes: body.notes ?? 'Manually recorded for verification',
      outcomeReason: 'manual_test_booking'
    },
    include: { contact: true, campaign: true }
  });
  return Response.json(appointment, { status: 201 });
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
