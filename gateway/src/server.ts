import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApolloClient } from './apollo';
import { HunterClient } from './hunter';
import { discover } from './discover';

import { GatewayHttpError, VendorError } from './errors';
import { GatewayStore } from './store';
import type { GatewayConfig, TenantBinding } from './config';

const list = z.array(z.string().max(200)).max(100).default([]);
// One definition of a tenant ID, shared by the route schemas and by self-registration, so a claim can
// never be accepted under looser rules than the route that owns it.
const tenantIdSchema = z.string().min(1).max(100);
const icpSchema = z.object({ industries: list, companySizes: list, geographies: list, technologies: list, buyingSignals: list, buyerTitles: list, exclusionRules: list }).passthrough();
const discoverReq = z.object({ tenantId: tenantIdSchema, campaignId: z.string().min(1).max(100), icp: icpSchema, limit: z.number().int().min(0).max(100) }).strict();
const verifyReq = z.object({ tenantId: tenantIdSchema, contactId: z.string().min(1).max(100), email: z.string().email().max(254) }).strict();
// Vendor keys are optional so a partial update is possible; null clears one. Lengths mirror the
// vendor minimums (8) and the plaintext ceiling LeadMelo enforces (2000).
// tenantId is optional: it is only read when this request is the one that registers a new tenant,
// and an existing tenant is identified by its bearer alone.
const credentialReq = z.object({
  apolloKey: z.string().min(8).max(2000).nullable().optional(),
  hunterKey: z.string().min(8).max(2000).nullable().optional(),
  tenantId: tenantIdSchema.optional()
}).strict();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms));

// The body is read once and memoised. Self-registration needs the tenantId before the route decides
// what to do with the request, and a stream cannot be read twice; caching here keeps both callers
// reading the same bytes rather than one of them seeing an empty stream.
const bodyCache = new WeakMap<IncomingMessage, string>();
async function readBody(req: IncomingMessage, max = 65536): Promise<string> {
  const cached = bodyCache.get(req);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new GatewayHttpError(413, 'body_too_large'); parts.push(chunk as Buffer); }
  const text = Buffer.concat(parts).toString('utf8');
  bodyCache.set(req, text);
  return text;
}
async function readJson(req: IncomingMessage, max = 65536): Promise<unknown> {
  let text: string;
  try { text = await readBody(req, max); }
  // A read failure is already classified (413/400); do not relabel it as malformed JSON.
  catch (e) { if (e instanceof GatewayHttpError) throw e; throw new GatewayHttpError(400, 'invalid_json'); }
  try { return JSON.parse(text); } catch { throw new GatewayHttpError(400, 'invalid_json'); }
}
// Best-effort tenantId for registration. A body that is absent, unparseable or too large is left to
// the route's own validation to reject, so this never masks the real error and never leaves the
// stream half-consumed (readBody memoises whatever it did read).
async function peekTenantId(req: IncomingMessage, method?: string): Promise<string | undefined> {
  // A GET carries no body, so there is nothing to claim and nothing that can be malformed.
  if (method === 'GET' || method === 'HEAD') return undefined;
  // A body that is genuinely unreadable (413, or invalid JSON) must reach the caller as itself: the
  // route below parses the same memoised bytes and will reject it there. Swallowing it here would
  // report a malformed request as an unauthenticated one and send the operator after the wrong thing.
  // An entirely empty body is "nothing to claim", which is a missing tenantId rather than a
  // malformed request; the route below parses the same bytes and reports it in its own terms.
  const text = await readBody(req);
  if (!text.trim()) return undefined;
  const raw = await readJson(req);
  if (!raw || typeof raw !== 'object') return undefined;
  const v = tenantIdSchema.safeParse((raw as { tenantId?: unknown }).tenantId);
  return v.success ? v.data : undefined;
}
function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// HTTP surface of docs/PROVIDER_GATEWAY.md: POST /discover, POST /verify, (POST /send is not supported).
// Bind to localhost/private network behind a TLS reverse proxy; LeadMelo requires an https URL.
export function createGatewayServer(config: GatewayConfig, deps: { fetcher?: typeof fetch; store?: GatewayStore; now?: () => Date } = {}): Server {
  const fetcher = deps.fetcher ?? fetch, store = deps.store ?? new GatewayStore(config.storeFile);
  const log = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, at: new Date().toISOString(), ...extra })); // never logs emails or keys

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://gateway').pathname;
    // Set when a self-registering gateway could not bind this bearer, so the operator is told the
    // request was refused for a missing tenantId rather than for a rejected token.
    let registrationHint = false;
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    const bearer = /^Bearer (.{16,512})$/.exec(String(req.headers.authorization ?? ''))?.[1];

    // TENANT REGISTRATION. With no tenants file the gateway is self-registering: the bearer a
    // LeadMelo tenant presents defines that tenant, and Settings pushes its vendor keys over
    // /credentials. So an unknown bearer is admitted and bound to the tenantId it claims.
    //
    // What this gives up, and why it is acceptable here only: an allow-list is no longer deciding
    // who may talk to the gateway, so ANY caller who can reach this port can register a tenant and
    // spend vendor credits. That is only tolerable because the gateway holds no database
    // credentials and is bound to the private compose network / loopback, never the internet. If
    // you ever expose it, put GATEWAY_TENANTS_FILE back: a non-empty file sets
    // allowSelfRegistration false and restores the closed allow-list.
    //
    // First-claim-wins: once a bearer is bound to a tenantId it may never claim a different one, so
    // a leaked bearer cannot be re-pointed at another tenant's data. The binding lives only for the
    // life of the process, so a restart re-teaches it from whatever Settings pushes next.
    let binding: TenantBinding | undefined = bearer ? config.tenants.get(sha256(bearer)) : undefined;
    if (!binding && bearer && config.allowSelfRegistration && ['/credentials', '/discover', '/verify'].includes(path)) {
      // Every self-registering route carries a tenantId, including /credentials: saving in Settings
      // pushes the vendor keys there first, so if /credentials could not register, a brand-new
      // deployment would never get as far as a discovery request.
      const claimed = await peekTenantId(req, req.method);
      registrationHint = true;
      if (claimed) {
        // First-claim-wins. A second, different bearer claiming an already-registered tenant ID is
        // refused rather than silently given that tenant's data.
        const owner = [...config.tenants.entries()].find(([, b]) => b.tenantId === claimed);
        if (owner) throw new GatewayHttpError(409, owner[0] === sha256(bearer) ? 'tenant_already_registered' : 'tenant_id_already_registered');
        binding = { tenantId: claimed };
        config.tenants.set(sha256(bearer), binding);
        log('tenant_registered', { tenant: claimed });
      }
    }

    // Vendor credentials, managed from LeadMelo Settings. The bearer token is already this tenant's
    // identity here, so it authenticates the write too: a tenant can only ever replace its own keys,
    // and no new shared secret or database credential is introduced. Responses carry booleans only.
    //
    // The config directory stays read-only and this endpoint never writes to it: the gateway holds
    // keys in memory only. LeadMelo re-pushes on save and again whenever discovery or verification
    // is refused for a missing key, so a restart costs one extra request and nothing else. That is
    // deliberately better than letting the gateway rewrite a file that holds vendor keys in
    // plaintext, which is the operator's to manage at mode 600.
    if (path === '/credentials') {
      if (!binding) throw new GatewayHttpError(401, registrationHint ? 'unauthorized: send tenantId to register this gateway' : 'unauthorized');
      if (req.method === 'GET') {
        // A GET carries its tenantId as a query parameter, since there is no body to put it in.
        const claimed = new URL(req.url ?? '/', 'http://gateway').searchParams.get('tenantId') ?? undefined;
        if (claimed !== undefined && claimed !== binding.tenantId) throw new GatewayHttpError(403, 'tenant_mismatch');
        log('credentials_read', { tenant: binding.tenantId });
        return send(res, 200, { tenantId: binding.tenantId, apollo: !!binding.apolloKey, hunter: !!binding.hunterKey, inMemory: true });
      }
      if (req.method !== 'PUT') throw new GatewayHttpError(404, 'not_found');
      const body = credentialReq.parse(await readJson(req));
      // A tenantId on an already-registered bearer must agree with the binding that bearer already
      // owns. Without this check a caller could restate its identity freely; with it, one bearer is
      // pinned to exactly one tenant for the life of the process.
      if (body.tenantId !== undefined && body.tenantId !== binding.tenantId)
        throw new GatewayHttpError(403, 'tenant_mismatch');
      // An omitted field leaves the stored key alone; an explicit null clears it.
      if (body.apolloKey !== undefined) binding.apolloKey = body.apolloKey ?? undefined;
      if (body.hunterKey !== undefined) binding.hunterKey = body.hunterKey ?? undefined;
      log('credentials_updated', { tenant: binding.tenantId, apollo: !!binding.apolloKey, hunter: !!binding.hunterKey });
      return send(res, 200, { ok: true, tenantId: binding.tenantId, apollo: !!binding.apolloKey, hunter: !!binding.hunterKey, inMemory: true });
    }

    if (req.method !== 'POST' || !['/discover', '/verify', '/send'].includes(path)) throw new GatewayHttpError(404, 'not_found');
    if (!binding) throw new GatewayHttpError(401, registrationHint ? 'unauthorized: send tenantId to register this gateway' : 'unauthorized');
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '');
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new GatewayHttpError(400, 'idempotency_key_required');
    const raw = await readJson(req);
    if (path === '/send') throw new GatewayHttpError(501, 'send_not_supported: use the native Microsoft 365 connection');
    const key = `${binding.tenantId}:${path}:${idempotencyKey}`;

    let job: Promise<unknown>;
    if (path === '/discover') {
      const body = discoverReq.parse(raw);
      if (body.tenantId !== binding.tenantId) throw new GatewayHttpError(403, 'tenant_mismatch');
      const icp = { industries: body.icp.industries, companySizes: body.icp.companySizes, geographies: body.icp.geographies, technologies: body.icp.technologies, buyingSignals: body.icp.buyingSignals, buyerTitles: body.icp.buyerTitles, exclusionRules: body.icp.exclusionRules };
      const requestHash = sha256(JSON.stringify({ c: body.campaignId, icp, l: body.limit }));
      if (!binding.apolloKey) throw new GatewayHttpError(409, 'vendor_not_configured: discovery needs an Apollo key');
      const apollo = new ApolloClient(fetcher, binding.apolloKey, config.apolloBase);
      const hunter = binding.hunterKey ? new HunterClient(fetcher, binding.hunterKey, config.hunterBase) : null;
      job = store.run(key, requestHash, () => discover({ apollo, hunter, store, config, now: deps.now }, { tenantId: body.tenantId, campaignId: body.campaignId, icp, limit: body.limit }));
    } else {
      const body = verifyReq.parse(raw);
      if (body.tenantId !== binding!.tenantId) throw new GatewayHttpError(403, 'tenant_mismatch');
      if (!binding.hunterKey) throw new GatewayHttpError(409, 'vendor_not_configured: verification needs a Hunter key');
      const hunter = new HunterClient(fetcher, binding.hunterKey, config.hunterBase);
      const now = deps.now ?? (() => new Date());
      // Only a definitive answer is remembered; UNKNOWN (pending/SMTP failure) must be retryable under the same key.
      job = store.run(key, sha256(JSON.stringify({ e: body.email.toLowerCase() })), async () => {
        const r = await hunter.verify(body.email.toLowerCase());
        return { email: body.email.toLowerCase(), verification: r.verification, verifiedAt: now().toISOString() };
      }, v => v.verification !== 'UNKNOWN');
    }
    job.catch(() => undefined); // the job keeps running if we answer "in progress"; its error is handled below or on retry
    const outcome = await Promise.race([job.then(value => ({ value }), error => ({ error })), sleep(config.syncWaitMs)]);
    if (outcome === 'timeout') throw new GatewayHttpError(503, 'in_progress', 15);
    if ('error' in outcome) throw outcome.error;
    log('request_ok', { path, tenant: binding.tenantId });
    send(res, 200, outcome.value);
  }

  return createServer((req, res) => {
    handle(req, res).catch(error => {
      let status = 500, message = 'internal_error', retry: number | undefined;
      if (error instanceof GatewayHttpError) { status = error.status; message = error.message; retry = error.retryAfterSeconds; }
      else if (error instanceof z.ZodError) { status = 400; message = 'invalid_request'; }
      else if (error instanceof VendorError) {
        // Vendor detail is not passed on. Rate limits and outages are retryable; a bad vendor key is an operator problem.
        status = error.code === 'vendor_auth' ? 502 : error.code === 'vendor_error' || error.code === 'vendor_response_invalid' ? 502 : 503;
        message = error.code; retry = error.retryAfterSeconds;
      }
      log('request_failed', { path: req.url, status, message: message.split(':')[0] });
      if (!res.headersSent) send(res, status, { error: message }, retry ? { 'Retry-After': String(Math.ceil(retry)) } : {});
    });
  });
}
