# Autonomous operations and exception handling

The ordinary path remains campaign ICP -> discovery -> verification -> controlled email/follow-ups -> reply -> booking invitation -> authoritative calendar confirmation. The following controls reduce routine intervention; they do not guarantee appointments or remove all exceptions.

## Alerts

Alerts persist in OperationalAlert with a tenant-scoped unique key. The workspace shows current alerts and lets administrators/managers acknowledge them. Acknowledging is not a repair or retry. The worker collects failed discovery/outreach, exhausted verification attempts and uncertain Microsoft sends. Reply uncertainty and mailbox synchronization failures also generate alerts.

Configure operator-owned `ALERT_WEBHOOK_URL=https://...` and `ALERT_WEBHOOK_SECRET` in the deployment environment and recreate web/worker. Notifications contain alert ID, tenant ID, code, entity ID and creation time, not email bodies or credentials. Verify HMAC-SHA256 over `<X-LeadMelo-Timestamp>.<raw body>` against X-LeadMelo-Signature, with a bounded timestamp age. Deduplicate by the alert ID / Idempotency-Key. Return 2xx only after durable receipt. Delivery retries up to six attempts with backoff and a lease. Inspect undelivered alerts after exhaustion. Do not configure tenant-controlled URLs or forward tenant details to an unrelated recipient.

A dead worker cannot notify you through itself. Independently monitor `/api/ready`, worker heartbeat, backup success age, disk space, DB availability and undelivered alert count. Acknowledged deduplication keys are not automatically reopened; track recurring mailbox/health problems with the external monitor. Pagination, repair/replay tooling and automated incident resolution remain future work.

| Code / condition | Operator response |
|---|---|
| mail_sync_failed | Check Microsoft permission, secret, Inbox cursor and pending Sent Items receipts. Sending is gated while unhealthy. |
| m365_send_needs_reconciliation | Inspect receipt key, immutable draft ID and Microsoft evidence. Do not reset to NEW or create a new send key to bypass uncertainty. |
| reply_attribution_review | Inspect the buyer's message in the authorized mailbox, resolve campaign context and honor any opt-out. Pending contact outreach has stopped. |
| reply_review | Review pricing, OOO or uncertain intent. Supply an approved human response if needed; no automatic negotiation is claimed. |
| verification_exhausted | Check verification provider result/quota before considering a controlled retry. Invalid/risky contacts stay suppressed. |
| discovery_failed / outreach_failed | Inspect redacted errors, provider status, health, caps and authorization. Reconcile remote effects before replay. |

## Reverification

Before a follow-up, contacts older than seven days are deferred and a verification request is persisted. The worker calls `/verify` under the tenant's credential, using a stable request key, up to three attempts. Valid fresh evidence releases deferred messages; invalid or risky results suppress the contact. Unknown results and transport errors back off, then raise an alert. Provider fees and idempotent purchases must be governed in the external gateway.

## Release, recovery and key custody

Use the four committed SQL migrations, restricted runtime DB account and physical-server instructions. Encrypt backups with age, replicate offsite, verify checksums and test recovery into a new database. Preserve MailReceipt, WebhookEvent, Suppression and pending work during recovery; reconcile provider side effects newer than the restored backup before enabling outbound. Otherwise restored pending work can represent messages already accepted remotely. Keep outbound disabled throughout the drill.

Keep DATA_ENCRYPTION_KEY and the age private recovery key separately recoverable; a DB dump alone cannot restore encrypted provider access. See BACKUP_AND_RECOVERY.md for commands and required RPO/RTO evidence. This package contains no customer DB snapshot and no production credentials.

## External monitoring and digest

`deploy/monitor/external-monitor.sh` (with `leadmelo-monitor.service`/`.timer`) must run on a **separate host**. It polls `/api/ready` (which fails when the database is down or the worker heartbeat is older than two minutes), pages a HTTPS webhook after `FAILURES_TO_PAGE` consecutive failures (default 3), pages once per outage, retries the page if the webhook itself fails, and sends a recovery notice. Install: copy the script to `/opt/leadmelo-monitor/`, put `LEADMELO_URL`, `PAGE_WEBHOOK_URL` in `/etc/leadmelo-monitor.env`, enable the timer. The paging webhook receiver (Slack relay, ntfy, PagerDuty) is yours to provide and must be tested end to end.

In-app alerts (`/api/alerts`) now also cover: sender health missing/degraded/stale, reply sync failing or older than 10 minutes, and sends stuck after a worker death. Persisting conditions are re-raised at most once per UTC day after acknowledgement. `GET /api/digest` returns the tenant's 24-hour activity counts, upcoming meetings, open alerts and month spend.
