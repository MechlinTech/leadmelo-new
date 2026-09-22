// Generates docs/SCHEMA_REFERENCE.md from prisma/schema.prisma and the committed SQL migrations.
//   node scripts/generate-schema-docs.mjs          write the file
//   node scripts/generate-schema-docs.mjs --check  fail if the committed file is out of date
// tests/schema-docs.test.mjs runs the check, and fails when a model has no classification below, so the
// reference cannot silently go stale when the schema changes.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs', 'SCHEMA_REFERENCE.md');

// Classification: P personal data about prospects/contacts, U staff account data, S secret or credential
// (encrypted or hashed), B business/configuration, O operational/system, A audit or compliance record.
// `retention` states what the application ACTUALLY does today, not what a policy might require.
export const CLASSIFICATION = {
  Tenant: ['B', 'Kept until the tenant is deleted; deletion cascades to nearly every table.'],
  User: ['U,S', 'Kept until deleted. Holds email, name, scrypt password hash, AES-256-GCM encrypted TOTP secret and hashed recovery codes.'],
  Invite: ['U', 'Invitee email. Only the token hash is stored. Expired or accepted invitations are not purged.'],
  Lead: ['B,P', 'Company record. `contactName`/`contactEmail` are personal and are cleared by an erasure request.'],
  Contact: ['P', 'Prospect name, email, title, LinkedIn URL. Deleted by an erasure request; otherwise kept.'],
  DataProvider: ['B,S', 'Defined in the schema but NOT used by any current code path (provider credentials live in TenantSetting).'],
  ICP: ['B', 'Targeting definition. Kept.'],
  DiscoveryJob: ['B', 'Defined in the schema but NOT used by any current code path (discovery runs are AutomationRun).'],
  Campaign: ['B', 'Campaign configuration including sender identity. Kept; edits are versioned in CampaignVersion.'],
  SequenceStep: ['B', 'Email copy. Kept.'],
  OutreachEvent: ['P', 'Message subject/body and delivery state per contact. Optional retention job nulls subject/body after N days (never for queued or sending work); an erasure request nulls them and detaches the contact.'],
  Reply: ['P', 'Free-text reply snippet. Optional retention job redacts it after N days; an erasure request deletes it.'],
  Appointment: ['P,B', 'Meeting times, timezone, qualification notes. An erasure request detaches the contact and clears notes; the business record is kept.'],
  CampaignOutcome: ['B', 'Defined in the schema but NOT used by any current code path (outcomes are recorded on Appointment).'],
  CalendarRoutingRule: ['B', 'Defined in the schema but NOT used by any current code path.'],
  DeliverabilityProfile: ['O', 'Sender health fed by signed events. Kept.'],
  AutomationRun: ['O', 'Discovery run state and leases. Not purged.'],
  TenantSetting: ['B,S', 'Caps, postal address, spend/retention settings, and AES-256-GCM encrypted gateway key, webhook secret and Calendly signing key.'],
  AuditEvent: ['A', 'Who did what. Kept indefinitely (no purge implemented). Privacy events store only a hash prefix of the email, never the address.'],
  Suppression: ['P,A', 'Do-not-contact addresses in plaintext, needed to enforce them. Kept permanently; it is the one record retained after an erasure.'],
  Session: ['U,S', 'Hashed session tokens. Expired sessions are purged by the worker every tick.'],
  RateLimit: ['O', 'Fixed-window counters. Expired rows are purged by the worker every tick.'],
  Enrollment: ['P', 'Score and evidence about one contact in one campaign. Deleted with the contact.'],
  WebhookEvent: ['O', 'Provider event IDs for de-duplication. Not purged.'],
  WorkerHeartbeat: ['O', 'Worker liveness for readiness checks.'],
  M365Connection: ['S,B', 'Microsoft directory/client IDs, allowlisted mailboxes and AES-256-GCM encrypted client secret.'],
  MailReceipt: ['O', 'Send reconciliation: request hash, Graph message IDs. Holds no recipient address.'],
  MailCursor: ['O', 'Inbox delta cursors per mailbox.'],
  OperationalAlert: ['O', 'Alert state and delivery attempts (IDs and codes only).'],
  CampaignVersion: ['B', 'Full snapshot of campaign settings and copy per material edit. Kept.'],
  UsageLedger: ['B,A', 'Metering rows (discovery, emails, verifications) with cost. Contains no personal data. Not enforced as immutable by a database trigger.'],
  PasswordReset: ['U,S', 'Token hash, expiry, used-at. Not purged.'],
  Experiment: ['B', 'A/B test definition. Kept.'],
  ExperimentVariant: ['B', 'Variant copy. Kept.'],
  ExperimentAssignment: ['P', 'Links an enrollment to the arm it received. Deleted with the enrollment.'],
  ExperimentRecommendation: ['B,A', 'Statistical verdict and the human decision on it. Kept.'],
  AccessRequest: ['P', 'Name, email, company and message a visitor typed into the public access form or assistant. Not purged; the operator handles and should delete them.'],
  AssistantQuestion: ['O', 'Public assistant questions it could not answer (truncated, email and phone patterns redacted) to find gaps in the knowledge base. Not purged.']
};
const KEY = { P: 'personal data about prospects/contacts', U: 'staff account data', S: 'secret or credential (encrypted or hashed)', B: 'business/configuration', O: 'operational/system', A: 'audit or compliance record' };

function parseSchema(text) {
  const models = [], enums = [];
  const re = /^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (let m; (m = re.exec(text));) {
    const body = m[3].split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
    if (m[1] === 'enum') { enums.push({ name: m[2], values: body }); continue; }
    const fields = [], blocks = [];
    for (const line of body) {
      if (line.startsWith('@@')) { blocks.push(line); continue; }
      const f = /^(\w+)\s+([\w.]+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!f) continue;
      const attrs = f[5].replace(/\s+/g, ' ').trim();
      const rel = /@relation\((?:.*?)fields:\s*\[(\w+)\],\s*references:\s*\[(\w+)\]/.exec(attrs);
      fields.push({ name: f[1], type: f[2], list: !!f[3], optional: !!f[4], attrs, relation: rel ? { field: rel[1], references: rel[2] } : null });
    }
    models.push({ name: m[2], fields, blocks });
  }
  return { models, enums };
}

export function generate() {
  const { models, enums } = parseSchema(readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8'));
  const enumNames = new Set(enums.map(e => e.name)), modelNames = new Set(models.map(m => m.name));
  for (const m of models) if (!CLASSIFICATION[m.name]) throw new Error(`Model ${m.name} has no entry in CLASSIFICATION (scripts/generate-schema-docs.mjs)`);
  for (const name of Object.keys(CLASSIFICATION)) if (!modelNames.has(name)) throw new Error(`CLASSIFICATION lists ${name}, which is not in the schema`);
  const migrations = readdirSync(join(root, 'prisma', 'migrations'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  const out = [];
  out.push('# Schema Reference', '', '> Generated by `npm run docs:schema` from `prisma/schema.prisma` and `prisma/migrations/`. **Do not edit by hand.** `tests/schema-docs.test.mjs` fails when this file is out of date or a table lacks a classification.', '');
  out.push(`PostgreSQL 16, ${models.length} tables, ${enums.length} enums, ${migrations.length} committed migrations. \`prisma/schema.prisma\` is the source of truth for the Prisma client; the SQL migrations additionally hold triggers, CHECK constraints and partial indexes that Prisma cannot express (see "Invariants enforced in SQL").`, '');
  out.push('## Migrations', '', ...migrations.map(n => `1. \`${n}\``), '', 'Migrations are applied in order with `npm run db:deploy` and are never reset in production. See `docs/DATABASE.md` for upgrade and rollback guidance.', '');
  out.push('## Data classification and retention', '', 'Classes: ' + Object.entries(KEY).map(([k, v]) => `**${k}** ${v}`).join('; ') + '.', '', 'The "Retention today" column states what the application actually does. Where it says "not purged", no automatic deletion exists.', '', '| Table | Class | Retention today |', '|---|---|---|');
  for (const m of models) out.push(`| \`${m.name}\` | ${CLASSIFICATION[m.name][0]} | ${CLASSIFICATION[m.name][1].replace(/\|/g, '\\|')} |`);
  out.push('');
  out.push('## Entity relationships', '', '```mermaid', 'erDiagram');
  for (const m of models) for (const f of m.fields) {
    if (!f.relation || !modelNames.has(f.type)) continue;
    out.push(`  ${f.type} ${f.optional ? '|o' : '||'}--o{ ${m.name} : "${f.relation.field}"`);
  }
  out.push('```', '');
  out.push('Tables also carry a plain `tenantId` (no Prisma relation) where the foreign key is added in SQL; the tenant-link triggers below reject cross-tenant references.', '');
  out.push('## Tables', '');
  for (const m of models) {
    out.push(`### ${m.name}`, '', `Class ${CLASSIFICATION[m.name][0]}. ${CLASSIFICATION[m.name][1]}`, '', '| Column | Type | Notes |', '|---|---|---|');
    // Relation fields (`tenant`, `campaign`, ...) and back-references are not columns; the real column is the
    // scalar named in `fields: [...]`, which gets the foreign-key note.
    const fk = new Map(m.fields.filter(f => f.relation && modelNames.has(f.type)).map(f => [f.relation.field, `FK to ${f.type}.${f.relation.references}`]));
    for (const f of m.fields) {
      if (modelNames.has(f.type)) continue;
      const type = `${f.type}${f.list ? '[]' : ''}${f.optional ? '?' : ''}`;
      const def = /@default\((.*?)\)(?= @|$)/.exec(f.attrs)?.[1];
      const notes = [f.attrs.includes('@id') ? 'primary key' : '', f.attrs.includes('@unique') ? 'unique' : '', def ? `default ${def}` : '', fk.get(f.name) ?? '', enumNames.has(f.type) ? 'enum' : ''].filter(Boolean).join('; ');
      out.push(`| \`${f.name}\` | ${type} | ${notes} |`);
    }
    if (m.blocks.length) out.push('', 'Constraints/indexes declared in the schema: ' + m.blocks.map(b => `\`${b}\``).join(', '));
    out.push('');
  }
  out.push('## Enums', '', ...enums.map(e => `- \`${e.name}\`: ${e.values.join(', ')}`), '');
  out.push('## Invariants enforced in SQL', '', 'Hand-written database rules extracted from the migrations: functions, tenant-link triggers, CHECK constraints and partial unique indexes. These hold even if application code is wrong. Routine foreign keys are shown in the table sections above.', '');
  for (const dir of migrations) {
    const sql = readFileSync(join(root, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8');
    const lines = sql.split('\n').map(l => l.trim()).filter(l => /^CREATE (TRIGGER|FUNCTION)|^CREATE UNIQUE INDEX .* WHERE|CONSTRAINT \w+ CHECK|ADD CONSTRAINT \w+ CHECK/.test(l));
    if (!lines.length) continue;
    out.push(`### ${dir}`, '', ...lines.map(l => `- \`${l.replace(/`/g, "'").replace(/\|/g, '\\|').slice(0, 260)}\``), '');
  }
  return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = generate() + '\n';
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    if (current !== text) { console.error('docs/SCHEMA_REFERENCE.md is out of date: run npm run docs:schema'); process.exit(1); }
    console.log('docs/SCHEMA_REFERENCE.md is up to date');
  } else { writeFileSync(OUT, text); console.log(`wrote ${OUT}`); }
}
