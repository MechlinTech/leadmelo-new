import { createHash } from 'node:crypto';
import { db } from './db';
import { HttpError } from './http';
import { suppress } from './webhooks';

export const REDACTED = '[redacted by retention policy]';
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const emailHash = (email: string) => createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 16);
const isAdmin = (role: string) => role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';

// Data-subject access: everything this tenant holds about one email address.
export async function exportSubjectData(tenantId: string, actor: { id: string; role: string }, rawEmail: string) {
  if (!isAdmin(actor.role)) throw new HttpError(403, 'admin_required');
  const email = normalizeEmail(rawEmail);
  const contact = await db.contact.findUnique({ where: { tenantId_email: { tenantId, email } }, include: { lead: true } });
  const [suppression, enrollments, events, replies, appointments] = await Promise.all([
    db.suppression.findUnique({ where: { tenantId_email: { tenantId, email } } }),
    contact ? db.enrollment.findMany({ where: { tenantId, contactId: contact.id }, include: { campaign: { select: { name: true } } } }) : [],
    contact ? db.outreachEvent.findMany({ where: { tenantId, contactId: contact.id }, orderBy: { createdAt: 'asc' } }) : [],
    contact ? db.reply.findMany({ where: { tenantId, contactId: contact.id }, orderBy: { createdAt: 'asc' } }) : [],
    contact ? db.appointment.findMany({ where: { tenantId, contactId: contact.id } }) : []
  ]);
  await db.auditEvent.create({ data: { tenantId, actorUserId: actor.id, action: 'privacy_export', metadata: { emailHash: emailHash(email) } } });
  return {
    generatedAt: new Date().toISOString(), subject: email, found: !!contact || !!suppression,
    contact: contact && { fullName: contact.fullName, title: contact.title, email: contact.email, linkedinUrl: contact.linkedinUrl, verification: contact.verification, sourceProvider: contact.sourceProvider, lastVerifiedAt: contact.lastVerifiedAt, createdAt: contact.createdAt, company: contact.lead?.company, domain: contact.lead?.domain },
    suppression: suppression && { reason: suppression.reason, createdAt: suppression.createdAt },
    enrollments: enrollments.map(e => ({ campaign: e.campaign.name, score: e.score, evidence: e.evidence, stoppedAt: e.stoppedAt, stopReason: e.stopReason, createdAt: e.createdAt })),
    messages: events.map(e => ({ purpose: e.purpose, status: e.status, subject: e.subject, body: e.body, sentAt: e.sentAt, scheduledAt: e.scheduledAt })),
    replies: replies.map(r => ({ intent: r.intent, text: r.rawSnippet, receivedAt: r.createdAt })),
    appointments: appointments.map(a => ({ status: a.status, scheduledStart: a.scheduledStart, scheduledEnd: a.scheduledEnd, timezone: a.timezone }))
  };
}

// Erasure keeps ONE minimal record: the suppression row, so the person is never contacted again.
// Idempotent, and safe for an address we hold nothing on (it then only suppresses).
export async function eraseSubject(tenantId: string, actorUserId: string | null, rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tenantId} FOR UPDATE`;
    await tx.suppression.upsert({ where: { tenantId_email: { tenantId, email } }, update: { reason: 'erasure_request' }, create: { tenantId, email, reason: 'erasure_request' } });
    await suppress(tx, tenantId, email, 'erasure_request'); // stops enrollments and cancels queued sends
    const counts = { contact: 0, replies: 0, messages: 0, appointments: 0, leads: 0 };
    const contact = await tx.contact.findUnique({ where: { tenantId_email: { tenantId, email } } });
    if (contact) {
      counts.replies = (await tx.reply.deleteMany({ where: { tenantId, contactId: contact.id } })).count;
      counts.messages = (await tx.outreachEvent.updateMany({ where: { tenantId, contactId: contact.id }, data: { subject: null, body: null, contactId: null } })).count;
      counts.appointments = (await tx.appointment.updateMany({ where: { tenantId, contactId: contact.id }, data: { contactId: null, qualificationNotes: null } })).count;
      await tx.contact.delete({ where: { id: contact.id } }); // cascades enrollments
      counts.contact = 1;
    }
    counts.leads = (await tx.lead.updateMany({ where: { tenantId, contactEmail: email }, data: { contactEmail: null, contactName: null } })).count;
    await tx.auditEvent.create({ data: { tenantId, actorUserId, action: 'privacy_erasure', metadata: { emailHash: emailHash(email), counts } } });
    return counts;
  }, { timeout: 30000 });
}

// The erasure ledger is the set of suppression rows created by erasure requests. Export it
// regularly (encrypted, stored apart from database backups) and re-apply it after any restore,
// otherwise a restored backup silently resurrects people who were erased after it was taken.
export async function exportErasureLedger() {
  const rows = await db.suppression.findMany({ where: { reason: 'erasure_request' }, select: { tenantId: true, email: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
  return rows.map(r => ({ tenantId: r.tenantId, email: r.email, requestedAt: r.createdAt.toISOString() }));
}
export async function reapplyErasures(ledger: Array<{ tenantId: string; email: string }>) {
  let applied = 0, skipped = 0;
  for (const entry of ledger) {
    if (!await db.tenant.findUnique({ where: { id: entry.tenantId }, select: { id: true } })) { skipped++; continue; }
    await eraseSubject(entry.tenantId, null, entry.email);
    applied++;
  }
  return { applied, skipped };
}

export async function applyRetention(now = new Date()) {
  let redacted = 0;
  for (const s of await db.tenantSetting.findMany({ where: { messageRetentionDays: { not: null } }, select: { tenantId: true, messageRetentionDays: true } })) {
    const cutoff = new Date(now.getTime() - s.messageRetentionDays! * 86400000);
    redacted += (await db.outreachEvent.updateMany({ where: { tenantId: s.tenantId, createdAt: { lt: cutoff }, status: { notIn: ['QUEUED', 'SENDING'] }, OR: [{ body: { not: null } }, { subject: { not: null } }] }, data: { body: null, subject: null } })).count;
    redacted += (await db.reply.updateMany({ where: { tenantId: s.tenantId, createdAt: { lt: cutoff }, rawSnippet: { not: REDACTED } }, data: { rawSnippet: REDACTED } })).count;
  }
  return redacted;
}
