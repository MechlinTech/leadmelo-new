# Backup And Recovery Runbook

No production data or database backup was supplied for this audit. This package contains schema, migrations and executable backup/restore procedures. It is not a backup of an existing LeadMelo deployment. The scripts have been tested only against stub `docker`, `age` and `rsync` executables (ordering, failure handling, refusals), never against a real PostgreSQL, real age or a real offsite host: the first real backup and restore drill on your server is the first real proof.

## Recovery Objectives

The included daily logical backup has an RPO target of **24 hours** if every backup succeeds. Proposed pilot RTO is **4 hours**, subject to a measured full recovery drill. Neither is a measured guarantee. Alert if no successful offsite backup is recorded within 26 hours. If business needs require 15-minute RPO or continuous point-in-time recovery, add PostgreSQL WAL archiving/base backups using a supported tool such as pgBackRest; that is not implemented here.

Store encrypted backups on a physically separate host/account or immutable object storage, not just a different directory on the server. Keep at least 14 daily backups locally and a separately managed offsite retention schedule (example: 35 daily and 12 monthly). The script never deletes remote archives. Document and test the remote retention/immutability policy. RAID, a Docker volume and a same-host snapshot do not protect against host loss.

## Install And Configure

On the physical host install `age`, `rsync`, `util-linux` (flock), coreutils and Docker Compose v2. Run from `/opt/leadmelo`. Create a dedicated recovery key on a secure recovery workstation:

```bash
age-keygen -o leadmelo-recovery.key
age-keygen -y leadmelo-recovery.key
```

Keep the private key offline or in the organization's recovery vault. Only put the public `age1...` recipient on the production host. Provision restricted SSH access to an offsite backup account; verify its SSH host key out of band. Do not disable host key checks.

Copy `deploy/backup.env.example` to `/etc/leadmelo/backup.env`, mode 600, and configure the public recipient, backup directory and `user@host:/absolute/path/` offsite target. Provision writable directories and confirm free space. PostgreSQL archive contains PII; disk encryption should also protect temporary plaintext dump storage. The scripts use umask 077 and clean temporary files on exit; plaintext deletion is not secure erasure on SSDs.

The backup script reads backup settings from its environment. A systemd EnvironmentFile supplies them automatically. For a manual run, use the configured service:

```bash
sudo cp deploy/systemd/leadmelo-backup.service /etc/systemd/system/
sudo cp deploy/systemd/leadmelo-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start leadmelo-backup.service
sudo journalctl -u leadmelo-backup.service --no-pager
sudo systemctl enable --now leadmelo-backup.timer
sudo systemctl list-timers leadmelo-backup.timer
```

The example service runs as the system operator; Docker socket access is effectively root access. Protect its unit and environment file accordingly. Assign a backup-failure alert to your monitoring system; the timer alone does not notify anyone. Monitor service exit codes, free space, archive age and offsite availability.

## What A Successful Backup Does

1. Takes a process lock and restrictive temporary directory.
2. Runs PostgreSQL's custom-format `pg_dump` from the matching database container.
3. Requires a nonempty archive and validates its table of contents with `pg_restore --list`. It also exports the **erasure ledger** (people erased or suppressed for erasure requests) from the running `web` container and validates it as a JSON array; if either fails, the whole backup fails.
4. Encrypts the dump and the ledger with age and moves both into the backup directory.
5. Computes a SHA-256 checksum of each and replicates all four files (two archives, two checksums) offsite with rsync checksums.
6. Updates `last-success` only after replication succeeds; then prunes expired local dumps and ledgers. `scripts/check_backup.sh` reports CRITICAL if the marker is stale, malformed, or either file or checksum is missing or fails verification.

A checksum checks transfer integrity; it does not prove the backup can be restored or provide independent authenticity if an attacker controls both files. Use immutable offsite storage and access separation. `pg_dump` covers the database, not OS files, role passwords, TLS keys, the code image or DATA_ENCRYPTION_KEY. Keep versioned infrastructure configuration and key recovery in separate protected systems. Runtime DB role grants are re-created by `scripts/database-role.ts`.

## Restore Drill

Perform the drill on a recovery host with outbound network access blocked, no workers running, and `OUTBOUND_ENABLED=false`. Retrieve an archive and its `.sha256` file from **offsite**. Supply the private recovery key securely and run:

```bash
export AGE_IDENTITY_FILE=/secure/recovery/leadmelo-recovery.key
export ERASURE_LEDGER_FILE=/secure/recovery/leadmelo-TIMESTAMP.erasures.age   # newest ledger, ideally exported from the live system after the dump
bash scripts/restore_postgres.sh /secure/recovery/leadmelo-TIMESTAMP.dump.age leadmelo_restore_drill
```

The command refuses an existing target DB and only accepts a new name beginning `leadmelo_restore_`. It verifies the checksum, decrypts, validates the archive, creates the new database and restores in a transaction with errors fatal. It pauses campaigns and disables tenant automation in the recovered copy, then re-applies the erasure ledger with owner credentials (the script refuses to start without `ERASURE_LEDGER_FILE` unless you set `SKIP_ERASURE_LEDGER=yes` for a throwaway drill, and prints a warning if you do). If restore fails after DB creation, keep that failed copy for diagnosis and choose a new target on the next attempt; never overwrite production to make a drill pass.

Verify migration history, table counts, tenants/users/campaigns/enrollments, appointment dates, suppressions and secrets decryption with the recovered key. Check PostgreSQL constraints/triggers and perform a tenant-A/tenant-B authorization test. Measure elapsed recovery time and archive age. Record archive hash, release version, date, operator and results in the recovery ticket. Delete the recovery environment through the operator's controlled process after review.

## Disaster Promotion

Freeze sending and inbound mutation processing first. Preserve the damaged database and logs if possible. Restore to a separate database; reconcile provider sends and webhook events that happened after the snapshot. Reapply unsubscribes, complaints and privacy deletions received since the snapshot from independently retained provider/audit records. Expire restored user sessions. Reconcile ambiguous sends by their idempotency keys; do not replay old outreach blindly.

Recreate the runtime DB role/grants, configure the recovered DATA_ENCRYPTION_KEY, verify the application against the new URL, and obtain operational signoff before routing traffic. Keep sending disabled until suppression, provider reconciliation and campaign states are checked. Roll back routing to the preserved environment if validation fails; do not drop either database during the incident.

Sources: [PostgreSQL pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html), [PostgreSQL pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html), [continuous archiving](https://www.postgresql.org/docs/16/continuous-archiving.html). These explain why a readable logical archive and a tested complete recovery are separate checks.

## After every restore: re-apply erasures

A restored backup can resurrect people who were erased after it was taken. Before enabling outbound on a restored database:

1. Use the most recent erasure ledger. Each backup now includes one (`leadmelo-*.erasures.age`); for a fresher one, export from the live system (`docker compose exec -T web node --import tsx scripts/privacy-erasures.ts export`), encrypt it with `age` and keep it apart from the database backups. The ledger contains the suppressed email addresses, which is the minimum record kept to honour the erasure.
2. `restore_postgres.sh` does this for you when `ERASURE_LEDGER_FILE` is set (`privacy-erasures.ts reapply -`). It re-erases each person and re-creates the suppression row; entries for tenants that no longer exist are skipped. To do it by hand: `npm run privacy:erasures -- reapply ledger.json` with the restored database's URL.
3. Only then reconcile provider-side sends and enable outbound.

Erasures made after the ledger export cannot be recovered by this step; the ledger freshness is part of your effective privacy RPO.
