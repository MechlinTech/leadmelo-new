import { readFileSync } from 'node:fs';
import { z } from 'zod';

// GATEWAY_TENANTS_FILE: JSON array binding each LeadMelo tenant's bearer credential (stored only as
// its SHA-256) to exactly one tenant and that tenant's OWN vendor keys:
//   [{ "bearerSha256": "<64 hex>", "tenantId": "...", "apolloKey": "...", "hunterKey": "..." }]
// GATEWAY_TAXONOMY_FILE (optional): { "industries": { "<vendor industry, lowercase>": "<ICP industry>" },
//                                     "titles":     { "<vendor title, lowercase>": "<ICP title>" } }
// Only mappings between genuinely equivalent values belong here; they are how the operator lets a
// vendor's wording match an ICP's exact wording without relabelling anyone.
const tenantFile = z.array(z.object({ bearerSha256: z.string().regex(/^[0-9a-f]{64}$/), tenantId: z.string().min(1), apolloKey: z.string().min(8).optional(), hunterKey: z.string().min(8).optional() }).strict()).min(1);
const taxonomyFile = z.object({ industries: z.record(z.string()).default({}), titles: z.record(z.string()).default({}) }).strict();

export type TenantBinding = { tenantId: string; apolloKey?: string; hunterKey?: string };
export type GatewayConfig = {
  tenants: Map<string, TenantBinding>; taxonomy: { industries: Record<string, string>; titles: Record<string, string> };
  syncWaitMs: number; discoveryDeadlineMs: number; maxEnrichPerRequest: number; maxPages: number; storeFile?: string;
  apolloBase?: string; hunterBase?: string;
};
const lowerKeys = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase(), v]));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  if (!env.GATEWAY_TENANTS_FILE) throw new Error('GATEWAY_TENANTS_FILE is required');
  const tenants = new Map<string, TenantBinding>();
  for (const t of tenantFile.parse(JSON.parse(readFileSync(env.GATEWAY_TENANTS_FILE, 'utf8')))) {
    if (tenants.has(t.bearerSha256)) throw new Error('duplicate bearer credential in tenants file');
    tenants.set(t.bearerSha256, { tenantId: t.tenantId, apolloKey: t.apolloKey, hunterKey: t.hunterKey });
  }
  const tax = env.GATEWAY_TAXONOMY_FILE ? taxonomyFile.parse(JSON.parse(readFileSync(env.GATEWAY_TAXONOMY_FILE, 'utf8'))) : { industries: {}, titles: {} };
  const num = (v: string | undefined, d: number, min: number, max: number) => Math.min(max, Math.max(min, Number(v ?? d) || d));
  return {
    tenants, taxonomy: { industries: lowerKeys(tax.industries), titles: lowerKeys(tax.titles) },
    syncWaitMs: num(env.GATEWAY_SYNC_WAIT_MS, 12000, 1000, 14000), // LeadMelo aborts a gateway call after 15 s
    discoveryDeadlineMs: num(env.GATEWAY_DISCOVERY_DEADLINE_MS, 90000, 5000, 600000),
    maxEnrichPerRequest: num(env.GATEWAY_MAX_ENRICH_PER_REQUEST, 60, 1, 500), maxPages: num(env.GATEWAY_MAX_PAGES, 3, 1, 10),
    storeFile: env.GATEWAY_STORE_FILE
  };
}
