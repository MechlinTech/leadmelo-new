import { db } from '../../../../lib/db';
import { authenticate } from '../../../../lib/auth';
import { decrypt } from '../../../../lib/crypto';
import { endpoint, HttpError } from '../../../../lib/http';
import { chargeAiCall, testConnection } from '../../../../lib/ai/features';
import { checkAiUrl } from '../../../../lib/ai/client';
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  if (!['TENANT_ADMIN', 'SUPER_ADMIN'].includes(user.role)) throw new HttpError(403, 'admin_required');
  const s = await db.tenantSetting.findUnique({ where: { tenantId: user.tenantId } });
  if (!s?.aiBaseUrl || !s.aiModel) throw new HttpError(409, 'ai_not_configured');
  const bad = checkAiUrl(s.aiBaseUrl); if (bad) throw new HttpError(409, `ai_url_rejected: ${bad}`);
  await chargeAiCall(user.tenantId, user.id, 'test');
  return Response.json(await testConnection({ baseUrl: s.aiBaseUrl, model: s.aiModel, apiKey: s.aiKey ? decrypt(s.aiKey) : undefined }));
});
