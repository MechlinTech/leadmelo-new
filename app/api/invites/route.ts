import { z } from 'zod';
import { authenticate } from '../../../lib/auth';
import { endpoint, jsonBody } from '../../../lib/http';
import { createInvite, revokeInvite, listInvites, INVITE_ROLES } from '../../../lib/identity';

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await listInvites(user.tenantId));
});
// Returns the one-time acceptance URL; the administrator delivers it (no platform mail service).
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  const body = z.object({ email: z.string().email().max(254), role: z.enum(INVITE_ROLES) }).strict().parse(await jsonBody(req, 4096));
  const { token, expiresAt } = await createInvite(user, body.email, body.role);
  return Response.json({ acceptUrl: `${process.env.APP_URL}/auth/accept?token=${token}`, expiresAt }, { status: 201 });
});
export const DELETE = endpoint(async req => {
  const user = await authenticate(req, true);
  const id = new URL(req.url).searchParams.get('id') ?? '';
  await revokeInvite(user, id);
  return Response.json({ ok: true });
});
