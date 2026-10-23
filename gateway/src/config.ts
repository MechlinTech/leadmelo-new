import { readFileSync } from 'node:fs';
import { z } from 'zod';

// GATEWAY_TENANTS_FILE (OPTIONAL): JSON array binding each LeadMelo tenant's bearer credential (stored
// only as its SHA-256) to exactly one tenant and that tenant's OWN vendor keys:
//   [{ "bearerSha256": "<64 hex>", "tenantId": "...", "apolloKey": "...", "hunterKey": "..." }]
// Omit it and the gateway self-registers: the first request from a bearer claims a tenant ID and the
// claim is pinned to that bearer for the life of the process, so a bearer can never be re-pointed at a
// second tenant. Vendor keys are always managed from LeadMelo Settings over PUT /credentials, whether
// or not this file exists; setting it here only pre-seeds them.
// See the tenant-registration note in server.ts for what self-registration gives up.
// GATEWAY_TAXONOMY_FILE (optional): { "industries": { "<vendor industry, lowercase>": "<ICP industry>" },
//                                     "titles":     { "<vendor title, lowercase>": "<ICP title>" } }
// Only mappings between genuinely equivalent values belong here; they are how the operator lets a
// vendor's wording match an ICP's exact wording without relabelling anyone. A missing file is not a
// startup failure: built-in title equivalents still work and the gateway logs a warning. A file that is
// present but unreadable or malformed is a configuration error and stops startup, so a typo can never
// silently change who qualifies.
const tenantFile = z.array(z.object({ bearerSha256: z.string().regex(/^[0-9a-f]{64}$/), tenantId: z.string().min(1), apolloKey: z.string().min(8).optional(), hunterKey: z.string().min(8).optional() }).strict()).min(1);
const taxonomyFileSchema = z.object({ industries: z.record(z.string()).default({}), titles: z.record(z.string()).default({}) }).strict();

export type TenantBinding = { tenantId: string; apolloKey?: string; hunterKey?: string };
export type GatewayConfig = {
  tenants: Map<string, TenantBinding>; taxonomy: { industries: Record<string, string>; titles: Record<string, string> };
  /**
   * When true, an unknown bearer may claim a tenant ID on first contact (self-registration). Set
   * false by supplying GATEWAY_TENANTS_FILE, which restores the closed allow-list: only bearers
   * listed there are ever accepted. A tenants file therefore still *restricts* access.
   */
  allowSelfRegistration: boolean;
  syncWaitMs: number; discoveryDeadlineMs: number; maxEnrichPerRequest: number; maxPages: number; storeFile?: string;
  apolloBase?: string; hunterBase?: string;
  /** Path named by GATEWAY_TAXONOMY_FILE, for startup logs and diagnostics. */
  taxonomyFile?: string;
  /** Non-fatal configuration notes; startup logs them so an empty fallback is visible to operators. */
  warnings: string[];
};
const lowerKeys = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase(), v]));

function configErrorMessage(label: string, file: string, error: unknown) {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => `${issue.path.length ? issue.path.join('.') : 'file'}: ${issue.message}`).join('; ');
    return `${label} ${file} is invalid: ${issues}`;
  }
  if (error instanceof SyntaxError) return `${label} ${file} is not valid JSON`;
  const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
  if (code === 'ENOENT') return `${label} ${file} was not found`;
  if (code === 'EACCES' || code === 'EPERM') return `${label} ${file} is not readable (permission denied)`;
  if (code === 'EISDIR') return `${label} ${file} is a directory, not a file`;
  return `${label} ${file} could not be read: ${error instanceof Error ? error.message : 'unknown error'}`;
}

function readJsonFile(label: string, file: string) {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(configErrorMessage(label, file, error));
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(configErrorMessage(label, file, error));
  }
}

function parseJsonFile<T>(schema: z.ZodType<T>, label: string, file: string): T {
  const value = readJsonFile(label, file);
  try {
    return schema.parse(value);
  } catch (error) {
    throw new Error(configErrorMessage(label, file, error));
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const tenants = new Map<string, TenantBinding>();
  const warnings: string[] = [];
  // Optional: with no tenants file the gateway starts empty and learns tenants from the frontend.
  // Supplying one keeps its entries and turns self-registration back off, so the file narrows
  // access rather than merely seeding it. A configured tenants file that is missing is fatal: it
  // would otherwise silently reopen the gateway to self-registration.
  if (env.GATEWAY_TENANTS_FILE?.trim()) {
    const file = env.GATEWAY_TENANTS_FILE.trim();
    for (const t of parseJsonFile(tenantFile, 'gateway tenants file', file)) {
      if (tenants.has(t.bearerSha256)) throw new Error('duplicate bearer credential in tenants file');
      tenants.set(t.bearerSha256, { tenantId: t.tenantId, apolloKey: t.apolloKey, hunterKey: t.hunterKey });
    }
  }

  // The taxonomy file is optional, but when the operator names one it should be loaded exactly.
  // Missing is a safe, visible fallback; malformed or unreadable is fatal.
  let taxonomy = { industries: {} as Record<string, string>, titles: {} as Record<string, string> };
  let taxonomyFile: string | undefined;
  if (env.GATEWAY_TAXONOMY_FILE?.trim()) {
    taxonomyFile = env.GATEWAY_TAXONOMY_FILE.trim();
    let raw: string | undefined;
    try {
      raw = readFileSync(taxonomyFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        warnings.push(`gateway taxonomy file ${taxonomyFile} was not found; using built-in mappings only`);
      } else {
        throw new Error(configErrorMessage('gateway taxonomy file', taxonomyFile, error));
      }
    }
    if (raw !== undefined) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new Error(configErrorMessage('gateway taxonomy file', taxonomyFile, error));
      }
      try {
        taxonomy = taxonomyFileSchema.parse(value);
      } catch (error) {
        throw new Error(configErrorMessage('gateway taxonomy file', taxonomyFile, error));
      }
      if (Object.keys(taxonomy.industries).length === 0 && Object.keys(taxonomy.titles).length === 0) {
        warnings.push(`gateway taxonomy file ${taxonomyFile} defines no custom mappings; using built-in mappings only`);
      }
    }
  }

  const allowSelfRegistration = tenants.size === 0;
  const num = (v: string | undefined, d: number, min: number, max: number) => Math.min(max, Math.max(min, Number(v ?? d) || d));
  return {
    tenants, allowSelfRegistration,
    taxonomy: { industries: lowerKeys(taxonomy.industries), titles: lowerKeys(taxonomy.titles) },
    syncWaitMs: num(env.GATEWAY_SYNC_WAIT_MS, 12000, 1000, 14000), // LeadMelo aborts a gateway call after 15 s
    discoveryDeadlineMs: num(env.GATEWAY_DISCOVERY_DEADLINE_MS, 90000, 5000, 600000),
    maxEnrichPerRequest: num(env.GATEWAY_MAX_ENRICH_PER_REQUEST, 60, 1, 500), maxPages: num(env.GATEWAY_MAX_PAGES, 3, 1, 10),
    storeFile: env.GATEWAY_STORE_FILE,
    taxonomyFile,
    warnings
  };
}
