import type { ICP, Campaign } from '@prisma/client';
import type { Prospect } from './providers';

const has = (values: string[], value: string) => values.some(v => v.trim().toLowerCase() === value.trim().toLowerCase());
export function qualifyProspect(icp: Pick<ICP, 'industries' | 'companySizes' | 'geographies' | 'buyerTitles' | 'buyingSignals' | 'technologies' | 'exclusionRules' | 'minScore'>, p: Prospect, now = new Date()) {
  const hasBuyer = has(icp.buyerTitles, p.title);
  const hasPainSignal = p.signals.some(v => has(icp.buyingSignals, v));
  const excluded = icp.exclusionRules.some(v => [p.domain, p.company, p.industry].some(x => x.toLowerCase() === v.toLowerCase()));
  const verifiedAge = now.getTime() - Date.parse(p.verifiedAt);
  const eligible = !excluded && p.verification === 'VALID' && verifiedAge >= 0 && verifiedAge <= 7 * 86400000 && hasBuyer && hasPainSignal && has(icp.industries, p.industry) && has(icp.companySizes, p.companySize) && has(icp.geographies, p.geography);
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

export function withinSendWindow(c: Pick<Campaign, 'timezone' | 'businessDaysOnly' | 'sendStartHour' | 'sendEndHour'> & { holidays?: string[] }, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: c.timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const day = parts.find(p => p.type === 'weekday')?.value;
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  // Holidays block sending even for campaigns that also send on weekends.
  return (!c.businessDaysOnly || !['Sat', 'Sun'].includes(day ?? '')) && !isHoliday(now, c.timezone, c.holidays) && hour >= c.sendStartHour && hour < c.sendEndHour;
}
export function addBusinessDays(from: Date, days: number, timeZone: string, holidays: string[] = []) {
  const date = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
    if (!['Sat', 'Sun'].includes(weekday) && !isHoliday(date, timeZone, holidays)) remaining--;
  }
  return date;
}
export function renderTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error('unknown_template_variable');
    return vars[name];
  });
}
