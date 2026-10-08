import { Prisma } from '@prisma/client';
import { db } from '../../../../lib/db';
import { authenticate } from '../../../../lib/auth';
import { encrypt } from '../../../../lib/crypto';
import { endpoint, HttpError, jsonBody } from '../../../../lib/http';
import { z } from 'zod';
import {
  configuredFlags, gatewayCredentialState, loadProviderSecrets, probeApollo, probeGateway, probeHunter,
  pushCredentialsToGateway, PROVIDERS, type ProviderName
} from '../../../../lib/providerCredentials';

// Settings surface for the three provider credentials. The bearer token is stored in the existing
// gatewayKey column; Apollo and Hunter arrived with the provider_credentials migration.
//
// Nothing in a response is ever a secret: GET returns booleans plus what the gateway reports it
// holds, and a test returns a verdict and a sentence. The plaintext only ever travels inbound.

const saveInput = z.object({
  // Blank means "leave the stored value alone", matching the rest of the settings form. null clears it.
  gatewayKey: z.string().min(16).max(2000).optional(),
  apolloKey: z.string().min(8).max(2000).optional(),
  hunterKey: z.string().min(8).max(2000).optional(),
  clear: z.array(z.enum(PROVIDERS)).max(3).optional()
}).strict();

const testInput = z.object({ provider: z.enum(PROVIDERS) }).strict();

const requireAdmin = (role: string) => {
  if (!['TENANT_ADMIN', 'SUPER_ADMIN'].includes(role)) throw new HttpError(403, 'admin_required');
};

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  const secrets = await loadProviderSecrets(user.tenantId);
  const state = await gatewayCredentialState(user.tenantId, secrets);
  return Response.json({ ...configuredFlags(secrets), gatewaySynced: state ? state.apollo || state.hunter : null });
});

export const PUT = endpoint(async req => {
  const user = await authenticate(req, true);
  requireAdmin(user.role);
  const body = saveInput.parse(await jsonBody(req));
  const clear = new Set(body.clear ?? []);

  // Encrypt before anything else so an invalid value never reaches the database, and drop the
  // undefined entries so an untouched field keeps its stored ciphertext.
  const data = Object.fromEntries(Object.entries({
    gatewayKey: body.gatewayKey ? encrypt(body.gatewayKey.trim()) : undefined,
    apolloKey: body.apolloKey ? encrypt(body.apolloKey.trim()) : undefined,
    hunterKey: body.hunterKey ? encrypt(body.hunterKey.trim()) : undefined
  }).filter(([, value]) => value !== undefined)) as Prisma.TenantSettingUncheckedUpdateInput;
  for (const provider of clear) {
    if (provider === 'gateway') data.gatewayKey = null;
    if (provider === 'apollo') data.apolloKey = null;
    if (provider === 'hunter') data.hunterKey = null;
  }
  const changed = Object.keys(data).length > 0;
  if (changed) {
    await db.tenantSetting.upsert({
      where: { tenantId: user.tenantId }, update: data,
      create: { ...data, tenantId: user.tenantId } as Prisma.TenantSettingUncheckedCreateInput
    });
  }

  // The gateway keeps its own copy, so a save is not finished until the gateway has it. A gateway
  // that cannot be reached is reported, not thrown: the credential is safely stored either way and
  // discovery or verification re-pushes on the next run.
  let syncError: string | null = null;
  const secrets = await loadProviderSecrets(user.tenantId);
  if (secrets.gatewayKey) {
    try { await pushCredentialsToGateway(user.tenantId, secrets); }
    catch (e) { syncError = e instanceof HttpError ? e.message : 'gateway_unreachable'; }
  }

  await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'provider_credentials_updated' } });
  const state = await gatewayCredentialState(user.tenantId, secrets);
  return Response.json({
    ok: true, saved: changed,
    ...configuredFlags(secrets),
    gatewaySynced: state ? state.apollo || state.hunter : null,
    gatewaySyncError: syncError
  });
});

export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  requireAdmin(user.role);
  const { provider } = testInput.parse(await jsonBody(req));
  const secrets = await loadProviderSecrets(user.tenantId);
  // Check presence before calling the vendor: probing with an empty key would spend a request to
  // learn something the database already knows.
  const stored = provider === 'apollo' ? secrets.apolloKey : provider === 'hunter' ? secrets.hunterKey : secrets.gatewayKey;
  if (!stored)
    return Response.json({ provider: provider as ProviderName, ok: false, code: 'provider_credential_missing', detail: `No ${provider} credential is saved for this workspace yet.` }, { status: 409 });
  const result = provider === 'apollo' ? await probeApollo(stored) : provider === 'hunter' ? await probeHunter(stored) : await probeGateway(secrets);
  await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'provider_credential_tested', entity: provider } });
  return Response.json({ provider: provider as ProviderName, ...result });
});
