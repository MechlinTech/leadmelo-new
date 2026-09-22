import { z } from 'zod';
import { db } from '../../../../../../lib/db';
import { authenticate } from '../../../../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../../../../lib/http';

// Platform operator control: a suspended tenant cannot discover, purchase or send.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return endpoint(async r => {
    const user = await authenticate(r, true);
    if (user.role !== 'SUPER_ADMIN') throw new HttpError(403, 'super_admin_required');
    const { id } = await ctx.params;
    const { suspended } = z.object({ suspended: z.boolean() }).strict().parse(await jsonBody(r));
    if (!await db.tenant.findUnique({ where: { id }, select: { id: true } })) throw new HttpError(404, 'tenant_not_found');
    await db.tenantSetting.upsert({ where: { tenantId: id }, update: { suspended }, create: { tenantId: id, suspended } });
    await db.auditEvent.create({ data: { tenantId: id, actorUserId: user.id, action: suspended ? 'tenant_suspended' : 'tenant_reinstated' } });
    return Response.json({ ok: true, suspended });
  })(req);
}
