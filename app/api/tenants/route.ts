import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint } from '../../../lib/http';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.tenant.findUnique({ where: { id: user.tenantId }, select: { id: true, name: true, slug: true, plan: true } }));
});
