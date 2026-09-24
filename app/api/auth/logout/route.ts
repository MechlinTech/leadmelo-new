import { db } from '../../../../lib/db';
import { assertOrigin, cookieHeader, sessionCookie, sessionUser } from '../../../../lib/auth';
import { endpoint } from '../../../../lib/http';
export const POST = endpoint(async req => {
  assertOrigin(req);
  const cookie = req.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${sessionCookie}=`));
  const user = await sessionUser(cookie?.slice(sessionCookie.length + 1));
  if (user) await db.session.deleteMany({ where: { userId: user.id } });
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookieHeader('', 0) } });
});
