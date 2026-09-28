# Deployment Entry Point

For a physical server, dedicated host, VPS or generic Docker-capable VM, follow **SELF_HOSTED_DEPLOYMENT.md**. It contains the concrete build, migration, first-admin, TLS, integration and rollback steps.

The topology is reverse proxy -> web + background worker -> PostgreSQL. The provider gateway (bundled Apollo/Hunter reference gateway in `gateway/`, or your own implementation of docs/PROVIDER_GATEWAY.md) connects prospecting and verification; Microsoft 365 and Calendly are native. PostgreSQL contains durable work; Redis is not required.

Cloud hosting is optional. You may replace the database, secrets, backups and observability with equivalents on AWS/Azure/GCP or a private platform without changing product semantics. Kubernetes manifests and high-availability failover are not supplied or validated; do not infer production support from architectural portability.

Before any customer rollout read START_HERE_DEV_MANAGER.md, docs/AUDIT_AND_GAPS.md, docs/BACKUP_AND_RECOVERY.md and docs/RELEASE_ACCEPTANCE.md. The source package is a pilot handoff and needs live integrations and deployment acceptance.

LeadMelo sends and polls Inbox replies through its native Microsoft 365 adapter and receives Calendly bookings natively (docs/CALENDLY.md). A gateway remains required for prospect discovery, verification and sender health. Send reservation transactions finish before network I/O; leases and immutable receipt/request hashes protect recovery. Read docs/MICROSOFT_365.md and docs/OPERATIONS.md.
