#!/usr/bin/env bash
# Run from cron/systemd on a DIFFERENT host than LeadMelo. A dead worker or dead server cannot
# raise its own alert, so this polls /api/ready from outside and pages via a webhook.
#
#   LEADMELO_URL       https://app.example.com            (required)
#   PAGE_WEBHOOK_URL   https URL that receives a JSON POST (required; Slack/ntfy/PagerDuty relay)
#   STATE_DIR          where failure counts are kept       (default /var/tmp/leadmelo-monitor)
#   FAILURES_TO_PAGE   consecutive failures before paging  (default 3)
set -eu
: "${LEADMELO_URL:?LEADMELO_URL is required}"
: "${PAGE_WEBHOOK_URL:?PAGE_WEBHOOK_URL is required}"
STATE_DIR="${STATE_DIR:-/var/tmp/leadmelo-monitor}"
FAILURES_TO_PAGE="${FAILURES_TO_PAGE:-3}"
case "$LEADMELO_URL" in https://*) ;; *) echo "LEADMELO_URL must be https" >&2; exit 2 ;; esac
case "$PAGE_WEBHOOK_URL" in https://*) ;; *) echo "PAGE_WEBHOOK_URL must be https" >&2; exit 2 ;; esac
mkdir -p "$STATE_DIR"
count_file="$STATE_DIR/failures"; paged_file="$STATE_DIR/paged"
failures=0; [ -f "$count_file" ] && failures="$(cat "$count_file")"

curl_bin="${CURL_BIN:-curl}" # override only for tests or a wrapper; must be an https-capable curl

notify() {
  "$curl_bin" -fsS --max-time 15 -X POST -H 'Content-Type: application/json' \
    -d "{\"service\":\"leadmelo\",\"status\":\"$1\",\"detail\":\"$2\"}" "$PAGE_WEBHOOK_URL" >/dev/null
}

if "$curl_bin" -fsS --max-time 10 --proto '=https' --max-redirs 0 "${LEADMELO_URL%/}/api/ready" >/dev/null 2>&1; then
  echo 0 > "$count_file"
  if [ -f "$paged_file" ]; then notify recovered "readiness restored" && rm -f "$paged_file"; fi
  exit 0
fi
failures=$((failures + 1)); echo "$failures" > "$count_file"
if [ "$failures" -ge "$FAILURES_TO_PAGE" ] && [ ! -f "$paged_file" ]; then
  # Mark as paged only if the page was actually delivered, so a webhook outage retries next run.
  notify down "readiness failed $failures consecutive checks (server, database or worker heartbeat)" && : > "$paged_file"
fi
exit 1
