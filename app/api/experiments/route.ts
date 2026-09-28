import { z } from 'zod';
import { authenticate } from '../../../lib/auth';
import { db } from '../../../lib/db';
import { endpoint, jsonBody } from '../../../lib/http';
import { createExperiment, experimentResults, setExperimentStatus } from '../../../lib/experiments';

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  const id = new URL(req.url).searchParams.get('id');
  if (id) return Response.json(await experimentResults(user.tenantId, id));
  return Response.json(await db.experiment.findMany({ where: { tenantId: user.tenantId }, include: { variants: { select: { id: true, label: true, isControl: true, weight: true } }, recommendations: true }, orderBy: { createdAt: 'desc' }, take: 100 }));
});
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  return Response.json(await createExperiment(user.tenantId, user, await jsonBody(req)), { status: 201 });
});
export const PATCH = endpoint(async req => {
  const user = await authenticate(req, true);
  const { id, status } = z.object({ id: z.string(), status: z.enum(['RUNNING', 'STOPPED']) }).strict().parse(await jsonBody(req, 2048));
  await setExperimentStatus(user.tenantId, user, id, status);
  return Response.json({ ok: true });
});
