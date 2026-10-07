import type { ICP, Campaign } from '@prisma/client';
import type { Prospect } from './providers';
import { renderTemplate } from './template';
export { renderTemplate } from './template';

const has = (values: string[], value: string) => values.some(v => v.trim().toLowerCase() === value.trim().toLowerCase());
// The gateway stamps verifiedAt on its own clock while the run clock was taken earlier.
// A few minutes ahead is clock skew, not a forged future verification.
const VERIFICATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
export function qualifyProspect(icp: Pick<ICP, 'industries' | 'companySizes' | 'geographies' | 'buyerTitles' | 'buyingSignals' | 'technologies' | 'exclusionRules' | 'minScore'>, p: Prospect, now = new Date()) {
  const hasBuyer = has(icp.buyerTitles, p.title);
  const hasPainSignal = p.signals.some(v => has(icp.buyingSignals, v));
  const excluded = icp.exclusionRules.some(v => [p.domain, p.company, p.industry].some(x => x.toLowerCase() === v.toLowerCase()));
  const verifiedAt = Date.parse(p.verifiedAt);
  const verifiedAge = now.getTime() - verifiedAt;
  const fresh = Number.isFinite(verifiedAt) && verifiedAge >= -VERIFICATION_FUTURE_SKEW_MS && verifiedAge <= 7 * 86400000;
  const eligible = !excluded && p.verification === 'VALID' && fresh && hasBuyer && hasPainSignal && has(icp.industries, p.industry) && has(icp.companySizes, p.companySize) && has(icp.geographies, p.geography);
  const score = eligible ? 90 + (p.technologies.some(v => has(icp.technologies, v)) ? 10 : 0) : 0;
  return { eligible: eligible && score >= icp.minScore, score, hasBuyer, hasPainSignal };
}

// The calendar date (YYYY-MM-DD) in the campaign's time zone; holidays are matched against it.
export function localDate(date: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t: string) => p.find(x => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export const isHoliday = (date: Date, timeZone: string, holidays: string[] = []) => holidays.includes(localDate(date, timeZone));

function localDateTime(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function fromLocalDateTime(parts: ReturnType<typeof localDateTime>, timeZone: string, millisecond: number) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, millisecond);
  let timestamp = desired;
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = localDateTime(new Date(timestamp), timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, millisecond);
    const correction = desired - represented;
    if (!correction) return new Date(timestamp);
    timestamp += correction;
  }
  return new Date(timestamp);
}

// Specific wait codes replace the opaque waiting_for_send_gate so the Automation
// queue shows which check is holding an approved message.
export function outreachWaitReason(input: {
  campaign: { status: string; automationMode: string; timezone: string; businessDaysOnly: boolean; sendStartHour: number; sendEndHour: number; holidays?: string[] };
  settings: { automationEnabled: boolean; suspended: boolean; gatewayKey: string | null; postalAddress: string | null } | null;
  health: { status: string; lastCheckedAt: Date | null } | null;
  approvedAt: Date | null;
  mailboxBlocked: boolean;
  stale: boolean;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const { campaign: c, settings: s, health } = input;
  if (input.stale) return 'reverification_required';
  if (c.automationMode === 'REVIEW_BEFORE_SEND' && !input.approvedAt) return 'awaiting_approval';
  if (!withinSendWindow(c, now)) return 'outside_send_window';
  if (input.mailboxBlocked) return 'mailbox_sync_unhealthy';
  if (c.status !== 'ACTIVE') return 'campaign_not_active';
  if (c.automationMode === 'PAUSED') return 'campaign_paused';
  if (!s?.automationEnabled) return 'tenant_automation_off';
  if (s.suspended) return 'tenant_suspended';
  if (!s.gatewayKey) return 'gateway_credential_missing';
  if (!s.postalAddress) return 'postal_address_missing';
  if (!health || health.status !== 'HEALTHY' || !health.lastCheckedAt || now.getTime() - health.lastCheckedAt.getTime() > 86400000) return 'sender_health_not_ready';
  return null;
}

export function withinSendWindow(c: Pick<Campaign, 'timezone' | 'businessDaysOnly' | 'sendStartHour' | 'sendEndHour'> & { holidays?: string[] }, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: c.timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const day = parts.find(p => p.type === 'weekday')?.value;
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  // Holidays block sending even for campaigns that also send on weekends.
  return (!c.businessDaysOnly || !['Sat', 'Sun'].includes(day ?? '')) && !isHoliday(now, c.timezone, c.holidays) && hour >= c.sendStartHour && hour < c.sendEndHour;
}
// TEMP_QA_FOLLOWUP_MINUTES shortens follow-up/reminder steps to a fixed number of minutes so a
// sequence can be verified end to end without waiting days. It is a TEST-ONLY override:
// production timing always comes from the step's waitBusinessDays. Invalid, negative or blank
// values are ignored rather than silently disabling the override with a zero delay.
export function qaFollowUpDelayMinutes(env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.TEMP_QA_FOLLOWUP_MINUTES ?? '').trim();
  if (!raw) return null;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

// When the next follow-up is due. `from` must be the real event timestamp: the SENT time of the
// previous email, never its creation or approval time, otherwise the countdown is wrong.
export function followUpDueAt(input: { from: Date; waitBusinessDays: number; timezone: string; holidays?: string[]; qaMinutes?: number | null }) {
  if (input.qaMinutes !== null && input.qaMinutes !== undefined) return new Date(input.from.getTime() + input.qaMinutes * 60_000);
  return addBusinessDays(input.from, input.waitBusinessDays, input.timezone, input.holidays);
}

export function addBusinessDays(from: Date, days: number, timeZone: string, holidays: string[] = []) {
  if (days <= 0) return new Date(from);
  const time = localDateTime(from, timeZone);
  const date = new Date(Date.UTC(time.year, time.month - 1, time.day));
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    if (weekday !== 0 && weekday !== 6 && !holidays.includes(dateKey)) remaining--;
  }
  return fromLocalDateTime({ ...time, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }, timeZone, from.getUTCMilliseconds());
}
