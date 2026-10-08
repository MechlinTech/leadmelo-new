const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Invalid email or password. Please try again.',
  invalid_request: 'Some fields are invalid. Check the values and try again.',
  invalid_json: 'That request was not valid. Please try again.',
  body_required: 'Please fill in the required fields.',
  body_too_large: 'That submission is too large.',
  role_not_allowed: 'Your role cannot do that.',
  admin_required: 'Only a workspace administrator can do that.',
  origin_not_allowed: 'This request was blocked because it did not come from the LeadMelo site.',
  authentication_required: 'Please sign in.',
  already_exists: 'That record already exists.',
  rate_limit_exceeded: 'Too many attempts. Please wait and try again.',
  invalid_email: 'Enter a valid email address.',
  invalid_reset: 'This password-reset link is invalid, has expired, or has already been used. Request a new reset link.',
  invalid_invite: 'This invitation link is invalid, has expired, or has already been used. Ask your administrator for a new invitation.',
  campaign_not_found: 'That campaign was not found.',
  icp_not_found: 'That ideal customer profile was not found.',
  reply_not_found: 'That reply was not found.',
  booked_appointment_not_found: 'That booked meeting was not found.',
  qualification_requirements_not_met: 'This meeting does not yet meet the campaign qualification rules.',
  experiment_running_on_step: 'An experiment is running on that email step. Pause it before editing the copy.',
  id_required: 'A record id is required.',
  import_too_large: 'Import at most 200 prospects at a time.',
  mfa_required: 'Enter the 6-digit code from your authenticator app, or a recovery code.',
  invalid_mfa_code: 'That code was not accepted. Codes can be used once; wait for the next code and try again.',
  ai_url_required: 'Enter an AI base URL before enabling AI assist.',
  ai_empty_response: 'The AI provider answered but returned no text. This usually means the model needed a larger output budget, or the model name is wrong.',
  ai_output_budget_exhausted: 'The AI model used its whole token budget and the answer was cut off. This is a reasoning model such as Gemini or an o-series model, which spends part of the budget reasoning before it writes anything; it needs a larger max output setting.',
  ai_google_key_invalid: 'That does not look like a Google AI Studio key. Gemini keys start with AIza. Paste the key from Google AI Studio, not the project ID.',
  ai_openai_key_invalid: 'That does not look like an OpenAI key. OpenAI keys start with sk-. Paste the key from the OpenAI platform, not the organisation ID.',
  ai_unreachable: 'The AI provider could not be reached. Check the base URL and that the server can reach it.',
  ai_timeout: 'The AI provider did not answer in time. Try again, or use a faster model.',
  ai_invalid_response: 'The AI provider returned a response that could not be read. Check the base URL points at an OpenAI-compatible endpoint.',
  ai_response_too_large: 'The AI provider returned more data than the limit allows.',
  waiting_for_send_gate: 'This message is waiting on a send check (approval, send hours, mailbox sync, or sender health).',
  outside_send_window: 'Approved, but outside this campaign’s send hours in its timezone. It will send when the window opens.',
  awaiting_approval: 'This message is waiting for Approve send on the Automation page.',
  mailbox_sync_unhealthy: 'The Microsoft 365 mailbox sync for this sender is not healthy. Check Settings → Microsoft 365.',
  sender_health_not_ready: 'Sender health is missing, not HEALTHY, or older than 24 hours.',
  campaign_not_active: 'The campaign is not active.',
  campaign_paused: 'The campaign automation mode is paused.',
  tenant_automation_off: 'Tenant automation is off in Settings.',
  tenant_suspended: 'This tenant is suspended.',
  gateway_requires_https: 'The provider gateway URL must be HTTPS, or the internal http://gateway address.',
  integration_or_database_error: 'This automation run failed unexpectedly. It has been retried and stopped after three attempts. Check the worker logs for the technical detail, then use Run now to try again.',
  gateway_not_configured: 'No provider gateway URL is configured for this deployment. Set PROVIDER_GATEWAY_URL on the server, then run the campaign again.',
  gateway_credential_missing: 'This workspace has no provider gateway API key. Add one in Settings, then approve or re-run the message.',
  gateway_unreachable: 'The provider gateway could not be reached. Check that the gateway service is running and reachable from the app, then run the campaign again.',
  gateway_timeout: 'The provider gateway did not answer in time. It may be overloaded; the run will retry automatically.',
  gateway_invalid_response: 'The provider gateway replied with data LeadMelo could not read. Check the gateway logs and its version against docs/PROVIDER_GATEWAY.md.',
  gateway_http_422: 'The discovery gateway rejected the request parameters. Check the campaign ICP targeting and retry.',
  gateway_http_401: 'Authentication to the provider gateway failed. Please verify the gateway API key in Settings.',
  gateway_http_403: 'Access to the provider gateway was forbidden for this tenant.',
  gateway_http_502: 'The discovery provider gateway is unreachable or returned a bad gateway response. Check gateway service status and retry.',
  gateway_http_503: 'The discovery provider gateway is temporarily busy or unavailable. The run will retry automatically.',
  gateway_http_500: 'The discovery provider gateway encountered an internal server error. Please retry or check gateway service logs.',
  gateway_http_409: 'The provider gateway has no vendor key for this workspace. Save an Apollo and Hunter key under Provider credentials in Settings; the gateway reads them from its own tenants.json, so run discovery again once they are saved.',
  gateway_credentials_unsupported: 'This gateway build has no credential endpoint, so keys saved in Settings cannot reach it. Upgrade the gateway, or add the keys to its tenants file by hand.',
  provider_credential_missing: 'That provider credential is not saved for this workspace yet. Enter it and choose Save credentials first.',
  vendor_auth: 'The provider rejected this API key. Check the key in the vendor’s dashboard and save it again.',
  vendor_rate_limited: 'The provider is rate limiting this key. Wait a moment and test again.',
  vendor_quota_exhausted: 'This provider key is valid but the account has no credits left. Top up the account, then test again.',
  vendor_unreachable: 'The provider could not be reached from this server. Check outbound network access, then test again.',
  vendor_unavailable: 'The provider returned a temporary error. Wait a moment and test again.',
  vendor_error: 'The provider rejected the request. Check the key and try again.',
  apollo_probe_unsupported: 'Apollo no longer offers the auth endpoint this check used, so the key could not be verified. Save it anyway and confirm through discovery.',
  gateway_sync_failed: 'The credential was saved, but the gateway could not be updated. Discovery and verification will re-send it automatically next time.',
  mail_body_effectively_empty: 'This message was not sent because its body is empty. Add body text to the email step, then approve it again.',
  mail_body_template_empty: 'This message was not sent because its email step has no body text. Add body text to the step, then approve it again.',
  mail_subject_template_empty: 'This message was not sent because its email step has no subject text. Add a subject to the step, then approve it again.',
  mail_subject_blank: 'This message was not sent because its subject is empty. Add a subject to the email step, then approve it again.',
  message_changed_since_review: 'The message changed after you reviewed it. Refresh the queue, review the latest content, and approve again.',
  provider_exceeded_limit: 'The discovery provider returned more prospects than permitted by the cap.',
  lease_expired_after_max_attempts: 'The run timed out across maximum retry attempts. Check system health and trigger a new run.',
  max_attempts_exhausted: 'This run used all three attempts without completing. Fix the cause shown above, then use Run now to queue a fresh run.',
  send_lease_exhausted: 'Email sending timed out across maximum retry attempts.',
  m365_send_ambiguous: 'Microsoft 365 did not confirm whether this message was created, so it was not resubmitted. Check the sender mailbox, then queue the message again.',
  m365_send_recovered: 'A previous send attempt could not be confirmed and was safely retried.',
  send_attempts_exhausted: 'This message used all five send attempts without being accepted by the email provider. Check the reason shown, fix it, then queue the message again.',
  send_target_unavailable: 'This message was canceled because its campaign, contact or recipient is no longer available.',
  sequence_step_missing: 'This message was canceled because the email step it belonged to no longer exists in the campaign. Restore the step or queue a new message.',
  sequence_stopped: 'This message was canceled because the contact replied or the sequence was stopped.',
  suppressed_before_send: 'This message was canceled because the recipient unsubscribed or bounced before it could be sent.',
  daily_cap: 'Daily email cap reached for this campaign or tenant. Sending will resume in the next send window.',
  postal_address_missing: 'The business postal address is missing in Settings.',
  reverification_required: 'The contact’s email verification is missing or older than 7 days.'
};

const READY: Record<string, string> = {
  tenant_automation_enabled: 'tenant automation is off',
  provider_gateway: 'the provider gateway is not connected',
  postal_address: 'the business postal address is missing',
  operator_outbound_enabled: 'outbound sending is disabled by the operator',
  m365_sender_and_reply_sync: 'Microsoft 365 sender or reply sync is not healthy',
  active_icp: 'the ideal customer profile is missing or inactive',
  sequence: 'the email sequence is empty',
  fresh_sender_health: 'sender health has not been checked in the last day'
};

export function userError(code: unknown): string {
  const raw = String(code ?? '').trim();
  if (!raw) return 'Something went wrong. Please try again.';
  if (raw.includes(' ') && !raw.startsWith('campaign_not_ready:') && !raw.startsWith('ai_url_rejected:')) return raw;
  if (raw.startsWith('campaign_not_ready:')) {
    const parts = raw.slice('campaign_not_ready:'.length).split(',').map(s => s.trim()).filter(Boolean);
    const list = parts.map(p => READY[p] ?? p.replaceAll('_', ' ')).join('; ');
    return `This campaign is not ready to start: ${list}. Open Settings to fix these.`;
  }
  if (raw.startsWith('ai_url_rejected:')) return `That AI URL was rejected: ${raw.slice('ai_url_rejected:'.length).trim()}`;
  if (raw.startsWith('gateway_http_')) {
    const status = raw.slice('gateway_http_'.length);
    return MESSAGES[raw] ?? `Provider gateway returned HTTP ${status}. Please check gateway logs and retry.`;
  }
  // The provider refused the draft outright (bad request, auth, throttling, mailbox full).
  if (raw.startsWith('m365_draft_rejected_')) {
    const status = raw.slice('m365_draft_rejected_'.length);
    return `Microsoft 365 refused this email (HTTP ${status}), so nothing was sent. Check the sender mailbox permissions and the campaign sender address, then queue the message again.`;
  }
  // An AI provider error is a status from someone else's API. Without a curated sentence the
  // fallback turned "ai_provider_error_503" into "ai provider error 503", which reads like a
  // broken connection rather than what it is.
  if (raw.startsWith('ai_provider_error_')) {
    const status = raw.slice('ai_provider_error_'.length);
    if (status === '429') return 'The AI provider is rate limiting this key (HTTP 429). Wait a moment and try again; if it persists, check the quota or billing on the provider account.';
    if (status === '503' || status === '500' || status === '502') return 'The AI provider is temporarily unavailable (HTTP ' + status + '), usually high demand on their side. Wait a moment and try again; nothing was billed.';
    if (status === '401' || status === '403') return 'The AI provider rejected the API key (HTTP ' + status + '). Check the key is active and has access to the configured model.';
    if (status === '404') return 'The AI provider does not recognise that model (HTTP 404). Check the model name, for example gemini-flash-latest.';
    // Google answers a bad key with 400 "Please pass a valid API key" rather than 401, so this is
    // where a wrong Gemini key actually lands.
    if (status === '400') return 'The AI provider rejected the request as invalid (HTTP 400). With Gemini this usually means the API key was not accepted or is not enabled for the configured model; check the key in Google AI Studio.';
    return 'The AI provider returned HTTP ' + status + '. Check the provider dashboard for details.';
  }
  // Codes with a curated sentence always win over the underscore-stripped fallback.
  if (MESSAGES[raw]) return MESSAGES[raw];
  return MESSAGES[raw] ?? raw.replaceAll('_', ' ');
}
