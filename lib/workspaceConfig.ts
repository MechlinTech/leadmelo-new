import { z } from 'zod';
import { db } from './db';

export const ALERT_CODES = [
  'sender_health_missing', 'sender_degraded', 'sender_health_stale', 'reply_sync_stale', 'send_stuck',
  'discovery_failed', 'outreach_failed', 'verification_exhausted', 'm365_send_needs_reconciliation',
  'booking_failure', 'bounced_email', 'missed_webhook', 'test_exception', 'calendly_reconcile_failed',
  'bounce_notice_unattributed', 'mail_sync_failed', 'test_failure', 'reply_review'
] as const;

export const RULE_WHEN = ['bounced_email', 'booking_failure', 'missed_webhook', 'discovery_failed', 'outreach_failed', 'positive_reply', 'negative_reply'] as const;
export const RULE_ACTION = ['raise_alert', 'pause_active_campaigns'] as const;

export type AutomationRule = {
  id: string;
  name: string;
  enabled: boolean;
  system?: boolean;
  when: (typeof RULE_WHEN)[number];
  action: (typeof RULE_ACTION)[number];
};

export type WorkspaceConfig = {
  v: 1;
  alerts: { inApp: boolean; recipients: string[]; webhookUrl: string | null; codes: Record<string, boolean> };
  rules: AutomationRule[];
};

export const SYSTEM_RULES: AutomationRule[] = [
  { id: 'sys_bounce_alert', name: 'Alert when a send bounces', enabled: true, system: true, when: 'bounced_email', action: 'raise_alert' },
  { id: 'sys_booking_alert', name: 'Alert when booking fails', enabled: true, system: true, when: 'booking_failure', action: 'raise_alert' },
  { id: 'sys_webhook_alert', name: 'Alert when a calendar webhook is missed', enabled: true, system: true, when: 'missed_webhook', action: 'raise_alert' },
  { id: 'sys_discovery_alert', name: 'Alert when discovery fails', enabled: true, system: true, when: 'discovery_failed', action: 'raise_alert' },
  { id: 'sys_outreach_alert', name: 'Alert when a queued send fails', enabled: true, system: true, when: 'outreach_failed', action: 'raise_alert' }
];

const email = z.string().trim().email().max(200);
const httpsUrl = z.string().url().max(400).refine(u => new URL(u).protocol === 'https:', 'Use an https URL');
const ruleInput = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(2).max(120),
  enabled: z.boolean(),
  system: z.boolean().optional(),
  when: z.enum(RULE_WHEN),
  action: z.enum(RULE_ACTION)
}).strict();

export const workspaceConfigInput = z.object({
  alerts: z.object({
    inApp: z.boolean(),
    recipients: z.array(email).max(20),
    webhookUrl: httpsUrl.nullable(),
    codes: z.record(z.boolean())
  }).strict(),
  rules: z.array(ruleInput).max(40)
}).strict();

export function defaultConfig(): WorkspaceConfig {
  return {
    v: 1,
    alerts: { inApp: true, recipients: [], webhookUrl: null, codes: Object.fromEntries(ALERT_CODES.map(c => [c, true])) },
    rules: SYSTEM_RULES.map(r => ({ ...r }))
  };
}

export function mergeConfig(raw: unknown): WorkspaceConfig {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<WorkspaceConfig>;
  const codes = { ...base.alerts.codes, ...(value.alerts?.codes ?? {}) };
  const incoming = Array.isArray(value.rules) ? value.rules : [];
  const custom = incoming.filter(r => r && !r.system && r.id && !r.id.startsWith('sys_'));
  const system = SYSTEM_RULES.map(sys => incoming.find(r => r.id === sys.id) ? { ...sys, enabled: incoming.find(r => r.id === sys.id)!.enabled } : sys);
  return {
    v: 1,
    alerts: {
      inApp: value.alerts?.inApp !== false,
      recipients: Array.isArray(value.alerts?.recipients) ? value.alerts.recipients.filter(Boolean) : [],
      webhookUrl: value.alerts?.webhookUrl ?? null,
      codes
    },
    rules: [...system, ...custom]
  };
}

export async function readWorkspaceConfig(tenantId: string): Promise<WorkspaceConfig> {
  const row = await db.tenantSetting.findUnique({ where: { tenantId }, select: { encryptedConfig: true } });
  if (!row?.encryptedConfig) return defaultConfig();
  try { return mergeConfig(JSON.parse(row.encryptedConfig)); }
  catch { return defaultConfig(); }
}

export async function writeWorkspaceConfig(tenantId: string, next: WorkspaceConfig) {
  const encoded = JSON.stringify(next);
  await db.tenantSetting.upsert({
    where: { tenantId },
    update: { encryptedConfig: encoded },
    create: { tenantId, encryptedConfig: encoded }
  });
}

export function alertCodeEnabled(config: WorkspaceConfig, code: string) {
  if (config.alerts.inApp === false && !config.alerts.webhookUrl && !config.alerts.recipients.length) return false;
  return config.alerts.codes[code] !== false;
}
