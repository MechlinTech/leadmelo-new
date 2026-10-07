import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
import { campaignReady } from '../../../lib/campaigns';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.automationRun.findMany({ where: { tenantId: user.tenantId }, include: { campaign: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }));
});
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  const { campaignId } = z.object({ campaignId: z.string() }).strict().parse(await jsonBody(req));
  const c = await campaignReady(user.tenantId, campaignId);
  if (c.status !== 'ACTIVE' || c.automationMode === 'PAUSED') throw new HttpError(409, 'campaign_inactive');
  const key = req.headers.get('idempotency-key');
  if (!key || key.length > 100) throw new HttpError(400, 'idempotency_key_required');
  const idempotencyKey = user.tenantId + ':' + campaignId + ':' + key;
  const run = await db.automationRun.upsert({
    where: { idempotencyKey },
    update: {
      status: 'QUEUED',
      errors: Prisma.DbNull,
      attempts: 0,
      availableAt: new Date(),
      leaseUntil: null,
      leaseToken: null,
      finishedAt: null
    },
    create: { tenantId: user.tenantId, campaignId, idempotencyKey }
  });
  return Response.json(run, { status: 202 });
});
