#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")/.."
: "${BACKUP_DIR:?Set BACKUP_DIR}"
: "${AGE_RECIPIENT:?Set the backup encryption public key}"
: "${BACKUP_OFFSITE_TARGET:?Set an off-host rsync target}"
retention="${BACKUP_RETENTION_DAYS:-14}"
[[ "$retention" =~ ^[0-9]+$ ]] && (( retention >= 7 )) || { echo 'Retention must be at least 7 days' >&2; exit 1; }
[[ "$BACKUP_OFFSITE_TARGET" == *@*:* ]] || { echo 'Offsite target must use user@host:/path' >&2; exit 1; }
for cmd in docker age rsync sha256sum flock; do command -v "$cmd" >/dev/null; done
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { echo 'Backup already running' >&2; exit 1; }
work="$(mktemp -d "$BACKUP_DIR/.work-XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
compose=(docker compose --env-file .env -f docker-compose.selfhosted.yml)
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
name="leadmelo-$stamp.dump.age"
ledger_name="leadmelo-$stamp.erasures.age"

# 1. Database: custom-format dump, validated by listing its table of contents.
"${compose[@]}" exec -T postgres pg_dump -U leadmelo -d leadmelo --format=custom --no-owner --no-acl > "$work/database.dump"
[[ -s "$work/database.dump" ]] || { echo 'Empty database dump' >&2; exit 1; }
"${compose[@]}" exec -T postgres pg_restore --list < "$work/database.dump" > "$work/archive.list"
[[ -s "$work/archive.list" ]] || { echo 'Unreadable database dump' >&2; exit 1; }

# 2. Erasure ledger: the addresses erased or suppressed for erasure requests. After a restore it is
#    re-applied so a backup taken before an erasure cannot bring the person back. It must be part of
#    every backup run: if it cannot be exported and validated the whole backup fails.
"${compose[@]}" exec -T web node --import tsx scripts/privacy-erasures.ts export > "$work/erasures.json"
[[ -s "$work/erasures.json" ]] || { echo 'Empty erasure ledger' >&2; exit 1; }
"${compose[@]}" exec -T web node -e "const a=JSON.parse(require('fs').readFileSync(0,'utf8'));if(!Array.isArray(a))process.exit(1)" < "$work/erasures.json" \
  || { echo 'Invalid erasure ledger' >&2; exit 1; }

# 3. Encrypt both, checksum both, replicate both offsite, and only then mark success.
age --recipient "$AGE_RECIPIENT" --output "$work/$name" "$work/database.dump"
age --recipient "$AGE_RECIPIENT" --output "$work/$ledger_name" "$work/erasures.json"
mv "$work/$name" "$BACKUP_DIR/$name"
mv "$work/$ledger_name" "$BACKUP_DIR/$ledger_name"
(cd "$BACKUP_DIR" && sha256sum "$name" > "$name.sha256" && sha256sum "$ledger_name" > "$ledger_name.sha256")
rsync --archive --checksum -- "$BACKUP_DIR/$name" "$BACKUP_DIR/$name.sha256" "$BACKUP_DIR/$ledger_name" "$BACKUP_DIR/$ledger_name.sha256" "$BACKUP_OFFSITE_TARGET"
printf '%s\n' "$name" > "$work/last-success"
mv "$work/last-success" "$BACKUP_DIR/last-success"
# Never prune unless encryption, archive validation and offsite transfer all succeeded.
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'leadmelo-*.dump.age*' -o -name 'leadmelo-*.erasures.age*' \) -mtime "+$retention" -delete
echo "Encrypted backup and erasure ledger validated and replicated: $name"
