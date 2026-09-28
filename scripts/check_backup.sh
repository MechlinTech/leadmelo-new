#!/usr/bin/env bash
set -Eeuo pipefail
: "${BACKUP_DIR:?Set BACKUP_DIR}"
max_hours="${BACKUP_MAX_AGE_HOURS:-26}"
[[ "$max_hours" =~ ^[0-9]+$ ]] || exit 1
marker="$BACKUP_DIR/last-success"
[[ -f "$marker" ]] || { echo 'CRITICAL: no successful offsite backup'; exit 1; }
stamp="$(stat -c %Y "$marker")"
age_seconds=$(( $(date +%s) - stamp ))
(( age_seconds <= max_hours * 3600 )) || { echo 'CRITICAL: backup is stale'; exit 1; }
name="$(cat "$marker")"
[[ "$name" =~ ^leadmelo-[0-9TZ-]+\.dump\.age$ ]] || { echo 'CRITICAL: last-success marker is malformed'; exit 1; }
ledger="${name%.dump.age}.erasures.age"
[[ -f "$BACKUP_DIR/$name" && -f "$BACKUP_DIR/$name.sha256" ]] || { echo 'CRITICAL: latest database archive or checksum is missing'; exit 1; }
[[ -f "$BACKUP_DIR/$ledger" && -f "$BACKUP_DIR/$ledger.sha256" ]] || { echo 'CRITICAL: erasure ledger for the latest backup is missing'; exit 1; }
(cd "$BACKUP_DIR" && sha256sum --check --quiet "$name.sha256" "$ledger.sha256") || { echo 'CRITICAL: local backup files fail their checksums'; exit 1; }
echo 'Backup freshness OK; restore drill is a separate required check.'
