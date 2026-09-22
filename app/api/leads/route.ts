import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint } from '../../../lib/http';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.lead.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 100 }));
});
