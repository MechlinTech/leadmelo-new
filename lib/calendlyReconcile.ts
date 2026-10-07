import { z } from 'zod';
import { db } from './db';
import { decrypt } from './crypto';
import { HttpError } from './http';
import { raiseAlert } from './alerts';
import { handleProviderEvent } from './webhooks';
import { calendlyLinkSlug, calendlySubscriptionCovers, normalizeCalendlyEvent, type CalendlySubscription } from './calendly';

// Recovers bookings whose webhooks were missed. Calendly API per its OpenAPI file:
//   GET /scheduled_events?organization=&min_start_time=&count=&page_token=   -> { collection, pagination.next_page_token }
//   GET /scheduled_events/{uuid}/invitees?count=&page_token=                -> invitees with uri,email,status,timezone,created_at,tracking,cancellation
// Every booking is fed through the same signed-attribution and idempotent path as a webhook, so running this
// repeatedly, or alongside webhooks, cannot create duplicates. Bookings without a valid attribution token are ignored.
const API = 'https://api.calendly.com';
const page = z.object({ collection: z.array(z.record(z.string(), z.unknown())), pagination: z.object({ next_page_token: z.string().nullish() }).passthrough().optional() }).passthrough();
const event = z.object({ uri: z.string().url(), start_time: z.string(), end_time: z.string(), status: z.string().optional() }).passthrough();
const invitee = z.object({ uri: z.string().url(), email: z.string(), status: z.string(), timezone: z.string().nullish(), created_at: z.string(), updated_at: z.string().optional(), tracking: z.object({ utm_content: z.string().nullish() }).passthrough().nullish(), cancellation: z.object({ created_at: z.string().optional() }).passthrough().nullish() }).passthrough();
const MAX_PAGES = 5;

async function get(fetcher: typeof fetch, token: string, url: URL) {
  if (url.origin !== API) throw new HttpError(502, 'calendly_unexpected_origin');
  const res = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'calendly_auth_failed');
  if (res.status === 429) throw new HttpError(503, 'calendly_rate_limited');
  if (!res.ok) throw new HttpError(502, `calendly_http_${res.status}`);
  const text = await res.text();
  if (text.length > 2_000_000) throw new HttpError(502, 'calendly_response_too_large');
  return page.parse(JSON.parse(text));
}

async function readJson(fetcher: typeof fetch, token: string, url: URL) {
  if (url.origin !== API) throw new HttpError(502, 'calendly_unexpected_origin');
  const res = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'calendly_auth_failed');
  if (res.status === 429) throw new HttpError(503, 'calendly_rate_limited');
  if (!res.ok) throw new HttpError(502, `calendly_http_${res.status}`);
  const text = await res.text();
  if (text.length > 2_000_000) throw new HttpError(502, 'calendly_response_too_large');
  return JSON.parse(text) as unknown;
}

// Reports a webhook pointed at another app, or a token whose Calendly user does not own the campaign link.
// Diagnostic only: a failure here must not block importing attributed bookings.
export async function auditCalendlyConnection(tenantId: string, fetcher: typeof fetch, token: string, org: string, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const me = await readJson(fetcher, token, new URL(`${API}/users/me`)) as { resource?: { uri?: string; slug?: string } };
  const slug = me.resource?.slug;
  const campaigns = await db.campaign.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { calendlyUrl: true } });
  const hosts = [...new Set(campaigns.map(c => calendlyLinkSlug(c.calendlyUrl)).filter((v): v is string => !!v))];
  if (slug && hosts.some(h => h !== slug)) {
    await raiseAlert(tenantId, 'calendly_account_mismatch', `${slug}:${hosts.filter(h => h !== slug).sort().join(',')}:${day}`);
  }
  const orgHooks = await readJson(fetcher, token, new URL(`${API}/webhook_subscriptions?organization=${encodeURIComponent(org)}&scope=organization&count=20`)) as { collection?: CalendlySubscription[] };
  const userUri = me.resource?.uri;
  const userHooks = userUri
    ? await readJson(fetcher, token, new URL(`${API}/webhook_subscriptions?organization=${encodeURIComponent(org)}&scope=user&user=${encodeURIComponent(userUri)}&count=20`)) as { collection?: CalendlySubscription[] }
    : { collection: [] };
  const app = (process.env.APP_URL ?? '').replace(/\/$/, '');
  if (app) {
    const expected = `${app}/api/webhooks/calendly/${tenantId}`;
    const subs = [...(orgHooks.collection ?? []), ...(userHooks.collection ?? [])];
    if (!calendlySubscriptionCovers(subs, expected)) await raiseAlert(tenantId, 'calendly_webhook_missing', day);
  }
}

export async function reconcileCalendly(tenantId: string, fetcher: typeof fetch = fetch, now = new Date()) {
  const s = await db.tenantSetting.findUnique({ where: { tenantId } });
  if (!s?.calendlyToken || !s.calendlyOrganizationUri) return { skipped: 'not_configured' as const };
  const token = decrypt(s.calendlyToken), org = s.calendlyOrganizationUri;
  try { await auditCalendlyConnection(tenantId, fetcher, token, org, now); }
  catch (error) {
    console.error(JSON.stringify({ event: 'calendly_connection_audit_failed', tenantId, code: error instanceof HttpError ? error.message : 'calendly_connection_audit_failed' }));
  }
  // Recent past and every future meeting: a booking made today can start weeks from now.
  const minStart = new Date(now.getTime() - 86400000).toISOString();
  const counts = { events: 0, invitees: 0, applied: 0, ignored: 0, duplicates: 0 };
  let events: Array<z.infer<typeof event>> = [], pageTokenEvents: string | null | undefined;
  for (let p = 0; p < MAX_PAGES; p++) {
    const u = new URL(`${API}/scheduled_events`);
    u.searchParams.set('organization', org); u.searchParams.set('min_start_time', minStart); u.searchParams.set('count', '100'); u.searchParams.set('sort', 'start_time:asc');
    if (pageTokenEvents) u.searchParams.set('page_token', pageTokenEvents);
    const r = await get(fetcher, token, u);
    events = events.concat(r.collection.map(x => event.parse(x)));
    pageTokenEvents = r.pagination?.next_page_token; if (!pageTokenEvents) break;
  }
  counts.events = events.length;
  for (const ev of events) {
    let pageToken: string | null | undefined;
    for (let p = 0; p < MAX_PAGES; p++) {
      const u = new URL(`${ev.uri}/invitees`); u.searchParams.set('count', '100');
      if (pageToken) u.searchParams.set('page_token', pageToken);
      const r = await get(fetcher, token, u);
      for (const raw of r.collection) {
        const inv = invitee.parse(raw); counts.invitees++;
        const canceled = inv.status === 'canceled' || ev.status === 'canceled';
        const at = canceled ? (inv.cancellation?.created_at ?? inv.updated_at ?? inv.created_at) : inv.created_at;
        const payload = { uri: inv.uri, email: inv.email, timezone: inv.timezone ?? 'UTC', tracking: inv.tracking ?? null, scheduled_event: { uri: ev.uri, start_time: ev.start_time, end_time: ev.end_time }, cancellation: canceled ? { created_at: at } : null };
        const tokenContactId = inv.tracking?.utm_content?.split('.')[1];
        const email = tokenContactId ? (await db.contact.findFirst({ where: { id: tokenContactId, tenantId }, select: { email: true } }))?.email ?? null : null;
        let normalized;
        try { normalized = normalizeCalendlyEvent(tenantId, { event: canceled ? 'invitee.canceled' : 'invitee.created', created_at: at, payload }, () => email); } catch { counts.ignored++; continue; }
        if (normalized.ignored) { counts.ignored++; continue; }
        // A stable id that differs from webhook ids: the appointment upsert is what guarantees exactly-once.
        const result = await handleProviderEvent(tenantId, { ...normalized.event, id: `calendly-reconcile:${inv.uri}:${canceled ? 'canceled' : 'active'}` });
        if ('duplicate' in result && result.duplicate) counts.duplicates++; else counts.applied++;
      }
      pageToken = r.pagination?.next_page_token; if (!pageToken) break;
    }
  }
  await db.tenantSetting.update({ where: { tenantId }, data: { calendlyReconciledAt: now } });
  console.log(JSON.stringify({ event: 'calendly_reconcile', tenantId, ...counts }));
  return counts;
}

// Worker entry: every tenant with a token, at most every 15 minutes each; failures alert, never crash the tick.
export async function reconcileAllCalendly(now = new Date(), fetcher: typeof fetch = fetch) {
  const due = await db.tenantSetting.findMany({ where: { calendlyToken: { not: null }, calendlyOrganizationUri: { not: null }, OR: [{ calendlyReconciledAt: null }, { calendlyReconciledAt: { lt: new Date(now.getTime() - 15 * 60000) } }] }, select: { tenantId: true }, take: 20 });
  let n = 0;
  for (const t of due) {
    try { await reconcileCalendly(t.tenantId, fetcher, now); n++; }
    catch (error) {
      console.error(JSON.stringify({ event: 'calendly_reconcile_failed', tenantId: t.tenantId, code: error instanceof HttpError ? error.message : 'calendly_reconcile_failed' }));
      await raiseAlert(t.tenantId, 'calendly_reconcile_failed', now.toISOString().slice(0, 13));
    }
  }
  return n;
}
