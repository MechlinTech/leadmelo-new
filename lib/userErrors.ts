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
  gateway_http_409: 'The provider gateway is not configured for this tenant: it has no vendor (Apollo/Hunter) key or dummy-discovery setting. Add the key in gateway/tenants.json, or enable dummy discovery for testing, then run the campaign again.',
  mail_body_effectively_empty: 'This message was not sent because its body is empty. Add body text to the email step, then approve it again.',
  mail_body_template_empty: 'This message was not sent because its email step has no body text. Add body text to the step, then approve it again.',
  mail_subject_template_empty: 'This message was not sent because its email step has no subject text. Add a subject to the step, then approve it again.',
  mail_subject_blank: 'This message was not sent because its subject is empty. Add a subject to the email step, then approve it again.',
  provider_exceeded_limit: 'The discovery provider returned more prospects than permitted by the cap.',
  lease_expired_after_max_attempts: 'The run timed out across maximum retry attempts. Check system health and trigger a new run.',
  max_attempts_exhausted: 'This run used all three attempts without completing. Fix the cause shown above, then use Run now to queue a fresh run.',
  send_lease_exhausted: 'Email sending timed out across maximum retry attempts.',
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
  // Codes with a curated sentence always win over the underscore-stripped fallback.
  if (MESSAGES[raw]) return MESSAGES[raw];
  return MESSAGES[raw] ?? raw.replaceAll('_', ' ');
}
