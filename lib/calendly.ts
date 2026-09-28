import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './http';
import { timingSafeEqualText } from './security';
import type { ProviderEvent } from './webhooks';

// Calendly adapter: signed campaign/contact attribution for outgoing links and
// verification/normalization of Calendly webhook deliveries. Only a verified
// invitee.created event is ever converted into a booking.

function attributionKey() {
  const key = Buffer.from(process.env.DATA_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must encode 32 random bytes');
  return createHmac('sha256', key).update('calendly-attribution-v1').digest();
}
function mac(tenantId: string, campaignId: string, contactId: string) {
  return createHmac('sha256', attributionKey()).update(`${tenantId}|${campaignId}|${contactId}`).digest('base64url').slice(0, 32);
}

export function attributionToken(tenantId: string, campaignId: string, contactId: string) {
  return `${campaignId}.${contactId}.${mac(tenantId, campaignId, contactId)}`;
}
export function parseAttributionToken(tenantId: string, token: unknown): { campaignId: string; contactId: string } | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const [campaignId, contactId, given, extra] = token.split('.');
  if (!campaignId || !contactId || !given || extra !== undefined) return null;
  return timingSafeEqualText(mac(tenantId, campaignId, contactId), given) ? { campaignId, contactId } : null;
}
// Adds a signed token that Calendly echoes back in tracking.utm_content.
export function schedulingUrl(baseUrl: string, tenantId: string, campaignId: string, contactId: string) {
  const url = new URL(baseUrl);
  url.searchParams.set('utm_source', 'leadmelo');
  url.searchParams.set('utm_content', attributionToken(tenantId, campaignId, contactId));
  return url.toString();
}

// Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "t.body">
// (developer.calendly.com/api-docs/overview/webhooks/webhook-signatures). Calendly recommends
// rejecting timestamps older than 3 minutes.
export function verifyCalendlySignature(raw: string, header: string, signingKey: string, now = Date.now()) {
  const parts = Object.fromEntries(header.split(',').map(p => p.trim().split('=') as [string, string]));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1 || !/^\d{10}$/.test(t) || Math.abs(now - Number(t) * 1000) > 180000) return false;
  return timingSafeEqualText(createHmac('sha256', signingKey).update(`${t}.${raw}`).digest('hex'), v1);
}

const invitee = z.object({
  uri: z.string().url().max(500),
  email: z.string().email(),
  timezone: z.string().max(100).nullish(),
  tracking: z.object({ utm_content: z.string().nullish() }).passthrough().nullish(),
  scheduled_event: z.object({ uri: z.string().url().max(500), start_time: z.string().datetime({ offset: true }), end_time: z.string().datetime({ offset: true }) }).passthrough(),
  // Calendly's documented Cancellation object: { canceled_by, reason, canceler_type, created_at }.
  cancellation: z.object({ created_at: z.string().datetime({ offset: true }).optional() }).passthrough().nullish(),
  updated_at: z.string().datetime({ offset: true }).optional()
}).passthrough();
export const calendlyEnvelope = z.object({
  event: z.string().max(100),
  created_at: z.string().datetime({ offset: true }),
  payload: z.unknown()
}).passthrough();

export type CalendlyNormalized =
  | { ignored: true; reason: string }
  | { ignored?: false; event: Extract<ProviderEvent, { type: 'booking.created' | 'booking.canceled' }>; inviteeEmail: string; attribution: { campaignId: string; contactId: string } };

// `contactEmail` resolves the attributed contact (by signed token) to its stored
// address; the invitee's own email is returned so callers can flag mismatches.
export function normalizeCalendlyEvent(tenantId: string, envelopeInput: unknown, resolveContactEmail: (contactId: string) => string | null): CalendlyNormalized {
  const envelope = calendlyEnvelope.parse(envelopeInput);
  if (envelope.event !== 'invitee.created' && envelope.event !== 'invitee.canceled') return { ignored: true, reason: 'unsupported_event' };
  const payload = invitee.parse(envelope.payload);
  const attribution = parseAttributionToken(tenantId, payload.tracking?.utm_content);
  if (!attribution) return { ignored: true, reason: 'unattributed_booking' };
  const email = resolveContactEmail(attribution.contactId);
  if (!email) throw new HttpError(404, 'campaign_contact_not_found');
  const start = new Date(payload.scheduled_event.start_time).toISOString(), end = new Date(payload.scheduled_event.end_time).toISOString();
  const created = envelope.event === 'invitee.created';
  const occurredAt = new Date(created ? envelope.created_at : payload.cancellation?.created_at ?? envelope.created_at).toISOString();
  return {
    attribution, inviteeEmail: payload.email.toLowerCase(),
    event: { id: `calendly:${envelope.event}:${payload.uri}:${envelope.created_at}`, occurredAt, type: created ? 'booking.created' : 'booking.canceled', campaignId: attribution.campaignId, email, bookingId: payload.uri, start, end, timezone: payload.timezone ?? 'UTC', eventUrl: payload.scheduled_event.uri }
  };
}
