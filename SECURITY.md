# Security Status

V20 implements password hashing, TOTP multi-factor authentication with single-use recovery codes, administrator-issued one-time invitation and password-reset links, expiring hashed sessions, role checks, session-derived tenant scope, request-body bounds, database rate limits, same-origin mutations, nonce CSP, private no-store responses, encrypted tenant gateway secrets, signed/idempotent webhooks and signed unsubscribe links.

Database triggers prevent cross-tenant parent references. The runtime database account is not an owner/superuser; it has DML access across tenants. PostgreSQL RLS, enterprise SSO (Google/Microsoft), enforced-per-tenant MFA, self-service password recovery, automated recovery and centralized security monitoring are not implemented. The provider gateway keeps vendor API keys in a mode-600 file, in plaintext. Do not describe the product as security-certified.

Production gates: external access review, dependency/container/OS scan, pen test, edge rate limiting, sender ownership, least privilege, data retention, key rotation and complete backup/restore drill. Keep APP_URL HTTPS and never expose PostgreSQL or the Docker socket.

SESSION_SECRET signs long-lived unsubscribe links; rotating it without retaining a previous verification key invalidates old links. Plan key rollover rather than silently breaking opt-outs. DATA_ENCRYPTION_KEY rotation requires re-encryption of stored ciphertext with a recovery plan. Existing backups require their original key. Do not rotate by merely overwriting environment variables.

Report vulnerabilities to the deployment owner through your internal security process. Preserve logs with PII/secret redaction; access tokens and unsubscribe query strings must not be logged.

Dependencies were updated after checking the [Next.js security advisory](https://nextjs.org/blog/security-update-2025-12-11) and the live npm audit report. The lockfile overrides PostCSS and deepmerge-ts to patched versions; rerun builds/tests and audit when changing them. No audit result guarantees freedom from vulnerabilities.

Native Microsoft credentials are encrypted in M365Connection. The Graph client restricts outbound origin and mailbox, forbids redirects, bounds response size, and records send state before side effects. Application mailbox allowlists complement, rather than replace, Microsoft-side authorization. Configure independent effective-access tests. Operational notification webhooks contain identifiers/codes, not mail content.
