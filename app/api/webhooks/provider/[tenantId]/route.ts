import { db } from '../../../../../lib/db';
import { decrypt } from '../../../../../lib/crypto';
import { endpoint, HttpError } from '../../../../../lib/http';
import { rateLimit } from '../../../../../lib/auth';
import { handleProviderEvent, verifyWebhook, webhookInput } from '../../../../../lib/webhooks';

export async function POST(req: Request, context: { params: Promise<{ tenantId: string }> }) {
  return endpoint(async request => {
    const { tenantId } = await context.params;
    const settings = await db.tenantSetting.findUnique({ where: { tenantId } });
    if (!settings?.webhookSecret) throw new HttpError(401, 'invalid_webhook');
    await rateLimit(`webhook:${tenantId}`, 600, 1);
    if (!request.body) throw new HttpError(400, 'body_required');
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw new HttpError(413, 'body_too_large'); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!verifyWebhook(raw, request.headers.get('x-leadmelo-timestamp') ?? '', request.headers.get('x-leadmelo-signature') ?? '', decrypt(settings.webhookSecret))) throw new HttpError(401, 'invalid_webhook');
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json'); }
    return Response.json(await handleProviderEvent(tenantId, webhookInput.parse(data)));
  })(req);
}
