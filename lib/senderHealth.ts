import { promises as dns } from 'node:dns';
import type { Prisma } from '@prisma/client';
import { db } from './db';

// Sender health computed from LeadMelo's own data plus DNS, so sending does not depend on an external feed.
// A signed external `sender.health` event, when present and fresh, always wins (see healthSource).
// LIMITS: only bounces/complaints LeadMelo can see are counted (Microsoft bounce notices found in the Inbox, and
// signed bounce/complaint events). Complaints from feedback loops it does not receive are invisible to it.
export const SENDER_HEALTH_AUTO = () => (process.env.SENDER_HEALTH_AUTO ?? 'on') !== 'off';
export type AuthStatus = 'pass' | 'fail' | 'unknown';
export type Resolver = { txt(name: string): Promise<string[][]>; cname(name: string): Promise<string[]> };
export const systemResolver: Resolver = { txt: name => dns.resolveTxt(name), cname: name => dns.resolveCname(name) };
let resolver: Resolver = systemResolver;
export function setResolverForTests(r: Resolver | null) { resolver = r ?? systemResolver; }

const MISSING = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']); // a definite "no such record"
const joined = (records: string[][]) => records.map(r => r.join(''));
async function lookup<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; missing: boolean }> {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, missing: MISSING.has((e as NodeJS.ErrnoException).code ?? '') }; }
}
// DKIM selectors are chosen by the sender, so absence cannot be proven: this can only return pass or unknown.
const DKIM_SELECTORS = ['selector1', 'selector2', 'google', 'default', 's1', 's2', 'k1', 'mail'];

export async function checkDomainAuth(domain: string, r: Resolver = resolver) {
  const detail: Record<string, unknown> = {};
  const spfRes = await lookup(() => r.txt(domain));
  let spf: AuthStatus = 'unknown';
  if (spfRes.ok) { const rec = joined(spfRes.value).find(t => /^v=spf1(\s|$)/i.test(t)); spf = rec ? 'pass' : 'fail'; detail.spf = rec ?? 'no v=spf1 record'; } else if (spfRes.missing) { spf = 'fail'; detail.spf = 'no TXT records'; }
  const dmarcRes = await lookup(() => r.txt(`_dmarc.${domain}`));
  let dmarc: AuthStatus = 'unknown';
  if (dmarcRes.ok) { const rec = joined(dmarcRes.value).find(t => /^v=DMARC1\s*;/i.test(t)); dmarc = rec ? 'pass' : 'fail'; detail.dmarc = rec ?? 'no v=DMARC1 record'; if (rec) detail.dmarcPolicy = /;\s*p=(\w+)/i.exec(rec)?.[1]?.toLowerCase() ?? 'unknown'; } else if (dmarcRes.missing) { dmarc = 'fail'; detail.dmarc = 'no _dmarc record'; }
  let dkim: AuthStatus = 'unknown';
  for (const s of DKIM_SELECTORS) {
    const name = `${s}._domainkey.${domain}`;
    const t = await lookup(() => r.txt(name));
    if (t.ok && joined(t.value).some(x => /v=DKIM1|k=rsa|p=/i.test(x))) { dkim = 'pass'; detail.dkimSelector = s; break; }
    const c = await lookup(() => r.cname(name));
    if (c.ok && c.value.length) { dkim = 'pass'; detail.dkimSelector = s; break; }
  }
  return { spf, dkim, dmarc, detail };
}

// New senders start small and grow. Age counts from the first email this sender actually sent.
export const RAMP: Array<[days: number, cap: number]> = [[0, 10], [3, 20], [7, 30], [14, 50], [28, 100], [42, 150], [60, 250]];
export function rampCap(ageDays: number) { let cap = RAMP[0][1]; for (const [d, c] of RAMP) if (ageDays >= d) cap = c; return cap; }

export type HealthInput = { sent: number; bounces: number; complaints: number; ageDays: number; auth: { spf: AuthStatus; dmarc: AuthStatus } };
// Pure decision function (unit-tested). Only HEALTHY allows sending.
export function decideHealth(i: HealthInput): { status: 'HEALTHY' | 'WATCHLIST' | 'BLOCKED'; dailyCap: number; bounceRate: number; complaintRate: number; reasons: string[] } {
  const bounceRate = i.sent ? i.bounces / i.sent : 0, complaintRate = i.sent ? i.complaints / i.sent : 0, reasons: string[] = [];
  let cap = rampCap(i.ageDays);
  // Complaints are the most serious signal: with a small sample even one blocks.
  if (i.complaints >= 1 && (i.sent < 1000 || complaintRate >= 0.001)) return { status: 'BLOCKED', dailyCap: 0, bounceRate, complaintRate, reasons: ['complaint_threshold'] };
  if (i.sent >= 20 && bounceRate >= 0.05) return { status: 'BLOCKED', dailyCap: 0, bounceRate, complaintRate, reasons: ['bounce_rate_at_least_5_percent'] };
  if (i.sent < 20 && i.bounces >= 3) return { status: 'BLOCKED', dailyCap: 0, bounceRate, complaintRate, reasons: ['bounces_on_small_sample'] };
  if (i.auth.spf === 'fail') reasons.push('spf_missing');
  if (i.auth.dmarc === 'fail') reasons.push('dmarc_missing');
  if (reasons.length) return { status: 'WATCHLIST', dailyCap: 0, bounceRate, complaintRate, reasons };
  if (i.sent >= 20 && bounceRate >= 0.02) { cap = Math.max(5, Math.floor(cap / 2)); reasons.push('elevated_bounce_rate_cap_halved'); }
  return { status: 'HEALTHY', dailyCap: Math.min(250, cap), bounceRate, complaintRate, reasons };
}

const DAY = 86400000;
export async function measureSender(tenantId: string, senderEmail: string, now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const events = await db.outreachEvent.findMany({ where: { tenantId, status: 'SENT', sentAt: { not: null }, campaign: { senderEmail } }, select: { sentAt: true, contact: { select: { email: true } } }, orderBy: { sentAt: 'asc' }, take: 20000 });
  const recent = events.filter(e => e.sentAt! >= since);
  const emails = [...new Set(recent.map(e => e.contact?.email).filter((x): x is string => !!x))];
  const [bounces, complaints] = emails.length
    ? await Promise.all([db.suppression.count({ where: { tenantId, email: { in: emails }, reason: 'bounce' } }), db.suppression.count({ where: { tenantId, email: { in: emails }, reason: 'complaint' } })])
    : [0, 0];
  const first = events[0]?.sentAt ?? null;
  return { sent: recent.length, bounces, complaints, ageDays: first ? Math.floor((now.getTime() - first.getTime()) / DAY) : 0, firstSendAt: first };
}

// Recomputes one sender. An external signed health event newer than 36 hours is authoritative and is left alone.
export async function refreshSenderHealth(tenantId: string, senderEmail: string, now = new Date(), opts: { force?: boolean; authMaxAgeMs?: number } = {}) {
  const profile = await db.deliverabilityProfile.findUnique({ where: { tenantId_senderEmail: { tenantId, senderEmail } } });
  if (profile?.healthSource === 'external' && profile.lastCheckedAt && now.getTime() - profile.lastCheckedAt.getTime() < 36 * 3600000) return { skipped: 'external_feed_fresh' as const };
  if (!opts.force && profile?.healthSource === 'internal' && profile.lastCheckedAt && now.getTime() - profile.lastCheckedAt.getTime() < 55 * 60000) return { skipped: 'recent' as const };
  const domain = senderEmail.split('@')[1];
  const authFresh = profile?.authCheckedAt && now.getTime() - profile.authCheckedAt.getTime() < (opts.authMaxAgeMs ?? 6 * 3600000);
  const auth = authFresh ? { spf: (profile!.spfStatus ?? 'unknown') as AuthStatus, dkim: (profile!.dkimStatus ?? 'unknown') as AuthStatus, dmarc: (profile!.dmarcStatus ?? 'unknown') as AuthStatus, detail: (profile!.detail as Record<string, unknown> | null)?.auth as Record<string, unknown> ?? {} } : await checkDomainAuth(domain);
  const m = await measureSender(tenantId, senderEmail, now);
  const d = decideHealth({ sent: m.sent, bounces: m.bounces, complaints: m.complaints, ageDays: m.ageDays, auth });
  const data = { domain, status: d.status, dailyCap: d.dailyCap, bounceRate: d.bounceRate, complaintRate: d.complaintRate, lastCheckedAt: now, healthSource: 'internal', spfStatus: auth.spf, dkimStatus: auth.dkim, dmarcStatus: auth.dmarc, authCheckedAt: authFresh ? profile!.authCheckedAt : now, detail: { reasons: d.reasons, sent30d: m.sent, bounces30d: m.bounces, complaints30d: m.complaints, senderAgeDays: m.ageDays, auth: auth.detail } as Prisma.InputJsonObject };
  await db.deliverabilityProfile.upsert({ where: { tenantId_senderEmail: { tenantId, senderEmail } }, update: data, create: { ...data, tenantId, senderEmail } });
  return { status: d.status, dailyCap: d.dailyCap, reasons: d.reasons };
}

// Worker entry: every sender used by an active campaign.
export async function runSenderHealth(now = new Date()) {
  if (!SENDER_HEALTH_AUTO()) return 0;
  const active = await db.campaign.findMany({ where: { status: 'ACTIVE', automationMode: { not: 'PAUSED' } }, select: { tenantId: true, senderEmail: true }, distinct: ['tenantId', 'senderEmail'], take: 500 });
  let n = 0;
  for (const s of active) { try { const r = await refreshSenderHealth(s.tenantId, s.senderEmail, now); if (!('skipped' in r)) n++; } catch { /* one bad sender must not stop the others */ } }
  return n;
}
