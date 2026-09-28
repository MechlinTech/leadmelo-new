import { createHmac } from 'node:crypto';
import { timingSafeEqualText } from './security';
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('SESSION_SECRET missing');
  return value;
}
export function unsubscribeToken(tenantId: string, email: string) {
  const payload = Buffer.from(JSON.stringify({ tenantId, email: email.toLowerCase() })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret()).update(payload).digest('hex')}`;
}
export function parseUnsubscribe(token: string) {
  if (token.length > 2000) throw new Error('invalid_token');
  const [payload, signature] = token.split('.');
  const expected = createHmac('sha256', secret()).update(payload ?? '').digest('hex');
  if (!signature || !timingSafeEqualText(signature, expected)) throw new Error('invalid_token');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (typeof parsed.tenantId !== 'string' || typeof parsed.email !== 'string') throw new Error('invalid_token');
  return parsed as { tenantId: string; email: string };
}
