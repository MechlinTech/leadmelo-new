import { Prisma } from '@prisma/client';
import { db } from './db';
import { HttpError } from './http';
import { campaignInput } from './validation';

const FIELDS = ['name', 'icpId', 'offer', 'senderName', 'senderEmail', 'calendlyUrl', 'dailySendCap', 'weeklyProspectCap', 'weeklyAppointmentGoal', 'minScore', 'minAppointmentQualityScore', 'automationMode', 'outcomeType', 'timezone', 'sendStartHour', 'sendEndHour', 'businessDaysOnly', 'holidays'] as const;
// Changes to these alter who is targeted, what is said, or who sends it.
const MATERIAL = ['icpId', 'offer', 'senderName', 'senderEmail', 'calendlyUrl', 'minScore', 'minAppointmentQualityScore', 'sequenceSteps'] as const;
type Step = { stepOrder: number; waitBusinessDays: number; subject: string; body: string };
export type CampaignPatch = Partial<Record<(typeof FIELDS)[number], unknown>> & { sequenceSteps?: Step[] };
type Snapshot = { fields: Record<string, unknown>; sequenceSteps: Step[] };

type CampaignWithSteps = Prisma.CampaignGetPayload<{ include: { sequenceSteps: true } }>;
function snapshotOf(c: CampaignWithSteps): Snapshot {
  return {
    fields: Object.fromEntries(FIELDS.map(f => [f, c[f]])),
    sequenceSteps: [...c.sequenceSteps].sort((a, b) => a.stepOrder - b.stepOrder).map(s => ({ stepOrder: s.stepOrder, waitBusinessDays: s.waitBusinessDays, subject: s.subject ?? '', body: s.body }))
  };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Edit an existing campaign. Validation reuses campaignInput on the merged result,
// so an edit can never save something creation would reject.
export async function updateCampaign(tenantId: string, campaignId: string, actorUserId: string | null, patch: CampaignPatch, reason = 'edit') {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tenantId} FOR UPDATE`;
    const current = await tx.campaign.findFirst({ where: { id: campaignId, tenantId }, include: { sequenceSteps: true } });
    if (!current) throw new HttpError(404, 'campaign_not_found');
    const before = snapshotOf(current);
    const merged = { ...before.fields, ...patch, sequenceSteps: patch.sequenceSteps ?? before.sequenceSteps };
    if (merged.offer === null) delete merged.offer;
    const parsed = campaignInput.parse(merged);
    const { sequenceSteps, icp: _icp, startImmediately: _s, ...fields } = parsed;
    if (fields.icpId && fields.icpId !== current.icpId && !await tx.iCP.findFirst({ where: { id: fields.icpId, tenantId, active: true } })) throw new HttpError(404, 'icp_not_found');
    const after: Snapshot = { fields: Object.fromEntries(FIELDS.map(f => [f, (fields as Record<string, unknown>)[f] ?? (f === 'offer' ? null : undefined)])), sequenceSteps: [...sequenceSteps].sort((a, b) => a.stepOrder - b.stepOrder) };
    const changed = FIELDS.filter(f => !same(before.fields[f], after.fields[f]));
    const stepsChanged = !same(before.sequenceSteps, after.sequenceSteps);
    if (!changed.length && !stepsChanged) return { campaign: current, version: current.version, changed: [] as string[], material: false };
    if (stepsChanged) {
      // Editing the copy of a step while it is under test would silently change the control.
      for (const e of await tx.experiment.findMany({ where: { campaignId, status: 'RUNNING' }, select: { stepOrder: true } })) {
        const was = before.sequenceSteps.find(s => s.stepOrder === e.stepOrder), now = after.sequenceSteps.find(s => s.stepOrder === e.stepOrder);
        if (!same(was && [was.subject, was.body], now && [now.subject, now.body])) throw new HttpError(409, 'experiment_running_on_step');
      }
    }
    const material = stepsChanged || changed.some(f => (MATERIAL as readonly string[]).includes(f));

    // Preserve the state being replaced so any version can be restored.
    if (material && !await tx.campaignVersion.findUnique({ where: { campaignId_version: { campaignId, version: current.version } } })) {
      await tx.campaignVersion.create({ data: { tenantId, campaignId, version: current.version, snapshot: before as unknown as Prisma.InputJsonValue, reason: 'baseline', actorUserId } });
    }
    const senderChanged = changed.includes('senderEmail');
    const version = material ? current.version + 1 : current.version;
    await tx.campaign.update({ where: { id: campaignId }, data: { ...fields, offer: fields.offer ?? null, version, ...(senderChanged && current.status === 'ACTIVE' ? { status: 'PAUSED' as const } : {}) } });
    if (stepsChanged) {
      await tx.sequenceStep.deleteMany({ where: { campaignId } });
      await tx.sequenceStep.createMany({ data: sequenceSteps.map(s => ({ ...s, campaignId })) });
    }
    if (material) {
      // Prior approvals covered the old content; queued sends must be approved again.
      await tx.outreachEvent.updateMany({ where: { tenantId, campaignId, status: 'QUEUED', purpose: 'SEQUENCE' }, data: { approvedAt: null } });
      await tx.outreachEvent.updateMany({ where: { tenantId, campaignId, status: 'QUEUED', purpose: 'SEQUENCE', stepOrder: { gt: Math.max(...sequenceSteps.map(s => s.stepOrder)) } }, data: { status: 'CANCELED', error: 'step_removed_by_version' } });
      const stored = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: { sequenceSteps: true } });
      await tx.campaignVersion.create({ data: { tenantId, campaignId, version, snapshot: snapshotOf(stored) as unknown as Prisma.InputJsonValue, reason, actorUserId } });
    }
    await tx.auditEvent.create({ data: { tenantId, actorUserId, action: material ? 'campaign_version_created' : 'campaign_updated', entityId: campaignId, metadata: { changed: [...changed, ...(stepsChanged ? ['sequenceSteps'] : [])], version, reason } } });
    return { campaign: await tx.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: { sequenceSteps: true } }), version, changed: [...changed, ...(stepsChanged ? ['sequenceSteps'] : [])], material };
  }, { timeout: 15000 });
}

export async function listVersions(tenantId: string, campaignId: string) {
  return db.campaignVersion.findMany({ where: { tenantId, campaignId }, orderBy: { version: 'desc' }, take: 50, select: { version: true, reason: true, actorUserId: true, createdAt: true } });
}

// Rollback restores an earlier snapshot as a NEW version; history is never rewritten.
export async function rollbackCampaign(tenantId: string, campaignId: string, toVersion: number, actorUserId: string | null) {
  const target = await db.campaignVersion.findFirst({ where: { tenantId, campaignId, version: toVersion } });
  if (!target) throw new HttpError(404, 'version_not_found');
  const snap = target.snapshot as unknown as Snapshot;
  return updateCampaign(tenantId, campaignId, actorUserId, { ...snap.fields, sequenceSteps: snap.sequenceSteps }, `rollback_to_${toVersion}`);
}

// A clone is always a draft: no enrollments, no approvals, must pass the readiness gate.
export async function cloneCampaign(tenantId: string, campaignId: string, actorUserId: string | null, name?: string) {
  const src = await db.campaign.findFirst({ where: { id: campaignId, tenantId }, include: { sequenceSteps: true } });
  if (!src) throw new HttpError(404, 'campaign_not_found');
  const snap = snapshotOf(src);
  const copyName = (name ?? `${src.name} (copy)`).slice(0, 200);
  const copy = await db.campaign.create({ data: { ...(snap.fields as Prisma.CampaignUncheckedCreateInput), tenantId, name: copyName, status: 'DRAFT', version: 1, sequenceSteps: { create: snap.sequenceSteps } }, include: { sequenceSteps: true } });
  await db.auditEvent.create({ data: { tenantId, actorUserId, action: 'campaign_cloned', entityId: copy.id, metadata: { from: campaignId } } });
  return copy;
}
