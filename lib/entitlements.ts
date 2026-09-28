import { Prisma } from '@prisma/client';
import { db } from './db';
import { HttpError } from './http';
import { PLANS, TRIAL_DAYS, UNLIMITED, monthStart, type Limits, type PlanId } from './plans';

type Client = Prisma.TransactionClient | typeof db;

// Plan limits are enforced only when PLAN_ENFORCEMENT=on. Self-hosted single-operator installs and the
// pilot leave it off, so nothing is gated by billing there. With it on, limits come from lib/plans.ts.
export const enforcementOn = () => process.env.PLAN_ENFORCEMENT === 'on';
const OPEN: Limits = { activeCampaigns: UNLIMITED, seats: UNLIMITED, monthlyEmails: UNLIMITED, monthlyProspects: UNLIMITED, senders: UNLIMITED, experiments: UNLIMITED };
const over = (used: number, limit: number) => limit !== UNLIMITED && used >= limit;

export async function planState(tenantId: string, client: Client = db, now = new Date()) {
  const t = await client.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { plan: true, createdAt: true } });
  const plan = t.plan as PlanId;
  const trialEnds = plan === 'FREE' ? new Date(t.createdAt.getTime() + TRIAL_DAYS * 86400000) : null;
  const trialExpired = trialEnds !== null && now > trialEnds;
  return { plan, enforced: enforcementOn(), limits: enforcementOn() ? PLANS[plan].limits : OPEN, planLimits: PLANS[plan].limits, trialEnds, trialExpired: enforcementOn() && trialExpired, trialDaysLeft: trialEnds ? Math.max(0, Math.ceil((trialEnds.getTime() - now.getTime()) / 86400000)) : null };
}

export async function usageNow(tenantId: string, client: Client = db, now = new Date()) {
  const since = monthStart(now);
  const [activeCampaigns, senders, users, invites, experiments, emails, prospects] = await Promise.all([
    client.campaign.count({ where: { tenantId, status: 'ACTIVE' } }),
    client.campaign.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { senderEmail: true }, distinct: ['senderEmail'] }),
    client.user.count({ where: { tenantId, disabled: false } }),
    client.invite.count({ where: { tenantId, acceptedAt: null, expiresAt: { gt: now } } }),
    client.experiment.count({ where: { tenantId, status: { in: ['DRAFT', 'RUNNING'] } } }),
    client.usageLedger.aggregate({ where: { tenantId, kind: 'EMAIL_SENT', createdAt: { gte: since } }, _sum: { quantity: true } }),
    client.usageLedger.aggregate({ where: { tenantId, kind: 'DISCOVERY_PROSPECT', createdAt: { gte: since } }, _sum: { quantity: true } })
  ]);
  return { activeCampaigns, senders: senders.length, seats: users + invites, experiments, monthlyEmails: emails._sum.quantity ?? 0, monthlyProspects: prospects._sum.quantity ?? 0 };
}

const planError = (code: string) => new HttpError(402, code);

export async function assertCanActivateCampaign(tenantId: string, campaignId: string, client: Client = db) {
  const s = await planState(tenantId, client);
  if (!s.enforced) return;
  if (s.trialExpired) throw planError('plan_trial_expired');
  const campaign = await client.campaign.findFirst({ where: { id: campaignId, tenantId }, select: { senderEmail: true, status: true } });
  if (campaign?.status === 'ACTIVE') return; // already counted
  const active = await client.campaign.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { senderEmail: true } });
  if (over(active.length, s.limits.activeCampaigns)) throw planError('plan_limit:activeCampaigns');
  const senders = new Set(active.map(c => c.senderEmail));
  if (campaign && !senders.has(campaign.senderEmail) && over(senders.size, s.limits.senders)) throw planError('plan_limit:senders');
}
export async function assertCanAddSeat(tenantId: string, client: Client = db) {
  const s = await planState(tenantId, client);
  if (!s.enforced) return;
  if (s.trialExpired) throw planError('plan_trial_expired');
  if (over((await usageNow(tenantId, client)).seats, s.limits.seats)) throw planError('plan_limit:seats');
}
export async function assertCanCreateExperiment(tenantId: string, client: Client = db) {
  const s = await planState(tenantId, client);
  if (!s.enforced) return;
  if (s.limits.experiments === 0 || over((await usageNow(tenantId, client)).experiments, s.limits.experiments)) throw planError('plan_limit:experiments');
}
// Sequence emails only. A booking invitation answers a buyer who already replied, so it is never plan-blocked.
export async function sendAllowance(client: Client, tenantId: string, now = new Date()): Promise<{ allowed: boolean; reason?: string }> {
  const s = await planState(tenantId, client, now);
  if (!s.enforced) return { allowed: true };
  if (s.trialExpired) return { allowed: false, reason: 'plan_trial_expired' };
  if (over((await usageNow(tenantId, client, now)).monthlyEmails, s.limits.monthlyEmails)) return { allowed: false, reason: 'plan_limit:monthlyEmails' };
  return { allowed: true };
}
// How many more prospects may be bought this month (Infinity when unlimited or not enforced).
export async function prospectAllowance(client: Client, tenantId: string, now = new Date()): Promise<{ remaining: number; reason?: 'plan_limit' | 'plan_trial_expired' }> {
  const s = await planState(tenantId, client, now);
  if (!s.enforced) return { remaining: Infinity };
  if (s.trialExpired) return { remaining: 0, reason: 'plan_trial_expired' };
  if (s.limits.monthlyProspects === UNLIMITED) return { remaining: Infinity };
  const used = (await usageNow(tenantId, client, now)).monthlyProspects;
  return { remaining: Math.max(0, s.limits.monthlyProspects - used), reason: 'plan_limit' };
}
