import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function jsonBody(req: Request, maxBytes = 65536): Promise<unknown> {
  if (!req.body) throw new HttpError(400, 'body_required');
  const reader = req.body.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, 'body_too_large'); }
    parts.push(value);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid_json'); }
}
export function endpoint(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    try {
      const response = await fn(req);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch (error) {
      let status = 500, message = 'internal_error';
      if (error instanceof HttpError) { status = error.status; message = error.message; }
      else if (error instanceof ZodError) { status = 400; message = 'invalid_request'; }
      else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        status = 409; message = 'already_exists';
      } else console.error(JSON.stringify({ event: 'request_failed', errorType: error instanceof Error ? error.name : 'unknown', code: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined }));
      return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
