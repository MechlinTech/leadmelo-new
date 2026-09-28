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
