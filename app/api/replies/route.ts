import { z } from 'zod';
import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
import { applyRulesForAlert } from '../../../lib/automationRules';
import { readWorkspaceConfig } from '../../../lib/workspaceConfig';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.reply.findMany({ where: { tenantId: user.tenantId }, include: { contact: true }, orderBy: { createdAt: 'desc' }, take: 500 }));
});
export const PATCH = endpoint(async req => {
  const user = await authenticate(req, true);
  const body = z.object({ id: z.string(), action: z.enum(['qualify', 'suppress', 'dismiss']) }).strict().parse(await jsonBody(req));
  const reply = await db.reply.findFirst({ where: { id: body.id, tenantId: user.tenantId }, include: { contact: true } });
  if (!reply) throw new HttpError(404, 'reply_not_found');
  if (body.action === 'qualify') {
    await db.reply.update({ where: { id: reply.id }, data: { intent: 'POSITIVE', recommendedAction: 'Send booking link — reviewed by a person' } });
    await applyRulesForAlert(user.tenantId, 'positive_reply', await readWorkspaceConfig(user.tenantId));
  } else if (body.action === 'suppress' && reply.contact?.email) {
    await db.suppression.upsert({
      where: { tenantId_email: { tenantId: user.tenantId, email: reply.contact.email } },
      update: { reason: 'manual_triage' },
      create: { tenantId: user.tenantId, email: reply.contact.email, reason: 'manual_triage' }
    });
    await db.reply.update({ where: { id: reply.id }, data: { intent: 'NEGATIVE', recommendedAction: 'Suppressed by a person' } });
    await applyRulesForAlert(user.tenantId, 'negative_reply', await readWorkspaceConfig(user.tenantId));
  } else {
    await db.reply.update({ where: { id: reply.id }, data: { recommendedAction: 'Reviewed and dismissed' } });
  }
  return Response.json({ ok: true });
});
