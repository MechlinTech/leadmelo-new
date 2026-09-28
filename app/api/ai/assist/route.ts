import { z } from 'zod';
import { authenticate } from '../../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../../lib/http';
import { chargeAiCall, loadAiConfig, suggestCampaign } from '../../../../lib/ai/features';
const input = z.object({ description: z.string().trim().min(20).max(2000), senderName: z.string().trim().max(100).optional(), steps: z.number().int().min(1).max(4).optional() }).strict();
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  if (user.role === 'MEMBER') throw new HttpError(403, 'manager_required');
  const body = input.parse(await jsonBody(req));
  const cfg = await loadAiConfig(user.tenantId, 'campaign_assist');
  await chargeAiCall(user.tenantId, user.id, 'campaign_assist');
  return Response.json({ suggestion: await suggestCampaign(cfg, body), notice: 'AI-generated draft. Review every line before saving; nothing is sent until the campaign passes the normal approval flow.' });
});
