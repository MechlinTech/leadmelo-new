import { z } from 'zod';
import { decrypt } from './crypto';

export const prospectSchema = z.object({
  company: z.string().min(1).max(200), domain: z.string().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/),
  fullName: z.string().min(1).max(200), title: z.string().min(1).max(200),
  email: z.string().email().transform(v => v.toLowerCase()),
  industry: z.string().max(200), companySize: z.string().max(200), geography: z.string().max(200),
  technologies: z.array(z.string().max(200)).max(50), signals: z.array(z.string().max(200)).max(50),
  verification: z.enum(['VALID', 'RISKY', 'INVALID', 'UNKNOWN']),
  verifiedAt: z.string().datetime(), evidenceUrl: z.string().url(), evidenceSummary: z.string().min(1).max(1000)
}).strict();
export type Prospect = z.infer<typeof prospectSchema>;
export const discoveredSchema = z.object({ prospects: z.array(prospectSchema).max(100) }).strict();
export const sentSchema = z.object({ messageId: z.string().min(1).max(200) }).strict();

export async function gateway<T>(encryptedKey: string, path: 'discover' | 'send' | 'verify', key: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  // Every failure mode gets a stable code. An unset URL used to throw a bare TypeError
  // ("Invalid URL") and a dead gateway threw a bare fetch TypeError; both collapsed into
  // integration_or_database_error, which told the user nothing and hid the real cause.
  const configured = (process.env.PROVIDER_GATEWAY_URL ?? '').trim();
  if (!configured) throw new Error('gateway_not_configured');
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error('gateway_not_configured'); }
  // https in production; http allowed for local/test loopback and the compose gateway service.
  const allowHttp = ['127.0.0.1', 'localhost', 'gateway'].includes(url.hostname);
  if (url.protocol !== 'https:' && !allowHttp) throw new Error('gateway_requires_https');
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + path;
  url.search = '';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${decrypt(encryptedKey)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body)
    });
  } catch (error) {
    // DNS, refused connection, TLS or timeout: the gateway was never reached.
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('gateway_timeout');
    throw new Error('gateway_unreachable');
  }
  if (!res.ok) throw new Error(`gateway_http_${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('gateway_empty_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 512000) { await reader.cancel(); throw new Error('gateway_response_too_large'); }
    chunks.push(value);
  }
  // A 200 with a body that does not match the contract is a provider contract violation,
  // not a database fault. Name it so the operator sees the gateway shape is wrong.
  try {
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    throw new Error('gateway_invalid_response');
  }
}
