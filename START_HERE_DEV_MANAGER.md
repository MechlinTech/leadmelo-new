# LeadMelo V20 (V19 baseline + increments): Development Manager Handoff

Release status: **tested engineering pilot; not approved for unattended production sales outreach.** No real prospect was contacted, no real email was sent and no real meeting was booked while building or testing this release.

## What V20 adds on top of V19 (all tested; see docs/VALIDATION_REPORT.md for exact commands and limits)

1. Fix: the run-claim SQL was time-zone dependent and never claimed work on a non-UTC PostgreSQL session.
2. Calendly adapter: signed webhook verification, HMAC-signed campaign/contact attribution in every scheduling link, duplicate/out-of-order/cancel handling.
3. Campaign edit, versioning, rollback and clone; approvals revoked on material edits.
4. Usage ledger (discovery, emails, verifications), hard monthly spend reservation, operator tenant suspension.
5. Identity: invitations, TOTP MFA with recovery codes, administrator-issued password reset. (No SSO.)
6. Operations: sender/reply-sync/stuck-send alerts, daily digest endpoint, external readiness monitor script.
7. Reply classifier rewrite with reason codes, prompt-injection defence and a labelled regression set.
8. Privacy engineering: export, erasure, erasure-ledger re-application after restore, message retention.
9. UI for the above (digest, campaign history/clone/restore, MFA, invitations, privacy, accept/reset pages).
10. Controlled email-copy experiments with statistically guarded, human-decided recommendations.
11. Apollo discovery + Hunter verification gateway (`gateway/`), written from vendor docs, mock-tested only.
12. Packaging completion: encrypted backup now includes an erasure ledger and restore re-applies it; generated schema reference (`docs/SCHEMA_REFERENCE.md`) with data classification and retention; optional gateway service in compose; Calendly setup guide (`docs/CALENDLY.md`); V19-to-V20 upgrade steps; a sender-health posting tool; settings UI for the Calendly key, spend cap and retention; Calendly cancellation-field and tolerance fixes found by reading Calendly's OpenAPI file.

## Setup order (exact)

```
npm ci
npm run db:generate
npm run typecheck
npm test                 # 77 tests; on Windows 10 shell-script tests skip unless FORCE_POSIX_TESTS=1 BASH_BIN=<git bash>; they run on Linux
npm run test:isolated    # 65 pass on PGlite (WebAssembly PostgreSQL). Also run against native PostgreSQL 16.
npm run build
```

Local development database (in-memory PGlite, data lost on exit): `node scripts/dev-pglite.mjs`, then run the app with the printed `DATABASE_URL` plus `?pgbouncer=true`, and `npm run bootstrap` for the first administrator.
Migrations 1-9 are in `prisma/migrations/`. Production setup, backup and recovery: `SELF_HOSTED_DEPLOYMENT.md`, `docs/BACKUP_AND_RECOVERY.md` (now including the post-restore erasure step).

## Honest blockers (unchanged or newly explicit)

- **Discovery/verification: Apollo + Hunter adapters exist in `gateway/` but were written from vendor documentation and have never run against a live account.** Read `gateway/README.md` (assumption list, known gaps, live acceptance checklist) before trusting them. Other vendors are not implemented. This remains the main production blocker until live acceptance passes.
- Microsoft 365 mail and Calendly are implemented and tested only against synthetic/mocked responses. Nothing has run against a live account.
- Not run at all: native PostgreSQL 16 concurrency tests, Docker/compose deployment, backup/restore drill with measured RPO/RTO, load test, security scan, accessibility audit, keyboard/screen-reader testing, live external paging.
- Google/Microsoft SSO, self-service password recovery, billing/paid plans, CRM sync, operator admin console UI, experiment UI, spend-cap/usage/retention settings UI are not built.
- Privacy and compliance: engineering support only. Terms, privacy notice, DPAs, lawful basis and jurisdiction sign-off need qualified people.
- The reply classifier is keyword rules; its labelled set was written with the rules and is not an accuracy estimate.
- Meeting volume cannot be guaranteed. Measure attended qualified meetings, opportunities and cost per attended meeting.

## Ownership suggestion

Integrations owner: gateway adapters and live Microsoft/Calendly acceptance. Platform owner: hosting, native PostgreSQL run, backup drill, external monitor. QA owner: browser/accessibility/load/security gates and the Linux run of skipped tests. Privacy owner: legal documents and jurisdiction review.

Use the Mechlin calendar `https://calendly.com/pm-mechlintech/30min` only for Mechlin's campaign. Sender identity and mailbox must be supplied and verified by Mechlin; none is assumed.

---

# Previous release notes (V19)

Audit date: 18 September 2026. Release status: **tested engineering pilot; not approved for unattended production sales outreach**.

## Decision

V16 was a UI and architecture scaffold. Its successful API responses did not save records, its database schema was not valid Prisma, and it had no executing revenue engine. V17 repaired those foundations. V18 restores the complete product purpose: an ICP-driven campaign runs discovery, qualification, initial email, timed follow-ups, reply handling and appointment routing as one autonomous loop. No real prospect was contacted and no real meeting was booked during this audit.

The goal is tenant-specific campaigns that produce qualified meetings with little daily administration. Meeting volume cannot be guaranteed by software: it depends on offer quality, market size, contact data, reputation and buyer acceptance. Measure **qualified meetings attended, qualified opportunities and cost per attended meeting**, not just invitations or calendar-link clicks.

## Read In This Order

1. `docs/AUDIT_AND_GAPS.md`: defects, changes and remaining implementation work.
2. `docs/VALIDATION_REPORT.md`: what was actually executed and what was not.
3. `SELF_HOSTED_DEPLOYMENT.md`: exact physical-server deployment and first administrator.
4. `docs/DATABASE.md` and `prisma/migrations/`: schema, constraints and upgrade handling.
5. `docs/BACKUP_AND_RECOVERY.md`: encrypted offsite backups and recovery drill.
6. `docs/PROVIDER_GATEWAY.md`: the external integration contract the engine requires.
7. `docs/RELEASE_ACCEPTANCE.md`: go-live gates and ownership.

## Added In V19

- Native Microsoft Graph app-only mail adapter: encrypted credentials, mailbox allowlist, persisted draft/send receipts and reconciliation without blind resends.
- Inbox delta synchronization, final Sent Items message-ID correlation, deduplicated replies, and a send gate when mailbox synchronization is unhealthy.
- Unknown-thread replies from known buyers stop contact outreach and raise an attribution exception; explicit negative replies also suppress the contact.
- Automatic contact reverification through the gateway, bounded retries and suppression of invalid/risky addresses.
- Persistent tenant-scoped alerts, an acknowledgement UI, and signed webhook notification delivery with retries.
- Network calls moved outside DB reservation transactions, with durable send leases and late-result ownership checks.
- Fourth SQL migration and integration/failure tests. Read `docs/MICROSOFT_365.md` for setup and limitations.

## Working In This Release

- Password login, expiring database sessions, role checks, tenant-scoped APIs and protected workspace pages.
- One-step tenant campaign creation with an inline or reusable ICP, offer, independent sequence/follow-up strategy, caps, timezone, calendar route, automation mode and outcome objective.
- Optional immediate activation after sender, tenant and campaign safety gates pass; otherwise the campaign is saved as a draft with the exact activation blocker.
- Database-backed background scheduling; discover, qualify, deduplicate, enroll, sequence, throttle, retry and stop-on-reply logic.
- HTTPS provider gateway client with timeouts, response validation and idempotency keys. Test gateway is a simulator, not a live lead database.
- Signed normalized event ingestion for replies, sender health, bounce/complaint/unsubscribe and confirmed booking/cancellation events. Clear positive intent stops the sales sequence and queues one idempotent booking email with that campaign's calendar URL.
- Encrypted provider credentials, unsubscribe suppression, database cross-tenant reference checks, audit records and send kill switches.
- Live meetings/prospects/campaigns/run views with empty/error states; no invented metrics.
- SQL migrations, Docker web/worker/database topology, least-privilege application DB role, backup/restore scripts, systemd timer and CI gates.

## What Still Prevents Production

The production discovery/verification/calendar gateway is **not implemented in this package**. A dev team must implement and certify those contracts, plus sender health/bounce/complaint feeds. Microsoft 365 mail sending and Inbox polling now have native implementations, tested with mocked Microsoft responses, not a live account. Adding an Apollo key or a Calendly link alone is insufficient. The complete loop still cannot find real buyers and confirm live meetings until those remaining adapters and authorized accounts are connected.

Google/Microsoft SSO, automatic onboarding/invitation delivery, self-service password recovery/MFA, paid billing, advanced AI research and free-form reply negotiation, CRM integrations, autonomous optimization, privacy export/deletion workflows, and complete production monitoring also remains unfinished (V19 includes operational alerts and a signed alert webhook). They are identified in the gap register, not represented as completed features.

The supplied backups are scripts and runbooks; **this package does not contain a backup of your business database**. No production database was supplied. A real encrypted backup, offsite recovery drill, Docker rollout, native PostgreSQL concurrency test, browser test and load/security assessment must pass in staging before launch.

## Manager's First Assignment

Assign a backend/integrations owner to the gateway, a platform owner to physical hosting and recovery, and a QA owner to acceptance evidence. Run `npm ci`, `npm run db:generate`, `npm test`, `npm run test:isolated`, `npm run typecheck`, and `npm run build`. The isolated test uses PostgreSQL compiled to WebAssembly; also run CI against native PostgreSQL 16. Do not bypass activation gates or change `OUTBOUND_ENABLED` merely to make a demo appear successful.

Use the Mechlin calendar `https://calendly.com/pm-mechlintech/30min` only for Mechlin's campaign. Shubham's exact sender address and connected mailbox must be supplied and verified by Mechlin; no address is assumed. Other tenants must supply their own senders and calendars.

## Package contents checklist (database, schema, deployment)

| You asked for | Where | State |
|---|---|---|
| Database schema | `prisma/schema.prisma` (36 tables), `docs/SCHEMA_REFERENCE.md` (generated: columns, ER diagram, data classification, retention, SQL constraints), `docs/DATABASE.md` | Complete and kept current by a failing test. RLS is not implemented. 4 tables are defined but unused (named in the docs). |
| Migrations | `prisma/migrations/` (9 SQL migrations) | Apply cleanly on PGlite, twice. **Not run on native PostgreSQL 16.** |
| Deployment instructions | `SELF_HOSTED_DEPLOYMENT.md` (8 sections, V19->V20 upgrade), `DEPLOYMENT_CHANGES.md`, `Dockerfile`, `docker-compose.selfhosted.yml`, `deploy/caddy`, `deploy/nginx`, `deploy/systemd`, `deploy/monitor`, `scripts/preflight.sh`, `.env.example` | Written and structurally tested (secret separation, no published DB port, version agreement, `bash -n`). **Docker was never run.** |
| Database backup | `scripts/backup_postgres.sh`, `restore_postgres.sh`, `check_backup.sh`, `deploy/systemd/leadmelo-backup.*`, `docs/BACKUP_AND_RECOVERY.md` | Scripts tested against **stub** docker/age/rsync (ordering, failures, refusals; a mutation check confirmed the tests can fail). **No real backup exists in this package** because no business database was supplied; the first real backup and restore drill must be done on your server. |

Before go-live, read `docs/RELEASE_ACCEPTANCE.md` (V20 gates): native PostgreSQL run, Docker stack, real backup/restore drill, vendor and Calendly live acceptance, sender-health feed, external monitor, accessibility/load/security.
