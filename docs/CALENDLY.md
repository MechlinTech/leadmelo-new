# Calendly setup and acceptance

**Status: implemented against Calendly's published API documentation (OpenAPI file and webhook-signature page, read 18 September 2026) and tested with synthetic payloads. Never run against a live Calendly account.** Facts marked *(confirm)* were not in the documentation I could read.

## How it works

1. Every scheduling link LeadMelo emails is your campaign's Calendly URL plus `utm_source=leadmelo` and `utm_content=<signed token>`. The token is an HMAC over tenant, campaign and contact, so it cannot be forged or edited to attribute a booking elsewhere. Calendly returns it in the booking as `payload.tracking.utm_content`.
2. Calendly POSTs `invitee.created` and `invitee.canceled` events to `https://<your-app>/api/webhooks/calendly/<tenantId>` with a `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex>` header. LeadMelo verifies HMAC-SHA256 over `t + "." + exact body bytes` with your signing key and rejects timestamps more than 3 minutes off (Calendly's recommendation).
3. A verified, attributed event becomes an appointment through the same idempotent path as every other booking. A booking with no valid token, or a token from another tenant, is acknowledged (so Calendly stops retrying) but creates nothing. If the invitee's email differs from the contact's, the booking is kept (the token is authoritative) and an alert is raised.
4. A positive reply, a link click or an email is never a meeting; only a verified booking creates one.

## Setup

1. Generate a random signing key (`openssl rand -hex 32`). Store it under **Settings > Calendly webhook signing key**. It is encrypted at rest. Nothing is accepted from Calendly until this is set.
2. Create a Calendly personal access token (or OAuth app) with permission to manage webhooks *(confirm the exact scopes; the documentation lists `scheduled_events:read` for the invitee events and `webhooks:read` for listing)*. Confirm your Calendly plan supports webhooks *(confirm; the documentation I read does not say)*.
3. Get your organization URI (for example `GET https://api.calendly.com/users/me`, field `current_organization`) *(confirm)*.
4. Create the subscription (`POST https://api.calendly.com/webhook_subscriptions`; required fields per the OpenAPI file are `url`, `events`, `organization` and `scope`; `signing_key` is optional in Calendly but **required by LeadMelo**):

   ```bash
   curl -sS https://api.calendly.com/webhook_subscriptions \
     -H "Authorization: Bearer $CALENDLY_TOKEN" -H "Content-Type: application/json" \
     -d '{"url":"https://app.example.com/api/webhooks/calendly/TENANT_ID",
          "events":["invitee.created","invitee.canceled"],
          "organization":"https://api.calendly.com/organizations/ORG_UUID",
          "scope":"organization","signing_key":"THE_SAME_KEY_AS_IN_SETTINGS"}'
   ```
   `scope` may be `organization`, `user` or `group`. Use `user` if you only want one host's events; the campaign's booking link must belong to that scope. Calendly's dashboard hides these details, so keep the returned subscription URI.
5. The URL must be public HTTPS. The reverse proxy must not cache or rewrite the body (the signature covers the exact bytes).
6. Give the campaign the event type's booking link (for example `https://calendly.com/pm-mechlintech/30min` for Mechlin only). Do not put your own `utm_content` on it; LeadMelo sets it.

## Live acceptance (do before relying on it)

With a test Calendly event type and a consenting test contact:

- Send a scheduling email through the real pipeline, book through the link, and confirm one appointment appears on the right campaign and contact.
- Cancel the booking; confirm the appointment becomes CANCELED. Reschedule; confirm the result (Calendly models a reschedule as a cancellation plus a new booking; LeadMelo shows two records, one canceled and one booked; it does not link them).
- Book through the raw link with the `utm_content` removed or edited; confirm nothing is created.
- Send a request with a wrong signature and with an old timestamp; confirm rejection.
- Stop the app for a few minutes, book, restart; confirm what Calendly does about the missed delivery. **Retry behaviour is not documented in what I read** *(confirm)*, and LeadMelo has **no reconciliation job** that fetches missed bookings from Calendly.
- Confirm invitee email mismatch raises the alert.

## Known limitations

- No reconciliation of missed webhooks, no availability search, no multi-host routing, no no-show or attendance events (`invitee_no_show.*` are not handled; outcomes are recorded by a person).
- The `invitee.created` `cancellation` field name is `created_at` per Calendly's schema; earlier code used a wrong name and was fixed on 18 September 2026.
- The time a cancellation "occurred" comes from the payload; an older creation event delivered late cannot resurrect a canceled booking.
- Only these two event types are processed; others are acknowledged and ignored.
