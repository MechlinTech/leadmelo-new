import { endpoint, jsonBody } from '../../../../lib/http';
import { assertOrigin, rateLimit } from '../../../../lib/auth';
import { clientKey } from '../../../../lib/public';
import { requireResetEmail, RESET_REQUESTS_PER_CALLER, RESET_REQUESTS_TOTAL, RESET_REQUEST_ANSWER, requestPasswordReset } from '../../../../lib/passwordRecovery';

// "Forgot password?" on the sign-in page.
//
// Order matters: the origin check first (CSRF), then a shape check that costs no
// database work, then the rate-limit budgets, and only then the account lookup.
//
// The status and body are identical for every well-formed address, so this endpoint
// can never confirm whether an account exists. Only a malformed address (400) and an
// exhausted budget (429) are distinguishable, and neither depends on the account.
// A delivery failure is deliberately not reported: a 502 here would confirm that the
// address is registered.
export const POST = endpoint(async req => {
  assertOrigin(req);
  const body = await jsonBody(req, 2048) as { email?: unknown };
  const email = requireResetEmail(body?.email);
  await rateLimit(`password-reset-request:ip:${clientKey(req)}`, RESET_REQUESTS_PER_CALLER, 60);
  await rateLimit('password-reset-request:all', RESET_REQUESTS_TOTAL, 60);
  await requestPasswordReset(email);
  return Response.json({ ok: true, message: RESET_REQUEST_ANSWER });
});