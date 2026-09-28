# Windows Server: Docker, two environments, GitHub runners

This host can run **development** (from `main`) and **production** (from the `production` branch) as two isolated Compose projects. Each has its own PostgreSQL volume and database name. The web UI is published only on localhost.

| Environment | Git branch | Compose project | Database | Local URL |
|---|---|---|---|---|
| development | `main` | `leadmelo-dev` | `leadmelo_dev` | http://localhost:7676 |
| production | `production` | `leadmelo-prod` | `leadmelo_prod` | http://localhost:7677 |

Production uses **7677** so both stacks can run on one Windows server. Public access is via Cloudflare Tunnel to localhost; set `APP_URL` to the HTTPS hostname (for example `https://leadmelo.mechlintech.com`), not `http://localhost`.

## 1. Host software

Install, using **Linux containers** (not Windows containers):

- Docker Desktop for Windows, or Docker Engine + Compose v2
- Git for Windows
- A GitHub Actions self-hosted runner (two registrations; see below)

Confirm:

```powershell
docker version
docker compose version
git --version
```

Do not publish PostgreSQL (5432) or the Docker socket.

## 2. Local start without CI

From the repository root:

```powershell
Copy-Item .env.dev.example .env.dev
Copy-Item .env.prod.example .env.prod
# Replace every CHANGE_ME. Generate hex secrets with: openssl rand -hex 32
# DATA_ENCRYPTION_KEY: openssl rand -base64 32
.\scripts\deploy.ps1 -Environment dev
.\scripts\deploy.ps1 -Environment production
```

Health checks:

```powershell
Invoke-WebRequest http://127.0.0.1:7676/api/health
Invoke-WebRequest http://127.0.0.1:7677/api/health
```

## 3. Two GitHub Actions runners

Create two self-hosted runners on this server (or one per server). In the GitHub repo: **Settings → Actions → Runners → New self-hosted runner → Windows**.

Register them with **distinct** labels:

- Runner A labels: `self-hosted`, `leadmelo-dev`
- Runner B labels: `self-hosted`, `leadmelo-prod`

Install each as a Windows service so deploys run when nobody is logged in. Use separate runner folders (for example `C:\actions-runner-dev` and `C:\actions-runner-prod`).

The workflows `.github/workflows/deploy-dev.yml` and `deploy-prod.yml` target those labels. Until both runners are online, the deploy jobs stay queued.

## 4. GitHub Environments and secrets

Create environments named **development** and **production** (Settings → Environments). Put **different** database passwords on each environment.

Required **environment secrets** (not repository secrets, so prod cannot reuse dev credentials):

- `POSTGRES_PASSWORD` — 64 hex characters
- `APP_DB_PASSWORD` — 64 hex characters
- `SESSION_SECRET` — 64 hex characters
- `DATA_ENCRYPTION_KEY` — 32-byte value, base64

Optional environment secrets: `PROVIDER_GATEWAY_URL`, `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_SECRET`.

Optional **environment variables**: `APP_URL`, `HOST_PORT`, `COMPOSE_PROJECT_NAME`, `POSTGRES_DB`.

For Cloudflare in front of development, set `APP_URL=https://leadmelo.mechlintech.com` (no trailing slash). After changing it, redeploy so session cookies are `Secure` and origin checks match the browser.

## 6. Cloudflare Tunnel (`leadmelo.mechlintech.com`)

Keep PostgreSQL and Docker unpublished. Point Cloudflare at the loopback web port only.

1. In Cloudflare Zero Trust: **Networks → Tunnels → Create a tunnel** (Windows installer or `cloudflared` service).
2. Public hostname:
   - Subdomain / domain: `leadmelo` on `mechlintech.com`
   - Type: `HTTP`
   - URL: `http://127.0.0.1:7676` for the development stack (use `7677` when this hostname should serve production)
3. SSL/TLS mode for the zone can stay **Full**. The tunnel is HTTP only to localhost; browsers get HTTPS from Cloudflare.
4. Do not orange-cloud a public A/AAAA to the Windows server if the app is bound to `127.0.0.1`. The tunnel CNAME is enough.

If `leadmelo.mechlintech.com` is the real customer URL, attach the tunnel to **production** (`7677`) and use a second hostname (for example `leadmelo-dev.mechlintech.com` → `127.0.0.1:7676`) for development. One public hostname cannot safely serve both databases.

Push to `main` deploys development. Push (or merge) to `production` deploys production. You can also run **Actions → deploy-development / deploy-production → Run workflow**.

## 5. First administrator

After a stack is healthy:

```powershell
$env:BOOTSTRAP_TENANT = 'Mechlin Technologies'
$env:BOOTSTRAP_EMAIL = 'REPLACE_WITH_VERIFIED_ADMIN_EMAIL'
$env:BOOTSTRAP_PASSWORD = 'use-a-16-plus-char-password'
docker compose --env-file .env.dev -p leadmelo-dev -f docker-compose.selfhosted.yml run --rm -e BOOTSTRAP_TENANT -e BOOTSTRAP_EMAIL -e BOOTSTRAP_PASSWORD web npm run bootstrap
Remove-Item Env:BOOTSTRAP_PASSWORD
```

Repeat against `-p leadmelo-prod` and `.env.prod` for the production database.
