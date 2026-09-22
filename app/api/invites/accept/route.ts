import { z } from 'zod';
import { assertOrigin, rateLimit } from '../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../lib/http';
import { acceptInvite, passwordSchema } from '../../../../lib/identity';

export const POST = endpoint(async req => {
  assertOrigin(req);
  await rateLimit('invite-accept', 60, 1);
  const body = z.object({ token: z.string().length(64), password: passwordSchema, name: z.string().trim().max(200).optional() }).strict().parse(await jsonBody(req, 4096));
  await acceptInvite(body.token, body.password, body.name);
  return Response.json({ ok: true }, { status: 201 });
});
