# Release Acceptance

Do not mark this checklist passed based solely on the handoff audit. Attach evidence and the named owner for each gate. This package has not been deployed to your physical server.

## Platform Gate

- Immutable release image/tag and dependency lock; inventory image digests and scan image/OS before promotion.
- Database migrations run once; repeat deployment is a no-op; runtime role has no DDL/superuser rights.
- Only reverse-proxy TLS is public. Database has no public port; SSH is restricted to the admin network. Set request-size and connection-rate limits at the edge.
- Application URL/Origin and TLS cookies verified. No secrets in images, git, browser bundles, logs or downloadable reports.
- Web and worker restart after reboot; readiness fails when DB/worker is unavailable. Alert on stale heartbeat, failed runs, error spikes and disk space.
- Offsite encrypted backup and full restore drill passed; measured RPO/RTO and separately recoverable keys recorded.

## Functional Gate

- Create two tenants, two ICPs and at least two campaigns per tenant, with different offers/goals/calendar links.
- Test real authentication and every read/write path with tenant A against tenant B identifiers. MEMBER cannot change campaigns/settings. Disabled/expired users lose access.
- Run discovery against approved real provider data; verify source evidence and buyer identity; check exclusion and budget behavior.
- Real test mailbox accepts one message; follow-up waits from actual send time in campaign timezone; weekend and DST cases pass.
- Unsubscribe, complaint, bounce, negative reply and any reply stop the sequence; duplicate provider calls do not duplicate sends.
- No provider key, unhealthy sender, paused tenant/campaign, exhausted budget or stale verification causes a send.
- Confirmed buyer booking appears once, attributed to the correct tenant/campaign, with start/end/timezone; cancellation/reschedule and out-of-order events pass.
- Review-before-send and review-before-booking behavior is tested end to end; missing features are not bypassed in production.
- Browser tests cover desktop/mobile layout, keyboard navigation, error states, API failures, and no leaked cached tenant data.

## Reliability And Security Gate

- Native PostgreSQL: run multiple workers and inject crashes before/after provider acceptance, during DB commit and during webhook handling.
- Provider contract: 429, 5xx, timeout, quota exhaustion, revocation, delivery ambiguity, stale signatures and missed webhook reconciliation.
- Rate limiting, secret rotation, audit access, login recovery and intrusion response are evaluated.
- Load test 500 users/tenant only with an agreed tenant count, data size, operations mix and hardware. Capture p95/p99 response time, error rate, worker lag and DB lock contention. No concurrency capacity has been established by this handoff.
- Retention, privacy requests, suppression durability and deletion reconciliation after restore are approved and tested.

## Pilot Rollout

Start with Mechlin only, a small verified audience and approved copy. Start in review-before-send. Connect Shubham's verified mailbox and the supplied Calendly route. Check delivery, reply quality and meeting attendance, then explicitly approve fully automatic mode. Expand tenant access and volume only after observing stable metrics and passing the release gates.

Weekly owner report: spend, verified prospects, delivered emails, complaints/bounces, positive replies, qualified bookings, attended meetings, opportunities, wins and cost per attended meeting. Separate goals from observed counts. A meeting is not a customer or booked revenue.

## V19 integration gate

Complete MICROSOFT_365.md live cases; prove final Sent Items correlation, unhealthy sync gating, known-buyer new-thread stop, mailbox disable and Microsoft-level scope denial. Verify `/verify` with real data, alert receiver signatures/retries, and external detection of worker outage. Source tests do not replace these gates.

## V20 gates

In addition to the V19 gates above, do not enable unattended outreach until each of these has evidence attached:

1. **Native PostgreSQL 16:** `npm run test:integration` (all files, including the concurrency-relevant tests) passes against a real PostgreSQL 16, not PGlite. Never executed for this release.
2. **Docker stack:** `docker compose build`, `scripts/preflight.sh`, `docker compose up -d` and the optional gateway profile start cleanly on the target host; `/api/ready` is green. Never executed for this release.
3. **Backup and restore drill on a real host:** run `scripts/backup_postgres.sh` (dump plus erasure ledger, offsite), then `scripts/restore_postgres.sh` with `ERASURE_LEDGER_FILE` into an isolated database; record archive age, elapsed time (RTO), and verify counts, suppressions, tenant isolation, and that an erased test person does not reappear. Prove `scripts/check_backup.sh` alerts on a stale or damaged backup. The scripts have only been tested against stub executables.
4. **Apollo and Hunter live acceptance:** the checklist in `gateway/README.md` (one `limit: 1` discovery, credit spend, Hunter status cases, revoked-key and rate-limit behaviour, no repurchase after a killed job, ICP qualification of a real result). The adapters were written from documentation and never run live.
5. **Calendly live acceptance:** the checklist in `docs/CALENDLY.md` (booking, cancellation, reschedule, forged/absent attribution, bad signature, missed delivery).
6. **Sender health feed:** a real, measured `sender.health` source (or the operator procedure using `scripts/post-sender-health.mjs`) running at least daily; sending must stay blocked when it stops.
7. **External monitor:** `deploy/monitor/` running on a separate host with a paging receiver; stop the worker and confirm a page arrives within the agreed time.
8. **Identity:** administrator invitation, MFA enrolment and login with recovery code, password reset and session revocation exercised by a person in a browser on the target deployment.
9. **Privacy:** an erasure and an export exercised end to end, the erasure ledger restored into a drill database, and jurisdiction review by qualified counsel of terms, notices, DPAs, retention and vendor terms.
10. **Reply classifier:** measured on held-out real replies from a supervised pilot. The bundled labelled set was written with the rules and is not an accuracy estimate.
11. **Accessibility, browser and load:** keyboard and screen-reader pass, a real-device mobile check, and a load test with the operations mix and hardware recorded before any per-tenant user-count claim.
12. **Security:** dependency, container and OS scan; an external review; penetration test.
