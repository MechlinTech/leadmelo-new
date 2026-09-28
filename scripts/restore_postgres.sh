#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")/.."
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the recovery private-key file}"
backup="${1:?Usage: restore_postgres.sh /absolute/backup.dump.age leadmelo_restore_NAME}"
target="${2:?A new recovery database name is required}"
[[ "$target" =~ ^leadmelo_restore_[a-z0-9_]+$ ]] || { echo 'Target must start leadmelo_restore_ and contain lowercase letters, digits or underscores' >&2; exit 1; }
[[ ${#target} -le 63 ]] || exit 1
[[ -f "$backup" && -f "$backup.sha256" && -f "$AGE_IDENTITY_FILE" ]] || { echo 'Missing archive, checksum or private key' >&2; exit 1; }
# A backup taken before a privacy erasure would bring that person back. The erasure ledger from the
# LIVE system (the newest one, made with the latest backup or exported later) is re-applied after the
# restore. Restoring without it must be an explicit decision, for example a throwaway restore drill.
ledger="${ERASURE_LEDGER_FILE:-}"
if [[ -z "$ledger" && "${SKIP_ERASURE_LEDGER:-}" != "yes" ]]; then
  echo 'Set ERASURE_LEDGER_FILE=/path/leadmelo-...erasures.age (with its .sha256), or SKIP_ERASURE_LEDGER=yes for a drill that will never handle real traffic.' >&2
  exit 1
fi
[[ -z "$ledger" || ( -f "$ledger" && -f "$ledger.sha256" ) ]] || { echo 'Missing erasure ledger or its checksum' >&2; exit 1; }
for cmd in age docker sha256sum; do command -v "$cmd" >/dev/null; done
compose=(docker compose --env-file .env -f docker-compose.selfhosted.yml)
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
(cd "$(dirname "$backup")" && sha256sum -c "$(basename "$backup").sha256")
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$work/recovery.dump" "$backup"
"${compose[@]}" exec -T postgres pg_restore --list < "$work/recovery.dump" >/dev/null
if [[ -n "$ledger" ]]; then
  (cd "$(dirname "$ledger")" && sha256sum -c "$(basename "$ledger").sha256")
  age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$work/erasures.json" "$ledger"
  [[ -s "$work/erasures.json" ]] || { echo 'Empty erasure ledger' >&2; exit 1; }
fi
exists="$("${compose[@]}" exec -T postgres psql -U leadmelo -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$target'")"
[[ -z "$exists" ]] || { echo 'Refusing to overwrite an existing database' >&2; exit 1; }
"${compose[@]}" exec -T postgres createdb -U leadmelo "$target"
"${compose[@]}" exec -T postgres pg_restore -U leadmelo --dbname="$target" --no-owner --no-acl --exit-on-error --single-transaction < "$work/recovery.dump"
"${compose[@]}" exec -T postgres psql -U leadmelo -d "$target" -v ON_ERROR_STOP=1 -c "UPDATE \"TenantSetting\" SET \"automationEnabled\"=false; UPDATE \"Campaign\" SET status='PAUSED';"
if [[ -n "$ledger" ]]; then
  # Owner credentials: the restored database has no runtime-role grants yet (pg_restore --no-acl).
  owner_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)"
  [[ -n "$owner_password" ]] || { echo 'POSTGRES_PASSWORD not found in .env' >&2; exit 1; }
  DATABASE_URL="postgresql://leadmelo:${owner_password}@postgres:5432/${target}" \
    "${compose[@]}" run --rm --no-deps -T -e DATABASE_URL web node --import tsx scripts/privacy-erasures.ts reapply - < "$work/erasures.json"
  echo "Erasure ledger re-applied to $target."
else
  echo "WARNING: no erasure ledger was applied to $target. People erased after this backup may be present. Do not enable outbound." >&2
fi
echo "Restored to $target. Verify counts, tenant isolation, suppression and migration history before promotion."
