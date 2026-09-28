import { endpoint, jsonBody } from '../../../../lib/http';
import { createAccessRequest, publicGuard } from '../../../../lib/public';

// Public form behind the pricing page and the assistant. No email is sent: the operator reads requests in the admin console.
export const POST = endpoint(async req => {
  await publicGuard(req, 'access-request', 5, 60, 200);
  await createAccessRequest(await jsonBody(req, 8192));
  return Response.json({ ok: true }, { status: 201 });
});
