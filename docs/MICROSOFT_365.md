# Microsoft 365 setup and acceptance (V19)

## Supported integration

LeadMelo now includes native Microsoft Graph application-authenticated sending and Inbox reply polling. It uses the public Microsoft global cloud, application client credentials, a mailbox allowlist, and encrypted application secrets. This is not a user sign-in/SSO implementation or a delegated OAuth wizard. One Microsoft directory can belong to one LeadMelo tenant in this pilot. Configure up to 20 mailboxes, using exact primary user principal names that also match the campaign sender email; aliases and shared mailboxes need separate live certification.

## Administrator setup

1. Keep operator outbound disabled and campaigns paused. Register a dedicated confidential application in the tenant's Microsoft directory. Create a secret with an owned rotation schedule; never paste it into tickets, code or logs.
2. Authorize draft creation/read and sending with the equivalent of Mail.ReadWrite and Mail.Send application access, restricted to the intended mailboxes. Use Exchange application RBAC or your approved application-access policy. Validate the effective permissions with an allowed mailbox AND a mailbox outside the scope. Microsoft warns that unscoped Entra grants and scoped RBAC grants are additive: a broad grant must not defeat the mailbox restriction. The LeadMelo checkbox is an administrator attestation, not proof that Microsoft enforced scope.
3. Sign in as TENANT_ADMIN, open Settings > Microsoft 365, enter directory ID, client ID, secret and exact mailbox addresses, and attest to mailbox scope. GET responses never return the secret. Secret rotation with the same identity/mailbox set is supported; changing identities/mailboxes needs a planned migration so reply cursors and send receipts are not orphaned.
4. Start the worker with sending disabled. Confirm `MailCursor.lastSuccessAt` advances and `error` is null. Inbox polling runs while outbound is disabled so replies and opt-outs remain processed. The app reads new Inbox messages since initial connection; it does not mark messages read or delete them.
5. Configure the external discovery/verification gateway, webhook signing secret, postal address, calendar event adapter, and a fresh authoritative sender-health feed. Native Microsoft mail does not remove those dependencies.
6. Use a consenting test recipient. After the release gates pass, turn on operator and tenant automation, start a review-before-send campaign, approve one message and complete the tests below. Activate fully automatic campaigns only after that evidence is accepted.

Use dedicated campaign mailboxes with no rule that moves replies out of Inbox before polling. This release does not subscribe to every folder, parse every nondelivery report, supply complaint telemetry, or ingest arbitrary forwarded/aliased mail. The gateway must still supply authoritative bounce/complaint and sender-health events. Do not substitute a fabricated HEALTHY event.

## Send and reply semantics

- A receipt and request hash are persisted before creating a MIME draft. IDs are requested in immutable format. The same idempotency key cannot be reused for a changed request.
- The receipt enters SUBMITTING before the send request. A timeout never causes a blind second send. A later read can establish that the message reached Sent Items. Uncertain creation with no returned draft ID, or an unresolved draft, raises an exception for operator review.
- ACCEPTED means Graph accepted the request; it does not prove recipient delivery. Before progressing Inbox cursors, the poller resolves final Internet Message-IDs from Sent Items. Delayed/missing sent copies keep synchronization unhealthy and stop further sends. Up to 20 pending receipts are read in one polling pass.
- Inbox pages and cursors are durable. Cursor URLs must match Microsoft's origin and the configured mailbox. Replies use References/In-Reply-To, tenant, mailbox and contact email for campaign attribution. Unique text body is used, so the quoted sales pitch does not become the buyer's intent.
- A known contact's new thread without reliable correlation cancels their pending outreach and raises an attribution alert. An explicit negative reply also suppresses the contact. It never guesses a calendar or fabricates a meeting.
- Unknown, pricing and out-of-office replies stop outreach for review. There is no free-form autonomous negotiation or OOO restart in V19. Clearly positive replies queue the configured campaign booking invitation. Only authoritative calendar events create appointments.
- Reply-sync errors, backlog, or last success older than five minutes block sending. HTTP 410 resets the cursor to replay from connection time; persisted event IDs deduplicate processing. All HTTP operations have timeouts; no credential-bearing redirects are followed.
- Disabling Microsoft pauses active tenant campaigns. It does not silently switch to another mail sender. Read receipt and provider evidence before any manual replay.

## Required live acceptance

Record tenant/campaign IDs and redacted evidence for: allowed/out-of-scope mailbox access; draft/202/Sent Items receipt; real reply headers and uniqueBody; delayed sent copy; Microsoft 401/403/429; revoked or expired secret; duplicate worker and crash cases; negative/pricing/OOO/new-thread replies; unsubscribe headers surviving transport; Inbox rule behavior; bounce/complaint feeds; pause/disconnect; booking and cancellation at the correct calendar.

No real Microsoft credentials were used in the supplied tests. Implemented does not mean live-certified. Inbox rates, secret rotation, safe operator reconciliation and mailbox scope remain deployment responsibilities.

## Official API references checked during this update

- [Create a message](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0): MIME drafts and required access.
- [Send a draft](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0): asynchronous acceptance.
- [Immutable identifiers](https://learn.microsoft.com/en-us/graph/outlook-immutable-id): draft-to-Sent-Items correlation and possible delay.
- [Message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0): cursor/filter semantics.
- [Exchange application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac): effective mailbox permission scoping.
