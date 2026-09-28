import { z } from 'zod';
import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
import { icpInput } from '../../../lib/validation';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.iCP.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 500 }));
});
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  const raw = await jsonBody(req) as Record<string, unknown>;
  if (raw.duplicateFrom) {
    const src = await db.iCP.findFirst({ where: { id: String(raw.duplicateFrom), tenantId: user.tenantId } });
    if (!src) throw new HttpError(404, 'icp_not_found');
    return Response.json(await db.iCP.create({
      data: {
        tenantId: user.tenantId,
        name: `${src.name} (copy)`.slice(0, 200),
        offer: src.offer,
        industries: src.industries,
        companySizes: src.companySizes,
        geographies: src.geographies,
        technologies: src.technologies,
        buyingSignals: src.buyingSignals,
        buyerTitles: src.buyerTitles,
        exclusionRules: src.exclusionRules,
        minScore: src.minScore,
        weeklyAppointmentGoal: src.weeklyAppointmentGoal,
        active: true
      }
    }), { status: 201 });
  }
  const body = icpInput.parse(raw);
  return Response.json(await db.iCP.create({ data: { ...body, tenantId: user.tenantId } }), { status: 201 });
});
export const PATCH = endpoint(async req => {
  const user = await authenticate(req, true);
  const raw = await jsonBody(req) as Record<string, unknown>;
  const id = z.string().parse(raw.id);
  const { id: _id, ...rest } = raw;
  const body = icpInput.parse(rest);
  const result = await db.iCP.updateMany({ where: { id, tenantId: user.tenantId }, data: body });
  if (!result.count) throw new HttpError(404, 'icp_not_found');
  return Response.json({ ok: true });
});
export const DELETE = endpoint(async req => {
  const user = await authenticate(req, true);
  const id = new URL(req.url).searchParams.get('id');
  if (!id) throw new HttpError(400, 'id_required');
  const used = await db.campaign.count({ where: { tenantId: user.tenantId, icpId: id } });
  if (used) {
    const result = await db.iCP.updateMany({ where: { id, tenantId: user.tenantId }, data: { active: false } });
    if (!result.count) throw new HttpError(404, 'icp_not_found');
    return Response.json({ ok: true, deactivated: true });
  }
  const result = await db.iCP.deleteMany({ where: { id, tenantId: user.tenantId } });
  if (!result.count) throw new HttpError(404, 'icp_not_found');
  return Response.json({ ok: true, deleted: true });
});
