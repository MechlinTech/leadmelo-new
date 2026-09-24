import { db } from './db';
import { type AutomationRule, type WorkspaceConfig, alertCodeEnabled } from './workspaceConfig';

export async function applyRulesForAlert(tenantId: string, code: string, config: WorkspaceConfig) {
  const matches = config.rules.filter(r => r.enabled && r.when === code);
  for (const rule of matches) {
    if (rule.action === 'pause_active_campaigns') {
      await db.campaign.updateMany({ where: { tenantId, status: 'ACTIVE' }, data: { status: 'PAUSED', nextRunAt: new Date() } });
      await db.auditEvent.create({ data: { tenantId, action: 'automation_rule_paused_campaigns', metadata: { ruleId: rule.id, code } } });
    }
  }
}

export function shouldRaise(code: string, config: WorkspaceConfig, rules: AutomationRule[] = config.rules) {
  if (!alertCodeEnabled(config, code)) return false;
  const blockers = rules.filter(r => r.when === code && r.action === 'raise_alert');
  if (!blockers.length) return true;
  return blockers.some(r => r.enabled);
}
