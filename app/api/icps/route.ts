import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, jsonBody } from '../../../lib/http';
import { icpInput } from '../../../lib/validation';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.iCP.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 100 }));
});
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  const body = icpInput.parse(await jsonBody(req));
  return Response.json(await db.iCP.create({ data: { ...body, tenantId: user.tenantId } }), { status: 201 });
});
