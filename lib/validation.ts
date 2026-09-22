import { z } from 'zod';

export const TEMPLATE_VARIABLES = new Set(['firstName', 'company', 'senderName', 'calendlyUrl', 'offer']);
const text = z.string().trim().min(1).max(200);
const list = z.array(text).max(50);
export const timezone = z.string().refine(value => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}, 'Invalid IANA timezone');
export const icpInput = z.object({
  name: text, offer: text, industries: list.min(1), companySizes: list.min(1),
  geographies: list.min(1), technologies: list.default([]), buyingSignals: list.min(1),
  buyerTitles: list.min(1), exclusionRules: list.default([]),
  minScore: z.number().int().min(50).max(100).default(75),
  weeklyAppointmentGoal: z.number().int().min(1).max(100).default(5)
}).strict();
export const campaignInput = z.object({
  name: text, icpId: text.optional(), icp: icpInput.optional(), offer: text.optional(), senderName: text,
  senderEmail: z.string().email().transform(v => v.toLowerCase()),
  calendlyUrl: z.string().url().refine(v => new URL(v).protocol === 'https:'),
  dailySendCap: z.number().int().min(1).max(250).default(25),
  weeklyProspectCap: z.number().int().min(1).max(1000).default(50),
  weeklyAppointmentGoal: z.number().int().min(1).max(100).default(5),
  minScore: z.number().int().min(50).max(100).default(75),
  minAppointmentQualityScore: z.number().int().min(50).max(100).default(80),
  automationMode: z.enum(['FULLY_AUTOMATIC', 'REVIEW_BEFORE_SEND', 'REVIEW_BEFORE_BOOKING', 'PAUSED']).default('REVIEW_BEFORE_SEND'),
  outcomeType: z.enum(['APPOINTMENT_BOOKED', 'QUALIFIED_OPPORTUNITY']).default('APPOINTMENT_BOOKED'),
  timezone: timezone.default('America/Los_Angeles'),
  sendStartHour: z.number().int().min(0).max(23).default(9),
  sendEndHour: z.number().int().min(1).max(24).default(17),
  businessDaysOnly: z.boolean().default(true),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(v => !Number.isNaN(Date.parse(v)), 'Not a real date')).max(60).default([]),
  startImmediately: z.boolean().default(false),
  sequenceSteps: z.array(z.object({
    stepOrder: z.number().int().min(1).max(10), waitBusinessDays: z.number().int().min(0).max(30),
    subject: z.string().trim().min(1).max(200), body: z.string().min(1).max(4000)
  }).strict()).min(1).max(10)
}).strict().superRefine((value, ctx) => {
  if (!!value.icpId === !!value.icp) ctx.addIssue({ code: 'custom', message: 'Select one existing ICP or define one inside the campaign' });
  if (value.sendStartHour >= value.sendEndHour) ctx.addIssue({ code: 'custom', message: 'Invalid send window' });
  const steps = [...value.sequenceSteps].sort((a, b) => a.stepOrder - b.stepOrder);
  if (steps.some((s, i) => s.stepOrder !== i + 1 || (i > 0 && s.waitBusinessDays < 1))) {
    ctx.addIssue({ code: 'custom', message: 'Use consecutive steps starting at 1; follow-ups need a delay' });
  }
  const allowed = TEMPLATE_VARIABLES;
  for (const step of steps) {
    for (const match of (step.subject + step.body).matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      if (!allowed.has(match[1])) ctx.addIssue({ code: 'custom', message: 'Unknown template variable' });
    }
    if (step.body.includes('[Describe your offer')) ctx.addIssue({ code: 'custom', message: 'Replace the sample offer before saving' });
  }
});

export const settingsInput = z.object({
  automationEnabled: z.boolean(), dailySendCap: z.number().int().min(1).max(1000),
  weeklyProspectCap: z.number().int().min(1).max(5000),
  postalAddress: z.string().trim().min(10).max(500),
  gatewayKey: z.string().min(16).max(2000).optional(),
  webhookSecret: z.string().min(32).max(256).optional(),
  calendlySigningKey: z.string().min(16).max(256).optional(),
  // Personal access token / OAuth token used only to READ scheduled events for missed-webhook reconciliation.
  calendlyToken: z.string().min(20).max(4000).optional(),
  calendlyOrganizationUri: z.string().url().max(300).refine(u => { const x = new URL(u); return x.origin === 'https://api.calendly.com' && /^\/organizations\/[A-Za-z0-9-]+$/.test(x.pathname); }, 'Use https://api.calendly.com/organizations/<id>').nullable().optional(),
  monthlySpendCapCents: z.number().int().min(0).max(100000000).nullable().optional(),
  providerCostCents: z.number().int().min(0).max(100000).optional(),
  messageRetentionDays: z.number().int().min(30).max(3650).nullable().optional(),
  aiEnabled: z.boolean().optional(),
  aiBaseUrl: z.string().trim().max(300).nullable().optional(),
  aiModel: z.string().trim().min(1).max(120).nullable().optional(),
  aiKey: z.string().max(2000).optional(),
  aiFeatures: z.array(z.enum(['campaign_assist', 'reply_assist'])).max(2).optional()
}).strict();
