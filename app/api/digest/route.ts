import { authenticate } from '../../../lib/auth';
import { endpoint } from '../../../lib/http';
import { buildDigest } from '../../../lib/digest';

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await buildDigest(user.tenantId));
});
