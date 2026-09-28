# Database Schema And Migration Guide

Database: PostgreSQL 16. Source of truth for the application client: `prisma/schema.prisma`. The **complete, generated** table, column, relationship, classification and constraint listing is in [`SCHEMA_REFERENCE.md`](SCHEMA_REFERENCE.md); it is regenerated with `npm run docs:schema` and a test fails if it goes stale or a table is left unclassified. This guide explains how the pieces fit and how to operate them.

## Migrations (apply in order, never reset)

| Migration | Adds |
|---|---|
| `202609180001_initial` | Baseline schema |
| `202609180002_invariants` | Tenant-link trigger function and triggers, CHECK constraints, one-active-enrollment index, work-queue indexes |
| `202609180003_campaign_icp_autopilot` | Campaign autopilot fields |
| `202609180004_m365_reliability` | Microsoft connection, send receipts, Inbox cursors, alerts, verification retries, send leases |
| `202609180005_calendly_adapter` | `TenantSetting.calendlySigningKey` |
| `202609180006_versions_usage` | `Campaign.version`, `CampaignVersion`, `UsageLedger`, spend/suspension columns on `TenantSetting` |
| `202609180007_identity` | TOTP and recovery-code columns on `User`, `PasswordReset` |
| `202609180008_retention` | `TenantSetting.messageRetentionDays` |
| `202609180009_experiments` | `Experiment`, `ExperimentVariant`, `ExperimentAssignment`, `ExperimentRecommendation`, partial unique indexes |

All of V20's migrations (5-9) are **additive**: new tables, new nullable or defaulted columns, new constraints on new tables. None drops or rewrites existing data, so a V19 database upgrades with `npm run db:deploy`. Even so: back up first, rehearse on a restored copy, and run `docker compose run --rm migrate` (which also re-applies runtime-role grants) rather than migrating by hand.

## Model map

| Domain | Tables | Purpose |
|---|---|---|
| Tenancy and access | Tenant, User, Session, Invite, PasswordReset, TenantSetting, RateLimit | Tenants, staff accounts, expiring sessions, invitations, administrator-issued password resets, per-tenant settings and secrets, rate limiting |
| Targeting | ICP, Campaign, SequenceStep, CampaignVersion | Offer, targeting and email sequence; every material edit stores a full snapshot |
| Prospects | Lead, Contact, Enrollment | Company and person records, de-duplication, per-campaign fit and evidence |
| Execution | AutomationRun, OutreachEvent, WorkerHeartbeat | Durable queue with leases, attempts, idempotency keys and send reservations |
| Responses and health | Reply, Suppression, DeliverabilityProfile | Reply intent, do-not-contact list, sender health and caps |
| Meetings | Appointment | Bookings confirmed by the calendar provider, qualification, outcome |
| Microsoft / reliability | M365Connection, MailReceipt, MailCursor, OperationalAlert | Encrypted app credentials, send reconciliation, Inbox cursors, alert delivery |
| Metering and spend | UsageLedger | Discovery purchases (reserved before buying), emails, verifications |
| Experiments | Experiment, ExperimentVariant, ExperimentAssignment, ExperimentRecommendation | Copy tests, stable assignment, recommendations and the human decision |
| Audit and integration | AuditEvent, WebhookEvent | Who did what, webhook de-duplication |

**Defined but not used by any current code:** `DataProvider`, `DiscoveryJob`, `CampaignOutcome`, `CalendarRoutingRule`. They are harmless leftovers from earlier designs; do not build on them without checking. Discovery runs are `AutomationRun`, provider credentials live in `TenantSetting`, and outcomes are recorded on `Appointment`.

## Sensitive data and encryption

- Personal data about prospects: `Contact`, `Lead.contactName/contactEmail`, `OutreachEvent.subject/body`, `Reply.rawSnippet`, `Appointment` notes, `Suppression.email`, and the `Enrollment.evidence` and `ExperimentAssignment` rows tied to a contact. Full classification and retention per table is in `SCHEMA_REFERENCE.md`.
- Encrypted with AES-256-GCM using `DATA_ENCRYPTION_KEY` (not stored in the database): `TenantSetting.gatewayKey`, `webhookSecret`, `calendlySigningKey`, `M365Connection.encryptedSecret`, `User.totpSecret`. Losing that key makes them unrecoverable; keep it separately recoverable from the database backup.
- Hashed, never stored raw: passwords (salted scrypt), session tokens, invitation tokens, password-reset tokens, MFA recovery codes.
- Retention that actually runs today: expired `Session` and `RateLimit` rows are purged every worker tick; an optional per-tenant setting redacts old message bodies and replies. Everything else is kept until an erasure request or tenant deletion. No purge exists for audit events, webhook events, alerts, invitations or usage rows.
- Encrypt the disk and every backup, limit database access, and never copy real data into a test fixture.

## Invariants enforced in SQL

The generated reference lists every trigger, CHECK constraint and partial index. In summary:

- Uniqueness: tenant+email contacts, tenant+domain leads, campaign+contact enrollments, tenant+provider booking ID, tenant+webhook event ID, tenant+ledger idempotency key, experiment+enrollment assignments, global work idempotency keys.
- At most one active enrollment per contact per tenant; at most one RUNNING experiment per campaign step; exactly one control variant per experiment.
- Tenant-link triggers reject any row that references a parent belonging to another tenant, and reject changing a row's tenant. They cover campaigns, enrollments, runs, outreach events, replies, appointments, campaign versions, usage rows and the experiment tables.
- CHECK constraints: campaign caps/hours, appointment intervals, ICP and enrollment scores, non-negative spend and usage, retention minimum (30 days), experiment status/metric/limits, variant weights.
- Tenant IDs come from the authenticated user, never from a JSON body. The public webhook URLs identify a tenant but require that tenant's signing secret.
- These constraints do not replace API authorization, and there is **no PostgreSQL row-level security**. The runtime database role can read every tenant; enforcement is in the application plus the triggers above.

## Database roles

`POSTGRES_USER` (owner, `leadmelo`) runs migrations and restores. The application runs as `leadmelo_app` (no DDL, no access to `_prisma_migrations`). `scripts/database-role.ts` creates the role and re-grants table privileges; the Docker `migrate` service runs it after every `db:deploy`, which is how new tables become accessible to the app. **If you migrate outside Docker, run `node --import tsx scripts/database-role.ts` afterwards, or the new tables will be unreadable to the app.** A database restored with `--no-acl` has no runtime grants until the role script runs.

## New installation

`npm run db:deploy` applies the committed migrations. `npm run db:generate` only generates the client; it does **not** create tables. Docker's migration service runs deployment and grants before web and worker start. Never use `prisma db push` for a release.

## Existing installation and upgrades

- **V19 to V20:** additive as described above. Sequence: pause campaigns, stop the worker, take an offsite backup, rehearse on a restored copy, run the migration service, recreate web and worker, resume.
- **Any V16 database:** there is no trustworthy automated upgrade. If tables were created manually, stop and inventory them, restore a staging copy, compare schema, and write and test a dedicated data migration. Do not apply the baseline over existing business tables, reset, or mark migrations applied to silence an error.
- **Future releases:** generate migrations in a development database, review the SQL, rehearse on a restored copy, deploy committed SQL, and prefer expand/migrate/contract across releases.
- **Rollback:** revert the application image only if the schema stays compatible (additive migrations usually do). Never run reverse SQL automatically or restore over the live database. A backup is a disaster-recovery option with a data-loss window, not a migration strategy.
- **After any restore:** re-apply the erasure ledger (see `BACKUP_AND_RECOVERY.md`).

## Useful commands

```bash
npm run db:validate       # validate schema.prisma
npm run db:generate       # generate the Prisma client
npm run db:deploy         # apply committed migrations
npx prisma migrate status
npm run docs:schema       # regenerate docs/SCHEMA_REFERENCE.md after a schema change
npm run test:isolated     # database tests on in-memory PGlite (fast correctness check)
npm run test:integration  # same tests against a real PostgreSQL 16 (TEST_DATABASE_CONFIRM=isolated)
```

`test:integration` must only ever point at a dedicated empty database; the tests insert synthetic tenants. The bundled PGlite run is a fast check, **not** the authority for locking and concurrency: only a native PostgreSQL 16 run (CI does this) counts, and it has not been executed for this release.

The Microsoft directory has a unique ownership constraint. Mail receipts store a request hash; reusing a key with changed content is rejected. `sentConfirmedAt` is separate from ACCEPTED: HTTP acceptance is not evidence of delivery. Reliability tables have explicit tenant foreign keys in SQL, and their queries also require tenant scope.


## Migration 10: growth and deliverability (202609180010)

Adds `AccessRequest` and `AssistantQuestion`; SPF/DKIM/DMARC status and `healthSource` on `DeliverabilityProfile`; `Campaign.holidays`; Calendly token, organization URI and reconcile timestamp on `TenantSetting`; `User.theme` (CHECK constrained). All changes are additive. See the generated docs/SCHEMA_REFERENCE.md.

## Migration 11: optional AI assist (202609180011)

Adds `aiEnabled`, `aiBaseUrl`, `aiModel`, `aiKey` (AES-256-GCM ciphertext) and `aiFeatures` to `TenantSetting`, with CHECK constraints on lengths and on the allowed feature names. Additive; nothing else reads these columns. AI calls are counted in `AuditEvent` (action `ai_call`) for the daily limit.
