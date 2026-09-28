import { z } from 'zod';
import { VendorError, readCapped, retryAfter } from './errors';

// Hunter Email Verifier, per https://hunter.io/api-documentation/v2 :
//   GET https://api.hunter.io/v2/email-verifier?email=...   auth: X-API-KEY header
//   200 { data: { status: valid|invalid|accept_all|webmail|disposable|unknown, result: deliverable|undeliverable|risky, ... } }
//   202 verification in progress (poll again)   222 SMTP failure (retry later)   400 bad email
//   401 invalid key   403 rate limit reached   429 usage limit exceeded   451 owner requested processing stop
//   Limits: 10 requests/second, 300 requests/minute.
// NOT VERIFIED AGAINST A LIVE ACCOUNT.
export type Verification = 'VALID' | 'INVALID' | 'RISKY' | 'UNKNOWN';
const body = z.object({ data: z.object({ status: z.string(), result: z.string().optional(), email: z.string().optional() }).passthrough() }).passthrough();

// Conservative: only a valid+deliverable answer is VALID. Catch-all servers and webmail addresses cannot
// be confirmed as a real business mailbox, so they are RISKY; disposable addresses are INVALID.
export function mapHunterStatus(status: string, result?: string): Verification {
  switch (status) {
    case 'valid': return result === 'risky' ? 'RISKY' : result === 'undeliverable' ? 'INVALID' : 'VALID';
    case 'invalid': case 'disposable': return 'INVALID';
    case 'accept_all': case 'webmail': return 'RISKY';
    default: return 'UNKNOWN';
  }
}

export class HunterClient {
  constructor(private fetcher: typeof fetch, private apiKey: string, private base = 'https://api.hunter.io/v2') {}
  async verify(email: string): Promise<{ verification: Verification; vendorStatus: string }> {
    const url = new URL(`${this.base}/email-verifier`);
    url.searchParams.set('email', email);
    let res: Response;
    try { res = await this.fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'X-API-KEY': this.apiKey, Accept: 'application/json' } }); }
    catch { throw new VendorError('vendor_unavailable'); }
    if (res.status === 202) return { verification: 'UNKNOWN', vendorStatus: 'pending' };
    if (res.status === 222) return { verification: 'UNKNOWN', vendorStatus: 'smtp_failure' };
    if (res.status === 451) return { verification: 'INVALID', vendorStatus: 'owner_requested_stop' };
    if (res.status === 400) return { verification: 'INVALID', vendorStatus: 'bad_email' };
    if (res.status === 401) throw new VendorError('vendor_auth');
    if (res.status === 403) throw new VendorError('vendor_rate_limited', retryAfter(res) ?? 2);
    if (res.status === 429) throw new VendorError('vendor_quota_exhausted', retryAfter(res));
    if (res.status >= 500) throw new VendorError('vendor_unavailable', retryAfter(res));
    if (!res.ok) throw new VendorError('vendor_error');
    let parsed;
    try { parsed = body.parse(JSON.parse(await readCapped(res))); } catch { throw new VendorError('vendor_response_invalid'); }
    return { verification: mapHunterStatus(parsed.data.status, parsed.data.result), vendorStatus: parsed.data.status };
  }
}
