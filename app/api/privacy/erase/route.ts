import { z } from 'zod';
import { authenticate } from '../../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../../lib/http';
import { eraseSubject } from '../../../../lib/privacy';

// Irreversible: removes the person's contact record, replies and message text for this tenant
// and permanently suppresses the address.
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  if (!['TENANT_ADMIN', 'SUPER_ADMIN'].includes(user.role)) throw new HttpError(403, 'admin_required');
  const { email } = z.object({ email: z.string().trim().email().max(254), confirm: z.literal(true) }).strict().parse(await jsonBody(req, 2048));
  return Response.json({ erased: await eraseSubject(user.tenantId, user.id, email) });
});
