import { z } from 'zod';
import { authenticate, assertOrigin, rateLimit } from '../../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../../lib/http';
import { enableMfa } from '../../../../../lib/identity';

export const POST = endpoint(async req => {
  assertOrigin(req);
  const user = await authenticate(req);
  await rateLimit(`mfa-enable:${user.id}`, 10, 15);
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(await jsonBody(req, 1024));
  return Response.json(await enableMfa(user.id, code));
});
