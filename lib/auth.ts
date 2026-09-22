import { randomBytes } from 'node:crypto';
import { db } from './db';
import { hashToken } from './security';
import { HttpError } from './http';

export const sessionCookie = 'leadmelo_session';
export function assertOrigin(req: Request) {
  const expected = new URL(process.env.APP_URL ?? 'http://localhost:7676').origin;
  if (req.headers.get('origin') !== expected) throw new HttpError(403, 'origin_not_allowed');
}
export async function rateLimit(key: string, limit: number, minutes: number) {
  const bucket = Math.floor(Date.now() / (minutes * 60000));
  const row = await db.rateLimit.upsert({
    where: { key: `${key}:${bucket}` },
    create: { key: `${key}:${bucket}`, count: 1, expiresAt: new Date((bucket + 1) * minutes * 60000) },
    update: { count: { increment: 1 } }
  });
  if (row.count > limit) throw new HttpError(429, 'rate_limit_exceeded');
}
export async function sessionUser(token?: string) {
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.expiresAt <= new Date() || session.user.disabled) return null;
  return session.user;
}
export async function authenticate(req: Request, write = false) {
  if (write) assertOrigin(req);
  const cookie = req.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${sessionCookie}=`));
  const user = await sessionUser(cookie?.slice(sessionCookie.length + 1));
  if (!user || !user.tenantId) throw new HttpError(401, 'authentication_required');
  if (write && !['TENANT_ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(user.role)) throw new HttpError(403, 'role_not_allowed');
  await rateLimit(`api:${user.id}`, 300, 1);
  return { ...user, tenantId: user.tenantId };
}
export async function createSession(userId: string) {
  const token = randomBytes(32).toString('hex');
  await db.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 8 * 3600000) } });
  return token;
}
export function cookieHeader(token: string, maxAge = 28800) {
  const secure = (process.env.APP_URL ?? '').startsWith('https:') ? '; Secure' : '';
  return `${sessionCookie}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
