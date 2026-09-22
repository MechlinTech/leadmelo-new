# LeadMelo V20 Handoff

Read **START_HERE_DEV_MANAGER.md** first.

LeadMelo is a multi-tenant campaign engine, not an appointment-only tool. Each tenant defines an offer, ICP, sender, email sequence, follow-up strategy, calendar route and desired outcome. The worker discovers and verifies matching prospects through an operator-owned gateway, sends controlled outreach, stops on replies, sends a booking invitation after a clear positive reply, and records a meeting only after the calendar provider confirms the buyer accepted a time.

The campaign is the autonomous unit. A tenant can run several campaigns with different ICPs, offers, sequences, caps, calendars and outcomes. Campaigns are versioned, cloneable and roll-back-able, and can be A/B tested on email copy.

**Status: tested engineering pilot, not a production-ready autonomous sales platform.** Nothing has been run against a live Microsoft 365, Calendly, Apollo or Hunter account, on native PostgreSQL 16, in Docker, or under load. See `docs/AUDIT_AND_GAPS.md` for the register and `docs/VALIDATION_REPORT.md` for exactly what was executed.

## Quick validation

```bash
npm ci
npm run db:generate
npm run typecheck
npm test                  # unit + contract + script tests (5-9 shell tests need Linux bash)
npm run test:isolated     # database tests on in-memory PGlite; also run npm run test:integration on native PostgreSQL 16
npm run build
npm audit --audit-level=high
python3 scripts/handoff_audit.py
```

Node 22 LTS; PostgreSQL 16 for deployment. Tests never send real email or call vendor APIs. `npm run docs:schema` regenerates `docs/SCHEMA_REFERENCE.md`; a test fails if it is stale.

## What is in the package

| Area | Where |
|---|---|
| Web app, API, worker | `app/`, `components/`, `lib/`, `worker/` |
| Provider gateway (Apollo discovery, Hunter verification; written from vendor docs, not live-tested) | `gateway/`, `gateway/README.md` |
| **Database schema and migrations** | `prisma/schema.prisma`, `prisma/migrations/` (9 SQL migrations), `docs/DATABASE.md`, generated `docs/SCHEMA_REFERENCE.md` (tables, columns, relationships, data classification, retention, SQL constraints) |
| **Deployment** | `SELF_HOSTED_DEPLOYMENT.md` (primary runbook), `docs/WINDOWS_SERVER.md` (Windows Docker + two GitHub runners), `Dockerfile`, `docker-compose.selfhosted.yml` (postgres, migrate, web, worker, optional gateway; web on localhost:7676), `deploy/` (Caddy and nginx examples, systemd units, external monitor), `.env.example`, `.env.dev.example`, `.env.prod.example`, `scripts/preflight.sh`, `scripts/deploy.ps1` |
| **Backup and recovery** | `scripts/backup_postgres.sh` (encrypted database dump **and** erasure ledger, offsite), `restore_postgres.sh`, `check_backup.sh`, `docs/BACKUP_AND_RECOVERY.md` |
| Integrations | `docs/MICROSOFT_365.md`, `docs/CALENDLY.md`, `docs/PROVIDER_GATEWAY.md` |
| Operations, security, privacy | `docs/OPERATIONS.md`, `SECURITY.md`, `COMPLIANCE.md` |
| Status and acceptance | `docs/AUDIT_AND_GAPS.md`, `docs/VALIDATION_REPORT.md`, `docs/RELEASE_ACCEPTANCE.md`, `TEST_PLAN.md`, `RELEASE_FILE_HASHES.json` |

**Not included, by design or necessity:** no credentials, no `.env`, no `node_modules`, and **no database backup of a business database, because none exists**. The backup scripts create one on your server. They and the restore procedure have been exercised only against stub `docker`/`age`/`rsync` executables in tests, never against a real PostgreSQL, so run the restore drill in `docs/BACKUP_AND_RECOVERY.md` before relying on them.

Do not use a database reset to upgrade an existing installation; see `docs/DATABASE.md`.

## Screenshots

Real captures of the production build running against a demo workspace with fictional data (`node scripts/seed-demo.mjs` then `node scripts/capture-screenshots.mjs`), desktop and 375px mobile, in [docs/screenshots](docs/screenshots/README.md). Every page was also scanned with axe-core (WCAG 2.0/2.1 A and AA): 0 violations reported; automated scans do not replace a manual accessibility audit.

## Optional AI assist

Bring your own model (Ollama or any OpenAI-compatible service) in Settings > AI assist. It drafts an ICP and email sequence from a plain description and summarises replies with a suggested response. Drafts only: nothing is sent or suppressed by AI, opt-outs stay rule-based, and model output is stripped of links, addresses, unsubscribe text, unknown variables and guarantee-style claims. Off by default. See SELF_HOSTED_DEPLOYMENT.md for Ollama setup.
