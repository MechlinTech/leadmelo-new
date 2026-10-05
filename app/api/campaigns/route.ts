import { z } from 'zod';
import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
import { campaignInput } from '../../../lib/validation';
import { campaignReady } from '../../../lib/campaigns';
import { assertCanActivateCampaign } from '../../../lib/entitlements';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.campaign.findMany({ where: { tenantId: user.tenantId }, include: { icp: true, sequenceSteps: true, _count: { select: { enrollments: true, appointments: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }));
});
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  const { sequenceSteps, icp: inlineICP, startImmediately, ...body } = campaignInput.parse(await jsonBody(req));
  if (body.icpId && !await db.iCP.findFirst({ where: { id: body.icpId, tenantId: user.tenantId, active: true } })) throw new HttpError(404, 'icp_not_found');
  const campaign = await db.$transaction(async tx => {
    const icpId = body.icpId ?? (await tx.iCP.create({ data: { ...inlineICP!, tenantId: user.tenantId } })).id;
    return tx.campaign.create({ data: { ...body, icpId, tenantId: user.tenantId, sequenceSteps: { create: sequenceSteps } }, include: { icp: true, sequenceSteps: true } });
  });
  let activation = { requested: startImmediately, started: false, reason: startImmediately ? 'activation_not_attempted' : 'saved_as_draft' };
  if (startImmediately) {
    try {
      await campaignReady(user.tenantId, campaign.id);
      await assertCanActivateCampaign(user.tenantId, campaign.id);
      await db.campaign.update({ where: { id: campaign.id }, data: { status: 'ACTIVE', nextRunAt: new Date() } });
      await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'campaign_created_and_activated', entityId: campaign.id } });
      activation = { requested: true, started: true, reason: 'autopilot_started' };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      activation = { requested: true, started: false, reason: error.message };
    }
  }
  return Response.json({ ...campaign, activation }, { status: 201 });
});
export const PATCH = endpoint(async req => {
  const user = await authenticate(req, true);
  const body = z.object({ id: z.string(), status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETE']) }).strict().parse(await jsonBody(req));
  const existing = await db.campaign.findFirst({ where: { id: body.id, tenantId: user.tenantId } });
  if (!existing) throw new HttpError(404, 'campaign_not_found');
  if (body.status === 'ACTIVE') { await campaignReady(user.tenantId, body.id); await assertCanActivateCampaign(user.tenantId, body.id); }
  // Only newly activating a campaign should wake the scheduler. Pause/complete must not
  // rewrite nextRunAt, and Activate while already ACTIVE must not enqueue another run.
  const data: { status: typeof body.status; nextRunAt?: Date } = { status: body.status };
  if (body.status === 'ACTIVE' && existing.status !== 'ACTIVE') data.nextRunAt = new Date();
  await db.campaign.update({ where: { id: existing.id }, data });
  await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'campaign_status_changed', entityId: body.id, metadata: { status: body.status } } });
  return Response.json({ ok: true });
});
