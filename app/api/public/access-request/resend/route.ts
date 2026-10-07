import { endpoint, jsonBody } from '../../../../../lib/http';
import { publicGuard } from '../../../../../lib/public';
import { resendSetupEmail } from '../../../../../lib/onboarding';

// Resend the account-setup email. Returns a generic answer for unknown emails;
// a delivery failure is reported as such, never dressed up as success.
export const POST = endpoint(async req => {
  await publicGuard(req, 'access-resend', 5, 60, 100);
  const body = await jsonBody(req, 2048) as { email?: unknown };
  return Response.json(await resendSetupEmail(body?.email));
});
