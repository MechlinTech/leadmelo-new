import { parseUnsubscribe } from '../../lib/unsubscribe';
import { suppress } from '../../lib/webhooks';
import { db } from '../../lib/db';
export async function GET(req: Request) {
  try {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    parseUnsubscribe(token);
    return new Response('<!doctype html><html lang="en"><title>Unsubscribe</title><main><h1>Stop receiving these emails</h1><form method="post"><button type="submit">Unsubscribe</button></form></main></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch { return new Response('Invalid unsubscribe link', { status: 400 }); }
}
export async function POST(req: Request) {
  try {
    const { tenantId, email } = parseUnsubscribe(new URL(req.url).searchParams.get('token') ?? '');
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tenantId} FOR UPDATE`;
      await suppress(tx, tenantId, email, 'unsubscribe');
    });
    return new Response('You have been unsubscribed.', { headers: { 'Cache-Control': 'no-store' } });
  } catch { return new Response('Unable to unsubscribe; use the sender reply address.', { status: 400 }); }
}
