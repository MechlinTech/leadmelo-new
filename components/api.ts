import { userError } from '../lib/userErrors';
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  if (response.status === 401 && !path.startsWith('auth/') && !path.startsWith('invites/accept')) { window.location.assign('/auth/signin?reason=session'); throw new Error('Please sign in'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(userError(result.error ?? 'Request failed'));
  return result;
}
export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
