import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from './db';
import { assertOrigin, rateLimit } from './auth';
import { HttpError } from './http';
import { PLANS, type PlanId } from './plans';
import { sendPlatformNotice } from './m365/send';

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
  // Repeated submissions for the same email do not create duplicate requests or spam the inbox.
  const existing = await db.accessRequest.findFirst({ where: { email: input.email, status: { in: ['PENDING', 'APPROVED'] } }, select: { id: true } });
  if (existing) return { ok: true, stored: false };
  const request = await db.accessRequest.create({ data: { name: input.name, email: input.email, company: input.company || null, message: input.message || null, plan: input.plan ?? null, source: input.source } });
  await sendRequestReceivedNotice(request.id);
  return { ok: true, stored: true };
}

// Confirmation sent right after a request is accepted. Tells the requester access is
// pending approval; no account exists yet and no password link is sent at this stage.
export async function sendRequestReceivedNotice(requestId: string, send: typeof sendPlatformNotice = sendPlatformNotice) {
  const request = await db.accessRequest.findUnique({ where: { id: requestId } });
  if (!request) return { emailed: false, emailError: 'request_not_found' };
  try {
    const emailed = await send(
      request.email,
      'Your LeadMelo access request was received',
      `Hi ${request.name},\n\nYour LeadMelo access request has been submitted successfully. Please check your email for confirmation and next steps.\n\nYour request is pending review by our team. Approval is required before an account is created. Once approved, we will email you a confirmation that your account is ready, your registered login email, and a secure single-use link to set your password.\n`
    );
    await db.accessRequest.update({ where: { id: requestId }, data: emailed ? { lastEmailAt: new Date(), emailError: null } : { emailError: 'm365_not_connected' } });
    return { emailed, emailError: emailed ? '' : 'm365_not_connected' };
  } catch (error) {
    const emailError = error instanceof Error ? error.message.slice(0, 200) : 'send_failed';
    await db.accessRequest.update({ where: { id: requestId }, data: { emailError } });
    return { emailed: false, emailError };
  }
}
export { HttpError };
