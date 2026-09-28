export class VendorError extends Error {
  constructor(public code: 'vendor_auth' | 'vendor_rate_limited' | 'vendor_quota_exhausted' | 'vendor_unavailable' | 'vendor_error' | 'vendor_response_invalid', public retryAfterSeconds?: number) { super(code); }
}
export class GatewayHttpError extends Error {
  constructor(public status: number, message: string, public retryAfterSeconds?: number) { super(message); }
}

// Reads at most maxBytes so a hostile or broken vendor response cannot exhaust memory.
export async function readCapped(res: Response, maxBytes = 1_000_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new VendorError('vendor_response_invalid'); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}
export function retryAfter(res: Response): number | undefined {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 3600) : undefined;
}
