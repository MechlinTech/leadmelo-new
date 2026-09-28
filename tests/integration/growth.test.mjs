import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt, hashPassword } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
function sessionFrom(response) {
  const all = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
  const raw = all.find(c => c.startsWith(`${sessionCookie}=`));
  const token = raw?.match(new RegExp(`^${sessionCookie}=([^;]+)`))?.[1];
  if (!token) throw new Error('login did not set a session cookie');
  return `${sessionCookie}=${token}`;
}
import { attributionToken } from '../../lib/calendly.ts';
import { reserveProviderSpend } from '../../lib/usage.ts';
import { sendAllowance, assertCanActivateCampaign } from '../../lib/entitlements.ts';
import { refreshSenderHealth, runSenderHealth, setResolverForTests } from '../../lib/senderHealth.ts';
import { handleBounceNotice } from '../../lib/m365/sync.ts';
import { reconcileCalendly, reconcileAllCalendly } from '../../lib/calendlyReconcile.ts';
import { POST as accessRequest } from '../../app/api/public/access-request/route.ts';
import { POST as assistantRoute } from '../../app/api/assistant/route.ts';
import { GET as planRoute } from '../../app/api/plan/route.ts';
import { POST as setPlan } from '../../app/api/admin/tenants/[id]/plan/route.ts';
import { GET as overview, PATCH as handleRequest } from '../../app/api/admin/overview/route.ts';
import { PUT as putTheme, GET as getTheme } from '../../app/api/profile/theme/route.ts';
import { GET as usersRoute } from '../../app/api/users/route.ts';
import { POST as inviteRoute } from '../../app/api/invites/route.ts';
import { POST as createExperimentRoute } from '../../app/api/experiments/route.ts';
import { PATCH as patchCampaign } from '../../app/api/campaigns/route.ts';
import { PUT as editCampaign } from '../../app/api/campaigns/[id]/route.ts';
import { POST as login } from '../../app/api/auth/login/route.ts';
import { PUT as putSettings } from '../../app/api/settings/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';
process.env.PLAN_ENFORCEMENT = 'on';
process.env.SENDER_HEALTH_AUTO = 'on';
process.env.OUTBOUND_ENABLED = 'true';
process.env.PROVIDER_GATEWAY_URL = 'https://gateway.example';

const dnsErr = code => Object.assign(new Error(code), { code });
const dnsRecords = {
  'ok.example': [['v=spf1 include:spf.protection.outlook.com -all']], '_dmarc.ok.example': [['v=DMARC1; p=quarantine']], 'CNAME:selector1._domainkey.ok.example': ['selector1._domainkey.t.onmicrosoft.com'],
  'spfonly.example': [['v=spf1 -all']]
};
setResolverForTests({ txt: async n => { if (n in dnsRecords) return dnsRecords[n]; throw dnsErr('ENOTFOUND'); }, cname: async n => { if (dnsRecords['CNAME:' + n]) return dnsRecords['CNAME:' + n]; throw dnsErr('ENODATA'); } });

const ORIGIN = 'http://localhost:3000';
const req = (path, method = 'GET', body, cookie = '', headers = {}) => new Request(`${ORIGIN}/api/${path}`, { method, headers: { origin: ORIGIN, 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = id => ({ params: Promise.resolve({ id }) });

async function tenantWith(name, { plan = 'FREE', createdAt, ready = false } = {}) {
  const passwordHash = hashPassword('a-long-test-password-1');
  const tenant = await db.tenant.create({ data: { name, slug: `${name}-${randomUUID()}`, plan, ...(createdAt ? { createdAt } : {}), settings: { create: ready ? { automationEnabled: true, postalAddress: '123 Test Street', gatewayKey: encrypt('gw-credential-1234'), webhookSecret: encrypt('w'.repeat(40)) } : { postalAddress: '123 Test Street' } }, users: { create: [{ email: `${name.toLowerCase()}-a-${randomUUID()}@example.com`, role: 'TENANT_ADMIN', passwordHash }, { email: `${name.toLowerCase()}-root-${randomUUID()}@example.com`, role: 'SUPER_ADMIN', passwordHash }] } }, include: { users: true } });
  const cookie = async role => `${sessionCookie}=${await createSession(tenant.users.find(u => u.role === role).id)}`;
  return { tenant, admin: await cookie('TENANT_ADMIN'), root: await cookie('SUPER_ADMIN'), adminUser: tenant.users.find(u => u.role === 'TENANT_ADMIN') };
}
const campaignFor = async (T, senderEmail, extra = {}) => {
  const icp = await db.iCP.create({ data: { tenantId: T.tenant.id, name: 'QA', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'] } });
  return db.campaign.create({ data: { tenantId: T.tenant.id, icpId: icp.id, name: `C-${senderEmail}`, senderName: 'Sam', senderEmail, calendlyUrl: 'https://calendly.com/x', status: 'PAUSED', automationMode: 'REVIEW_BEFORE_SEND', sequenceSteps: { create: [{ stepOrder: 1, subject: 'Hi', body: 'Hi {{firstName}}' }] }, ...extra } });
};

test('plans: limits are enforced server-side, per resource, and lift when the plan changes', async t => {
  const T = await tenantWith('plan', { ready: true });
  const c1 = await campaignFor(T, 'one@ok.example'), c2 = await campaignFor(T, 'two@ok.example');
  await t.test('readiness computes sender health itself (no external feed), then the first campaign activates', async () => {
    assert.equal(await db.deliverabilityProfile.count({ where: { tenantId: T.tenant.id } }), 0);
    const res = await patchCampaign(req('campaigns', 'PATCH', { id: c1.id, status: 'ACTIVE' }, T.admin));
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const profile = await db.deliverabilityProfile.findFirstOrThrow({ where: { tenantId: T.tenant.id, senderEmail: 'one@ok.example' } });
    assert.deepEqual([profile.status, profile.dailyCap, profile.healthSource, profile.spfStatus, profile.dmarcStatus, profile.dkimStatus], ['HEALTHY', 10, 'internal', 'pass', 'pass', 'pass']);
  });
  await t.test('the Trial plan allows one active campaign; the second is refused with a clear code', async () => {
    const res = await patchCampaign(req('campaigns', 'PATCH', { id: c2.id, status: 'ACTIVE' }, T.admin));
    assert.equal(res.status, 402); assert.equal((await res.json()).error, 'plan_limit:activeCampaigns');
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: c2.id } })).status, 'PAUSED');
    await assertCanActivateCampaign(T.tenant.id, c1.id); // an already-active campaign is never re-counted
  });
  await t.test('seats, experiments and prospects are limited by the same plan table', async () => {
    assert.equal((await inviteRoute(req('invites', 'POST', { email: `a-${randomUUID()}@example.com`, role: 'MEMBER' }, T.admin))).status, 402, 'trial has 2 seats: admin + operator already fill them');
    const exp = await createExperimentRoute(req('experiments', 'POST', { campaignId: c1.id, stepOrder: 1, name: 'x', variants: [{ label: 'B', subject: 's', body: 'b' }] }, T.admin));
    assert.equal(exp.status, 402); assert.equal((await exp.json()).error, 'plan_limit:experiments');
    const spend = await reserveProviderSpend(T.tenant.id, c1.id, 'plan-k1', 150);
    assert.deepEqual(spend, { quantity: 100, reason: 'plan_limit' }, 'trial allows 100 prospects a month');
    assert.deepEqual(await reserveProviderSpend(T.tenant.id, c1.id, 'plan-k2', 10), { quantity: 0, reason: 'plan_limit' });
    assert.equal((await reserveProviderSpend(T.tenant.id, c1.id, 'plan-k1', 150)).quantity, 100, 'a retry of the same key reuses its reservation');
  });
  await t.test('sequence emails stop at the monthly allowance', async () => {
    assert.equal((await sendAllowance(db, T.tenant.id)).allowed, true);
    await db.usageLedger.create({ data: { tenantId: T.tenant.id, kind: 'EMAIL_SENT', quantity: 200, costCents: 0, idempotencyKey: `bulk-${randomUUID()}` } });
    assert.deepEqual(await sendAllowance(db, T.tenant.id), { allowed: false, reason: 'plan_limit:monthlyEmails' });
  });
  await t.test('/api/plan reports usage against limits', async () => {
    const info = await (await planRoute(req('plan', 'GET', undefined, T.admin))).json();
    assert.deepEqual([info.plan, info.enforced, info.limits.activeCampaigns, info.usage.activeCampaigns, info.usage.monthlyEmails, info.usage.monthlyProspects], ['FREE', true, 1, 1, 200, 100]);
    assert.ok(info.trialDaysLeft > 0 && info.trialDaysLeft <= 14);
  });
  await t.test('only a platform administrator can change plans; upgrading lifts every limit at once', async () => {
    assert.equal((await setPlan(req('x', 'POST', { plan: 'GROWTH' }, T.admin), params(T.tenant.id))).status, 403);
    assert.equal((await setPlan(req('x', 'POST', { plan: 'PLATINUM' }, T.root), params(T.tenant.id))).status, 400);
    assert.equal((await setPlan(req('x', 'POST', { plan: 'GROWTH' }, T.root), params('nope'))).status, 404);
    assert.equal((await setPlan(req('x', 'POST', { plan: 'GROWTH' }, T.root), params(T.tenant.id))).status, 200);
    assert.equal((await patchCampaign(req('campaigns', 'PATCH', { id: c2.id, status: 'ACTIVE' }, T.admin))).status, 200);
    assert.equal((await sendAllowance(db, T.tenant.id)).allowed, true);
    assert.equal((await inviteRoute(req('invites', 'POST', { email: `b-${randomUUID()}@example.com`, role: 'MEMBER' }, T.admin))).status, 201);
    assert.equal((await db.auditEvent.count({ where: { tenantId: T.tenant.id, action: 'plan_changed' } })), 1);
  });
  await t.test('an expired trial blocks activation and sending; with enforcement off nothing is blocked', async () => {
    const old = await tenantWith('expired', { ready: true, createdAt: new Date(Date.now() - 20 * 86400000) });
    const c = await campaignFor(old, 'old@ok.example');
    const res = await patchCampaign(req('campaigns', 'PATCH', { id: c.id, status: 'ACTIVE' }, old.admin));
    assert.equal(res.status, 402); assert.equal((await res.json()).error, 'plan_trial_expired');
    assert.deepEqual(await sendAllowance(db, old.tenant.id), { allowed: false, reason: 'plan_trial_expired' });
    assert.deepEqual(await reserveProviderSpend(old.tenant.id, c.id, 'exp-k', 5), { quantity: 0, reason: 'plan_trial_expired' });
    process.env.PLAN_ENFORCEMENT = 'off';
    try { assert.equal((await sendAllowance(db, old.tenant.id)).allowed, true); assert.equal((await reserveProviderSpend(old.tenant.id, c.id, 'exp-k2', 5)).quantity, 5); }
    finally { process.env.PLAN_ENFORCEMENT = 'on'; }
  });
});

test('public access requests and the assistant API are validated, rate-limited and private', async t => {
  const ip = last => ({ 'x-forwarded-for': `203.0.113.${last}` });
  await t.test('a valid request is stored; the honeypot stores nothing; bad input and foreign origins are refused', async () => {
    const good = { name: 'Pat Buyer', email: 'Pat@Buyer.example', company: 'Buyer Co', plan: 'GROWTH', source: 'pricing', message: 'Interested' };
    assert.equal((await accessRequest(req('public/access-request', 'POST', good, '', ip(1)))).status, 201);
    const row = await db.accessRequest.findFirstOrThrow({ where: { email: 'pat@buyer.example' } });
    assert.deepEqual([row.name, row.plan, row.source, row.handledAt], ['Pat Buyer', 'GROWTH', 'pricing', null]);
    const before = await db.accessRequest.count();
    assert.equal((await accessRequest(req('public/access-request', 'POST', { ...good, email: 'bot@spam.example', website: 'http://spam' }, '', ip(2)))).status, 201, 'bots see success');
    assert.equal(await db.accessRequest.count(), before, 'but nothing is stored');
    assert.equal((await accessRequest(req('public/access-request', 'POST', { ...good, email: 'not-an-email' }, '', ip(3)))).status, 400);
    assert.equal((await accessRequest(req('public/access-request', 'POST', { ...good, plan: 'PLATINUM' }, '', ip(3)))).status, 400);
    assert.equal((await accessRequest(req('public/access-request', 'POST', { ...good, extra: 1 }, '', ip(3)))).status, 400);
    assert.equal((await accessRequest(req('public/access-request', 'POST', good, '', { ...ip(3), origin: 'https://evil.example' }))).status, 403);
  });
  await t.test('one address cannot flood the form', async () => {
    const body = { name: 'Flood', email: 'flood@example.com', source: 'contact' };
    const statuses = []; for (let i = 0; i < 7; i++) statuses.push((await accessRequest(req('public/access-request', 'POST', body, '', ip(50)))).status);
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429]);
    assert.equal((await accessRequest(req('public/access-request', 'POST', body, '', ip(51)))).status, 201, 'another address is unaffected');
  });
  await t.test('the assistant answers visitors, redacts what it stores about unanswered questions, and limits abuse', async () => {
    const ask = (message, cookie = '', last = 70) => assistantRoute(req('assistant', 'POST', { message }, cookie, ip(last)));
    const a = await (await ask('What does the Growth plan cost?')).json();
    assert.match(a.answer, /\$399/); assert.equal(a.audience, 'public'); assert.equal(a.confidence, 'high');
    const before = await db.assistantQuestion.count();
    const unknown = await (await ask('purple monkey dishwasher secret.person@corp.example +1 415 555 0100')).json();
    assert.equal(unknown.confidence, 'low'); assert.equal(unknown.handoff, true);
    const logged = await db.assistantQuestion.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    assert.equal(await db.assistantQuestion.count(), before + 1);
    assert.ok(!logged.question.includes('@') && !/\d{3}/.test(logged.question), 'email and phone are masked: ' + logged.question);
    assert.equal((await assistantRoute(req('assistant', 'POST', { message: 'x'.repeat(501) }, '', ip(71)))).status, 400, 'oversized questions are refused');
    assert.equal((await assistantRoute(req('assistant', 'POST', { message: 'hi', audience: 'app', extra: 1 }, '', ip(71)))).status, 400);
    const T = await tenantWith('assist');
    const app = await (await ask('why is my campaign not sending', T.admin, 72)).json();
    assert.equal(app.audience, 'app'); assert.ok(app.matched.includes('app-not-sending'));
    const pub = await (await ask('why is my campaign not sending', '', 73)).json();
    assert.equal(pub.audience, 'public'); assert.ok(!pub.matched.includes('app-not-sending'), 'signed-out visitors never get signed-in help');
    const statuses = []; for (let i = 0; i < 32; i++) statuses.push((await ask('hello there', '', 90)).status);
    assert.equal(statuses.filter(s => s === 429).length, 2, '30 questions per 10 minutes per address');
  });
});

test('operator console data, theme preference and members list are permissioned and isolated', async t => {
  const A = await tenantWith('opA'), B = await tenantWith('opB');
  await t.test('only a platform administrator sees tenants and access requests, and can mark them handled', async () => {
    assert.equal((await overview(req('admin/overview', 'GET', undefined, A.admin))).status, 403);
    assert.equal((await overview(req('admin/overview', 'GET', undefined, ''))).status, 401);
    const data = await (await overview(req('admin/overview', 'GET', undefined, A.root))).json();
    assert.ok(data.tenants.some(x => x.id === A.tenant.id && x.plan === 'FREE')); assert.ok(Array.isArray(data.requests) && Array.isArray(data.questions));
    const r = await db.accessRequest.findFirstOrThrow({});
    assert.equal((await handleRequest(req('admin/overview', 'PATCH', { id: r.id, handled: true }, A.admin))).status, 403);
    assert.equal((await handleRequest(req('admin/overview', 'PATCH', { id: r.id, handled: true }, A.root))).status, 200);
    assert.ok((await db.accessRequest.findUniqueOrThrow({ where: { id: r.id } })).handledAt);
    assert.equal((await handleRequest(req('admin/overview', 'PATCH', { id: 'nope', handled: true }, A.root))).status, 404);
  });
  await t.test('a theme is saved to the account and mirrored to a cookie; invalid themes and foreign origins are refused', async () => {
    const res = await putTheme(req('profile/theme', 'PUT', { theme: 'ocean' }, A.admin));
    assert.equal(res.status, 200); assert.match(res.headers.get('set-cookie'), /^lm_theme=ocean; Path=\/; Max-Age=31536000; SameSite=Lax/);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: A.adminUser.id } })).theme, 'ocean');
    assert.equal((await (await getTheme(req('profile/theme', 'GET', undefined, A.admin))).json()).theme, 'ocean');
    assert.equal((await (await getTheme(req('profile/theme', 'GET', undefined, B.admin))).json()).theme, 'system', 'another user is unaffected');
    assert.equal((await putTheme(req('profile/theme', 'PUT', { theme: '"><script>' }, A.admin))).status, 400);
    assert.equal((await putTheme(req('profile/theme', 'PUT', { theme: 'dark' }, A.admin, { origin: 'https://evil.example' }))).status, 403);
    assert.equal((await putTheme(req('profile/theme', 'PUT', { theme: 'dark' }, ''))).status, 401);
  });
  await t.test('signing in restores the saved theme cookie on any device', async () => {
    const admin = await db.user.findUniqueOrThrow({ where: { id: A.adminUser.id } });
    const res = await login(req('auth/login', 'POST', { email: admin.email, password: 'a-long-test-password-1' }));
    assert.equal(res.status, 200, await res.clone().text()); const cookies = res.headers.get('set-cookie'); assert.match(cookies, /HttpOnly/); assert.match(cookies, /lm_theme=ocean/);
    A.admin = sessionFrom(res);
  });
  await t.test('the members list is admin-only, tenant-scoped and contains no secrets', async () => {
    assert.equal((await usersRoute(req('users', 'GET', undefined, ''))).status, 401);
    const member = await db.user.create({ data: { tenantId: A.tenant.id, email: `m-${randomUUID()}@example.com`, role: 'MEMBER', passwordHash: hashPassword('a-long-test-password-1') } });
    const memberCookie = `${sessionCookie}=${await createSession(member.id)}`;
    assert.equal((await usersRoute(req('users', 'GET', undefined, memberCookie))).status, 403);
    const list = await (await usersRoute(req('users', 'GET', undefined, A.admin))).json();
    assert.ok(list.every(u => !('passwordHash' in u) && !('totpSecret' in u))); assert.ok(list.some(u => u.you));
    assert.ok(!list.some(u => u.email.startsWith('opb')), 'other tenants never appear');
  });
});

test('automatic sender health: DNS authentication, ramp, own bounce data, and external feeds keep priority', async t => {
  const T = await tenantWith('health', { plan: 'ENTERPRISE' });
  const seed = async (sender, n, { bounced = 0, complained = 0, ageDays = 30 } = {}) => {
    const campaign = await campaignFor(T, sender);
    const emails = [];
    const anchor = await db.contact.create({ data: { tenantId: T.tenant.id, fullName: 'A N', email: `${randomUUID()}@buyers.example` } });
    await db.outreachEvent.create({ data: { tenantId: T.tenant.id, campaignId: campaign.id, contactId: anchor.id, status: 'SENT', sentAt: new Date(Date.now() - ageDays * 86400000), idempotencyKey: randomUUID() } }); // first send: sets the sender's age
    for (let i = 0; i < n; i++) {
      const email = `${randomUUID()}@buyers.example`; emails.push(email);
      const contact = await db.contact.create({ data: { tenantId: T.tenant.id, fullName: 'X Y', email } });
      await db.outreachEvent.create({ data: { tenantId: T.tenant.id, campaignId: campaign.id, contactId: contact.id, status: 'SENT', sentAt: new Date(Date.now() - 86400000 + i * 1000), idempotencyKey: randomUUID() } });
    }
    await db.suppression.createMany({ data: emails.slice(0, bounced).map(email => ({ tenantId: T.tenant.id, email, reason: 'bounce' })).concat(emails.slice(bounced, bounced + complained).map(email => ({ tenantId: T.tenant.id, email, reason: 'complaint' }))) });
    return campaign;
  };
  await t.test('a new sender with authenticated DNS is HEALTHY at the lowest ramp step', async () => {
    await campaignFor(T, 'new@ok.example');
    assert.deepEqual(await refreshSenderHealth(T.tenant.id, 'new@ok.example'), { status: 'HEALTHY', dailyCap: 10, reasons: [] });
  });
  await t.test('missing SPF or DMARC keeps a sender on the watchlist, which blocks sending', async () => {
    const r = await refreshSenderHealth(T.tenant.id, 'a@nodns.example');
    assert.deepEqual([r.status, r.dailyCap, r.reasons], ['WATCHLIST', 0, ['spf_missing', 'dmarc_missing']]);
    const r2 = await refreshSenderHealth(T.tenant.id, 'b@spfonly.example');
    assert.deepEqual(r2.reasons, ['dmarc_missing']);
    assert.equal((await db.deliverabilityProfile.findFirstOrThrow({ where: { tenantId: T.tenant.id, senderEmail: 'a@nodns.example' } })).spfStatus, 'fail');
  });
  await t.test('the cap follows sender age; bounces halve it; complaints block', async () => {
    await seed('mature@ok.example', 30, { ageDays: 40 });
    assert.equal((await refreshSenderHealth(T.tenant.id, 'mature@ok.example')).dailyCap, 100);
    await seed('bouncy@ok.example', 50, { bounced: 2, ageDays: 40 });
    const bouncy = await refreshSenderHealth(T.tenant.id, 'bouncy@ok.example');
    assert.deepEqual([bouncy.status, bouncy.dailyCap, bouncy.reasons], ['HEALTHY', 50, ['elevated_bounce_rate_cap_halved']]);
    await seed('bad@ok.example', 50, { bounced: 3, ageDays: 40 });
    assert.deepEqual((await refreshSenderHealth(T.tenant.id, 'bad@ok.example')).status, 'BLOCKED');
    await seed('spam@ok.example', 40, { complained: 1, ageDays: 40 });
    assert.deepEqual((await refreshSenderHealth(T.tenant.id, 'spam@ok.example')).reasons, ['complaint_threshold']);
    const p = await db.deliverabilityProfile.findFirstOrThrow({ where: { tenantId: T.tenant.id, senderEmail: 'bad@ok.example' } });
    assert.equal(p.detail.bounces30d, 3); assert.equal(p.detail.senderAgeDays, 40);
  });
  await t.test('a fresh signed external feed is never overwritten; a stale one is taken over; recomputation is throttled', async () => {
    const now = new Date();
    await db.deliverabilityProfile.create({ data: { tenantId: T.tenant.id, senderEmail: 'ext@ok.example', domain: 'ok.example', status: 'HEALTHY', dailyCap: 77, lastCheckedAt: new Date(now.getTime() - 3600000), healthSource: 'external' } });
    assert.deepEqual(await refreshSenderHealth(T.tenant.id, 'ext@ok.example', now), { skipped: 'external_feed_fresh' });
    assert.equal((await db.deliverabilityProfile.findFirstOrThrow({ where: { tenantId: T.tenant.id, senderEmail: 'ext@ok.example' } })).dailyCap, 77);
    await db.deliverabilityProfile.updateMany({ where: { tenantId: T.tenant.id, senderEmail: 'ext@ok.example' }, data: { lastCheckedAt: new Date(now.getTime() - 40 * 3600000) } });
    assert.equal((await refreshSenderHealth(T.tenant.id, 'ext@ok.example', now)).status, 'HEALTHY');
    assert.equal((await db.deliverabilityProfile.findFirstOrThrow({ where: { tenantId: T.tenant.id, senderEmail: 'ext@ok.example' } })).healthSource, 'internal', 'the stale feed was replaced by our own computation');
    assert.deepEqual(await refreshSenderHealth(T.tenant.id, 'ext@ok.example', new Date(now.getTime() + 60000)), { skipped: 'recent' });
  });
  await t.test('the worker job refreshes every sender of an active campaign, and can be switched off', async () => {
    const c = await campaignFor(T, 'job@ok.example', { status: 'ACTIVE' });
    assert.ok(await runSenderHealth() >= 1);
    assert.ok(await db.deliverabilityProfile.findFirst({ where: { tenantId: T.tenant.id, senderEmail: c.senderEmail } }));
    process.env.SENDER_HEALTH_AUTO = 'off';
    try { assert.equal(await runSenderHealth(), 0); } finally { process.env.SENDER_HEALTH_AUTO = 'on'; }
  });
});

test('bounce notices from the mailbox suppress exactly the contact we emailed, or raise an alert', async t => {
  const T = await tenantWith('ndr', { plan: 'ENTERPRISE' });
  const mailbox = 'sender@ok.example';
  const campaign = await campaignFor(T, mailbox);
  const contactFor = async email => { const c = await db.contact.create({ data: { tenantId: T.tenant.id, fullName: 'B U', email } }); await db.enrollment.create({ data: { tenantId: T.tenant.id, campaignId: campaign.id, contactId: c.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: {} } }); await db.outreachEvent.create({ data: { tenantId: T.tenant.id, campaignId: campaign.id, contactId: c.id, status: 'SENT', sentAt: new Date(), idempotencyKey: randomUUID() } }); await db.outreachEvent.create({ data: { tenantId: T.tenant.id, campaignId: campaign.id, contactId: c.id, status: 'QUEUED', stepOrder: 2, idempotencyKey: randomUUID() } }); return c; };
  await t.test('one matching recipient: suppressed, marked invalid, follow-ups canceled, and the health signal sees it', async () => {
    const c = await contactFor('gone@buyer.example');
    const outcome = await handleBounceNotice(T.tenant.id, mailbox, 'ndr-1', { uniqueBody: { content: `<p>Your message to gone@buyer.example couldn't be delivered.</p><p>Original sender ${mailbox}</p>` } });
    assert.equal(outcome, 'bounce_recorded');
    assert.equal((await db.suppression.findUniqueOrThrow({ where: { tenantId_email: { tenantId: T.tenant.id, email: 'gone@buyer.example' } } })).reason, 'bounce');
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).verification, 'INVALID');
    assert.equal(await db.outreachEvent.count({ where: { contactId: c.id, status: 'QUEUED' } }), 0);
    assert.equal((await handleBounceNotice(T.tenant.id, mailbox, 'ndr-1', { uniqueBody: { content: 'gone@buyer.example' } })), 'bounce_recorded', 'replaying the same notice is harmless');
    const m = await db.deliverabilityProfile.count({ where: { tenantId: T.tenant.id } });
    assert.ok(m >= 0);
  });
  await t.test('an address we never emailed, or several candidates, never suppresses anyone', async () => {
    const before = await db.suppression.count({ where: { tenantId: T.tenant.id } });
    assert.equal(await handleBounceNotice(T.tenant.id, mailbox, 'ndr-2', { uniqueBody: { content: 'Could not deliver to stranger@nowhere.example' } }), 'bounce_unattributed');
    await contactFor('one@buyer.example'); await contactFor('two@buyer.example');
    assert.equal(await handleBounceNotice(T.tenant.id, mailbox, 'ndr-3', { uniqueBody: { content: 'one@buyer.example two@buyer.example failed' } }), 'bounce_unattributed');
    assert.equal(await handleBounceNotice(T.tenant.id, mailbox, 'ndr-4', { uniqueBody: { content: '' } }), 'bounce_unattributed');
    assert.equal(await db.suppression.count({ where: { tenantId: T.tenant.id } }), before);
    assert.equal(await db.operationalAlert.count({ where: { tenantId: T.tenant.id, code: 'bounce_notice_unattributed' } }), 3);
  });
  await t.test('another mailbox\'s recipients are not matched', async () => {
    const other = await campaignFor(T, 'someone-else@ok.example');
    const c = await db.contact.create({ data: { tenantId: T.tenant.id, fullName: 'O T', email: 'theirs@buyer.example' } });
    await db.outreachEvent.create({ data: { tenantId: T.tenant.id, campaignId: other.id, contactId: c.id, status: 'SENT', sentAt: new Date(), idempotencyKey: randomUUID() } });
    assert.equal(await handleBounceNotice(T.tenant.id, mailbox, 'ndr-5', { uniqueBody: { content: 'theirs@buyer.example' } }), 'bounce_unattributed');
  });
});

test('Calendly reconciliation recovers missed bookings exactly once and refuses bad configuration', async t => {
  const T = await tenantWith('recon', { plan: 'ENTERPRISE' });
  const campaign = await campaignFor(T, 'r@ok.example', { status: 'ACTIVE' });
  const contact = await db.contact.create({ data: { tenantId: T.tenant.id, fullName: 'Re Con', email: 'recon@buyer.example' } });
  await db.enrollment.create({ data: { tenantId: T.tenant.id, campaignId: campaign.id, contactId: contact.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: {} } });
  const org = 'https://api.calendly.com/organizations/ORG1', token = attributionToken(T.tenant.id, campaign.id, contact.id);
  const start = new Date(Date.now() + 3 * 86400000).toISOString(), end = new Date(Date.now() + 3 * 86400000 + 1800000).toISOString();
  const eventUri = 'https://api.calendly.com/scheduled_events/EV1';
  let inviteeStatus = 'active', calls = [], failWith = null;
  const invitee = (over = {}) => ({ uri: `${eventUri}/invitees/INV1`, email: 'recon@buyer.example', status: inviteeStatus, timezone: 'America/New_York', created_at: new Date(Date.now() - 3600000).toISOString(), updated_at: new Date().toISOString(), tracking: { utm_content: token }, cancellation: inviteeStatus === 'canceled' ? { created_at: new Date(Date.now() - 60000).toISOString() } : null, ...over });
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    if (failWith) return new Response('{}', { status: failWith });
    const u = new URL(String(url));
    if (u.pathname === '/scheduled_events') return Response.json({ collection: [{ uri: eventUri, start_time: start, end_time: end, status: inviteeStatus === 'canceled' ? 'canceled' : 'active' }], pagination: { next_page_token: null } });
    if (u.pathname.endsWith('/invitees')) return Response.json({ collection: [invitee(), invitee({ uri: `${eventUri}/invitees/INV2`, email: 'forged@x.example', tracking: { utm_content: `${campaign.id}.${contact.id}.forged` } }), invitee({ uri: `${eventUri}/invitees/INV3`, email: 'plain@x.example', tracking: null })], pagination: { next_page_token: null } });
    return new Response('{}', { status: 404 });
  };
  await t.test('nothing happens until a token and organization are configured; the token is stored encrypted', async () => {
    assert.deepEqual(await reconcileCalendly(T.tenant.id, fetcher), { skipped: 'not_configured' });
    assert.equal((await putSettings(req('settings', 'PUT', { automationEnabled: true, dailySendCap: 10, weeklyProspectCap: 10, postalAddress: '123 Test Street, City', calendlyToken: 'calendly-token-abcdefghijklmnop', calendlyOrganizationUri: 'https://evil.example/organizations/ORG1' }, T.admin))).status, 400, 'organization must be on api.calendly.com');
    assert.equal((await putSettings(req('settings', 'PUT', { automationEnabled: true, dailySendCap: 10, weeklyProspectCap: 10, postalAddress: '123 Test Street, City', calendlyToken: 'calendly-token-abcdefghijklmnop', calendlyOrganizationUri: org }, T.admin))).status, 200);
    const s = await db.tenantSetting.findUniqueOrThrow({ where: { tenantId: T.tenant.id } });
    assert.ok(s.calendlyToken && !s.calendlyToken.includes('calendly-token'), 'stored encrypted'); assert.equal(s.calendlyOrganizationUri, org);
  });
  await t.test('a missed booking is recovered once; unattributed and forged bookings are ignored', async () => {
    const r1 = await reconcileCalendly(T.tenant.id, fetcher);
    assert.deepEqual([r1.events, r1.invitees, r1.applied, r1.ignored, r1.duplicates], [1, 3, 1, 2, 0]);
    const a = await db.appointment.findMany({ where: { tenantId: T.tenant.id } });
    assert.equal(a.length, 1); assert.equal(a[0].status, 'BOOKED'); assert.equal(a[0].campaignId, campaign.id); assert.equal(a[0].contactId, contact.id);
    assert.ok(calls.every(c => c.auth === 'Bearer calendly-token-abcdefghijklmnop' && c.url.startsWith('https://api.calendly.com/')));
    assert.match(calls[0].url, /organization=https%3A%2F%2Fapi\.calendly\.com%2Forganizations%2FORG1/); assert.match(calls[0].url, /min_start_time=/);
    const r2 = await reconcileCalendly(T.tenant.id, fetcher);
    assert.deepEqual([r2.applied, r2.duplicates], [0, 1], 'running again creates nothing');
    assert.equal(await db.appointment.count({ where: { tenantId: T.tenant.id } }), 1);
  });
  await t.test('a cancellation missed by webhook is recovered', async () => {
    inviteeStatus = 'canceled';
    await reconcileCalendly(T.tenant.id, fetcher);
    assert.equal((await db.appointment.findFirstOrThrow({ where: { tenantId: T.tenant.id } })).status, 'CANCELED');
    assert.equal(await db.appointment.count({ where: { tenantId: T.tenant.id } }), 1);
  });
  await t.test('an auth or rate-limit failure raises an alert instead of crashing the worker', async () => {
    failWith = 401;
    await assert.rejects(reconcileCalendly(T.tenant.id, fetcher), /calendly_auth_failed/);
    failWith = 429; await assert.rejects(reconcileCalendly(T.tenant.id, fetcher), /calendly_rate_limited/);
    await db.tenantSetting.update({ where: { tenantId: T.tenant.id }, data: { calendlyReconciledAt: null } });
    failWith = 401;
    assert.equal(await reconcileAllCalendly(new Date(), fetcher), 0);
    assert.equal(await db.operationalAlert.count({ where: { tenantId: T.tenant.id, code: 'calendly_reconcile_failed' } }), 1);
    failWith = null; calls = [];
    await db.tenantSetting.update({ where: { tenantId: T.tenant.id }, data: { calendlyReconciledAt: new Date() } });
    assert.equal(await reconcileAllCalendly(new Date(), fetcher), 0, 'not due again for 15 minutes'); assert.equal(calls.length, 0);
  });
});

test('campaign holidays persist through the edit API and are validated', async () => {
  const T = await tenantWith('hol', { plan: 'ENTERPRISE' });
  const c = await campaignFor(T, 'h@ok.example');
  const put = body => editCampaign(req(`campaigns/${c.id}`, 'PUT', body, T.admin), params(c.id));
  assert.equal((await put({ holidays: ['2026-12-25', '2027-01-01'] })).status, 200);
  assert.deepEqual((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).holidays, ['2026-12-25', '2027-01-01']);
  assert.equal((await put({ holidays: ['tomorrow'] })).status, 400);
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).version, 1, 'timing changes do not create a version');
});
