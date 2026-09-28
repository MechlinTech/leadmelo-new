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
  ai_url_required: 'Enter an AI base URL before enabling AI assist.'
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
  return MESSAGES[raw] ?? raw.replaceAll('_', ' ');
}
