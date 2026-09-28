# Self-Driving Campaign Behavior

LeadMelo is a customer-acquisition workflow, not a booking widget. Each campaign is an independent autonomous unit with its own offer, ICP, initial email, follow-up sequence, sender, calendar URL, timezone, automation mode, caps and outcome. A tenant can create many campaigns and either define a new ICP inline or reuse an existing one. Tenant-level caps, suppression and sender health apply across all campaigns.

FULLY_AUTOMATIC permits eligible messages without per-message approval. REVIEW_BEFORE_SEND requires approval of each queued message. REVIEW_BEFORE_BOOKING currently allows the prospect to book externally and marks meeting qualification for human review; it does not intercept or hold a Calendly booking. PAUSED stops new work. Campaign status and tenant/operator switches must also permit execution.

The scheduler persists a run at most hourly per due active campaign. The worker claims runs with a lease, calls the discovery gateway with a stable idempotency key, filters verified evidence, avoids cross-campaign simultaneous contact and queues sequential outreach. Tenant/sender/campaign budgets are rolling 24-hour limits; prospect admission budgets cover the preceding seven days.

Follow-ups are scheduled from actual send time with business-day delay, then checked against the campaign's local send window. Unknown/revoked provider state, stale verification or unhealthy sender blocks sending. All replies stop the sales sequence. A clear positive reply queues exactly one booking invitation containing that campaign's calendar URL; REVIEW_BEFORE_SEND still requires approval. Negative replies, complaints, bounces and opt-outs suppress the contact and stop all outreach.

A positive reply is not treated as a booked appointment. A signed, verified calendar-provider booking is recorded once and attributed to its enrollment only after the buyer accepts a time. Qualified meeting criteria require the campaign's quality score plus buyer/pain evidence. Newer cancellation events supersede older creation events. Owners record attended/no-show/won/lost outcomes.

Current limitations: conservative rule-based qualification/replies; no native provider adapters, autonomous reply negotiation, learning loop, live availability negotiation or re-verification task. Exceptions are visible in the Automation view; alerting/digests require integration. See AUDIT_AND_GAPS.md.
