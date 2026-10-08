import { db } from './db';
import { decrypt } from './crypto';
import { HttpError } from './http';
import { gateway } from './providers';

// Vendor credentials for a tenant, configured from Settings instead of by editing the gateway's
// tenants.json by hand.
//
// Storage: every value is AES-256-GCM ciphertext in TenantSetting (lib/crypto.ts). Nothing in this
// module returns a secret to a caller that renders HTML or writes a log -- publicProviderStatus
// returns booleans only, and every error raised here names the provider and the reason, never the
// value.
//
// The gateway holds no database credentials by design (docker-compose.selfhosted.yml), so saving a
// key here is not enough on its own: it is pushed to the gateway's bearer-authenticated
// PUT /credentials, which is the only channel that has ever carried vendor keys in the other
// direction. The tenant's bearer token is the gateway's notion of tenant identity, so it
// authenticates the push and needs no new shared secret.

export const PROVIDERS = ['gateway', 'apollo', 'hunter'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export type ProviderStatus = {
  gatewayConfigured: boolean; apolloConfigured: boolean; hunterConfigured: boolean;
  /** Whether the gateway currently holds this tenant's vendor keys. Null when it cannot be reached. */
  gatewaySynced: boolean | null;
  /** Whether the gateway could write them back to its tenants file for durability across restarts. */
  gatewayPersisted: boolean | null;
};

/** Decrypted credentials. Server-side only: never return this from a route. */
export type ProviderSecrets = { gatewayKey?: string; apolloKey?: string; hunterKey?: string };

export async function loadProviderSecrets(tenantId: string): Promise<ProviderSecrets> {
  const s = await db.tenantSetting.findUnique({
    where: { tenantId }, select: { gatewayKey: true, apolloKey: true, hunterKey: true }
  });
  const open = (v: string | null | undefined) => { if (!v) return undefined; try { return decrypt(v).trim() || undefined; } catch { return undefined; } };
  return { gatewayKey: open(s?.gatewayKey), apolloKey: open(s?.apolloKey), hunterKey: open(s?.hunterKey) };
}

/** Booleans only. This is the shape the Settings UI is allowed to see. */
export function configuredFlags(secrets: ProviderSecrets): { gatewayConfigured: boolean; apolloConfigured: boolean; hunterConfigured: boolean } {
  return { gatewayConfigured: !!secrets.gatewayKey, apolloConfigured: !!secrets.apolloKey, hunterConfigured: !!secrets.hunterKey };
}

// ---- gateway channel --------------------------------------------------------------------------------------

function gatewayBase(): URL {
  const configured = (process.env.PROVIDER_GATEWAY_URL ?? '').trim();
  if (!configured) throw new HttpError(409, 'gateway_not_configured');
  let url: URL;
  try { url = new URL(configured); } catch { throw new HttpError(409, 'gateway_not_configured'); }
  const allowHttp = ['127.0.0.1', 'localhost', 'gateway'].includes(url.hostname);
  if (url.protocol !== 'https:' && !allowHttp) throw new HttpError(409, 'gateway_requires_https');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  return url;
}

export type GatewaySync = { ok: boolean; apollo: boolean; hunter: boolean; persisted: boolean };

/**
 * Call the gateway, pushing this tenant's vendor keys first if the gateway says it has none.
 *
 * The gateway answers 409 vendor_not_configured when a tenant's Apollo or Hunter key is missing.
 * That is recoverable: the keys live in this database, so re-push and try once more. This is what
 * makes the Settings page authoritative even when the gateway was restarted, was unreachable at save
 * time, or was started before the keys existed. A second 409 is a genuine "not configured" and is
 * allowed to propagate so the operator still sees the real error.
 */
export async function gatewayWithCredentialSync<T>(
  tenantId: string, encryptedKey: string, path: 'discover' | 'verify', key: string, body: unknown, schema: import('zod').ZodType<T>
): Promise<T> {
  const call = () => gateway(encryptedKey, path, key, body, schema);
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof Error) || !/^gateway_http_409$/.test(e.message)) throw e;
    await pushCredentialsToGateway(tenantId).catch(() => undefined);
    return await call();
  }
}

/**
 * Push this tenant's vendor keys to the gateway. Authenticated with the tenant's bearer token, which
 * is also how the gateway identifies the tenant, so a tenant can only ever write its own keys.
 * Returns what the gateway reports it now holds; never echoes a key.
 */
export async function pushCredentialsToGateway(tenantId: string, secrets?: ProviderSecrets): Promise<GatewaySync> {
  const s = secrets ?? await loadProviderSecrets(tenantId);
  if (!s.gatewayKey) throw new HttpError(409, 'gateway_credential_missing');
  const url = gatewayBase();
  url.pathname += '/credentials';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${s.gatewayKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apolloKey: s.apolloKey ?? null, hunterKey: s.hunterKey ?? null })
    });
  } catch {
    throw new HttpError(502, 'gateway_unreachable');
  }
  if (res.status === 401) throw new HttpError(409, 'gateway_http_401');
  if (!res.ok) throw new HttpError(502, `gateway_http_${res.status}`);
  const body = await res.json().catch(() => ({}));
  return { ok: true, apollo: !!body.apollo, hunter: !!body.hunter, persisted: !!body.persisted };
}

/**
 * What the gateway currently holds for this tenant, for the Settings status line. Answers null when
 * the gateway is unreachable so the UI can say "unknown" instead of claiming a false failure.
 */
export async function gatewayCredentialState(tenantId: string, secrets?: ProviderSecrets): Promise<{ apollo: boolean; hunter: boolean; persisted: boolean } | null> {
  const s = secrets ?? await loadProviderSecrets(tenantId);
  if (!s.gatewayKey) return null;
  try {
    const url = gatewayBase();
    url.pathname += '/credentials';
    const res = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${s.gatewayKey}` } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return { apollo: !!body.apollo, hunter: !!body.hunter, persisted: !!body.persisted };
  } catch {
    return null;
  }
}

// ---- vendor probes ---------------------------------------------------------------------------------------

export type ProbeResult = { ok: boolean; code: string; detail: string };

const PROBE_TIMEOUT = 12000;
const probe = (url: URL, headers: Record<string, string>, fetcher: typeof fetch) =>
  fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT), headers: { Accept: 'application/json', ...headers } });

/**
 * Apollo key check against the free auth-health endpoint. A bad key answers 401/403.
 * NOT VERIFIED AGAINST A LIVE ACCOUNT: if the endpoint is retired a 404 is reported as
 * apollo_probe_unsupported rather than as a valid key, so the UI never shows a false pass.
 */
export async function probeApollo(apiKey: string, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  let res: Response;
  try { res = await probe(new URL('https://api.apollo.io/api/v1/auth/health'), { 'x-api-key': apiKey }, fetcher); }
  catch { return { ok: false, code: 'vendor_unreachable', detail: 'Apollo could not be reached from this server.' }; }
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'vendor_auth', detail: 'Apollo rejected this API key.' };
  if (res.status === 429) return { ok: false, code: 'vendor_rate_limited', detail: 'Apollo is rate limiting this key. Wait a moment and test again.' };
  if (res.status === 404) return { ok: false, code: 'apollo_probe_unsupported', detail: 'Apollo no longer offers this auth endpoint, so the key could not be verified. Save it anyway and check discovery.' };
  if (res.status >= 500) return { ok: false, code: 'vendor_unavailable', detail: `Apollo returned HTTP ${res.status}. Try again shortly.` };
  if (!res.ok) return { ok: false, code: 'vendor_error', detail: `Apollo returned HTTP ${res.status}.` };
  return { ok: true, code: 'vendor_auth_ok', detail: 'Apollo accepted this API key.' };
}

/**
 * Hunter has no free auth-only endpoint, and every documented one spends a credit, so this probes
 * with a deliberately malformed address: a valid key rejects the request (HTTP 400) without being
 * charged, while a bad key is refused outright (HTTP 401). 429 means the key is real but out of
 * quota, which is a different problem from a wrong key and is reported as such.
 * NOT VERIFIED AGAINST A LIVE ACCOUNT.
 */
export async function probeHunter(apiKey: string, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  const url = new URL('https://api.hunter.io/v2/email-verifier');
  url.searchParams.set('email', 'not-an-email-address');
  let res: Response;
  try { res = await probe(url, { 'X-API-KEY': apiKey }, fetcher); }
  catch { return { ok: false, code: 'vendor_unreachable', detail: 'Hunter could not be reached from this server.' }; }
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'vendor_auth', detail: 'Hunter rejected this API key.' };
  if (res.status === 429) return { ok: false, code: 'vendor_quota_exhausted', detail: 'Hunter accepted this key but the account has no verification credits left. Top up, then test again.' };
  if (res.status === 400 || res.status === 422) return { ok: true, code: 'vendor_auth_ok', detail: 'Hunter accepted this API key.' };
  if (res.status >= 500) return { ok: false, code: 'vendor_unavailable', detail: `Hunter returned HTTP ${res.status}. Try again shortly.` };
  if (!res.ok) return { ok: false, code: 'vendor_error', detail: `Hunter returned HTTP ${res.status}.` };
  return { ok: true, code: 'vendor_auth_ok', detail: 'Hunter accepted this API key.' };
}

/**
 * Proves the gateway will accept this tenant's bearer token. /health is unauthenticated, so the
 * meaningful check is an authenticated request: a 401 means the token is not in the gateway's
 * tenants file, which is the one thing still configured out of band.
 */
export async function probeGateway(secrets: ProviderSecrets, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  if (!secrets.gatewayKey) return { ok: false, code: 'gateway_credential_missing', detail: 'No bearer token is saved for this workspace yet.' };
  try {
    const url = gatewayBase();
    url.pathname += '/credentials';
    const res = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${secrets.gatewayKey}` } });
    if (res.status === 401) return { ok: false, code: 'gateway_http_401', detail: 'The gateway does not recognise this bearer token. Its tenants file must contain this token’s SHA-256 bound to this workspace.' };
    if (res.status === 404) return { ok: false, code: 'gateway_credentials_unsupported', detail: 'This gateway build has no credential endpoint. Restart it on a version that supports PUT /credentials.' };
    if (!res.ok) return { ok: false, code: 'vendor_error', detail: `The gateway returned HTTP ${res.status}.` };
    return { ok: true, code: 'gateway_auth_ok', detail: 'The gateway accepted this bearer token.' };
  } catch {
    return { ok: false, code: 'gateway_unreachable', detail: 'The gateway could not be reached. Check PROVIDER_GATEWAY_URL.' };
  }
}
