import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
import { hashToken } from '../../../lib/security';
import { unsubscribeToken } from '../../../lib/unsubscribe';
import { schedulingUrl } from '../../../lib/calendly';
import { pickVariant, previewVariant } from '../../../lib/experiments';
import { renderOutreachContent } from '../../../lib/outreachContent';

type ReviewEvent = Prisma.OutreachEventGetPayload<{ include: { campaign: { include: { sequenceSteps: true } }; contact: { include: { lead: true } } } }>;

async function reviewContent(tx: Prisma.TransactionClient, event: ReviewEvent, persistVariant: boolean) {
  const { campaign, contact } = event;
  if (!campaign || !contact?.email) throw new HttpError(409, 'review_message_unavailable');
  const settings = await tx.tenantSetting.findUnique({ where: { tenantId: event.tenantId } });
  if (!settings?.postalAddress) throw new HttpError(409, 'postal_address_missing');
  const enrollment = event.purpose === 'SEQUENCE'
    ? await tx.enrollment.findUnique({ where: { campaignId_contactId: { campaignId: campaign.id, contactId: contact.id } } })
    : null;
  const step = event.purpose === 'SEQUENCE'
    ? campaign.sequenceSteps.find(item => item.stepOrder === event.stepOrder)
    : null;
  const variant = step && enrollment
    ? await (persistVariant ? pickVariant : previewVariant)(tx, event.tenantId, campaign.id, enrollment.id, step.stepOrder)
    : null;
  const calendlyUrl = schedulingUrl(campaign.calendlyUrl, event.tenantId, campaign.id, contact.id);
  const unsubscribeUrl = `${process.env.APP_URL}/unsubscribe?token=${encodeURIComponent(unsubscribeToken(event.tenantId, contact.email))}`;
  const content = renderOutreachContent({
    existingSubject: event.subject,
    existingBody: event.body,
    subjectTemplate: variant?.subject ?? step?.subject ?? '',
    bodyTemplate: variant?.body ?? step?.body ?? '',
    variables: {
      firstName: contact.fullName.trim().split(/\s+/)[0] || 'there',
      company: contact.lead?.company ?? '',
      senderName: campaign.senderName,
      calendlyUrl,
      offer: campaign.offer ?? ''
    },
    postalAddress: settings.postalAddress,
    unsubscribeUrl
  });
  return { ...content, reviewToken: hashToken(`${event.id}\0${content.subject}\0${content.body}`) };
}

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  const events = await db.outreachEvent.findMany({ where: { tenantId: user.tenantId }, include: { contact: { include: { lead: true } }, campaign: { include: { sequenceSteps: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  const rows = await Promise.all(events.map(async event => {
    if (event.status !== 'QUEUED') return event;
    try {
      const preview = await db.$transaction(tx => reviewContent(tx, event, false));
      return { ...event, reviewSubject: preview.subject, reviewBody: preview.body, reviewContentType: preview.contentType, reviewToken: preview.reviewToken, statusLabel: event.approvedAt ? 'APPROVED' : event.status };
    } catch (error) {
      return { ...event, reviewError: error instanceof Error ? error.message : 'review_message_unavailable' };
    }
  }));
  return Response.json(rows);
});
export const PATCH = endpoint(async req => {
  const user = await authenticate(req, true);
  const body = z.object({ id: z.string(), reviewToken: z.string().length(64) }).strict().parse(await jsonBody(req));
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${user.tenantId} FOR UPDATE`;
    const event = await tx.outreachEvent.findFirst({ where: { tenantId: user.tenantId, id: body.id, status: 'QUEUED' }, include: { contact: { include: { lead: true } }, campaign: { include: { sequenceSteps: true } } } });
    if (!event) throw new HttpError(404, 'queued_message_not_found');
    const approved = await reviewContent(tx, event, true);
    if (approved.reviewToken !== body.reviewToken) throw new HttpError(409, 'message_changed_since_review');
    const updated = await tx.outreachEvent.updateMany({
      where: { tenantId: user.tenantId, id: body.id, status: 'QUEUED' },
      data: { subject: approved.subject, body: approved.body, approvedAt: new Date(), scheduledAt: new Date() }
    });
    if (!updated.count) throw new HttpError(409, 'queued_message_not_found');
    await tx.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'outreach_approved', entityId: body.id } });
    return Response.json({ ok: true });
  });
});
