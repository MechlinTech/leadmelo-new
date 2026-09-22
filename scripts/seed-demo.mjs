// DEMO DATA ONLY. Fills a LOCAL, throw-away database with a realistic fictional workspace so the screens can be
// shown and photographed. It refuses to run unless ALLOW_DEMO_SEED=yes AND the database host is local, and every
// person and company it creates is fictional (example domains). Never run it against a real installation.
import { randomUUID } from 'node:crypto';
import { db } from '../lib/db.ts';
import { encrypt, hashPassword } from '../lib/crypto.ts';
import { updateCampaign } from '../lib/campaignVersions.ts';
import { createExperiment, setExperimentStatus, evaluateExperiments } from '../lib/experiments/index.ts';
import { attributionToken } from '../lib/calendly.ts';

const host = new URL(process.env.DATABASE_URL ?? 'postgresql://x@nowhere/x').hostname;
if (process.env.ALLOW_DEMO_SEED !== 'yes' || !['localhost', '127.0.0.1'].includes(host)) { console.error('Refusing to seed: set ALLOW_DEMO_SEED=yes and use a local database.'); process.exit(2); }

const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123456';
const ago = (ms) => new Date(Date.now() - ms), inH = h => new Date(Date.now() + h * 3600000), H = 3600000, D = 86400000;
const hash = hashPassword(PASSWORD);

const main = await db.tenant.create({ data: { name: 'Northwind Outbound', slug: 'northwind', plan: 'GROWTH', createdAt: ago(60 * D), settings: { create: { automationEnabled: true, postalAddress: '500 Market Street, Suite 200, San Francisco, CA 94105', dailySendCap: 100, weeklyProspectCap: 200, monthlySpendCapCents: 50000, providerCostCents: 75, messageRetentionDays: 180, gatewayKey: encrypt('demo-gateway-credential'), webhookSecret: encrypt('w'.repeat(40)), calendlySigningKey: encrypt('demo-calendly-signing-key'), calendlyToken: encrypt('demo-calendly-token-abcdefghijklmnop'), calendlyOrganizationUri: 'https://api.calendly.com/organizations/DEMO-ORG', calendlyReconciledAt: ago(6 * 60000) } },
  users: { create: [{ email: 'admin@northwind.example', name: 'Alex Admin', role: 'TENANT_ADMIN', passwordHash: hash }, { email: 'manager@northwind.example', name: 'Morgan Manager', role: 'MANAGER', passwordHash: hash }, { email: 'viewer@northwind.example', name: 'Vic Viewer', role: 'MEMBER', passwordHash: hash }] } }, include: { users: true } });
const ops = await db.tenant.create({ data: { name: 'LeadMelo Operations', slug: 'leadmelo-ops', plan: 'ENTERPRISE', settings: { create: {} }, users: { create: { email: 'operator@leadmelo.example', name: 'Olivia Operator', role: 'SUPER_ADMIN', passwordHash: hash } } } });
await db.tenant.create({ data: { name: 'Contoso Labs', slug: 'contoso', plan: 'STARTER', createdAt: ago(20 * D), settings: { create: { automationEnabled: true } }, users: { create: { email: 'lead@contoso.example', name: 'Casey Contoso', role: 'TENANT_ADMIN', passwordHash: hash } } } });
await db.tenant.create({ data: { name: 'Fabrikam Trial', slug: 'fabrikam', plan: 'FREE', createdAt: ago(3 * D), settings: { create: {} }, users: { create: { email: 'owner@fabrikam.example', name: 'Fay Fabrikam', role: 'TENANT_ADMIN', passwordHash: hash } } } });
const admin = main.users.find(u => u.role === 'TENANT_ADMIN');
await db.user.update({ where: { id: admin.id }, data: { theme: 'system' } });

const icp = await db.iCP.create({ data: { tenantId: main.id, name: 'QA leaders at US software companies', offer: 'QA automation and Playwright migration', industries: ['SaaS', 'Fintech', 'Healthtech'], companySizes: ['50-1000', '1001+'], geographies: ['US', 'Canada'], technologies: ['Selenium', 'Playwright'], buyingSignals: ['Hiring QA', 'Hiring SDET'], buyerTitles: ['CTO', 'VP Engineering', 'QA Director'], exclusionRules: ['competitor.example'], minScore: 80, weeklyAppointmentGoal: 6 } });
const icp2 = await db.iCP.create({ data: { tenantId: main.id, name: 'Healthcare platforms', offer: 'API and performance testing', industries: ['Healthtech'], companySizes: ['50-1000'], geographies: ['US'], technologies: [], buyingSignals: ['Hiring QA'], buyerTitles: ['CTO', 'QA Manager'], minScore: 75 } });
const steps = [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Quick question about {{company}} QA', body: 'Hi {{firstName}},\n\nI noticed {{company}} is hiring for QA. We help teams move Selenium suites to Playwright without pausing releases.\n\nWorth a short conversation? {{calendlyUrl}}\n\n{{senderName}}' }, { stepOrder: 2, waitBusinessDays: 3, subject: 'Re: QA at {{company}}', body: 'Hi {{firstName}}, following up in case this got buried. Happy to share how a similar team cut flaky tests by half. {{calendlyUrl}}' }, { stepOrder: 3, waitBusinessDays: 5, subject: 'Closing the loop', body: 'Hi {{firstName}}, I will stop here. If QA capacity becomes a priority, {{calendlyUrl}} is my calendar.' }];
const c1 = await db.campaign.create({ data: { tenantId: main.id, icpId: icp.id, name: 'QA automation, US software', offer: 'QA automation and Playwright migration', senderName: 'Sam Seller', senderEmail: 'sam@northwind.example', calendlyUrl: 'https://calendly.com/northwind/30min', status: 'ACTIVE', automationMode: 'REVIEW_BEFORE_SEND', dailySendCap: 40, weeklyProspectCap: 120, weeklyAppointmentGoal: 6, timezone: 'America/Los_Angeles', holidays: ['2026-11-26', '2026-12-25'], sequenceSteps: { create: steps } } });
const c2 = await db.campaign.create({ data: { tenantId: main.id, icpId: icp2.id, name: 'API testing, healthcare', offer: 'API and performance testing', senderName: 'Sam Seller', senderEmail: 'sam@northwind.example', calendlyUrl: 'https://calendly.com/northwind/30min', status: 'PAUSED', automationMode: 'REVIEW_BEFORE_SEND', sequenceSteps: { create: steps.slice(0, 2) } } });
await db.campaign.create({ data: { tenantId: main.id, icpId: icp.id, name: 'Playwright migration, Canada (draft)', senderName: 'Sam Seller', senderEmail: 'sam@northwind.example', calendlyUrl: 'https://calendly.com/northwind/30min', status: 'DRAFT', sequenceSteps: { create: steps.slice(0, 1) } } });
// Real version history through the same code path the API uses.
await updateCampaign(main.id, c1.id, admin.id, { sequenceSteps: [{ ...steps[0], subject: 'A quick idea for {{company}} QA' }, steps[1], steps[2]] }, 'edit');
await updateCampaign(main.id, c1.id, admin.id, { offer: 'QA automation, Playwright migration and SDET capacity' }, 'edit');
await updateCampaign(main.id, c1.id, admin.id, { sequenceSteps: steps }, 'rollback_to_1');

await db.deliverabilityProfile.create({ data: { tenantId: main.id, senderEmail: 'sam@northwind.example', domain: 'northwind.example', status: 'HEALTHY', dailyCap: 50, bounceRate: 0.012, complaintRate: 0, lastCheckedAt: ago(20 * 60000), healthSource: 'internal', spfStatus: 'pass', dkimStatus: 'pass', dmarcStatus: 'pass', authCheckedAt: ago(3 * H), detail: { reasons: [], sent30d: 412, bounces30d: 5, complaints30d: 0, senderAgeDays: 21 } } });

const people = [['Pat Buyer', 'CTO', 'Acme Robotics', 'acme-robotics'], ['Riley Chen', 'VP Engineering', 'Globex Health', 'globex-health'], ['Jordan Lee', 'QA Director', 'Initech Software', 'initech'], ['Sam Ortiz', 'CTO', 'Umbrella Fintech', 'umbrella'], ['Taylor Kim', 'VP Engineering', 'Hooli Cloud', 'hooli'], ['Drew Patel', 'QA Director', 'Stark Analytics', 'stark'], ['Avery Stone', 'CTO', 'Wayne Logistics', 'wayne'], ['Quinn Rivera', 'VP Engineering', 'Wonka Retail', 'wonka'], ['Blake Nguyen', 'CTO', 'Pied Piper Data', 'piedpiper'], ['Casey Moore', 'QA Director', 'Soylent Foods', 'soylent']];
const made = [];
for (const [i, [name, title, company, slug]] of people.entries()) {
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${slug}.example`;
  const lead = await db.lead.create({ data: { tenantId: main.id, company, domain: `${slug}.example`, contactName: name, contactEmail: email, score: 90 + (i % 2) * 10, qualification: 'QUALIFIED', status: i < 3 ? 'MEETING' : i < 6 ? 'REPLIED' : 'CONTACTED', source: `https://${slug}.example/careers`, signalSummary: 'Open QA / SDET roles on the careers page (Apollo filter, not independently confirmed)' } });
  const contact = await db.contact.create({ data: { tenantId: main.id, leadId: lead.id, fullName: name, title, email, verification: 'VALID', lastVerifiedAt: ago(2 * D) } });
  await db.enrollment.create({ data: { tenantId: main.id, campaignId: c1.id, contactId: contact.id, score: 90 + (i % 2) * 10, hasBuyer: true, hasPainSignal: true, evidence: { company, title }, ...(i > 5 ? {} : {}) } });
  made.push({ lead, contact, name });
}
const ev = (c, extra) => db.outreachEvent.create({ data: { tenantId: main.id, campaignId: c1.id, contactId: c.contact.id, leadId: c.lead.id, idempotencyKey: randomUUID(), ...extra } });
for (const [i, c] of made.entries()) {
  await ev(c, { status: 'SENT', stepOrder: 1, sentAt: ago((3 + i) * H), subject: 'A quick idea for QA', body: 'Hi, ...' });
  if (i < 5) await ev(c, { status: 'SENT', stepOrder: 1, sentAt: ago((30 + i) * H), subject: 'Earlier note', body: 'Hi again, ...', providerMessageId: `m-${i}` });
}
for (let i = 0; i < 4; i++) await ev(made[6 + i % 4], { status: 'QUEUED', stepOrder: 2, scheduledAt: inH(4 + i), subject: 'Re: QA at your company', body: 'Following up ...' });
await ev(made[5], { status: 'QUEUED', stepOrder: 2, scheduledAt: inH(30), approvedAt: new Date() });
await db.reply.createMany({ data: [
  { tenantId: main.id, contactId: made[0].contact.id, intent: 'POSITIVE', rawSnippet: 'Yes, this is timely. Send me a time.', recommendedAction: 'Booking invitation queued; calendar confirmation required.', createdAt: ago(5 * H) },
  { tenantId: main.id, contactId: made[1].contact.id, intent: 'POSITIVE', rawSnippet: 'Interested, please share your calendar.', recommendedAction: 'Booking invitation queued; calendar confirmation required.', createdAt: ago(9 * H) },
  { tenantId: main.id, contactId: made[3].contact.id, intent: 'OBJECTION', rawSnippet: 'What does this cost for a team of ten?', recommendedAction: 'Needs review (question_or_objection); all pending outreach stopped.', createdAt: ago(7 * H) },
  { tenantId: main.id, contactId: made[4].contact.id, intent: 'UNSURE', rawSnippet: 'You want Priya Shah in QA, not me.', recommendedAction: 'Needs review (referral); all pending outreach stopped.', createdAt: ago(28 * H) },
  { tenantId: main.id, contactId: made[5].contact.id, intent: 'NEGATIVE', rawSnippet: 'Not interested, thanks.', recommendedAction: 'Suppressed; do not contact.', createdAt: ago(50 * H) }] });
await db.suppression.createMany({ data: [{ tenantId: main.id, email: made[5].contact.email, reason: 'negative_reply' }, { tenantId: main.id, email: 'gone@nowhere.example', reason: 'bounce' }, { tenantId: main.id, email: 'unsub@example.org', reason: 'unsubscribe' }] });

const appt = (i, extra) => db.appointment.create({ data: { tenantId: main.id, campaignId: c1.id, contactId: made[i].contact.id, providerEventId: `demo-${i}-${randomUUID().slice(0, 6)}`, providerUpdatedAt: new Date(), qualityScore: 95, ...extra } });
await appt(0, { status: 'BOOKED', qualified: true, scheduledStart: inH(46), scheduledEnd: inH(46.5), timezone: 'America/New_York', qualificationNotes: 'ICP evidence and confirmed provider booking', createdAt: ago(4 * H) });
await appt(1, { status: 'BOOKED', qualified: false, scheduledStart: inH(74), scheduledEnd: inH(74.5), timezone: 'America/Chicago', qualificationNotes: 'Qualification review required', createdAt: ago(8 * H) });
await appt(2, { status: 'COMPLETED', qualified: true, scheduledStart: ago(6 * D), scheduledEnd: ago(6 * D - 1800000), timezone: 'America/Los_Angeles', outcomeReason: 'Good fit; proposal requested', createdAt: ago(9 * D) });
await appt(3, { status: 'CANCELED', qualified: true, scheduledStart: inH(20), scheduledEnd: inH(20.5), timezone: 'America/Denver', createdAt: ago(2 * D) });

// Usage, runs, alerts
await db.usageLedger.createMany({ data: [
  { tenantId: main.id, kind: 'EMAIL_SENT', quantity: 1840, costCents: 0, idempotencyKey: 'demo-emails' }, { tenantId: main.id, kind: 'VERIFICATION', quantity: 400, costCents: 0, idempotencyKey: 'demo-verify' },
  { tenantId: main.id, kind: 'DISCOVERY_PROSPECT', quantity: 420, costCents: 31500, idempotencyKey: 'demo-discover' }] });
for (const [i, s] of ['SUCCEEDED', 'SUCCEEDED', 'PARTIAL'].entries()) await db.automationRun.create({ data: { tenantId: main.id, campaignId: c1.id, status: s, startedAt: ago((i + 1) * 3 * H), finishedAt: ago((i + 1) * 3 * H - 120000), prospectsFound: 18 - i * 4, contactsVerified: 15 - i * 4, messagesQueued: 9 - i * 2, createdAt: ago((i + 1) * 3 * H), errors: s === 'PARTIAL' ? { code: 'vendor_rate_limited' } : undefined } });
await db.operationalAlert.createMany({ data: [{ tenantId: main.id, key: `${main.id}:reply_review:1`, code: 'reply_review', entityId: '1' }, { tenantId: main.id, key: `${main.id}:reply_review:2`, code: 'reply_review', entityId: '2' }, { tenantId: main.id, key: `${main.id}:bounce_notice_unattributed:1`, code: 'bounce_notice_unattributed', entityId: '1' }] });

// Experiment with real assignments and outcomes so the results table and recommendation are genuine.
const exp = await createExperiment(main.id, { id: admin.id, role: 'TENANT_ADMIN' }, { campaignId: c1.id, stepOrder: 1, name: 'Subject line: question vs statement', minSample: 100, variants: [{ label: 'B', subject: 'Are flaky tests slowing {{company}} down?', body: 'Hi {{firstName}},\n\nAre flaky end-to-end tests slowing releases at {{company}}? {{calendlyUrl}}\n\n{{senderName}}' }] });
await setExperimentStatus(main.id, { id: admin.id, role: 'TENANT_ADMIN' }, exp.id, 'RUNNING');
const full = await db.experiment.findUniqueOrThrow({ where: { id: exp.id }, include: { variants: true } });
async function arm(variant, n, positives) {
  const contacts = Array.from({ length: n }, () => ({ id: randomUUID(), tenantId: main.id, fullName: 'Demo Prospect', email: `${randomUUID()}@demo-prospects.example` }));
  await db.contact.createMany({ data: contacts });
  const enrollments = contacts.map(c => ({ id: randomUUID(), tenantId: main.id, campaignId: c1.id, contactId: c.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: {}, stoppedAt: new Date(), stopReason: 'demo' }));
  await db.enrollment.createMany({ data: enrollments });
  await db.experimentAssignment.createMany({ data: enrollments.map(e => ({ tenantId: main.id, experimentId: exp.id, variantId: variant.id, enrollmentId: e.id })) });
  await db.outreachEvent.createMany({ data: contacts.map(c => ({ tenantId: main.id, campaignId: c1.id, contactId: c.id, stepOrder: 1, status: 'SENT', sentAt: ago(10 * D), idempotencyKey: randomUUID() })) });
  await db.reply.createMany({ data: contacts.slice(0, positives).map(c => ({ tenantId: main.id, contactId: c.id, intent: 'POSITIVE', rawSnippet: 'yes' })) });
}
await arm(full.variants.find(v => v.isControl), 130, 13); await arm(full.variants.find(v => !v.isControl), 130, 31);
await evaluateExperiments();

// Team + operator data
await db.invite.create({ data: { tenantId: main.id, email: 'new.hire@northwind.example', role: 'MANAGER', tokenHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), expiresAt: inH(60) } });
await db.accessRequest.createMany({ data: [
  { name: 'Dana Whitfield', email: 'dana@bluepine.example', company: 'Bluepine Software', plan: 'GROWTH', source: 'pricing', message: 'We run three outbound teams and want one system.', createdAt: ago(3 * H) },
  { name: 'Eli Brooks', email: 'eli@harborlogic.example', company: 'Harbor Logic', plan: 'STARTER', source: 'pricing', createdAt: ago(20 * H) },
  { name: 'Mina Park', email: 'mina@quartzhealth.example', source: 'assistant', message: 'Asked about Google Workspace support', createdAt: ago(2 * D) },
  { name: 'Omar Haddad', email: 'omar@keystone.example', company: 'Keystone Partners', source: 'contact', handledAt: ago(D), createdAt: ago(5 * D) }] });
await db.assistantQuestion.createMany({ data: [{ question: 'do you integrate with pipedrive', audience: 'public' }, { question: 'can I white label this for my agency', audience: 'public' }, { question: 'how do I export all campaigns as csv', audience: 'app' }] });
void ops; void icp2; void c2; void attributionToken;
console.log(JSON.stringify({ seeded: true, tenant: main.slug, logins: { admin: 'admin@northwind.example', operator: 'operator@leadmelo.example', password: PASSWORD } }));
await db.$disconnect();
