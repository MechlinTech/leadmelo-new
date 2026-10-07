# Test Plan

Evidence and current limits are in docs/VALIDATION_REPORT.md. Release gates are in docs/RELEASE_ACCEPTANCE.md.

## Local Checks
```bash
npm ci
npm run db:generate
npm test
npm run test:isolated
npm run typecheck
npm run build
npm run test:http
npm audit --audit-level=high
python3 scripts/handoff_audit.py
```

Unit tests import production modules. Integration tests execute APIs, Prisma writes, worker scheduling/sending and webhooks against an isolated database and local synthetic gateway. They do not send live messages.

## Native Database
Use a dedicated PostgreSQL 16 database. Apply migrations twice (second invocation must be a no-op), set TEST_DATABASE_CONFIRM=isolated, and run npm run test:integration. Never use a production URL. The CI workflow includes this gate and an encrypted backup/restore round trip.

## Manual/Environment Acceptance
Validate Docker, reverse proxy/TLS, mailbox/provider/calendar sandbox, browser desktop/mobile/keyboard, native concurrent workers, crash/retry ambiguity, real encrypted offsite recovery, secret rotation, security assessment and agreed load profile. Record artifacts, hardware, data volume, timestamps and owner.

A passing unit test is not evidence that a vendor integration exists, and a simulated booked event is not a real meeting.

V19 reliability cases include Microsoft draft/send uncertainty, request-hash conflict, tenant isolation, reply deduplication, positive booking invitations, stale sync send gate, Sent Items delay/correlation, new-thread replies, secret storage/disable, reverification and signed alert retries. Microsoft HTTP responses in these tests are synthetic.

## V20 additions

Automated (all in `npm test` unless noted): Calendly signature/attribution/normalization (`calendly.test.mjs`), TOTP against RFC vectors (`totp.test.mjs`), reply classifier with a labelled set and adversarial properties (`replies.test.mjs`), experiment statistics (`experiments-stats.test.mjs`), gateway adapters against mocked vendors (`gateway.test.mjs`), sender-health tool (`sender-health-tool.test.mjs`), generated schema reference freshness (`schema-docs.test.mjs`), deployment-file structure and secret separation (`deploy-config.test.mjs`), and the shell scripts against stub executables (`backup.test.mjs`, `monitor.test.mjs`; these need POSIX bash and are skipped on Windows unless `FORCE_POSIX_TESTS=1 BASH_BIN=<path to bash>`). Database flows run with `npm run test:isolated` (PGlite) or `npm run test:integration` (native PostgreSQL): engine, Microsoft, Calendly, versions/usage, identity, operations, privacy and experiments.

What these do not prove: the shell scripts run against stubs, not real PostgreSQL/age/rsync; the gateway tests use mocked vendors; the compose test parses YAML without running Docker; PGlite is not native PostgreSQL. Manual acceptance is listed in `docs/RELEASE_ACCEPTANCE.md` (V20 gates).

## Verifying a short follow-up (5 minutes)

`TEMP_QA_FOLLOWUP_MINUTES` is a test-only override for the gap between sequence steps. It is read by the
worker only; the web container does not need it. Leave it blank (or remove it) to restore normal
production timing from each step's `waitBusinessDays`.

```bash
# .env.dev (or the GitHub "development" environment variable of the same name)
TEMP_QA_FOLLOWUP_MINUTES=5
# then redeploy so the worker picks it up: scripts/deploy.ps1 -Environment dev
docker compose --env-file .env.dev -p leadmelo-dev -f docker-compose.selfhosted.yml \
  up -d --force-recreate --no-deps worker
docker compose ... exec worker printenv TEMP_QA_FOLLOWUP_MINUTES   # expect 5
```

To verify:
1. Activate the campaign (Automation → Campaign → Activate). The first email queues immediately.
2. Approve the first email if the campaign is in "Review messages first" mode, then wait for `SENT`.
3. The next step appears in Automation → Outreach queue with `Scheduled:` exactly five minutes after
   the `Sent:` time. The scheduler (the worker loop) picks it up when due; no page needs to stay open.
4. Confirm a reply, booking or pause before the due time and the queued step becomes `CANCELED`.
5. Run it a second time: the Run row shows `SUCCEEDED`, and no second prospect or email appears for
   the same contact (the retry reuses the run's idempotency key and the outreach event's key).

Restore afterwards with `TEMP_QA_FOLLOWUP_MINUTES=` (empty) and redeploy the worker.

Automation-run failures are reported with a specific code (`gateway_unreachable`, `gateway_timeout`,
`gateway_not_configured`, `gateway_http_4xx/5xx`, `gateway_invalid_response`,
`provider_exceeded_limit`). Anything unexpected is reported as `integration_or_database_error`; the
stack trace is only in the worker log (`docker logs leadmelo-dev-worker-1 | grep automation_run_failed`).
