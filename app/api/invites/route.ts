import { z } from 'zod';
import { authenticate } from '../../../lib/auth';
import { endpoint, jsonBody } from '../../../lib/http';
import { createInvite, revokeInvite, listInvites, INVITE_ROLES } from '../../../lib/identity';
import { sendWorkspaceNotice } from '../../../lib/m365/send';
import { db } from '../../../lib/db';

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await listInvites(user.tenantId));
});
// Returns the one-time acceptance URL; the administrator delivers it (no platform mail service).
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  const body = z.object({ email: z.string().email().max(254), role: z.enum(INVITE_ROLES) }).strict().parse(await jsonBody(req, 4096));
  const { token, expiresAt } = await createInvite(user, body.email, body.role);
  const acceptUrl = `${process.env.APP_URL}/auth/accept?token=${token}`;
  const tenant = await db.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } });
  let emailed = false;
  let emailError = '';
  try {
    emailed = await sendWorkspaceNotice(user.tenantId, body.email, `Invitation to ${tenant?.name ?? 'LeadMelo'}`, `You have been invited to the ${tenant?.name ?? 'LeadMelo'} workspace.\n\nOpen this link to set your password and join. It expires in 72 hours and can be used once:\n${acceptUrl}\n`);
    if (!emailed) emailError = 'm365_not_connected';
  } catch (error) {
    emailed = false;
    emailError = error instanceof Error ? error.message : 'm365_not_connected';
  }
  return Response.json({ acceptUrl, expiresAt, emailed, emailError }, { status: 201 });
});
export const DELETE = endpoint(async req => {
  const user = await authenticate(req, true);
  const id = new URL(req.url).searchParams.get('id') ?? '';
  await revokeInvite(user, id);
  return Response.json({ ok: true });
});
