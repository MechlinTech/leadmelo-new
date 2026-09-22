from pathlib import Path
import re,sys
root=Path(__file__).resolve().parents[1]
required=[
 'DEPLOYMENT_INSTRUCTIONS.md','SELF_HOSTED_DEPLOYMENT.md','README.md','SECURITY.md','COMPLIANCE.md','TEST_PLAN.md',
 'Dockerfile','docker-compose.yml','docker-compose.selfhosted.yml','.env.example','.dockerignore',
 'deploy/caddy/Caddyfile.example','deploy/nginx/leadmelo.conf.example','deploy/systemd/leadmelo-compose.service.example',
 'scripts/preflight.sh','scripts/backup_postgres.sh','scripts/restore_postgres.sh',
 'scripts/check_backup.sh','package-lock.json','worker/index.ts','START_HERE_DEV_MANAGER.md',
 'docs/DATABASE.md','docs/BACKUP_AND_RECOVERY.md','docs/AUDIT_AND_GAPS.md',
 'docs/PROVIDER_GATEWAY.md','docs/RELEASE_ACCEPTANCE.md','docs/VALIDATION_REPORT.md',
 'prisma/migrations/202609180001_initial/migration.sql','prisma/migrations/202609180002_invariants/migration.sql',
 'prisma/migrations/202609180003_campaign_icp_autopilot/migration.sql',
 'docs/MICROSOFT_365.md','docs/OPERATIONS.md',
 'prisma/migrations/202609180004_m365_reliability/migration.sql',
 'tests/integration/reliability.test.mjs','lib/m365/send.ts','lib/m365/sync.ts',
 'public/manifest.webmanifest','public/sw.js','public/icons/logo.svg','prisma/schema.prisma',
 'prisma/migrations/202609180005_calendly_adapter/migration.sql','prisma/migrations/202609180006_versions_usage/migration.sql',
 'prisma/migrations/202609180007_identity/migration.sql','prisma/migrations/202609180008_retention/migration.sql',
 'prisma/migrations/202609180009_experiments/migration.sql',
 'docs/SCHEMA_REFERENCE.md','docs/CALENDLY.md','gateway/README.md','gateway/src/server.ts','gateway/src/discover.ts',
 'deploy/monitor/external-monitor.sh','scripts/privacy-erasures.ts','scripts/generate-schema-docs.mjs','scripts/post-sender-health.mjs',
 'prisma/migrations/202609180010_growth_deliverability/migration.sql','lib/plans.ts','lib/entitlements.ts','lib/senderHealth.ts','lib/calendlyReconcile.ts','lib/assistant/engine.ts','lib/assistant/knowledge.ts','lib/themes.ts','public/offline.html','public/icons/icon-512.png','public/icons/maskable-512.png','app/(site)/page.tsx','app/(site)/pricing/page.tsx','docs/CALENDLY.md',
 'tests/integration/growth.test.mjs','tests/assistant.test.mjs','tests/pwa.test.mjs','tests/themes.test.mjs','tests/deliverability.test.mjs','tests/integration/versions_usage.test.mjs','tests/integration/identity.test.mjs','tests/integration/privacy.test.mjs','tests/gateway.test.mjs','docs/screenshots/README.md','prisma/migrations/202609180011_ai_assist/migration.sql','lib/ai/client.ts','lib/ai/features.ts','tests/ai.test.mjs','tests/integration/ai.test.mjs','scripts/mock-llm.mjs','docs/DB_SCHEMA_FULL.sql','scripts/capture-screenshots.mjs','scripts/seed-demo.mjs'
]
errors=[]
for f in required:
    if not (root/f).exists(): errors.append('missing '+f)
# inspect internal static asset targets
files=[p for p in root.rglob('*') if p.is_file() and not any(part in {'node_modules','.next','.git','test-results','playwright-report'} for part in p.relative_to(root).parts)]
for p in (p for p in files if p.suffix=='.tsx'):
    t=p.read_text(errors='ignore')
    for val in re.findall(r'(?:href|src)=["\']([^"\']+)["\']',t):
        if val.startswith('/icons/') and not (root/'public'/val.lstrip('/')).exists():
            errors.append(f'broken asset {val} in {p.relative_to(root)}')
# secret leakage check
for p in files:
    if p.is_file() and p.name not in {'.env.example'} and p.suffix in {'.ts','.tsx','.js','.mjs','.md','.yml','.yaml','.json'}:
        txt=p.read_text(errors='ignore')
        if re.search(r'sk-[A-Za-z0-9]{20,}',txt): errors.append(f'possible secret in {p.relative_to(root)}')
# portability guard: UI must not require AWS-specific secret storage wording
settings=(root/'app/app/settings/page.tsx').read_text(errors='ignore')
if 'must be encrypted using AWS' in settings:
    errors.append('AWS-specific requirement remains in tenant settings UI')
print(f'Checked {len(files)} source/handoff files')
if errors:
    print('\n'.join('ERROR: '+e for e in errors));sys.exit(1)
print('PASS: required files, provider-portability guard, static assets and secret leakage checks')
