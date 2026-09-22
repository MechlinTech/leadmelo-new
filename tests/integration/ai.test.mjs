import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { hashPassword, decrypt } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { PUT as putSettings, GET as getSettings } from '../../app/api/settings/route.ts';
import { GET as aiStatus } from '../../app/api/ai/status/route.ts';
import { POST as aiTest } from '../../app/api/ai/test/route.ts';
import { POST as aiAssist } from '../../app/api/ai/assist/route.ts';
import { POST as aiReply } from '../../app/api/ai/reply/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';
const ORIGIN = 'http://localhost:3000';
const req = (path, method = 'GET', body, cookie = '') => new Request(`${ORIGIN}/api/${path}`, { method, headers: { origin: ORIGIN, 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

const good = { name: 'QA leaders', offer: 'Move Selenium suites to Playwright', icp: { industries: ['SaaS'], companySizes: ['50-200'], geographies: ['US'], buyingSignals: ['Hiring SDET'], buyerTitles: ['VP Engineering'] }, steps: [{ waitBusinessDays: 0, subject: 'QA at {{company}}', body: 'Hi {{firstName}}, {{calendlyUrl}}' }, { waitBusinessDays: 3, subject: 'Re: QA', body: 'Following up. {{calendlyUrl}}' }] };
let seenAuth = [], mode = 'good';
const server = http.createServer((rq, res) => {
  let raw = ''; rq.on('data', d => raw += d); rq.on('end', () => {
    seenAuth.push(rq.headers.authorization ?? null);
    const b = JSON.parse(raw); const prompt = b.messages.map(m => m.content).join('\n');
    const content = /prospect_reply/.test(prompt) ? { intent: 'POSITIVE', summary: 'Wants a call', suggestedReply: 'Great, {{calendlyUrl}}' } : /single word: ready/.test(prompt) ? 'ready' : good;
    if (mode === 'down') { res.statusCode = 503; return res.end('{}'); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.AI_ALLOWED_HOSTS = `127.0.0.1:${port}`;
const URL_ = `http://127.0.0.1:${port}/v1`;

async function tenant(name) {
  const t = await db.tenant.create({ data: { name, slug: `${name}-${randomUUID()}`, plan: 'GROWTH', settings: { create: { postalAddress: '123 Test Street' } }, users: { create: ['TENANT_ADMIN', 'MANAGER', 'MEMBER'].map(role => ({ email: `${role.toLowerCase()}-${randomUUID()}@example.com`, name: role, role, passwordHash: hashPassword('a-long-test-password-1') })) } }, include: { users: true } });
  const c = async role => `${sessionCookie}=${await createSession(t.users.find(u => u.role === role).id)}`;
  return { t, admin: await c('TENANT_ADMIN'), manager: await c('MANAGER'), member: await c('MEMBER') };
}
const base = { automationEnabled: false, dailySendCap: 50, weeklyProspectCap: 50, postalAddress: '123 Test Street' };
const enable = (A, extra = {}) => putSettings(req('settings', 'PUT', { ...base, aiEnabled: true, aiBaseUrl: URL_, aiModel: 'llama3', aiFeatures: ['campaign_assist', 'reply_assist'], ...extra }, A.admin));

test('AI is off by default and every AI route says so plainly', async () => {
  const A = await tenant('ai-off');
  assert.deepEqual(await (await aiStatus(req('ai/status', 'GET', undefined, A.admin))).json(), { enabled: false, features: [], canUse: true });
  const res = await aiAssist(req('ai/assist', 'POST', { description: 'We sell QA automation to SaaS companies.' }, A.admin));
  assert.equal(res.status, 409); assert.equal((await res.json()).error, 'ai_not_enabled');
});

test('settings: admin configures AI; the key is encrypted and never returned; unsafe URLs are refused', async t => {
  const A = await tenant('ai-cfg');
  await t.test('only admins may change it', async () => {
    assert.equal((await enable(A)).status, 200);
    const r = await putSettings(req('settings', 'PUT', { ...base, aiEnabled: false }, A.manager)); assert.equal(r.status, 403);
  });
  await t.test('key stored encrypted, reported only as configured', async () => {
    assert.equal((await enable(A, { aiKey: 'sk-test-secret-key-value' })).status, 200);
    const row = await db.tenantSetting.findUniqueOrThrow({ where: { tenantId: A.t.id } });
    assert.notEqual(row.aiKey, 'sk-test-secret-key-value'); assert.equal(decrypt(row.aiKey), 'sk-test-secret-key-value');
    const body = await (await getSettings(req('settings', 'GET', undefined, A.admin))).json();
    assert.equal(body.aiKeyConfigured, true); assert.equal(body.aiModel, 'llama3'); assert.ok(!JSON.stringify(body).includes('sk-test-secret'));
  });
  await t.test('a blank key on a later save keeps the stored one', async () => {
    await enable(A, { aiKey: '' });
    assert.equal(decrypt((await db.tenantSetting.findUniqueOrThrow({ where: { tenantId: A.t.id } })).aiKey), 'sk-test-secret-key-value');
  });
  await t.test('private and plain-http URLs that are not allow-listed are refused at save time', async () => {
    for (const u of ['http://10.0.0.1/v1', 'https://169.254.169.254/v1', 'http://example.com/v1']) { const r = await enable(A, { aiBaseUrl: u }); assert.equal(r.status, 400, u); assert.match((await r.json()).error, /ai_url_rejected/); }
  });
  await t.test('enabling without a URL is refused', async () => {
    const B = await tenant('ai-nourl');
    const r = await putSettings(req('settings', 'PUT', { ...base, aiEnabled: true }, B.admin)); assert.equal(r.status, 400);
  });
});

test('campaign assist: validated suggestion, tenant key sent, viewers blocked, feature switch and daily limit respected', async t => {
  const A = await tenant('ai-assist'); await enable(A, { aiKey: 'sk-abc-123456789012' });
  const ask = (cookie = A.manager) => aiAssist(req('ai/assist', 'POST', { description: 'We migrate QA suites from Selenium to Playwright for SaaS teams.' }, cookie));
  await t.test('manager gets a suggestion built from the model output', async () => {
    seenAuth = []; const r = await ask(); assert.equal(r.status, 200);
    const body = await r.json(); assert.equal(body.suggestion.steps.length, 2); assert.equal(body.suggestion.icp.buyerTitles[0], 'VP Engineering'); assert.match(body.notice, /Review every line/);
    assert.deepEqual(seenAuth, ['Bearer sk-abc-123456789012']);
  });
  await t.test('a read-only member cannot use it', async () => { assert.equal((await ask(A.member)).status, 403); });
  await t.test('a short description is rejected before any model call', async () => {
    seenAuth = []; const r = await aiAssist(req('ai/assist', 'POST', { description: 'too short' }, A.manager)); assert.equal(r.status, 400); assert.equal(seenAuth.length, 0);
  });
  await t.test('a model outage is a clean 502, not a crash', async () => {
    mode = 'down'; try { const r = await ask(); assert.equal(r.status, 502); assert.match((await r.json()).error, /ai_provider_error_503/); } finally { mode = 'good'; }
  });
  await t.test('turning the feature off blocks it', async () => {
    await enable(A, { aiFeatures: ['reply_assist'] }); const r = await ask(); assert.equal(r.status, 409); assert.equal((await r.json()).error, 'ai_feature_off'); await enable(A);
  });
  await t.test('the per-tenant daily limit stops runaway use', async () => {
    process.env.AI_DAILY_LIMIT = '2';
    try {
      const used = await db.auditEvent.count({ where: { tenantId: A.t.id, action: 'ai_call' } });
      await db.auditEvent.createMany({ data: Array.from({ length: Math.max(0, 2 - used) }, () => ({ tenantId: A.t.id, action: 'ai_call' })) });
      const r = await ask(); assert.equal(r.status, 429); assert.equal((await r.json()).error, 'ai_daily_limit');
    } finally { delete process.env.AI_DAILY_LIMIT; }
  });
  await t.test('test-connection works for admins only', async () => {
    const B = await tenant('ai-test'); await enable(B);
    const ok = await aiTest(req('ai/test', 'POST', {}, B.admin)); assert.equal(ok.status, 200); assert.equal((await ok.json()).sample, 'ready');
    assert.equal((await aiTest(req('ai/test', 'POST', {}, B.manager))).status, 403);
  });
});

test('reply assist: tenant-scoped, advisory only, and never touches stored intent or suppression', async t => {
  const A = await tenant('ai-reply'), B = await tenant('ai-reply-other'); await enable(A);
  const contact = await db.contact.create({ data: { tenantId: A.t.id, fullName: 'Pat', email: `pat-${randomUUID()}@buyer.example` } });
  const positive = await db.reply.create({ data: { tenantId: A.t.id, contactId: contact.id, intent: 'POSITIVE', rawSnippet: 'Yes, interested. Send a time.' } });
  const optout = await db.reply.create({ data: { tenantId: A.t.id, contactId: contact.id, intent: 'NEGATIVE', rawSnippet: 'Please stop emailing me.' } });
  await t.test('drafts a reply for a positive reply', async () => {
    const r = await aiReply(req('ai/reply', 'POST', { replyId: positive.id }, A.manager)); assert.equal(r.status, 200);
    const { insight } = await r.json(); assert.equal(insight.agrees, true); assert.match(insight.suggestedReply, /calendlyUrl/);
  });
  await t.test('an opt-out gets no drafted reply', async () => {
    const { insight } = await (await aiReply(req('ai/reply', 'POST', { replyId: optout.id }, A.manager))).json();
    assert.equal(insight.suggestedReply, ''); assert.match(insight.note, /should not receive further outreach/);
  });
  await t.test('nothing was changed in the database', async () => {
    assert.equal((await db.reply.findUniqueOrThrow({ where: { id: positive.id } })).intent, 'POSITIVE');
    assert.equal(await db.suppression.count({ where: { tenantId: A.t.id } }), 0);
  });
  await t.test('another tenant cannot analyse this tenant reply', async () => { await enable(B); assert.equal((await aiReply(req('ai/reply', 'POST', { replyId: positive.id }, B.admin))).status, 404); });
  await t.test('viewers are refused', async () => { assert.equal((await aiReply(req('ai/reply', 'POST', { replyId: positive.id }, A.member))).status, 403); });
});

test.after(() => { server.close(); return db.$disconnect(); });
