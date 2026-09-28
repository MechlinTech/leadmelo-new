# Where things are

## Database schema
- docs/SCHEMA_REFERENCE.md: every table and column, generated from the Prisma schema (a test fails if it drifts).
- docs/DB_SCHEMA_FULL.sql: all 11 migrations concatenated (reference; deploy with `prisma migrate deploy`).
- prisma/schema.prisma and prisma/migrations/: the source of truth.
- docs/DATABASE.md: migration notes, roles, invariants, upgrade rules.

## Database backup and restore
- docs/BACKUP_AND_RECOVERY.md: procedure, encryption, offsite copy, restore drill, key custody.
- scripts/backup_postgres.sh, scripts/restore_postgres.sh, scripts/check_backup.sh (tested against stub tools only; a real restore drill on your host is required).
- deploy/systemd/: timer/service examples for scheduled backups.

## Deployment
- SELF_HOSTED_DEPLOYMENT.md: step-by-step (host, secrets, build, migrate, first admin, TLS, integrations, backups, upgrade, rollback).
- DEPLOYMENT_INSTRUCTIONS.md: entry point. START_HERE_DEV_MANAGER.md: handoff checklist.
- docker-compose.selfhosted.yml, Dockerfile, .env.example, deploy/caddy, deploy/nginx, deploy/monitor.
- docs/RELEASE_ACCEPTANCE.md: go-live checklist.

## Optional AI assist
- Settings > AI assist in the app; lib/ai/ (client, guardrails, features); scripts/mock-llm.mjs (canned model for demos and tests); SELF_HOSTED_DEPLOYMENT.md section "Optional AI assist".
