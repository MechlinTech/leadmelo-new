import { z } from 'zod';
import { db } from '../../../../../../lib/db';
import { authenticate } from '../../../../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../../../../lib/http';
import { PLANS, type PlanId } from '../../../../../../lib/plans';

// Platform operator sets a tenant's plan (there is no online checkout yet). Limits apply only when PLAN_ENFORCEMENT=on.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return endpoint(async r => {
    const user = await authenticate(r, true);
    if (user.role !== 'SUPER_ADMIN') throw new HttpError(403, 'super_admin_required');
    const { id } = await ctx.params;
    const { plan } = z.object({ plan: z.enum(Object.keys(PLANS) as [PlanId, ...PlanId[]]) }).strict().parse(await jsonBody(r, 1024));
    if (!await db.tenant.findUnique({ where: { id }, select: { id: true } })) throw new HttpError(404, 'tenant_not_found');
    await db.tenant.update({ where: { id }, data: { plan } });
    await db.auditEvent.create({ data: { tenantId: id, actorUserId: user.id, action: 'plan_changed', metadata: { plan } } });
    return Response.json({ ok: true, plan });
  })(req);
}
