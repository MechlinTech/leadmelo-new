import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from './db';
import { assertOrigin, rateLimit } from './auth';
import { HttpError } from './http';
import { PLANS, type PlanId } from './plans';

// Helpers for unauthenticated endpoints. The caller's address is only ever stored as a hash, and only
// for rate limiting (the buckets expire); it is never written to a table.
export function clientKey(req: Request) {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  return createHash('sha256').update(forwarded).digest('hex').slice(0, 16);
}
export async function publicGuard(req: Request, name: string, perIp: number, minutes: number, global: number) {
  assertOrigin(req);
  await rateLimit(`${name}:ip:${clientKey(req)}`, perIp, minutes);
  await rateLimit(`${name}:all`, global, minutes);
}

export const accessRequestInput = z.object({
  name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email().max(254),
  company: z.string().trim().max(160).optional(), message: z.string().trim().max(2000).optional(),
  plan: z.enum(Object.keys(PLANS) as [PlanId, ...PlanId[]]).optional(), source: z.enum(['pricing', 'assistant', 'contact']).default('contact'),
  website: z.string().max(200).optional() // honeypot: real people never fill this hidden field
}).strict();

export async function createAccessRequest(raw: unknown) {
  const input = accessRequestInput.parse(raw);
  if (input.website) return { ok: true, stored: false }; // bots get a normal-looking answer and nothing is stored
  await db.accessRequest.create({ data: { name: input.name, email: input.email, company: input.company || null, message: input.message || null, plan: input.plan ?? null, source: input.source } });
  return { ok: true, stored: true };
}
export { HttpError };
