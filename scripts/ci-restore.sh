#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
pg_dump --format=custom --no-owner --no-acl > "$work/db.dump"
pg_restore --list "$work/db.dump" >/dev/null
age-keygen -o "$work/key" 2>/dev/null
recipient="$(age-keygen -y "$work/key")"
age -r "$recipient" -o "$work/db.dump.age" "$work/db.dump"
age -d -i "$work/key" -o "$work/restored.dump" "$work/db.dump.age"
cmp "$work/db.dump" "$work/restored.dump"
target="leadmelo_restore_ci_$(date +%s)"
createdb "$target"
pg_restore --dbname="$target" --no-owner --no-acl --single-transaction --exit-on-error "$work/restored.dump"
for table in Tenant Campaign Contact Enrollment Suppression Appointment; do
  before="$(psql -Atc "SELECT count(*) FROM \"$table\"")"
  after="$(psql -d "$target" -Atc "SELECT count(*) FROM \"$table\"")"
  [[ "$before" == "$after" ]] || { echo "Restore count mismatch: $table"; exit 1; }
done
echo 'Native database encrypted backup/restore round trip passed.'
