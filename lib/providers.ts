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
  const url = new URL(process.env.PROVIDER_GATEWAY_URL ?? '');
  const testLoopback = process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !testLoopback) throw new Error('gateway_requires_https');
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + path;
  url.search = '';
  const res = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${decrypt(encryptedKey)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body)
  });
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
  return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
