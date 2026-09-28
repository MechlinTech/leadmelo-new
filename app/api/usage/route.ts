import { authenticate } from '../../../lib/auth';
import { endpoint } from '../../../lib/http';
import { usageSummary } from '../../../lib/usage';

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await usageSummary(user.tenantId), { headers: { 'Cache-Control': 'no-store' } });
});
