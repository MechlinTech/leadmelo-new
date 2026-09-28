#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
for cmd in docker openssl curl; do command -v "$cmd" >/dev/null || { echo "Missing $cmd"; exit 1; }; done
docker compose version >/dev/null
[[ -f .env ]] || { echo 'Create .env from .env.example'; exit 1; }
[[ "$(stat -c %a .env)" == 600 ]] || { echo '.env must have mode 600'; exit 1; }
if grep -q CHANGE_ME .env; then echo 'Replace all CHANGE_ME values'; exit 1; fi
for key in POSTGRES_PASSWORD APP_DB_PASSWORD SESSION_SECRET; do
  value="$(sed -n "s/^$key=//p" .env)"
  [[ "$value" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "$key must contain 64 hex characters"; exit 1; }
done
key="$(sed -n 's/^DATA_ENCRYPTION_KEY=//p' .env)"
[[ "$(printf '%s' "$key" | openssl base64 -d -A | wc -c)" -eq 32 ]] || { echo 'Invalid encryption key'; exit 1; }
grep -Eq '^APP_URL=https://[^[:space:]]+$' .env || { echo 'Set HTTPS APP_URL'; exit 1; }
# Optional provider gateway: LeadMelo refuses a non-https gateway URL, and the tenants file holds vendor keys.
gateway_url="$(sed -n 's/^PROVIDER_GATEWAY_URL=//p' .env)"
if [[ -n "$gateway_url" && ! "$gateway_url" =~ ^https://[^[:space:]]+$ ]]; then echo 'PROVIDER_GATEWAY_URL must be an https URL'; exit 1; fi
gateway_dir="$(sed -n 's/^GATEWAY_CONFIG_DIR=//p' .env)"; gateway_dir="${gateway_dir:-./gateway-config}"
if [[ -f "$gateway_dir/tenants.json" ]]; then
  [[ "$(stat -c %a "$gateway_dir/tenants.json")" == 600 ]] || { echo "$gateway_dir/tenants.json holds vendor API keys and must have mode 600"; exit 1; }
fi
docker compose --env-file .env -f docker-compose.selfhosted.yml --profile gateway config --quiet
echo 'Preflight passed. Live connector and recovery gates still apply.'
