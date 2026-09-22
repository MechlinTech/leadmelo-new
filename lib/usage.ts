import { db } from './db';
import { monthStart } from './plans';
import { prospectAllowance } from './entitlements';

export { monthStart };

// Reserve provider spend BEFORE any purchase. Runs under the tenant row lock so two
// workers cannot both spend the last of the cap. A retry of the same key reuses the
// original reservation (the provider call is idempotent on that key, so no repurchase).
export async function reserveProviderSpend(tenantId: string, campaignId: string, key: string, requested: number, now = new Date()): Promise<{ quantity: number; reason: 'ok' | 'spend_cap' | 'tenant_suspended' | 'plan_limit' | 'plan_trial_expired' }> {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tenantId} FOR UPDATE`;
    const s = await tx.tenantSetting.findUniqueOrThrow({ where: { tenantId } });
    if (s.suspended) return { quantity: 0, reason: 'tenant_suspended' as const };
    const existing = await tx.usageLedger.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
    if (existing) return { quantity: Math.min(requested, existing.quantity), reason: 'ok' as const };
    let quantity = requested;
    if (s.monthlySpendCapCents !== null && s.providerCostCents > 0) {
      const spent = (await tx.usageLedger.aggregate({ where: { tenantId, createdAt: { gte: monthStart(now) } }, _sum: { costCents: true } }))._sum.costCents ?? 0;
      quantity = Math.max(0, Math.min(requested, Math.floor((s.monthlySpendCapCents - spent) / s.providerCostCents)));
    }
    // The plan's monthly prospect allowance is a second, independent ceiling.
    const plan = await prospectAllowance(tx, tenantId, now);
    let planLimited = false;
    if (quantity > plan.remaining) { quantity = plan.remaining; planLimited = true; }
    if (quantity > 0) await tx.usageLedger.create({ data: { tenantId, campaignId, kind: 'DISCOVERY_PROSPECT', quantity, costCents: quantity * s.providerCostCents, idempotencyKey: key } });
    return { quantity, reason: quantity < requested ? (planLimited ? plan.reason! : 'spend_cap' as const) : 'ok' as const };
  });
}

// After the provider answers, reduce the reservation to what was actually delivered.
export async function settleProviderSpend(tenantId: string, key: string, delivered: number) {
  const s = await db.tenantSetting.findUniqueOrThrow({ where: { tenantId } });
  await db.usageLedger.updateMany({ where: { tenantId, idempotencyKey: key, quantity: { gt: delivered } }, data: { quantity: delivered, costCents: delivered * s.providerCostCents } });
}

export async function usageSummary(tenantId: string, now = new Date()) {
  const rows = await db.usageLedger.groupBy({ by: ['kind'], where: { tenantId, createdAt: { gte: monthStart(now) } }, _sum: { quantity: true, costCents: true } });
  const s = await db.tenantSetting.findUnique({ where: { tenantId } });
  const spent = rows.reduce((n, r) => n + (r._sum.costCents ?? 0), 0);
  return { periodStart: monthStart(now).toISOString(), byKind: rows.map(r => ({ kind: r.kind, quantity: r._sum.quantity ?? 0, costCents: r._sum.costCents ?? 0 })), spentCents: spent, monthlySpendCapCents: s?.monthlySpendCapCents ?? null, remainingCents: s?.monthlySpendCapCents == null ? null : Math.max(0, s.monthlySpendCapCents - spent), suspended: s?.suspended ?? false };
}
