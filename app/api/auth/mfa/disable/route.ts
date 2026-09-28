import { z } from 'zod';
import { authenticate, assertOrigin, rateLimit } from '../../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../../lib/http';
import { disableMfa } from '../../../../../lib/identity';

export const POST = endpoint(async req => {
  assertOrigin(req);
  const user = await authenticate(req);
  await rateLimit(`mfa-disable:${user.id}`, 10, 15);
  const body = z.object({ password: z.string().min(1).max(256), code: z.string().min(6).max(32) }).strict().parse(await jsonBody(req, 1024));
  await disableMfa(user.id, body.password, body.code);
  return Response.json({ ok: true });
});
