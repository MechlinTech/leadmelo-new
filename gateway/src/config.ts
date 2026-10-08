import { readFileSync, writeFileSync, renameSync } from 'node:fs';
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
  // Dev/test only: when true, POST /discover returns synthetic prospects from GATEWAY_DUMMY_EMAILS and never calls Apollo.
  dummyDiscovery: boolean;
  dummyEmails: string[];
  // Where PUT /credentials writes the updated bindings back, so keys survive a restart. Absent or
  // read-only means the update is held in memory only and the caller is told so.
  tenantsFile?: string;
};
const lowerKeys = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase(), v]));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function parseDummyEmails(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase();
    if (!email || !EMAIL.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  if (!env.GATEWAY_TENANTS_FILE) throw new Error('GATEWAY_TENANTS_FILE is required');
  const tenants = new Map<string, TenantBinding>();
  for (const t of tenantFile.parse(JSON.parse(readFileSync(env.GATEWAY_TENANTS_FILE, 'utf8')))) {
    if (tenants.has(t.bearerSha256)) throw new Error('duplicate bearer credential in tenants file');
    tenants.set(t.bearerSha256, { tenantId: t.tenantId, apolloKey: t.apolloKey, hunterKey: t.hunterKey });
  }
  const tax = env.GATEWAY_TAXONOMY_FILE ? taxonomyFile.parse(JSON.parse(readFileSync(env.GATEWAY_TAXONOMY_FILE, 'utf8'))) : { industries: {}, titles: {} };
  const num = (v: string | undefined, d: number, min: number, max: number) => Math.min(max, Math.max(min, Number(v ?? d) || d));
  const dummyDiscovery = /^(1|true|yes|on)$/i.test(String(env.GATEWAY_DUMMY_DISCOVERY ?? '').trim());
  const dummyEmails = parseDummyEmails(env.GATEWAY_DUMMY_EMAILS);
  if (dummyDiscovery && dummyEmails.length === 0) throw new Error('GATEWAY_DUMMY_DISCOVERY requires GATEWAY_DUMMY_EMAILS with at least one email');
  return {
    tenants, taxonomy: { industries: lowerKeys(tax.industries), titles: lowerKeys(tax.titles) },
    syncWaitMs: num(env.GATEWAY_SYNC_WAIT_MS, 12000, 1000, 14000), // LeadMelo aborts a gateway call after 15 s
    discoveryDeadlineMs: num(env.GATEWAY_DISCOVERY_DEADLINE_MS, 90000, 5000, 600000),
    maxEnrichPerRequest: num(env.GATEWAY_MAX_ENRICH_PER_REQUEST, 60, 1, 500), maxPages: num(env.GATEWAY_MAX_PAGES, 3, 1, 10),
    storeFile: env.GATEWAY_STORE_FILE,
    tenantsFile: env.GATEWAY_TENANTS_FILE,
    dummyDiscovery, dummyEmails
  };
}

/**
 * Write the current bindings back to the tenants file so credentials set through the API survive a
 * restart. Keeps mode 600 because the file holds vendor keys in plaintext. Returns false instead of
 * throwing when the file is read-only: the in-memory update has already been applied and LeadMelo
 * re-pushes on demand, so failing the request would be misleading.
 */
export function persistTenants(config: GatewayConfig): boolean {
  const file = config.tenantsFile;
  if (!file) return false;
  try {
    const rows = [...config.tenants.entries()].map(([bearerSha256, b]) => {
      const row: Record<string, string> = { bearerSha256, tenantId: b.tenantId };
      if (b.apolloKey) row.apolloKey = b.apolloKey;
      if (b.hunterKey) row.hunterKey = b.hunterKey;
      return row;
    });
    // Write-then-rename so a crash mid-write cannot leave a truncated, unparseable config.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
