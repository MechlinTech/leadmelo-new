# Architecture

The Next.js UI uses authenticated APIs. PostgreSQL stores tenants, sessions, campaign definitions, evidence, durable runs/outreach, suppressions and verified provider events. A separate Node worker schedules active campaigns, discovers through the gateway, qualifies/enrolls contacts and sends approved sequence steps.

The operator-managed HTTPS gateway connects real prospecting, email verification, mailbox and calendar services. It must enforce sender ownership, provider budgets and durable delivery idempotency. This service is a required implementation dependency, not bundled live integration code.

Worker send transactions serialize sender and tenant budgets. Webhooks validate tenant signatures and mutate suppression/reply/booking state atomically with event deduplication. Tenant-link triggers defend against cross-tenant parent references. The application checks authorization on every route; SQL does not supply RLS.

Use the schema and docs/PROVIDER_GATEWAY.md for contracts. See docs/AUDIT_AND_GAPS.md for scaling limits, reserved models and unimplemented features. No learning loop or advanced AI optimizer is claimed.

LeadMelo sends and polls Inbox replies through its native Microsoft 365 adapter and receives Calendly bookings natively (docs/CALENDLY.md). A gateway (`gateway/` or your own) remains required for prospect discovery, verification and sender health. Send reservation transactions finish before network I/O; leases and immutable receipt/request hashes protect recovery. Read docs/MICROSOFT_365.md and docs/OPERATIONS.md.
