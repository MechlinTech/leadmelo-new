import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
import { settingsInput } from '../../../lib/validation';
import { encrypt } from '../../../lib/crypto';
import { checkAiUrl } from '../../../lib/ai/client';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  const [s, tenant] = await Promise.all([
    db.tenantSetting.findUnique({ where: { tenantId: user.tenantId } }),
    db.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } })
  ]);
  return Response.json({ tenantId: user.tenantId, companyName: tenant?.name ?? '', automationEnabled: s?.automationEnabled ?? false, dailySendCap: s?.dailySendCap ?? 100, weeklyProspectCap: s?.weeklyProspectCap ?? 50, postalAddress: s?.postalAddress ?? '', gatewayConfigured: !!s?.gatewayKey, webhookConfigured: !!s?.webhookSecret, calendlyConfigured: !!s?.calendlySigningKey, calendlyReconcileConfigured: !!s?.calendlyToken && !!s?.calendlyOrganizationUri, calendlyOrganizationUri: s?.calendlyOrganizationUri ?? '', calendlyReconciledAt: s?.calendlyReconciledAt ?? null,monthlySpendCapCents: s?.monthlySpendCapCents ?? null, providerCostCents: s?.providerCostCents ?? 0, suspended: s?.suspended ?? false, messageRetentionDays: s?.messageRetentionDays ?? null,outboundEnabled: process.env.OUTBOUND_ENABLED === 'true', aiEnabled: s?.aiEnabled ?? false, aiBaseUrl: s?.aiBaseUrl ?? '', aiModel: s?.aiModel ?? '', aiKeyConfigured: !!s?.aiKey, aiFeatures: s?.aiFeatures ?? [] });
});
export const PUT = endpoint(async req => {
  const user = await authenticate(req, true);
  if (!['TENANT_ADMIN', 'SUPER_ADMIN'].includes(user.role)) throw new HttpError(403, 'admin_required');
  const parsed = settingsInput.parse(await jsonBody(req));
  const { companyName, ...body } = parsed;
  if (body.aiBaseUrl) { const bad = checkAiUrl(body.aiBaseUrl); if (bad) throw new HttpError(400, `ai_url_rejected: ${bad}`); }
  if (body.aiEnabled && !(body.aiBaseUrl ?? (await db.tenantSetting.findUnique({ where: { tenantId: user.tenantId } }))?.aiBaseUrl)) throw new HttpError(400, 'ai_url_required');
  const data = { ...body, aiKey: body.aiKey ? encrypt(body.aiKey) : undefined, gatewayKey: body.gatewayKey ? encrypt(body.gatewayKey) : undefined, webhookSecret: body.webhookSecret ? encrypt(body.webhookSecret) : undefined, calendlySigningKey: body.calendlySigningKey ? encrypt(body.calendlySigningKey) : undefined, calendlyToken: body.calendlyToken ? encrypt(body.calendlyToken) : undefined };
  if (companyName) await db.tenant.update({ where: { id: user.tenantId }, data: { name: companyName } });
  await db.tenantSetting.upsert({ where: { tenantId: user.tenantId }, update: data, create: { ...data, tenantId: user.tenantId } });
  await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'settings_updated' } });
  return Response.json({ ok: true });
});
