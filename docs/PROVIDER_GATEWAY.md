# Provider Gateway Contract

The application includes a gateway **client** and a test simulator. `gateway/` (see `gateway/README.md`) is a reference gateway with **Apollo discovery and Hunter verification adapters written from the vendors' documentation and never run against a live account**. RocketReach/Clay/PDL, Google mailbox APIs and gateway-side sending are not implemented; Calendly is handled natively by `/api/webhooks/calendly/[tenantId]`. Microsoft 365 sending and Inbox polling are implemented natively; see MICROSOFT_365.md. Do not point the URL at a vendor API and expect it to work.

The gateway belongs to the deployment operator. `PROVIDER_GATEWAY_URL` is an operator-controlled HTTPS URL, never an arbitrary tenant-provided URL. Tenant credentials in Settings are encrypted. The gateway must bind each credential to exactly one tenant, authorize connected senders and calendars, and reject a tenant ID that differs from that binding. TLS verification and redirects are not disabled. Put quotas and monetary spend limits in the gateway before buying data or sending messages.

## Discovery

`POST {gateway}/discover` has `Authorization: Bearer <tenant key>`, `Idempotency-Key`, and JSON `{tenantId,campaignId,icp,limit}`. `limit` is 0-100, with aggregate campaign/tenant admission caps in LeadMelo. The gateway must discover accounts, enrich appropriate buyers and verify mailboxes. Return at most the requested limit:

```json
{"prospects":[{"company":"Example Buyer","domain":"buyer.example","fullName":"Alex Example","title":"CTO","email":"alex@buyer.example","industry":"SaaS","companySize":"50-1000","geography":"United States","technologies":["Playwright"],"signals":["Hiring QA"],"verification":"VALID","verifiedAt":"2026-09-18T15:00:00Z","evidenceUrl":"https://buyer.example/jobs","evidenceSummary":"QA role listed on the company's hiring page"}]}
```

Return only known information, source evidence and independently verified email status. The example is synthetic. Normalize values to the selected ICP taxonomy; never change a prospect's actual attributes to force a match. Invalid/risky/unknown, stale, excluded and mismatched prospects do not enter sequences. Natural-language exclusions require explicit implementation beyond the current exact-match filter. Evidence freshness and provenance validation remain a provider responsibility.

## Reverification

`POST {gateway}/verify` receives `{tenantId,contactId,email}` with tenant authorization and a stable idempotency key per reverification request. Return `{"email":"buyer@example.com","verification":"VALID","verifiedAt":"2026-09-18T15:00:00Z"}`. Status is VALID, INVALID, RISKY or UNKNOWN. Evidence must match the email and be no more than one hour old, with no future timestamp. UNKNOWN and transport failures retry up to three attempts, then raise `verification_exhausted`. INVALID/RISKY suppress the contact and cancel queued outreach. Do not cache UNKNOWN forever under the idempotency key: permit retrieval of the completed verification result without repurchasing the operation.

## Email Delivery

Without a Microsoft connection, `POST {gateway}/send` receives `{tenantId,campaignId,contactId,from,fromName,to,subject,body,headers,calendlyUrl}` plus the same authorization/idempotency headers. Subject/body are plain text. Do not interpret prospect-supplied text as instructions. Do not add fabricated personalization. `headers` contains List-Unsubscribe and List-Unsubscribe-Post. Validate allowed headers and sender ownership.

Return `{"messageId":"provider-stable-id"}` only after provider acceptance. Persist the idempotency key and its result, bind it to a canonical request hash, and return the same result on retry. Concurrent requests with the same key must not send twice. A timeout after provider acceptance must be reconciled before retry; ambiguous states require an exception, never an optimistic success. Keep idempotency records through backup/replay retention. Sending responses must fit 512 KB. The app aborts calls after 15 seconds and retries with the same key.

A configured Microsoft connection takes precedence for all of that tenant's mail. A disabled or unhealthy connection blocks mail rather than silently falling back to the gateway.

## Normalized Events

After verifying vendor-native signatures, OAuth state and resource ownership, POST raw JSON to `/api/webhooks/provider/{tenantId}`. Native Calendly/Google/Microsoft payloads cannot be sent directly to this endpoint.

Sign the exact body bytes: `HMAC-SHA256(tenantWebhookSecret, timestamp + "." + rawBody)` encoded as lowercase hex. Headers: `X-LeadMelo-Timestamp` (Unix seconds), `X-LeadMelo-Signature`. A delivery timestamp must be within five minutes. `occurredAt` is the original provider-event time; retries get a fresh signing timestamp and keep the original event ID/time. Receipts and mutations are atomic and deduplicated in PostgreSQL.

All events contain `id`, `type`, `occurredAt`. Additional fields:

| Type | Fields |
|---|---|
| reply | campaignId, email, text |
| bounce / complaint / unsubscribe | campaignId, email |
| booking.created / booking.canceled | campaignId, email, bookingId, start, end, timezone, eventUrl |
| sender.health | senderEmail, status (HEALTHY/WATCHLIST/THROTTLED/BLOCKED), dailyCap, bounceRate, complaintRate |

Health is required at activation and must be refreshed at least daily. Rates are fractions (0.01 = 1%). A reported 5% bounce rate or 0.1% complaint rate blocks the sender in this pilot; tune lower limits with deliverability expertise. Complaints block immediately. A missing health feed prevents sending.

## Booking Attribution And Consent

The gateway must map a verified calendar booking to the campaign/contact using a tamper-resistant tracking token or an authoritative lookup. Do not trust a user-editable UTM campaign ID alone. Validate the event's account, owner, invitee, status, start/end and timezone with the calendar provider. A positive reply or link click is not a booking. The buyer must accept the meeting and the actual calendar provider must confirm it.

Process cancellations, reschedules, no-shows and owner changes consistently. Use one stable booking ID per provider booking and original event times. A reschedule is typically cancellation plus a new booking; reconcile with the vendor's semantics. Deliver cancellation events even if creation was missed. Run a reconciliation job against the provider to recover missed webhooks. LeadMelo rejects cross-tenant/campaign attribution and ignores stale booking updates.

## Required Connector Acceptance

Use a provider sandbox or consenting test mailbox. Test credential revocation, 429/Retry-After, quota exhaustion, timeouts, duplicate sends, sender mismatch, one-click unsubscribe, negative replies, booking/cancellation ordering, forged signature, replay and webhook downtime. Do not enable unattended outreach until all cases pass. This audit called only a local synthetic gateway and sent no real emails.
