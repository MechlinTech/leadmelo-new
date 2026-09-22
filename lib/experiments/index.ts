import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../db';
import { HttpError } from '../http';
import { TEMPLATE_VARIABLES } from '../validation';
import { updateCampaign } from '../campaignVersions';
import { assertCanCreateExperiment } from '../entitlements';
import { judge, type ArmStats, type Verdict } from './stats';

const isAdminOrManager = (role: string) => ['TENANT_ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(role);
const templateText = (max: number) => z.string().trim().min(1).max(max).superRefine((v, ctx) => {
  for (const m of v.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) if (!TEMPLATE_VARIABLES.has(m[1])) ctx.addIssue({ code: 'custom', message: 'Unknown template variable' });
});
export const experimentInput = z.object({
  campaignId: z.string().min(1), stepOrder: z.number().int().min(1).max(10), name: z.string().trim().min(1).max(200),
  primaryMetric: z.enum(['POSITIVE_REPLY', 'BOOKED', 'ATTENDED']).default('POSITIVE_REPLY'),
  minSample: z.number().int().min(20).max(100000).default(100),
  controlWeight: z.number().int().min(1).max(100000).default(1),
  variants: z.array(z.object({ label: z.string().trim().min(1).max(60), subject: templateText(200), body: templateText(4000), weight: z.number().int().min(1).max(100000).default(1) }).strict()).min(1).max(4)
}).strict().superRefine((v, ctx) => {
  const labels = v.variants.map(x => x.label.toLowerCase());
  if (new Set(labels).size !== labels.length || labels.includes('control')) ctx.addIssue({ code: 'custom', message: 'Variant labels must be unique and not "control"' });
});

export async function createExperiment(tenantId: string, actor: { id: string; role: string }, raw: unknown) {
  if (!isAdminOrManager(actor.role)) throw new HttpError(403, 'role_not_allowed');
  const input = experimentInput.parse(raw);
  await assertCanCreateExperiment(tenantId);
  const step = await db.sequenceStep.findFirst({ where: { campaignId: input.campaignId, stepOrder: input.stepOrder, campaign: { tenantId } } });
  if (!step) throw new HttpError(404, 'campaign_step_not_found');
  const experiment = await db.experiment.create({
    data: {
      tenantId, campaignId: input.campaignId, stepOrder: input.stepOrder, name: input.name, primaryMetric: input.primaryMetric, minSample: input.minSample,
      variants: { create: [{ tenantId, label: 'control', isControl: true, weight: input.controlWeight }, ...input.variants.map(v => ({ tenantId, ...v }))] }
    }, include: { variants: true }
  });
  await db.auditEvent.create({ data: { tenantId, actorUserId: actor.id, action: 'experiment_created', entityId: experiment.id } });
  return experiment;
}

export async function setExperimentStatus(tenantId: string, actor: { id: string; role: string }, id: string, status: 'RUNNING' | 'STOPPED') {
  if (!isAdminOrManager(actor.role)) throw new HttpError(403, 'role_not_allowed');
  const e = await db.experiment.findFirst({ where: { id, tenantId }, include: { variants: true } });
  if (!e) throw new HttpError(404, 'experiment_not_found');
  if (status === 'RUNNING' && e.status !== 'DRAFT' && e.status !== 'STOPPED') throw new HttpError(409, 'experiment_not_startable');
  if (status === 'STOPPED' && e.status !== 'RUNNING') throw new HttpError(409, 'experiment_not_running');
  if (status === 'RUNNING' && e.variants.length < 2) throw new HttpError(409, 'experiment_needs_variant');
  // The partial unique index rejects a second RUNNING experiment on the same step (409).
  await db.experiment.update({ where: { id }, data: { status, ...(status === 'RUNNING' ? { startedAt: e.startedAt ?? new Date() } : {}) } });
  await db.auditEvent.create({ data: { tenantId, actorUserId: actor.id, action: `experiment_${status.toLowerCase()}`, entityId: id } });
}

// Stable, idempotent assignment: the same enrollment always gets the same arm, and the assignment
// is persisted so later analysis uses what was actually sent. Returns override copy, or null for control.
export async function pickVariant(tx: Prisma.TransactionClient, tenantId: string, campaignId: string, enrollmentId: string, stepOrder: number) {
  const experiment = await tx.experiment.findFirst({ where: { tenantId, campaignId, stepOrder, status: 'RUNNING' }, include: { variants: { orderBy: { label: 'asc' } } } });
  if (!experiment) return null;
  const existing = await tx.experimentAssignment.findUnique({ where: { experimentId_enrollmentId: { experimentId: experiment.id, enrollmentId } } });
  let variant = existing ? experiment.variants.find(v => v.id === existing.variantId) : undefined;
  if (!variant) {
    const total = experiment.variants.reduce((n, v) => n + v.weight, 0);
    let point = parseInt(createHash('sha256').update(`${experiment.id}:${enrollmentId}`).digest('hex').slice(0, 12), 16) % total;
    variant = experiment.variants.find(v => (point -= v.weight) < 0)!;
    await tx.experimentAssignment.create({ data: { tenantId, experimentId: experiment.id, variantId: variant.id, enrollmentId } });
  }
  return variant.isControl ? null : { subject: variant.subject!, body: variant.body! };
}

const APPOINTMENT_BOOKED = ['BOOKED', 'COMPLETED', 'NO_SHOW', 'WON', 'LOST'] as const;
const APPOINTMENT_ATTENDED = ['COMPLETED', 'WON'] as const;
function chunks<T>(items: T[], size = 500) { const out: T[][] = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }

// Outcomes are derived from saved records; an arm's denominator is enrollments that were assigned
// AND actually had this step sent. Replies and meetings are attributed at contact level.
export async function experimentArms(experimentId: string) {
  const experiment = await db.experiment.findUniqueOrThrow({ where: { id: experimentId }, include: { variants: true } });
  const arms: ArmStats[] = [];
  for (const v of experiment.variants) {
    const assignments = await db.experimentAssignment.findMany({ where: { experimentId, variantId: v.id }, select: { enrollmentId: true } });
    let sent = 0, primary = 0, unsubscribed = 0;
    for (const ids of chunks(assignments.map(a => a.enrollmentId))) {
      const enrollments = await db.enrollment.findMany({ where: { id: { in: ids } }, select: { contactId: true, contact: { select: { email: true } } } });
      const contactIds = enrollments.map(e => e.contactId);
      const sentContacts = new Set((await db.outreachEvent.findMany({ where: { tenantId: experiment.tenantId, campaignId: experiment.campaignId, stepOrder: experiment.stepOrder, status: 'SENT', contactId: { in: contactIds } }, select: { contactId: true } })).map(e => e.contactId));
      const sentEnrollments = enrollments.filter(e => sentContacts.has(e.contactId));
      sent += sentEnrollments.length;
      const sentIds = sentEnrollments.map(e => e.contactId);
      if (experiment.primaryMetric === 'POSITIVE_REPLY') primary += new Set((await db.reply.findMany({ where: { tenantId: experiment.tenantId, intent: 'POSITIVE', contactId: { in: sentIds } }, select: { contactId: true } })).map(r => r.contactId)).size;
      else primary += new Set((await db.appointment.findMany({ where: { tenantId: experiment.tenantId, campaignId: experiment.campaignId, status: { in: [...(experiment.primaryMetric === 'ATTENDED' ? APPOINTMENT_ATTENDED : APPOINTMENT_BOOKED)] }, contactId: { in: sentIds } }, select: { contactId: true } })).map(a => a.contactId)).size;
      const emails = sentEnrollments.map(e => e.contact.email).filter((x): x is string => !!x);
      unsubscribed += await db.suppression.count({ where: { tenantId: experiment.tenantId, email: { in: emails }, reason: { in: ['unsubscribe', 'complaint'] } } });
    }
    arms.push({ variantId: v.id, label: v.label, isControl: v.isControl, weight: v.weight, sent, primary, unsubscribed });
  }
  return { experiment, arms };
}

export async function experimentResults(tenantId: string, id: string) {
  if (!await db.experiment.findFirst({ where: { id, tenantId }, select: { id: true } })) throw new HttpError(404, 'experiment_not_found');
  const { experiment, arms } = await experimentArms(id);
  return { experiment, arms, verdict: judge(arms, { minSample: experiment.minSample }) };
}

// Called by the worker. Creates at most one OPEN recommendation per (experiment, winning variant).
export async function evaluateExperiments() {
  let created = 0;
  for (const e of await db.experiment.findMany({ where: { status: 'RUNNING' }, select: { id: true, tenantId: true, minSample: true }, take: 200 })) {
    const { arms } = await experimentArms(e.id);
    const verdict: Verdict = judge(arms, { minSample: e.minSample });
    if (verdict.status !== 'WINNER' || !verdict.winnerVariantId) continue;
    const exists = await db.experimentRecommendation.findUnique({ where: { experimentId_variantId: { experimentId: e.id, variantId: verdict.winnerVariantId } } });
    if (exists) continue;
    await db.experimentRecommendation.create({ data: { tenantId: e.tenantId, experimentId: e.id, variantId: verdict.winnerVariantId, verdict: verdict as unknown as Prisma.InputJsonValue } });
    created++;
  }
  return created;
}

// A human accepts or rejects. Accepting writes the winning copy into the campaign step through the
// normal versioning path (new version, approvals invalidated) and concludes the experiment.
export async function decideRecommendation(tenantId: string, actor: { id: string; role: string }, recommendationId: string, decision: 'accept' | 'reject') {
  if (!isAdminOrManager(actor.role)) throw new HttpError(403, 'role_not_allowed');
  const rec = await db.experimentRecommendation.findFirst({ where: { id: recommendationId, tenantId }, include: { experiment: true } });
  if (!rec || rec.status !== 'OPEN') throw new HttpError(404, 'recommendation_not_open');
  const now = new Date();
  if (decision === 'reject') {
    await db.experimentRecommendation.update({ where: { id: rec.id }, data: { status: 'REJECTED', decidedBy: actor.id, decidedAt: now } });
    await db.auditEvent.create({ data: { tenantId, actorUserId: actor.id, action: 'experiment_recommendation_rejected', entityId: rec.id } });
    return { applied: false };
  }
  const variant = await db.experimentVariant.findFirstOrThrow({ where: { id: rec.variantId, tenantId } });
  const campaign = await db.campaign.findFirstOrThrow({ where: { id: rec.experiment.campaignId, tenantId }, include: { sequenceSteps: true } });
  // Conclude first so the "step is under experiment" guard in updateCampaign does not block the write.
  await db.experiment.update({ where: { id: rec.experimentId }, data: { status: 'CONCLUDED', concludedAt: now } });
  try {
    const steps = campaign.sequenceSteps.sort((a, b) => a.stepOrder - b.stepOrder).map(s => ({ stepOrder: s.stepOrder, waitBusinessDays: s.waitBusinessDays, subject: s.stepOrder === rec.experiment.stepOrder ? variant.subject! : s.subject ?? '', body: s.stepOrder === rec.experiment.stepOrder ? variant.body! : s.body }));
    await updateCampaign(tenantId, campaign.id, actor.id, { sequenceSteps: steps }, `experiment_winner_${rec.experimentId}`);
  } catch (error) {
    await db.experiment.update({ where: { id: rec.experimentId }, data: { status: 'RUNNING', concludedAt: null } });
    throw error;
  }
  await db.experimentRecommendation.update({ where: { id: rec.id }, data: { status: 'ACCEPTED', decidedBy: actor.id, decidedAt: now } });
  await db.auditEvent.create({ data: { tenantId, actorUserId: actor.id, action: 'experiment_recommendation_accepted', entityId: rec.id } });
  return { applied: true };
}
