import { db } from '../../../../../lib/db';
import { decrypt } from '../../../../../lib/crypto';
import { endpoint, HttpError } from '../../../../../lib/http';
import { rateLimit } from '../../../../../lib/auth';
import { handleProviderEvent } from '../../../../../lib/webhooks';
import { normalizeCalendlyEvent, parseAttributionToken, verifyCalendlySignature } from '../../../../../lib/calendly';

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
    // The contact id comes from the SIGNATURE-VERIFIED token. It used to be read with a bare
    // utm_content.split('.')[1], which skips verification and disagrees with the verified parse
    // on a malformed token (parseAttributionToken also rejects extra segments), so the mismatch
    // check could compare the invitee against a different contact's address entirely.
    const utmContent = (data as { payload?: { tracking?: { utm_content?: string } } })?.payload?.tracking?.utm_content;
    const verified = parseAttributionToken(tenantId, utmContent);
    const contact = verified ? await db.contact.findFirst({ where: { id: verified.contactId, tenantId }, select: { email: true } }) : null;
    const result = normalizeCalendlyEvent(tenantId, data, () => contact?.email ?? null);
    // Unattributed bookings are acknowledged (so Calendly does not retry) but never create an appointment.
    if (result.ignored) {
      logCalendly({ tenantId, outcome: 'ignored', reason: result.reason, calendlyEvent: typeof (data as { event?: unknown }).event === 'string' ? (data as { event: string }).event : null });
      return Response.json({ ignored: true, reason: result.reason });
    }
    // Compare case-insensitively. Calendly reports the invitee address in lower case, but the
    // contact's stored address keeps its original case, so the same mailbox in different case
    // raised a false booking_invitee_mismatch.
    const inviteeMismatch = result.inviteeEmail !== result.event.email.toLowerCase();
    if (inviteeMismatch) {
      await db.operationalAlert.upsert({ where: { key: `${tenantId}:booking_invitee_mismatch:${result.event.bookingId}` }, update: {}, create: { tenantId, key: `${tenantId}:booking_invitee_mismatch:${result.event.bookingId}`, code: 'booking_invitee_mismatch', entityId: result.event.bookingId } });
    }
    const saved = await handleProviderEvent(tenantId, result.event);
    // A mismatch with no way to tell a real one from noise is not actionable, so record whether
    // the invitee simply used another address on the same domain as the contact.
    logCalendly({ tenantId, outcome: saved.duplicate ? 'duplicate' : 'applied', bookingType: result.event.type, inviteeMismatch, inviteeDomain: result.inviteeEmail.split('@')[1] ?? null, contactDomain: result.event.email.toLowerCase().split('@')[1] ?? null });
    return Response.json(saved);
  })(req);
}
