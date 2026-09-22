import { z } from 'zod';
import { assertOrigin, rateLimit } from '../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../lib/http';
import { consumeReset, passwordSchema } from '../../../../lib/identity';

export const POST = endpoint(async req => {
  assertOrigin(req);
  await rateLimit('password-reset', 60, 1);
  const body = z.object({ token: z.string().length(64), password: passwordSchema }).strict().parse(await jsonBody(req, 4096));
  await consumeReset(body.token, body.password);
  return Response.json({ ok: true });
});
