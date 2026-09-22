import { db } from '../../../../lib/db';
import { authenticate, cookieHeader } from '../../../../lib/auth';
import { endpoint } from '../../../../lib/http';
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  await db.session.deleteMany({ where: { userId: user.id } });
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookieHeader('', 0) } });
});
