# V20 Deployment Changes

Upgrade from V19 (image tag `20.0.0`): pause campaigns, stop the worker, complete an offsite backup, rehearse on a restored staging copy, run the migration service, then recreate web and worker with `OUTBOUND_ENABLED=false`. Migrations 5-9 are additive; no reset is required. See `docs/DATABASE.md` and `SELF_HOSTED_DEPLOYMENT.md` section 8.

## What changes for the operator

- **Database:** five new migrations (Calendly key, campaign versions and usage ledger, identity/MFA, message retention, experiments). Migrating outside Docker requires re-running `scripts/database-role.ts` afterwards, or new tables are unreadable to the app.
- **Optional gateway service:** `docker compose --profile gateway up -d` starts the Apollo/Hunter gateway on `127.0.0.1:8788`. It receives no database credentials. It needs `gateway-config/tenants.json` (mode 600, holds vendor API keys) and an HTTPS reverse-proxy entry (`deploy/caddy`, `deploy/nginx` now include one). Set `PROVIDER_GATEWAY_URL` to that HTTPS URL. Read `gateway/README.md`: it was written from vendor documentation and has never run against a live account.
- **Backups now include an erasure ledger.** `backup_postgres.sh` exports it from the running `web` container and fails the backup if it cannot. `restore_postgres.sh` now refuses to run without `ERASURE_LEDGER_FILE` (or an explicit `SKIP_ERASURE_LEDGER=yes` for drills) and re-applies the ledger after restoring. `check_backup.sh` verifies the ledger and both checksums.
- **New endpoint to allow at the proxy/firewall:** `/api/webhooks/calendly/<tenantId>` (Calendly delivers here; see `docs/CALENDLY.md`). The existing `/api/webhooks/provider/<tenantId>` is unchanged.
- **External monitor:** `deploy/monitor/` (run on a separate host; needs a paging webhook you provide).
- **Image:** the Dockerfile now creates a writable state directory for the gateway. Rebuild the image and rely on the tag, not `latest`.
- **Settings:** new tenant settings (Calendly signing key, monthly provider-spend cap, message retention). Spend caps default to none until set.

## Not verified

Docker, compose and the shell scripts have not been run against a real Docker daemon or PostgreSQL. Native PostgreSQL 16 concurrency, load, a security scan and a timed restore drill remain go-live requirements (`docs/RELEASE_ACCEPTANCE.md`).

# V19 changes (retained)

V19 added a fourth additive migration and native Microsoft 365 sending/Inbox synchronization, persisted send-reconciliation state, contact reverification and operational alerts. Send reservations are committed before network I/O.
