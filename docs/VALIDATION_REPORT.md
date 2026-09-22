# Validation report: V19 baseline and V20 increments

The first sections describe the V19 baseline as validated in a Linux workspace (Node 24). Every section headed "V20 Increment" was run on Windows 11 with Node 22.17 and PGlite; see each for its exact limits.

Environment: isolated Linux workspace, Node 24.19.0. V19 completion checked after the interrupted work resumed. Deployment target is Node 22 or compatible Node 24, PostgreSQL 16 and Docker Compose. Results below apply to the source in this archive, not a live Mechlin installation.

## Executed checks

| Check | Result | Evidence and scope |
|---|---|---|
| Unit/fault tests (`npm test`) | 20/20 passed | Production functions imported; includes Graph origin/mailbox restrictions, MIME header injection, encryption, reply classification, policies, backup failures and restore safeguards. |
| Isolated DB engine suite | 9 nested cases + parent passed | Real persistence/API authorization, inline ICP/campaign activation, discovery, idempotent sending, follow-up, replies, booking/cancellation, unsubscribe and kill switch. |
| Isolated DB reliability suite | 12 nested cases + parent passed | Encrypted Microsoft setup, tenant isolation, ambiguous acceptance without resend, new-thread reply safety, delayed Sent Items correlation, sync gate, native send selection, pricing review, reverification, alerts and disconnect. |
| Four migrations, applied twice | Passed | First pass applies all four; second reports no pending migration. Runs on PGlite, not native PostgreSQL. |
| Prisma generation / validation | Passed | Client generated from shipped schema; schema validation succeeds. |
| Strict TypeScript | Passed | `npm run typecheck`. |
| Optimized production build | Passed | `npm run build`, including new Microsoft and alert routes. |
| Production HTTP smoke | Passed | Startup, protected redirect, unauthenticated API rejection, middleware bypass rejection and matching CSP nonce. Does not substitute for authenticated browser tests. |
| Dependency audit | 0 known vulnerabilities | `npm audit --audit-level=high` on this installed lockfile. Not a complete security guarantee. |
| Shell and YAML checks | Passed | Bash syntax for scripts; Compose and CI YAML parse. No Docker runtime here. |
| Handoff audit | Passed | Required source/runbooks/migration/test files, assets, portability and basic secret-pattern checks. |
| Archive | Validated during packaging | CRC/integrity, required .env.example and migration, exclusions for secrets/dependencies/cache. |

Total: 20 unit/fault tests and 21 nested database scenarios across two parent suites. Node counts the two suite parents too, giving 23 database test entries. Do not describe these as 43 independent end-to-end scenarios.

The PGlite socket adapter shares prepared statements across connections. The isolated harness now runs the two test files sequentially and deallocates statements between processes. That workaround is test-environment-only; native PostgreSQL CI uses its normal independent connection sessions.

Microsoft responses and gateway data are synthetic. The accepted-send timeout test proves one send submission and read-based reconciliation in the adapter. The native-mail worker case proves routing through that implementation with mock Graph responses. No real email was sent, contact purchased or meeting booked. Fresh dependency installation was not repeated in this resume; the existing installed dependencies, lockfile and generated client were used.

## Not executed / still required

- Live discovery and verification adapters, mailbox permissions/delivery, sender-health/bounce/complaint feeds, and native calendar mapping/reconciliation. Microsoft code exists; the other provider adapters still need implementation, not merely credentials.
- Native PostgreSQL concurrent workers and process-crash fault tests. CI specifies PostgreSQL 16 but has not been run in the recipient's repository.
- Docker image/Compose rollout, host TLS/reboot checks and runtime role deployment. No Docker executable is available here.
- Actual encrypted offsite backup and restore with customer keys/storage; supplied scripts were fault tested only. No business database snapshot is included.
- Live browser/mobile/keyboard, load/capacity, external security/privacy/accessibility acceptance. No 500-user-per-tenant claim is established.
- Free-form reply negotiation, automatic scheduling by negotiated time, adaptive campaign optimization, paid entitlements/spend ledger, enterprise SSO, and full customer self-service are not completed by V19.

The authoritative gap register is AUDIT_AND_GAPS.md. Attach live evidence before closing its deployment/integration gates. Existing successful synthetic checks must not be relabeled as real customer acquisition.

## V20 Increment 1 (Calendly adapter and baseline verification)

Executed on Windows 11, Node v22.17.1, npm ci, PGlite (WebAssembly PostgreSQL) for database tests. **No native PostgreSQL 16, Docker, browser, load, or live-provider run was performed.**

| Command | Result |
|---|---|
| `npm ci` | 0 vulnerabilities reported |
| `npm run db:generate` / `npm run typecheck` | pass |
| `npm test` | 23 pass, 0 fail, 3 skipped (POSIX-bash backup tests are skipped on Windows and must run in Linux CI) |
| `npm run test:isolated` | 29 pass, 0 fail (engine 10, Microsoft/reliability 13, Calendly 6); migrations 1-5 apply cleanly |
| `npm run build` | pass (with placeholder DATABASE_URL) |

Defect fixed: `processRun` claimed work with raw SQL comparing a `timestamptz` bind parameter to `timestamp(3)` columns using the session time zone, so a non-UTC PostgreSQL session never claimed queued runs. Timestamps are now normalised with `AT TIME ZONE 'UTC'`. It was found because PGlite inherited a US-Pacific system zone.

Calendly adapter (`lib/calendly.ts`, `/api/webhooks/calendly/[tenantId]`): Calendly webhook signature over exact bytes with 5 minute replay window; HMAC-signed tenant/campaign/contact attribution carried in `utm_content` of every scheduling link; unattributed or forged bookings are acknowledged but never create an appointment; invitee/contact email mismatch raises an alert. Verified only with synthetic payloads shaped from Calendly's documented webhook format; **not verified against a live Calendly account**.

## V20 Increment 2 (campaign versioning, usage ledger, spend caps, suspension)

Environment as Increment 1 (Windows 11, Node v22.17.1, PGlite). Results: `npm test` 23 pass / 3 POSIX-skipped; `npm run test:isolated` 40 pass (engine 10, Microsoft 13, Calendly 6, versions/usage 11); `npm run typecheck` and `npm run build` pass. Migration 6 applies cleanly on top of 1-5.

Covered: edit/clone/rollback with baseline snapshots, approval invalidation on material edits, sender change pausing an active campaign, cross-tenant refusal, spend-cap reservation under the tenant lock with idempotent retry and settlement, zero cap, suspended tenant, super-admin-only suspension.

Not verified: concurrent spend reservation on native PostgreSQL (PGlite serializes sessions, so that test proves logic, not lock behaviour); no worker-level test drives a full discovery run against a capped tenant (the reservation function is tested directly and the uncapped path runs in the engine test); email sends and verification calls are not yet written to the usage ledger (only discovery purchases are).

## V20 Increment 3 (usage metering, identity)

Same environment (Windows 11, Node v22.17.1, PGlite). `npm test` 27 pass / 3 POSIX-skipped; `npm run test:isolated` 45 pass (engine 10, Microsoft 13, Calendly 6, versions/usage 11, identity 5 incl. 4 identity flows); typecheck and build pass. Migration 7 applies on top of 1-6.

Covered: emails and verifications metered exactly once (including an ambiguous-send retry); admin-only invitations that never link to an existing account, single-use/expiring/revocable/superseded invite links, tokens stored only as hashes; TOTP MFA verified against RFC 4226/6238 vectors, enforced at login, TOTP replay refused, single-use hashed recovery codes; admin-initiated password reset scoped to the admin's tenant, single use, expiring, revoking all sessions.

Not done / limits: invitation and reset links are returned to the administrator, not emailed (no platform mail service); Google/Microsoft SSO is NOT implemented (needs app registrations to test); no self-service "forgot password"; MFA is optional, not enforceable per tenant; no WebAuthn; no login/accept UI pages for `/auth/accept`, `/auth/reset` or MFA enrolment yet (API only); MFA code-guessing is limited only by the per-email login rate limit.

## V20 Increment 4 (operations)

Same environment. `npm test` 27 pass / 5 POSIX-skipped; `npm run test:isolated` 51 pass (adds ops 5); typecheck passes. Migrations unchanged (7).

Covered: sender health missing/degraded/stale, reply-sync failure/staleness and stuck-send detectors with dedupe, per-day re-raise, tenant isolation; tenant digest counts and authentication. The external monitor script was exercised manually under Git Bash with a stub `curl` (page on 3rd failure, no repeat page, refuses non-HTTPS); its automated tests (`tests/monitor.test.mjs`) are skipped on Windows and must run in Linux CI.

Not done: digest is pull-only (no scheduled delivery); no real paging receiver was connected, so alert delivery to an external receiver within an SLO is unproven; no alert for provider quota exhaustion beyond spend cap, disk pressure or backup staleness inside the app (backup freshness remains `scripts/check_backup.sh`); no operator replay tooling.

## V20 Increment 5 (reply safety)

Same environment. `npm test` 33 pass / 5 POSIX-skipped; `npm run test:isolated` 51 pass; typecheck passes.

`lib/replies.ts` was rewritten as ordered conservative rules with a reason code (explicit negative, delivery notice, out of office, injection attempt, referral, existing relationship, question/objection, hedged, long reply, clear positive). Only a short, unhedged reply can be POSITIVE; questions, referrals, existing vendors, injected instructions and bounce notices route to a human. Reason is stored in the reply's recommended action.

Evidence and its limits: `tests/fixtures/reply-eval.json` holds 83 labelled replies. **It was written together with the rules, so it is a regression and safety suite, not an accuracy estimate.** A probe of 20 unseen phrases found four explicit opt-outs classified as UNSURE ("Kindly stop", "We're all set", "take us off your distribution list", bare "No."): sequences would have stopped but the contact would not have been suppressed. Those rules were fixed and the phrases added to the set. Property tests assert that nothing labelled non-positive becomes POSITIVE, injected prefixes never yield POSITIVE or override a negative, and zero-width, full-width and upper-case obfuscation cannot hide a negative.

Not done: this is still a keyword classifier; multilingual replies, sarcasm and long nuanced replies are only handled by the conservative fallback to human review. No model-assisted classification, no held-out live evaluation, no free-form reply drafting. "Send a calendar invite for Friday 2pm" is classified POSITIVE and receives the standard scheduling link, not the requested time.

## V20 Increment 6 (privacy, technical part)

Same environment. `npm test` 33 pass / 5 POSIX-skipped; `npm run test:isolated` 58 pass (adds privacy 7); typecheck passes. Migration 8 applies on top of 1-7.

Covered: admin-only, tenant-scoped data-subject export (audit log stores only a hash prefix, never the address); admin-only erasure with explicit confirmation that removes the contact, replies and message text, cancels queued sends, detaches appointments while keeping the business record, and keeps one suppression record; other tenants holding the same address are untouched; idempotent; erasure ledger export and re-application after a simulated restore; per-tenant retention that redacts old message bodies and replies but never in-flight sends.

Not done: this is engineering support, not a compliance programme. No lawful-basis register, DPIA, subprocessor/DPA records, privacy notice or terms; no automated handling of an objection received by email; retention covers message text and replies only (not contacts, leads, audit events or usage rows); suppression keeps the plaintext address; erasure does not reach data already sent to a provider gateway, Calendly or Microsoft; database backups are not rewritten (handled only by re-applying the ledger); no self-service subject-request portal. Requires review by qualified privacy counsel for each target jurisdiction.

## V20 Increment 7 (UI for versions, identity, digest, privacy)

Same environment. `npm test` 33 pass / 5 POSIX-skipped; `npm run test:isolated` 58 pass; typecheck and `next build` pass (new pages `/auth/accept`, `/auth/reset`).

Browser-verified against a running app (`next dev` on an in-memory PGlite database seeded with one demo tenant; `scripts/dev-pglite.mjs`, development only) using the Browser pane's DOM and script access: sign-in; digest cards matching seeded records; campaign History listing versions, Restore creating version 3 with the original content, Clone creating a draft copy; MFA enrolment showing 8 recovery codes; login then prompting for a code and accepting a recovery code (7 remaining in the database); invitation creation, acceptance (password-mismatch message, single use) creating a MANAGER in the same tenant; privacy export returning the seeded person's data. No console errors were reported.

Not verified: no screenshots were captured (the pane was hidden, so screenshots timed out), so visual design and contrast were not inspected; mobile was checked only as "no horizontal overflow" at an effective 489px width, not 375px; no keyboard-only walkthrough, screen-reader test or automated accessibility scan; no cross-browser run; the dev database is PGlite, not PostgreSQL 16. There is still no UI for spend caps/usage detail, retention settings, password reset issuance, tenant suspension, or editing (rather than restoring) a campaign; edits are API-only.

## V20 Increment 8 (experiments)

Same environment. `npm test` 40 pass / 5 POSIX-skipped; `npm run test:isolated` 65 pass (adds experiments 6 and an engine-flow check that the worker really sends the assigned arm); typecheck passes. Migration 9 applies on top of 1-8.

Covered: statistics module checked against published normal/chi-square reference values and a hand-computed z-test; a fixed-seed simulation of 400 no-difference experiments produced under 9% false winners at alpha 5%; winner rules (minimum sample per arm, sample-ratio-mismatch check, Bonferroni-corrected significance, minimum lift, unsubscribe guardrail); stable, persisted per-enrollment assignment following weights; one running experiment per step (database index); the tested step's copy cannot be edited while the test runs; recommendations created once and only applied by a human, through the normal version history (new version, approvals revoked); reject leaves the test running and is not re-proposed; tenant isolation on create, start, results and decision; the end-to-end worker sends the assigned copy and records the arm exactly once across an ambiguous-send retry.

Limits, stated plainly: this tests **email subject/body copy on one step**; it does not test targeting, ICP or send timing. There is **no no-send holdout** (control receives the original copy), so it measures relative copy performance, not incremental lift over doing nothing. Outcomes are attributed at contact level (a positive reply to a later step still counts for the arm assigned at the tested step). Reply-rate tests need on the order of hundreds of sends per arm; attended-meeting metrics will rarely reach significance at pilot volumes, so `POSITIVE_REPLY` is the practical primary metric and its relation to attended meetings is not proven. The winner check is a frequentist test evaluated repeatedly by the worker without sequential-testing correction, so peeking inflates false positives; treat recommendations as advice. No cross-tenant learning (by design). No UI for experiments yet (API only). Nothing was validated against real send data.

## V20 Increment 9 (Apollo + Hunter gateway, written from documentation, not live-tested)

Vendor documentation read on 18 September 2026: Apollo People API Search, People Enrichment and rate limits; Hunter Email Verifier. `gateway/` implements `/discover` (Apollo search, free title pre-filter, Apollo enrichment, Hunter verification) and `/verify` (Hunter) with idempotency, no-repurchase memory, cursor paging, partial results, in-progress handling and tenant/credential binding. `/send` is 501.

Executed: `npm run typecheck` pass; `npm test` 55 pass / 5 POSIX-skipped, including `tests/gateway.test.mjs` (15). Those tests run LeadMelo's real gateway client against the gateway with **mocked** Apollo and Hunter responses shaped from the documentation. They verify this code and the LeadMelo contract (schema, qualification against an ICP, idempotency, 401/403/409/422/429/503 handling, no credentials or emails in logs). They do **not** verify Apollo's or Hunter's actual behaviour.

Discovered while testing: the gateway sent the caller's mixed-case email to Hunter but keyed on the lowercased one (fixed: lowercased before the call).

Unverified by construction: every request/response shape (see the assumptions list in `gateway/README.md`; the enrichment `person` wrapper and Apollo technology UID format are the most likely to be wrong), credit consumption, real rate-limit behaviour, and that any prospect qualifies against a real ICP. Known gaps: no proactive rate limiting, single-process file store, plaintext vendor keys in the tenants file, no monetary tracking of enriched-but-rejected credits, only "Hiring <role>" signals can be evidenced. Vendor terms of service and data-processing obligations were not reviewed.

## V20 Increment 10 (packaging completion: backup, schema, deployment)

Environment: Windows 11, Node 22.17, PGlite, Git Bash (for shell tests). **No Docker, no native PostgreSQL, no real age/rsync, no Python.**

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm test` (Windows default) | 77 tests: 67 pass, 0 fail, 10 skipped (shell tests) |
| `FORCE_POSIX_TESTS=1 BASH_BIN=<Git Bash> npm test` | 77 pass, 0 fail, 0 skipped |
| `npm run test:isolated` | 65 pass across 8 files (unchanged) |
| `npm run build` | pass |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| Browser check (dev server on PGlite) | Settings form saves Calendly key, spend cap ($250.50 -> 25050 cents), cost per prospect, retention; blank clears cap and retention |

What was added and what its tests prove: backup script exports and encrypts an erasure ledger with each dump and fails if it cannot; restore refuses to run without a ledger (or explicit skip), re-applies it with owner credentials after restoring, and never puts the password on a command line; freshness check verifies both files and checksums. These are tested by running the real scripts against stub `docker`, `age`, `rsync`, `flock`, `curl`; a mutation check (dropping the ledger from the rsync line) made a test fail, confirming the tests can catch that regression. They do **not** prove pg_dump/pg_restore/age/rsync behave as assumed.

Generated `docs/SCHEMA_REFERENCE.md` (36 tables) with a test that fails if it is stale or a table is unclassified. Static deployment checks (`deploy-config.test.mjs`, uses a real YAML parser): services, no published database port, no Docker socket, every published port on localhost, web/worker lack the owner password, the gateway receives no LeadMelo secrets and mounts its config read-only, every compose variable is in `.env.example`, versions agree across package/lock/compose/env, proxy examples cover the app and gateway, `bash -n` on every shell script. These do not prove the images build or the stack starts.

Defects found and fixed while doing this: Calendly's cancellation time field is `created_at` (the adapter read `canceled_at`, found by reading Calendly's OpenAPI file) and Calendly recommends a 3-minute signature tolerance (was 5); decimal dollars could not be entered in the new settings fields because the number inputs lacked `step` (found in the browser); the Windows test run resolved the real `curl.exe` instead of the stub, so the monitor script got an explicit `CURL_BIN` override.

Still not verified: everything listed under "Not verified" in earlier sections, plus Docker build/start, real backup and restore, native PostgreSQL, and the CI workflow (never executed; it now also depends on `yaml`, installed by `npm ci`).

## V20 growth release: measured results

- Typecheck clean. Unit tests 106/106 (shell tests run through Git Bash on Windows). Database tests (PGlite, 10 migrations) 98/98. npm audit: 0 vulnerabilities. Production build passes.
- Browser run (Edge via Playwright, production build, seeded demo): all public and app pages captured desktop and mobile; axe-core 0 violations; 0 browser console errors; service worker registered; manifest valid; theme change persists across reload; a non-operator is redirected away from /app/operator.
- Defects found and fixed by that run: pricing table widened the mobile viewport (visually hidden text escaped the scroll container); scrollable tables were not keyboard-focusable; unbounded outreach/reply lists produced a 40,000px mobile page.
- Assistant accuracy on unseen paraphrases was 68% (held-out) and 80% (blind) at first measurement, later improved by tuning against those same sets, so current figures are optimistic. It is retrieval over a fixed knowledge base, not an LLM.
- Not tested: live Microsoft 365, Calendly, Apollo, Hunter; Docker; native PostgreSQL; a real backup/restore drill; iOS Safari and Android devices (only emulated mobile viewport); load/performance.

## Optional AI assist: measured results

- Unit tests (tests/ai.test.mjs, 17) cover URL safety (private and plain-http endpoints refused unless operator allow-listed), redirect/oversize/timeout handling, JSON extraction, output guardrails, prompt-injection delimiting and reply-assist authority. Database tests (tests/integration/ai.test.mjs) cover encrypted key storage, role checks, tenant isolation, feature switches, the daily limit and that AI never changes stored intent or suppression.
- The full UI flow (enable, save, test connection, draft campaign into the form, analyse a reply) was driven in Edge against scripts/mock-llm.mjs, a canned OpenAI-compatible server. axe-core: 0 violations.
- NOT verified: quality or speed with a real model. No Ollama was reachable during this build, so nothing was run against llama3 or any hosted model. Output quality depends on the model; small local models may produce weaker copy or invalid JSON (the app then returns a clear error rather than using it). DNS rebinding of a public hostname to a private address is not defended in the app; restrict egress at the network layer for multi-tenant hosting.

- Totals at release: typecheck clean; unit tests 123/123; database tests (PGlite, 11 migrations) 119/119; npm audit 0 vulnerabilities; production build passes; browser run with the AI flow: axe 0 violations, 0 console errors.
