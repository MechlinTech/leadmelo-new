# LeadMelo provider gateway (Apollo discovery + Hunter verification)

**Status: written from the vendors' published documentation. NOT verified against a live Apollo or Hunter account.** Offline tests (`tests/gateway.test.mjs`) mock the vendors using the documented response shapes; they check this code and the LeadMelo contract, not vendor behaviour. Do not run unattended outreach through it until the live acceptance below passes.

Implements `docs/PROVIDER_GATEWAY.md`: `POST /discover`, `POST /verify`, `GET /health`. `POST /send` returns 501 (use the native Microsoft 365 connection). No Google, RocketReach, Clay, PDL or Calendly-lookup code exists here.

## How discovery works

1. **Search** (Apollo `mixed_people/api_search`, 0 credits): filters built from the ICP: buyer titles, organization locations, employee ranges, technology UIDs, exclusion domains and, for each `Hiring <role>` buying signal, `q_organization_job_titles[]`.
2. **Free pre-filter**: a candidate whose title is not equal (or a listed equivalent, e.g. "Chief Technology Officer" = "CTO") to an ICP buyer title is skipped without spending a credit.
3. **Enrich** (Apollo `people/match?id=`, ~1 credit when an email is returned; never requests personal emails or phone numbers).
4. **Verify** the email with Hunter; only `valid` + not-risky becomes `VALID`. Catch-all and webmail addresses are `RISKY`, disposable are `INVALID`; neither is returned.
5. Return prospects in the ICP's own wording (size band, geography, title, industry) with evidence.

Claims are deliberately narrow: a "Hiring QA" signal is claimed only for candidates returned by a search filtered on that job title; a technology only if Apollo lists it for the company. `evidenceUrl` is the company website or LinkedIn page, which is provenance for the organization, **not** proof of the posting; the summary says the signal comes from an Apollo filter and is not independently confirmed. ICPs with no `Hiring <role>` signal are refused (422) before anything is spent, because no other signal can be evidenced.

Reliability: results are stored per `Idempotency-Key` (same key + same request returns the same result; a different request under the same key gets 422; concurrent calls share one execution); already-enriched people are remembered per tenant+campaign so they are never bought twice; a per-search page cursor advances and wraps; a vendor failure after some prospects were bought returns those prospects; a job slower than `GATEWAY_SYNC_WAIT_MS` (default 12 s, because LeadMelo aborts after 15 s) answers `503 in_progress` with `Retry-After: 15` and finishes in the background, so LeadMelo's retry with the same key collects it. LeadMelo retries a failed discovery run after 2 minutes and again after 4 minutes, then marks it FAILED (3 attempts in total), so a discovery job must finish within a couple of minutes for a retry to collect it.

## Setup

1. Choose tenant credentials. For each LeadMelo tenant, generate a long random bearer token (`openssl rand -hex 32`), save it in that tenant's LeadMelo Settings as the gateway credential, and put only its SHA-256 here:
   `printf %s "<token>" | sha256sum`
2. Create `tenants.json` from `gateway/tenants.example.json` with that tenant's **own** Apollo and Hunter keys. `chmod 600` it and keep it out of git; prefer your secret manager.
3. Optionally create `taxonomy.json` from `gateway/taxonomy.example.json`. **Without an industry mapping nothing will qualify**, because Apollo's industry names ("computer software") will not equal your ICP's ("SaaS"). Add only mappings you consider genuinely equivalent.
4. Run behind a TLS reverse proxy (LeadMelo requires an https URL; see `deploy/caddy` and `deploy/nginx`):
   ```
   GATEWAY_TENANTS_FILE=/etc/leadmelo/tenants.json GATEWAY_TAXONOMY_FILE=/etc/leadmelo/taxonomy.json \
   GATEWAY_STORE_FILE=/var/lib/leadmelo-gateway/store.jsonl PORT=8788 npm run gateway
   ```
   Set `PROVIDER_GATEWAY_URL` for the LeadMelo web and worker to the proxy's https URL.

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_TENANTS_FILE` | required | tenant bindings and vendor keys |
| `GATEWAY_TAXONOMY_FILE` | none | vendor-to-ICP wording maps |
| `GATEWAY_STORE_FILE` | in memory | append-only file so a restart does not repurchase data (mode 0600, not encrypted) |
| `GATEWAY_HOST` / `PORT` | 127.0.0.1 / 8788 | bind address |
| `GATEWAY_SYNC_WAIT_MS` | 12000 | how long a request waits before answering `in_progress` (1000-14000) |
| `GATEWAY_DISCOVERY_DEADLINE_MS` | 90000 | stop a discovery job after this long, returning what it has |
| `GATEWAY_MAX_ENRICH_PER_REQUEST` | 60 | credit budget per request (also capped at 4 x limit) |
| `GATEWAY_MAX_PAGES` | 3 | search pages per job |

## Assumptions that must be confirmed live (any of these may be wrong)

1. Apollo accepts the search parameters as a **query string on a POST** with `[]` array names, as the documentation describes and the offline test asserts; the documented technology filter takes Apollo technology UIDs, and the gateway guesses "lowercase, spaces to underscores". A wrong UID silently matches nothing.
2. The enrichment response wraps the record under a `person` key (the documentation lists the fields but the parser assumes the wrapper). If it is at the top level every enrichment returns "no data" and nothing is bought.
3. `q_organization_job_titles[]` means an open posting matching that title, and combines with the other filters as AND. The "Hiring X" claim depends on it.
4. `organization_locations[]` accepts a country name; `organization_num_employees_ranges[]` accepts `min,max`; per_page up to 100.
5. `people/match` with only an Apollo `id` and `reveal_personal_emails=false` returns a work email for the people you expect, at the documented credit cost. Actual credit consumption is unmeasured; the budget cap is your only protection until you measure it.
6. Hunter's `valid`/`accept_all`/`webmail`/`disposable`/`unknown` mapping to VALID/RISKY/INVALID/UNKNOWN is a judgement, not vendor guidance. A `202` (pending) is returned as UNKNOWN and relies on LeadMelo's retry; there is no polling. `verifiedAt` is the gateway's clock, since Hunter returns no timestamp.
7. Geography uses the **person's** country, not the company's HQ; company size is Apollo's `estimated_num_employees`, which can be stale.

## Known gaps

- **No proactive rate limiting.** Documented limits (Hunter 10 requests/second and 300/minute; Apollo enrichment 600 calls/hour on the documented endpoint, lower on some plans) are only handled by reacting to 429/403 with `503 Retry-After`. Ten budget-sized runs in an hour can exhaust Apollo's hourly allowance.
- Single process; the store is not shared between instances and the file grows without bound.
- The tenants file holds vendor keys in plaintext.
- No monetary spend tracking: LeadMelo's ledger counts prospects returned, not Apollo credits spent (people who were enriched but rejected cost credits and are not in the ledger).
- No TLS termination, no request-level authentication beyond the bearer token, no per-tenant quotas.
- Vendor terms of service, data-provenance and consent obligations for the target regions (including your vendors as subprocessors) have not been reviewed.

## Live acceptance checklist (do before production)

With sandbox/test accounts and a consenting test mailbox: run one `limit: 1` discovery and check the Apollo request in their dashboard; confirm one credit was spent and the email is correct; confirm Hunter status for a known-valid, a known-invalid, a catch-all and a disposable address; revoke each key and confirm `502`; force a 429 and confirm `503 Retry-After`; kill the gateway mid-job and confirm the retry does not repurchase; confirm a prospect passes LeadMelo qualification; then run a supervised campaign with a low daily cap.
