import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { timingSafeEqualText } from './security';
import { classifyReplyDetailed } from './replies';
import { HttpError } from './http';
import { schedulingUrl } from './calendly';

export function verifyWebhook(raw: string, timestamp: string, signature: string, secret: string, now = Date.now()) {
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300000) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return timingSafeEqualText(expected, signature);
}
const base = { id: z.string().min(1).max(200), occurredAt: z.string().datetime() };
const contact = { campaignId: z.string(), email: z.string().email().transform(v => v.toLowerCase()) };
export const webhookInput = z.discriminatedUnion('type', [
  z.object({ ...base, ...contact, type: z.literal('reply'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ ...base, ...contact, type: z.enum(['bounce', 'complaint', 'unsubscribe']) }).strict(),
  z.object({ ...base, ...contact, type: z.enum(['booking.created', 'booking.canceled']), bookingId: z.string().min(1).max(300), start: z.string().datetime(), end: z.string().datetime(), timezone: z.string().max(100), eventUrl: z.string().url() }).strict(),
  z.object({ ...base, type: z.literal('sender.health'), senderEmail: z.string().email().transform(v => v.toLowerCase()), status: z.enum(['HEALTHY', 'WATCHLIST', 'THROTTLED', 'BLOCKED']), dailyCap: z.number().int().min(0).max(250), bounceRate: z.number().min(0).max(1), complaintRate: z.number().min(0).max(1) }).strict()
]);
export type ProviderEvent = z.infer<typeof webhookInput>;

export async function suppress(tx: Prisma.TransactionClient, tenantId: string, email: string, reason: string) {
  await tx.suppression.upsert({ where: { tenantId_email: { tenantId, email } }, update: {}, create: { tenantId, email, reason } });
  const c = await tx.contact.findUnique({ where: { tenantId_email: { tenantId, email } } });
  if (c) {
    await tx.enrollment.updateMany({ where: { tenantId, contactId: c.id }, data: { stoppedAt: new Date(), stopReason: reason } });
    await tx.outreachEvent.updateMany({ where: { tenantId, contactId: c.id, status: { in: ['QUEUED', 'SENDING'] } }, data: { status: 'CANCELED' } });
  }
}

export async function handleProviderEvent(tenantId: string, event: ProviderEvent) {
  if (Date.parse(event.occurredAt) > Date.now() + 300000) throw new HttpError(400, 'event_time_in_future');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tenantId} FOR UPDATE`;
    if (await tx.webhookEvent.findUnique({ where: { tenantId_providerEventId: { tenantId, providerEventId: event.id } } })) return { duplicate: true };
    if (event.type === 'sender.health') {
      const existing = await tx.deliverabilityProfile.findUnique({ where: { tenantId_senderEmail: { tenantId, senderEmail: event.senderEmail } } });
      if (!existing?.lastCheckedAt || existing.lastCheckedAt < new Date(event.occurredAt)) {
        const status = event.bounceRate >= 0.05 || event.complaintRate >= 0.001 ? 'BLOCKED' : event.status;
        const data = { domain: event.senderEmail.split('@')[1], status, dailyCap: event.dailyCap, bounceRate: event.bounceRate, complaintRate: event.complaintRate, lastCheckedAt: new Date(event.occurredAt), healthSource: 'external' };
        await tx.deliverabilityProfile.upsert({ where: { tenantId_senderEmail: { tenantId, senderEmail: event.senderEmail } }, update: data, create: { ...data, tenantId, senderEmail: event.senderEmail } });
      }
    } else {
      const campaign = await tx.campaign.findFirst({ where: { id: event.campaignId, tenantId } });
      const c = await tx.contact.findUnique({ where: { tenantId_email: { tenantId, email: event.email } } });
      const enrollment = c && campaign ? await tx.enrollment.findUnique({ where: { campaignId_contactId: { campaignId: campaign.id, contactId: c.id } } }) : null;
      if (!campaign || !c || !enrollment) throw new HttpError(404, 'campaign_contact_not_found');
      await tx.enrollment.updateMany({ where: { tenantId, contactId: c.id }, data: { stoppedAt: new Date(), stopReason: event.type } });
      const replyDetail = event.type === 'reply' ? classifyReplyDetailed(event.text) : null;
      const replyIntent = replyDetail?.intent ?? null;
      await tx.outreachEvent.updateMany({ where: { tenantId, contactId: c.id, status: { in: ['QUEUED', 'SENDING'] }, ...(replyIntent === 'POSITIVE' ? { purpose: 'SEQUENCE' as const } : {}) }, data: { status: 'CANCELED' } });
      if (event.type === 'reply') {
        const intent = replyIntent!;
        const blocked = !!await tx.suppression.findUnique({where:{tenantId_email:{tenantId,email:event.email}}}) || !!await tx.appointment.findFirst({where:{tenantId,contactId:c.id,campaignId:campaign.id}});
        const reply = await tx.reply.create({ data: { tenantId, contactId: c.id, rawSnippet: event.text, intent, recommendedAction: intent === 'POSITIVE' ? blocked ? 'Existing booking or suppression; no new invitation.' : campaign.automationMode === 'REVIEW_BEFORE_SEND' ? 'Booking invitation awaits approval.' : 'Booking invitation queued; calendar confirmation required.' : intent === 'NEGATIVE' ? 'Suppressed; do not contact.' : `Needs review (${replyDetail!.reason}); all pending outreach stopped.` } });
        if (['UNSURE','NEUTRAL','OBJECTION','OUT_OF_OFFICE'].includes(intent)) await tx.operationalAlert.upsert({where:{key:`${tenantId}:reply_review:${reply.id}`},update:{},create:{tenantId,key:`${tenantId}:reply_review:${reply.id}`,code:'reply_review',entityId:reply.id}});
        if (intent === 'POSITIVE' && !blocked) {
          const firstName = c.fullName.split(' ')[0];
          await tx.outreachEvent.upsert({
            where: { idempotencyKey: `booking-invite:${campaign.id}:${c.id}` },
            update: {},
            create: {
              tenantId, campaignId: campaign.id, contactId: c.id, leadId: c.leadId,
              purpose: 'BOOKING_INVITATION', scheduledAt: new Date(),
              approvedAt: campaign.automationMode === 'REVIEW_BEFORE_SEND' ? null : new Date(),
              idempotencyKey: `booking-invite:${campaign.id}:${c.id}`,
              subject: `Choose a time with ${campaign.senderName}`,
              body: `Hi ${firstName},\n\nThanks for your interest. Please choose a convenient time here:\n${schedulingUrl(campaign.calendlyUrl, tenantId, campaign.id, c.id)}\n\n${campaign.senderName}`
            }
          });
        }
        if (intent === 'NEGATIVE') await suppress(tx, tenantId, event.email, 'negative_reply');
      } else if (event.type === 'bounce' || event.type === 'complaint' || event.type === 'unsubscribe') {
        await suppress(tx, tenantId, event.email, event.type);
        if (event.type === 'bounce') await tx.contact.update({ where: { id: c.id }, data: { verification: 'INVALID' } });
        if (event.type === 'complaint') await tx.deliverabilityProfile.updateMany({ where: { tenantId, senderEmail: campaign.senderEmail }, data: { status: 'BLOCKED' } });
      } else if (event.type === 'booking.created' || event.type === 'booking.canceled') {
        if (Date.parse(event.end) <= Date.parse(event.start)) throw new HttpError(400, 'invalid_booking_interval');
        const existing = await tx.appointment.findUnique({ where: { tenantId_providerEventId: { tenantId, providerEventId: event.bookingId } } });
        if (existing && (existing.campaignId !== campaign.id || existing.contactId !== c.id)) throw new HttpError(409, 'booking_attribution_conflict');
        if (!existing?.providerUpdatedAt || existing.providerUpdatedAt < new Date(event.occurredAt)) {
          const qualified = enrollment.score >= campaign.minAppointmentQualityScore && enrollment.hasBuyer && enrollment.hasPainSignal && campaign.automationMode !== 'REVIEW_BEFORE_BOOKING';
          const data = { campaignId: campaign.id, contactId: c.id, providerUpdatedAt: new Date(event.occurredAt), status: event.type === 'booking.canceled' ? 'CANCELED' as const : 'BOOKED' as const, scheduledStart: new Date(event.start), scheduledEnd: new Date(event.end), timezone: event.timezone, calendlyEventUri: event.eventUrl, qualityScore: enrollment.score, qualified, qualificationNotes: qualified ? 'ICP evidence and confirmed provider booking' : 'Qualification review required' };
          await tx.appointment.upsert({ where: { tenantId_providerEventId: { tenantId, providerEventId: event.bookingId } }, create: { ...data, tenantId, providerEventId: event.bookingId }, update: data });
        }
      }
    }
    await tx.webhookEvent.create({ data: { tenantId, providerEventId: event.id, type: event.type } });
    return { duplicate: false };
  }, { timeout: 30000 });
}
