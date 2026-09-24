import { db } from './db';
import { usageSummary } from './usage';

// Tenant-scoped operating summary. Window is 24, 168 or 720 hours. Counts only; no contact data.
export async function buildDigest(tenantId: string, now = new Date(), hours = 24) {
  const windowHours = [24, 168, 720].includes(hours) ? hours : 24;
  const since = new Date(now.getTime() - windowHours * 3600000);
  const [sent, failed, replies, positive, booked, cancelled, activeCampaigns, alertRows, upcoming, usage] = await Promise.all([
    db.outreachEvent.count({ where: { tenantId, status: 'SENT', sentAt: { gte: since } } }),
    db.outreachEvent.count({ where: { tenantId, status: 'FAILED', createdAt: { gte: since } } }),
    db.reply.count({ where: { tenantId, createdAt: { gte: since } } }),
    db.reply.count({ where: { tenantId, intent: 'POSITIVE', createdAt: { gte: since } } }),
    db.appointment.count({ where: { tenantId, status: 'BOOKED', createdAt: { gte: since } } }),
    db.appointment.count({ where: { tenantId, status: 'CANCELED', createdAt: { gte: since } } }),
    db.campaign.count({ where: { tenantId, status: 'ACTIVE' } }),
    db.operationalAlert.groupBy({ by: ['code'], where: { tenantId, acknowledgedAt: null }, _count: { _all: true } }),
    db.appointment.count({ where: { tenantId, status: 'BOOKED', scheduledStart: { gte: now } } }),
    usageSummary(tenantId, now)
  ]);
  return {
    periodStart: since.toISOString(), periodEnd: now.toISOString(),
    activity: { emailsSent: sent, emailsFailed: failed, replies, positiveReplies: positive, meetingsBooked: booked, meetingsCancelled: cancelled },
    upcomingMeetings: upcoming, activeCampaigns,
    openAlerts: Object.fromEntries(alertRows.map(r => [r.code, r._count._all])),
    needsAttention: alertRows.reduce((n, r) => n + r._count._all, 0),
    spentCentsThisMonth: usage.spentCents
  };
}
