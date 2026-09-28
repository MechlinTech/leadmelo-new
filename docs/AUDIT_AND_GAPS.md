# Audit Findings And Gap Register

Scope: source package, not a deployed system. V17 repaired the persisted foundation; V18 added the self-driving campaign loop; V19 added native Microsoft mail, reverification, alerts and safer send reservations; V20 added the Calendly adapter, campaign versioning, spend controls, MFA/invitations, privacy tooling, experiments, an Apollo/Hunter gateway, and backup/schema/deployment completion (rows below marked V20). Prior releases are preserved separately. "Implemented" here means source exists; evidence levels are in VALIDATION_REPORT.md.

## Confirmed V16 Defects

| Severity | Finding and consequence | V18 treatment |
|---|---|---|
| Critical | `prisma/schema.prisma` used semicolons and one-line blocks; duplicate/missing appointment relation. Database could not be generated reliably. | Validated schema, generated baseline migration, explicit tenant-link triggers and checks. |
| Critical | Campaign, ICP, lead, appointment and run routes returned success without writes; callers could supply arbitrary tenant IDs. | Session-derived tenancy, real writes, foreign-parent checks, protected reads, no fake booking endpoint. |
| Critical | No login/session implementation; public static app/admin pages. | Scrypt passwords, hashed random session tokens, expiry/revocation, role checks, CSRF origin checks and protected layouts. |
| Critical | No scheduling or worker implementation. | Durable PostgreSQL work tables, scheduler, leases, retries, deadlines and terminal failures. |
| High | `not interested` matched `interested` first. | Negative intent precedes positive; uncertainty stops the sequence. Regression coverage. |
| High | Browser service worker cached every GET, including authenticated pages and APIs. | Worker retirement and cache purge; private routes use no-store. Clear legacy browser storage on upgrade. |
| High | Booking route labeled arbitrary JSON as BOOKED. | Only signed normalized provider events create bookings; durable IDs and event timestamps prevent duplicates/stale updates. |
| High | No unsubscribe processing, suppression enforcement or aggregate send budgets. | Signed unsubscribe tokens, tenant suppression, send-time rechecks, rolling 24-hour caps and 7-day prospect caps. |
| High | Backup produced unencrypted local dump, no restore tooling, no offsite-success condition. | Age-encrypted backups, archive validation, checksums, offsite replication before pruning, recovery into new DB. |
| High | No lockfile, broken npm-ci pipeline, missing migration deployment; outdated dependencies. | Lockfile, updated dependencies, audited overrides, migrations and real CI flow. |
| Medium | Tests copied the functions under test rather than importing production functions. | Tests import application code; database integration flow and fault cases added. |
| Medium | Controls, dashboard metrics, billing and marketing claims implied live functionality. | Saved data and functioning pilot controls; unimplemented capabilities explicitly identified. |
| Medium | CSP blocked the app's own inline bootstrap scripts. | Per-request nonce CSP; dynamic protected pages. Browser validation remains a separate gate. |

## Production Blockers

| ID | Priority | Remaining work | Owner | Acceptance evidence |
|---|---|---|---|---|
| G01 | P0 | **Implemented from vendor docs, awaiting live acceptance (V20):** Apollo discovery and Hunter verification in gateway/; mocked-contract tested only. Remaining: live sandbox run, proactive rate limiting, other vendors, Google mailbox. Original: Implement real provider gateway: discovery, verification, provider attribution and calendar normalization. Microsoft mail has a native adapter in V19; certify it with a real account. | Integrations | Live sandbox account finds verified buyers, sends approved sample, ingests replies and records accepted booking/cancellation. No false success. |
| G02 | P0 | Certify sender ownership, DNS authentication, mailbox app authorization/secret rotation/revocation, bounce/complaint feeds and provider policy. | Integrations + platform | Revoked token and unhealthy sender block sends; one tenant cannot use another sender. |
| G03 | P0 | Run native PostgreSQL concurrent-worker tests and crash/timeout reconciliation against chosen email provider. | Backend + QA | Duplicate workers, provider accepted-but-timeout, process restart and pause race do not cause duplicate delivery or exceed caps. |
| G04 | P0 | Execute physical-host rollout and recovery drill with encryption keys stored separately. | Platform | Native backup restores to isolated DB, counts/constraints/suppressions pass, measured RPO/RTO recorded. |
| G05 | P0 | Real end-to-end browser, performance and security acceptance. | QA + security | Login, ICP, campaign, exception and meeting flows work; authorization negatives pass. No claim of 500 users/tenant until measured. |
| G06 | P0 | **Technical part done in V20:** export, erasure, suppression retention, restore re-application and message retention implemented and tested. Remaining (needs people, not code): terms/privacy notice, DPAs/subprocessors, lawful-basis and jurisdiction sign-off. Original: Complete customer-facing terms/privacy, retention policy, data processing contracts, lawful contact rules and privacy request implementation. | Product + privacy | Approved target geographies and deletion/export tests, backup suppression/deletion reconciliation. |
| G07 | P1 | **Partly done in V20 (API only):** invitations, TOTP MFA, admin-initiated password reset implemented and tested. Remaining: Google/Microsoft SSO, UI pages, self-service recovery, per-tenant MFA enforcement, operator console. Original scope: Google/Microsoft SSO, invitations, MFA, account recovery, onboarding and operator admin console. | Identity | Correct-tenant login only; no automatic account linking by unverified email; token rotation/revocation and role tests. |
| G08 | P1 | **Partly done in V20:** Calendly webhook adapter with signed attribution, dedupe and cancellation ordering exists (synthetic-tested). Remaining: live Calendly acceptance, reschedule linkage, availability search, Microsoft/Google calendar adapters, reconciliation job for missed webhooks. Original scope: Native calendar integration or gateway mapping with signed campaign attribution, consent, availability, timezone, rescheduling and reconciliation. | Integrations | Calendar acceptance maps to the right campaign; cancellation-first delivery, reschedule and duplicate event tests pass. |
| G09 | P1 | **Partly done in V20:** usage ledger, hard monthly provider-spend reservation, operator suspension implemented and tested. Remaining: email/verification metering, paid plans and verified billing webhooks, campaign-level caps. Original scope: Billing/subscription entitlements, usage ledger and provider spend limits. | Billing/backend | Verified billing webhooks; hard spend cap enforced before purchases and discover retries; suspended tenant cannot consume providers. |
| G10 | P1 | Reverification worker implemented; Hunter verification adapter written from docs (V20) and awaiting live acceptance. | Integrations | Tests prove valid resumption, invalid suppression, bounded failures and alerts; prove the same with purchased provider data. |
| G11 | P1 | **Partly done in V20:** sender/reply-sync/stuck-send detectors, daily digest endpoint and an external readiness monitor with paging exist (external paging unproven end to end). Remaining: scheduled digest delivery, operator replay tooling, history pagination, disk/backup alerts in app. Original: V19 implements alerts and signed webhook delivery. Remaining: digest, operator replay tooling, history pagination, external heartbeat paging and comprehensive reconciliation. | Platform/backend | Stale worker, failed run, send ambiguity and missed webhooks alert within agreed SLO. Current UI shows latest 100. |
| G12 | P1 | **Partly done in V20:** conservative classifier with referral/existing-vendor/bounce/injection handling, reason codes and a labelled regression set. Remaining: held-out live evaluation, multilingual, model-assisted drafting with tenant-approved knowledge. Original: Advanced reply understanding and free-form booking negotiation with evidence and consent. | Applied AI | Negation/OOO/objection/prompt-injection evaluation; uncertain intent does not initiate new contact. V18 handles clear positive intent with one booking invitation and negative intent with suppression; its classifier remains conservative rules. |
| G13 | P1 | **Mostly done in V20 (API only):** edit, versioning, rollback, clone and approval invalidation implemented and tested. Remaining: UI for these, preview/test-send, staged activation. Original scope: Full lifecycle campaign/ICP editing and cloning, approval previews and role-aware UI. | Frontend/backend | Draft changes persist, active campaign changes versioned, approvals invalidated when message content changes. V18 has one-step inline/reusable ICP creation, immediate gated activation, pause and resume; editing/cloning/versioning remain. |
| G14 | P2 | **Partly done in V20 (API only):** controlled copy experiments with guarded recommendations and human accept/reject. Remaining: UI, no-send holdouts, ICP/timing experiments, sequential testing, evaluation on real data, multichannel, CRM sync. Original: Learning/experimentation, multichannel workflows, regional calendars, CRM sync and attended-meeting optimization. | Product/data | Holdout evaluation improves qualified attended meetings; no false personalized claims or uncontrolled spend. |

## Engineering Limits To Understand

- Qualification is deterministic and conservative: exact configured industry/size/geography/title/signal matching, 90 base points plus 10 for a matching technology. It is not an AI learning model. Exclusions match explicit domains/company/industry values, not arbitrary natural-language instructions. Provider normalization and evidence truth need validation.
- Campaign goals are targets. They do not create demand or guarantee booked meetings. V18 automates the configured initial email, follow-ups and positive-reply booking invitation; booking/outcome records support reporting, but an adaptive optimizer is not implemented.
- A calendar link asks a buyer to choose a time. The engine records externally confirmed bookings. It does not invent acceptance or reserve a slot solely because a reply sounds positive.
- Gateway delivery must persist idempotency and reconcile ambiguous sends. SMTP alone cannot promise exactly-once delivery. The app cannot guarantee it without the downstream contract.
- V19 commits tenant/sender send reservations before network I/O. Leases and request hashes protect retries; Microsoft sends are never blindly resubmitted after ambiguity. Native multi-worker crash tests are still required. Uncertain draft creation or permanently missing sent copies require operator review.
- PostgreSQL is the durable queue; Redis was removed because it was unused. At high scale, introduce a queue only with an outbox and explicit replay guarantees.
- Application APIs scope tenants and SQL triggers reject cross-tenant parent references. There is no PostgreSQL row-level-security policy; the runtime database account can access all tenants. Evaluate RLS for production defense in depth.
- A pause takes effect on the next send-time check. A provider request already accepted cannot be recalled. Reconcile in-flight requests during emergency stop and recovery.
- Backups cannot protect encryption keys unless key custody is handled separately. The supplied daily timer alone targets up to 24 hours of data loss; it is not continuous recovery.

## Completion Rule

An item is closed only when its acceptance evidence is attached and its owner signs off. Documentation, an environment variable, a model/table name, or a green mock test does not close a live integration requirement.

## V19 Boundaries

Native Microsoft support is app-only, global cloud, one Microsoft directory per LeadMelo tenant, up to 20 configured mailboxes. It polls Inbox, not arbitrary folders; it is not Microsoft SSO. Sent-copy reconciliation gates reply cursor advancement. Inbox rules that move replies before polling, nondelivery reports, account aliases, permissions, and provider rate limits need live acceptance. Sender health remains an external required feed. No automatic time negotiation, live calendar adapter, contact-data adapter, or adaptive revenue optimizer was added in V19.


## V20 packaging register

| Item | State |
|---|---|
| Database schema documentation | Done: generated `docs/SCHEMA_REFERENCE.md` (36 tables, classification, retention, SQL invariants) guarded by a test; `docs/DATABASE.md` rewritten. Not done: row-level security; 4 unused tables remain in the schema. |
| Deployment instructions | Done: runbook, changelog, gateway profile, proxy examples, preflight checks, V19-to-V20 upgrade. Not verified: Docker was never run; CI never executed. |
| Database backup | Done: scripts now include the erasure ledger and a guarded restore. Not verified: never run against real PostgreSQL/age/rsync/offsite; no backup of a business database exists in the package (none was supplied); no restore drill or measured RPO/RTO. |
| Operator tooling | Added: sender-health posting tool. Missing: a real automated sender-health feed. |
| Calendly | Documented and corrected against the OpenAPI file. Missing: reconciliation of missed webhooks, live acceptance. |