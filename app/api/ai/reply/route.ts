import { z } from 'zod';
import { db } from '../../../../lib/db';
import { authenticate } from '../../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../../lib/http';
import { analyseReply, chargeAiCall, loadAiConfig } from '../../../../lib/ai/features';
const input = z.object({ replyId: z.string().min(1).max(64) }).strict();
export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  if (user.role === 'MEMBER') throw new HttpError(403, 'manager_required');
  const { replyId } = input.parse(await jsonBody(req));
  const reply = await db.reply.findFirst({ where: { id: replyId, tenantId: user.tenantId } });
  if (!reply) throw new HttpError(404, 'not_found');
  const cfg = await loadAiConfig(user.tenantId, 'reply_assist');
  await chargeAiCall(user.tenantId, user.id, 'reply_assist');
  const enrollment = reply.contactId ? await db.enrollment.findFirst({ where: { tenantId: user.tenantId, contactId: reply.contactId }, orderBy: { createdAt: 'desc' } }) : null;
  const campaign = enrollment ? await db.campaign.findFirst({ where: { id: enrollment.campaignId, tenantId: user.tenantId } }) : null;
  const insight = await analyseReply(cfg, { text: reply.rawSnippet ?? '', offer: campaign?.offer ?? undefined, senderName: campaign?.senderName });
  return Response.json({ insight });
});
