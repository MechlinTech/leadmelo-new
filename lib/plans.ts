// Single source of truth for plans. The pricing page, the assistant and the server-side entitlement
// checks all read this file, so what is advertised is what is enforced (when PLAN_ENFORCEMENT=on).
// PRICES ARE PLACEHOLDERS chosen by the builder: change them here before publishing.
export type PlanId = 'FREE' | 'STARTER' | 'GROWTH' | 'SCALE' | 'ENTERPRISE';
export type Limits = { activeCampaigns: number; seats: number; monthlyEmails: number; monthlyProspects: number; senders: number; experiments: number }; // -1 = unlimited
export type PlanDef = { id: PlanId; name: string; tagline: string; monthlyUsd: number | null; annualUsd: number | null; limits: Limits; features: string[]; cta: string };

export const TRIAL_DAYS = 14;
export const MOST_POPULAR: PlanId = 'GROWTH';
export const UNLIMITED = -1;
export function monthStart(now = new Date()) { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); }

export const PLANS: Record<PlanId, PlanDef> = {
  FREE: {
    id: 'FREE', name: 'Trial', tagline: `Try the full workflow for ${TRIAL_DAYS} days`, monthlyUsd: 0, annualUsd: 0,
    limits: { activeCampaigns: 1, seats: 2, monthlyEmails: 200, monthlyProspects: 100, senders: 1, experiments: 0 },
    features: ['1 active campaign', '200 emails and 100 prospects a month', 'Approve-before-send mode', 'Meetings workspace'], cta: 'Start free trial'
  },
  STARTER: {
    id: 'STARTER', name: 'Starter', tagline: 'One team, a first repeatable outbound motion', monthlyUsd: 149, annualUsd: 1490,
    limits: { activeCampaigns: 2, seats: 3, monthlyEmails: 2000, monthlyProspects: 500, senders: 2, experiments: 1 },
    features: ['2 active campaigns', '2,000 emails and 500 prospects a month', '3 seats, 2 sender mailboxes', '1 copy experiment at a time', 'Campaign versioning and rollback'], cta: 'Start free trial'
  },
  GROWTH: {
    id: 'GROWTH', name: 'Growth', tagline: 'Several offers and markets running side by side', monthlyUsd: 399, annualUsd: 3990,
    limits: { activeCampaigns: 5, seats: 8, monthlyEmails: 10000, monthlyProspects: 2500, senders: 5, experiments: 5 },
    features: ['5 active campaigns', '10,000 emails and 2,500 prospects a month', '8 seats, 5 sender mailboxes', '5 concurrent copy experiments', 'Digest, alerts and external monitoring hooks'], cta: 'Start free trial'
  },
  SCALE: {
    id: 'SCALE', name: 'Scale', tagline: 'Agencies and multi-team outbound', monthlyUsd: 999, annualUsd: 9990,
    limits: { activeCampaigns: 15, seats: 25, monthlyEmails: 40000, monthlyProspects: 10000, senders: 15, experiments: UNLIMITED },
    features: ['15 active campaigns', '40,000 emails and 10,000 prospects a month', '25 seats, 15 sender mailboxes', 'Unlimited copy experiments', 'Priority onboarding'], cta: 'Start free trial'
  },
  ENTERPRISE: {
    id: 'ENTERPRISE', name: 'Enterprise', tagline: 'Custom volume, security review and support', monthlyUsd: null, annualUsd: null,
    limits: { activeCampaigns: UNLIMITED, seats: UNLIMITED, monthlyEmails: UNLIMITED, monthlyProspects: UNLIMITED, senders: UNLIMITED, experiments: UNLIMITED },
    features: ['Custom limits and contract', 'Security questionnaire and DPA support', 'Dedicated onboarding', 'Custom integrations'], cta: 'Talk to us'
  }
};
export const PUBLIC_PLAN_ORDER: PlanId[] = ['FREE', 'STARTER', 'GROWTH', 'SCALE', 'ENTERPRISE'];

export const annualMonthlyEquivalent = (p: PlanDef) => (p.annualUsd === null ? null : Math.round(p.annualUsd / 12));
export const annualSavingsPercent = (p: PlanDef) => (p.monthlyUsd && p.annualUsd ? Math.round((1 - p.annualUsd / (p.monthlyUsd * 12)) * 100) : 0);
export const formatLimit = (n: number) => (n === UNLIMITED ? 'Unlimited' : n.toLocaleString('en-US'));
export const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

export const LIMIT_LABELS: Record<keyof Limits, string> = {
  activeCampaigns: 'Active campaigns', seats: 'Team seats', monthlyEmails: 'Emails per month', monthlyProspects: 'Prospects discovered per month', senders: 'Sender mailboxes', experiments: 'Concurrent copy experiments'
};
