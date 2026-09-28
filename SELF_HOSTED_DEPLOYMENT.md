# Physical Server Deployment

This runbook is the primary supported topology. Use a staging host first. There is no AWS dependency.

## 1. Prepare The Host

Use a supported Linux server with Docker Engine, Docker Compose v2 (2.20+ for the optional include alias), OpenSSL, curl, age, rsync and a host reverse proxy (Caddy or Nginx). A reasonable pilot starting allocation is 4 vCPU, 8 GB RAM and SSD storage, with space for database growth, build images and backups. This is a starting estimate, not a capacity certification.

Use a UPS, restricted physical/admin access, disk encryption where practical, and an off-host backup destination. Permit public 80/443 to the reverse proxy; limit SSH to a VPN/admin subnet. PostgreSQL remains on the private Docker network. Do not publish port 5432 or the Docker socket.

## 2. Configure Release And Secrets

Extract the package into a versioned release directory and use `/opt/leadmelo` as the active path. Keep previous immutable images/releases for application rollback.

```bash
cd /opt/leadmelo
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 32
```

Set distinct hex outputs for POSTGRES_PASSWORD, APP_DB_PASSWORD and SESSION_SECRET, and the base64 output for DATA_ENCRYPTION_KEY. Set APP_URL to the exact external HTTPS origin and RELEASE_TAG to the release you are deploying. Keep OUTBOUND_ENABLED=false. Store these secrets in your controlled password/key system; never commit .env.

APP_DB_PASSWORD must be hex in the provided Compose URL so no URL-encoding ambiguity occurs. The runtime web/worker environment does not receive the database-owner password. The migration service does. For external PostgreSQL, supply separate owner and runtime connection strings with verified TLS, then adjust the Compose services under change control.

## 3. Build And Start

```bash
bash scripts/preflight.sh
docker compose -f docker-compose.selfhosted.yml build
docker compose -f docker-compose.selfhosted.yml up -d
docker compose -f docker-compose.selfhosted.yml ps
docker compose -f docker-compose.selfhosted.yml logs --tail=100 migrate web worker
curl -fsS http://127.0.0.1:7676/api/health
curl -fsS http://127.0.0.1:7676/api/ready
```

The migration service applies all eleven committed SQL migrations (see docs/DATABASE.md and the generated docs/SCHEMA_REFERENCE.md) and creates/grants the runtime role. Web and worker start only after migration success. The worker heartbeat runs even with sending disabled. Health checks process liveness; readiness also checks DB connectivity and a recent worker heartbeat. Configure your external monitor to alert on readiness failure.

Never run migrations against an existing manually-created V16 schema without following docs/DATABASE.md. `prisma generate` alone creates no tables.

## 4. Create The First Tenant Administrator

Run from a trusted operator terminal. Do not put the password in shell history or .env:

```bash
export BOOTSTRAP_TENANT='Mechlin Technologies'
export BOOTSTRAP_EMAIL='REPLACE_WITH_VERIFIED_ADMIN_EMAIL'
read -r -s -p 'Initial administrator password (16+ chars): ' BOOTSTRAP_PASSWORD
export BOOTSTRAP_PASSWORD
docker compose -f docker-compose.selfhosted.yml run --rm -e BOOTSTRAP_TENANT -e BOOTSTRAP_EMAIL -e BOOTSTRAP_PASSWORD web npm run bootstrap
unset BOOTSTRAP_PASSWORD
```

The bootstrap command refuses to overwrite an existing user or tenant slug. It creates a TENANT_ADMIN by default. Set `BOOTSTRAP_ROLE=SUPER_ADMIN` to create the platform operator who can use the Operator console (`/app/operator`: tenants, plans, access requests, unanswered assistant questions). Repeat with a distinct tenant name/email for another pilot tenant. Add further users from Settings > Team: an administrator creates an invitation and receives a one-time link to deliver (the platform sends no email). Each user can turn on TOTP two-factor authentication under Settings. An administrator can issue a one-time password-reset link (`POST /api/users/<id>/reset`); it revokes that user's sessions. Self-service signup, Google/Microsoft SSO and self-service password recovery are not implemented; see the register.

## 5. TLS And Browser Access

Adapt `deploy/caddy/Caddyfile.example` or `deploy/nginx/leadmelo.conf.example` to your real domain/certificate. Host proxy upstream is 127.0.0.1:7676. If proxy runs in Docker, use the web service on a shared protected network instead. Preserve Host and HTTPS scheme. On a Windows host, follow `docs/WINDOWS_SERVER.md` for Docker, the two environments, and GitHub Actions runners.

Verify certificates, APP_URL, secure session cookies, origin checks and nonce CSP. Do not cache authenticated HTML or API responses at the proxy/CDN. Do not log unsubscribe query tokens. Apply edge connection/request rate limits and central log redaction. Review HSTS before applying it to all subdomains.

Visit the HTTPS origin and sign in. The app is an installable PWA (manifest, icons, offline page). Its service worker caches only static assets and never pages, API responses or personal data. It registers only over HTTPS in production.

## 6. Connect Automation

Prospect discovery and email verification go through a gateway that implements docs/PROVIDER_GATEWAY.md. Two options:

- **Bundled Apollo + Hunter gateway** (`gateway/`; written from vendor documentation, never run against a live account: read `gateway/README.md` first). Create `gateway-config/tenants.json` from `gateway/tenants.example.json` (`chmod 600`; it holds vendor API keys) and optionally `taxonomy.json`; without an industry mapping no prospect will match an ICP. Put the SHA-256 of each tenant's bearer token in `tenants.json` and save the token itself as that tenant's gateway credential in Settings. Start it with `docker compose --profile gateway up -d`, add the `gateway.example.com` block from `deploy/caddy` or `deploy/nginx` (LeadMelo refuses a non-HTTPS gateway URL), and set `PROVIDER_GATEWAY_URL=https://gateway.example.com` in `.env`, then recreate web and worker. Run its live acceptance checklist before any unattended use.
- **Your own gateway.** Implement and certify the contract, and configure its HTTPS URL at the operator level and the tenant credential and signing secret through Settings.

Either way, complete mailbox sender/DNS/health checks. The gateway (or your own feed) must deliver a recent signed `sender.health` event to `/api/webhooks/provider/<tenantId>`; without it sending stays blocked. The bundled gateway does not produce sender-health events. Until you connect a real feed, post measured values yourself at least daily with `scripts/post-sender-health.mjs` (signed with the tenant's webhook secret; it reports only what you pass it, so take the numbers from your mail provider's bounce, complaint and reputation data; never automate a blanket HEALTHY).

For Calendly, follow docs/CALENDLY.md: create the webhook subscription pointing at `/api/webhooks/calendly/<tenantId>`, store its signing key in Settings, and use the campaign booking link (LeadMelo adds signed attribution to it automatically).

For Microsoft 365, follow docs/MICROSOFT_365.md to configure the native app connection in Settings. Keep the gateway for discovery, verification and sender health; Calendly bookings arrive natively. Configure ALERT_WEBHOOK_URL and ALERT_WEBHOOK_SECRET for your operator-owned notification receiver and certify it before unattended operation.

Create the tenant's ICP and campaign, accurate offer copy and buyer calendar route. Mechlin may use https://calendly.com/pm-mechlintech/30min. Supply Shubham's verified sender address yourself; this package does not guess it. Other tenants use their own values.

After release acceptance, set OUTBOUND_ENABLED=true, recreate web/worker to load it, enable tenant automation and activate an approved campaign. Start with REVIEW_BEFORE_SEND. Missing prerequisites produce an explicit activation error. Keep disabled while doing migration, recovery or demos.

### Marketing site, plans, assistant, themes

The public site (`/`, `/pricing`, `/request-access`) is served by the same app. Plans and prices live in `lib/plans.ts` and are placeholders: edit them before publishing. Limits are enforced only when `PLAN_ENFORCEMENT=on`; assign a tenant's plan in the Operator console. There is no online checkout: "Request access" submissions appear in the Operator console. The chat assistant answers from a curated knowledge base (`lib/assistant/knowledge.ts`) and live plan data; it is not a language model, and unanswered questions are logged (redacted) for you to review. Each user picks a theme in Settings > Appearance.

Sender health is now computed automatically (SPF/DMARC DNS checks, bounce and complaint rates, a send ramp for new senders). Calendly missed-booking recovery runs when a Calendly token and organization URI are saved in Settings.

### Optional AI assist (Ollama or any OpenAI-compatible model)

Off by default and not required. An admin turns it on per workspace in Settings > AI assist: base URL (ending in /v1), model name, optional API key (stored encrypted), and which features to allow (campaign assist: ICP and email-sequence draft from a description; reply assist: summary and suggested response). It never sends email, never changes suppression, and opt-outs are decided only by the built-in rules. Every suggestion is a draft that a person reviews and saves through the normal validated flow. Prospect and reply text is sent to the model you configure.

To use Ollama: run it where the web container can reach it, set `AI_ALLOWED_HOSTS` in `.env` (for example `host.docker.internal:11434`; on Linux add `extra_hosts: ["host.docker.internal:host-gateway"]` to the web service), recreate web, then use `http://host.docker.internal:11434/v1` and your pulled model name (for example `llama3.1`) in Settings and press Test connection. Hosted services must use https to a public address. `AI_DAILY_LIMIT` caps calls per workspace per 24 hours. Restrict egress from the web container at the network layer if you run multiple untrusted tenants. To try the screens without a model run `node scripts/mock-llm.mjs` (canned answers, not an AI).

## 7. Backups And Monitoring

Follow docs/BACKUP_AND_RECOVERY.md. Install the timer, run one offsite backup and a complete isolated restore drill. Protect the encryption private key and DATA_ENCRYPTION_KEY separately. Each backup now produces two encrypted files: the database dump and an erasure ledger; a restore needs both (see that document). The backup script has only been tested against stub executables, so the restore drill is the first real proof it works on your host.

Install the external monitor from `deploy/monitor/` on a **different host** (a dead server or worker cannot page itself) and point its `PAGE_WEBHOOK_URL` at a receiver you operate; test that the page actually arrives.

Monitor readiness, worker last activity, oldest queued work, failed runs/messages, provider quota/spend, bounce/complaint rates, backup freshness and disk space. The package exposes data and checks; connecting paging/email/Grafana is an operator task.

## 8. Upgrade And Rollback

**V19 to V20:** migrations 5-9 are additive. Pause campaigns and stop the worker, complete an offsite backup (with its erasure ledger), rehearse on a restored copy, set the new image tag (`RELEASE_TAG=20.0.0`), `docker compose build`, `docker compose run --rm migrate`, then `docker compose up -d web worker` (add `--profile gateway` if you run the gateway). Run `bash scripts/preflight.sh` first: it now also checks the gateway URL is HTTPS and that `tenants.json` is mode 600. Keep `OUTBOUND_ENABLED=false` until acceptance passes.

Before upgrading, pause campaigns and stop the worker, complete an offsite backup, test the release against a restored staging DB and review migration SQL. Build a new immutable image tag. Run the migration service for the release and recreate web/worker only after success. If migration fails, keep sending stopped and resolve the failed migration from its logs.

For application rollback use the previous image only if it remains schema-compatible. Do not reset migrations, delete pgdata, run `down -v`, or restore over the live database as a routine rollback. Recover into a new isolated DB and reconcile provider effects before promotion.

For emergency stop set OUTBOUND_ENABLED=false and recreate web/worker, or stop the worker immediately. Requests already accepted by a provider may still complete; reconcile them before restarting.
