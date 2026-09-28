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
const icpSchema = z.object({ industries: list, companySizes: list, geographies: list, technologies: list, buyingSignals: list, buyerTitles: list, exclusionRules: list }).passthrough();
const discoverReq = z.object({ tenantId: z.string().min(1).max(100), campaignId: z.string().min(1).max(100), icp: icpSchema, limit: z.number().int().min(0).max(100) }).strict();
const verifyReq = z.object({ tenantId: z.string().min(1).max(100), contactId: z.string().min(1).max(100), email: z.string().email().max(254) }).strict();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms));

async function readJson(req: IncomingMessage, max = 65536): Promise<unknown> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new GatewayHttpError(413, 'body_too_large'); parts.push(chunk as Buffer); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new GatewayHttpError(400, 'invalid_json'); }
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
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || !['/discover', '/verify', '/send'].includes(path)) throw new GatewayHttpError(404, 'not_found');
    const bearer = /^Bearer (.{16,512})$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const binding: TenantBinding | undefined = bearer ? config.tenants.get(sha256(bearer)) : undefined;
    if (!binding) throw new GatewayHttpError(401, 'unauthorized');
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '');
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new GatewayHttpError(400, 'idempotency_key_required');
    const raw = await readJson(req);
    if (path === '/send') throw new GatewayHttpError(501, 'send_not_supported: use the native Microsoft 365 connection');
    const key = `${binding.tenantId}:${path}:${idempotencyKey}`;

    let job: Promise<unknown>;
    if (path === '/discover') {
      const body = discoverReq.parse(raw);
      if (body.tenantId !== binding.tenantId) throw new GatewayHttpError(403, 'tenant_mismatch');
      if (!binding.apolloKey || !binding.hunterKey) throw new GatewayHttpError(409, 'vendor_not_configured: discovery needs both an Apollo key and a Hunter key');
      const icp = { industries: body.icp.industries, companySizes: body.icp.companySizes, geographies: body.icp.geographies, technologies: body.icp.technologies, buyingSignals: body.icp.buyingSignals, buyerTitles: body.icp.buyerTitles, exclusionRules: body.icp.exclusionRules };
      const requestHash = sha256(JSON.stringify({ c: body.campaignId, icp, l: body.limit }));
      const apollo = new ApolloClient(fetcher, binding.apolloKey, config.apolloBase), hunter = new HunterClient(fetcher, binding.hunterKey, config.hunterBase);
      job = store.run(key, requestHash, () => discover({ apollo, hunter, store, config, now: deps.now }, { tenantId: body.tenantId, campaignId: body.campaignId, icp, limit: body.limit }));
    } else {
      const body = verifyReq.parse(raw);
      if (body.tenantId !== binding.tenantId) throw new GatewayHttpError(403, 'tenant_mismatch');
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
