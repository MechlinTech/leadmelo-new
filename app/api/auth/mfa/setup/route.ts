import { authenticate, assertOrigin } from '../../../../../lib/auth';
import { endpoint } from '../../../../../lib/http';
import { setupMfa } from '../../../../../lib/identity';

export const POST = endpoint(async req => {
  assertOrigin(req);
  const user = await authenticate(req);
  return Response.json(await setupMfa(user.id, user.email));
});
