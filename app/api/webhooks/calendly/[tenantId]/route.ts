import { db } from '../../../../../lib/db';
import { decrypt } from '../../../../../lib/crypto';
import { endpoint, HttpError } from '../../../../../lib/http';
import { rateLimit } from '../../../../../lib/auth';
import { handleProviderEvent } from '../../../../../lib/webhooks';
import { normalizeCalendlyEvent, verifyCalendlySignature } from '../../../../../lib/calendly';

function logCalendly(fields: Record<string, string | number | boolean | null>) {
  console.log(JSON.stringify({ event: 'calendly_webhook', ...fields }));
}

export async function POST(req: Request, context: { params: Promise<{ tenantId: string }> }) {
  return endpoint(async request => {
    const { tenantId } = await context.params;
    const settings = await db.tenantSetting.findUnique({ where: { tenantId } });
    if (!settings?.calendlySigningKey) throw new HttpError(401, 'invalid_webhook');
    await rateLimit(`calendly:${tenantId}`, 600, 1);
    if (!request.body) throw new HttpError(400, 'body_required');
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw new HttpError(413, 'body_too_large'); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!verifyCalendlySignature(raw, request.headers.get('calendly-webhook-signature') ?? '', decrypt(settings.calendlySigningKey))) {
      logCalendly({ tenantId, outcome: 'rejected', reason: 'invalid_signature' });
      throw new HttpError(401, 'invalid_webhook');
    }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json'); }
    // Resolve the attributed contact's stored address (tenant-scoped) before normalizing.
    const tokenContactId = (data as { payload?: { tracking?: { utm_content?: string } } })?.payload?.tracking?.utm_content?.split('.')[1];
    const contact = tokenContactId ? await db.contact.findFirst({ where: { id: tokenContactId, tenantId }, select: { email: true } }) : null;
    const result = normalizeCalendlyEvent(tenantId, data, () => contact?.email ?? null);
    // Unattributed bookings are acknowledged (so Calendly does not retry) but never create an appointment.
    if (result.ignored) {
      logCalendly({ tenantId, outcome: 'ignored', reason: result.reason, calendlyEvent: typeof (data as { event?: unknown }).event === 'string' ? (data as { event: string }).event : null });
      return Response.json({ ignored: true, reason: result.reason });
    }
    if (result.inviteeEmail !== result.event.email) {
      await db.operationalAlert.upsert({ where: { key: `${tenantId}:booking_invitee_mismatch:${result.event.bookingId}` }, update: {}, create: { tenantId, key: `${tenantId}:booking_invitee_mismatch:${result.event.bookingId}`, code: 'booking_invitee_mismatch', entityId: result.event.bookingId } });
    }
    const saved = await handleProviderEvent(tenantId, result.event);
    logCalendly({ tenantId, outcome: saved.duplicate ? 'duplicate' : 'applied', bookingType: result.event.type, inviteeMismatch: result.inviteeEmail !== result.event.email });
    return Response.json(saved);
  })(req);
}
