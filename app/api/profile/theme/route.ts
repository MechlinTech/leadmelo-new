import { z } from 'zod';
import { db } from '../../../../lib/db';
import { assertOrigin, authenticate } from '../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../lib/http';
import { THEME_IDS, themeCookieHeader, type ThemeId } from '../../../../lib/themes';

// Any signed-in user may choose their own theme; it follows the account across devices.
export const PUT = endpoint(async req => {
  assertOrigin(req);
  const user = await authenticate(req);
  const { theme } = z.object({ theme: z.enum(THEME_IDS as [ThemeId, ...ThemeId[]]) }).strict().parse(await jsonBody(req, 512));
  await db.user.update({ where: { id: user.id }, data: { theme } });
  return Response.json({ ok: true, theme }, { headers: { 'Set-Cookie': themeCookieHeader(theme) } });
});
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  const row = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { theme: true } });
  return Response.json({ theme: row.theme ?? 'system' });
});
