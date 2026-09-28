import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { reserveProviderSpend, settleProviderSpend, usageSummary } from '../../lib/usage.ts';
import { PUT as editCampaign, GET as getVersions } from '../../app/api/campaigns/[id]/route.ts';
import { POST as rollback } from '../../app/api/campaigns/[id]/rollback/route.ts';
import { POST as clone } from '../../app/api/campaigns/[id]/clone/route.ts';
import { POST as suspend } from '../../app/api/admin/tenants/[id]/suspend/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';

const steps = [{ stepOrder: 1, waitBusinessDays: 0, subject: 'QA help', body: 'Hi {{firstName}}, {{calendlyUrl}}' }, { stepOrder: 2, waitBusinessDays: 2, subject: 'Following up', body: 'Still relevant, {{firstName}}?' }];

test('campaign versioning, isolation, clone/rollback, spend caps and suspension', async t => {
  const mk = async name => {
    const tenant = await db.tenant.create({ data: { name, slug: `${name}-${randomUUID()}`, settings: { create: { automationEnabled: true, postalAddress: '123 Test Street' } }, users: { create: [{ email: `admin-${randomUUID()}@example.com`, role: 'TENANT_ADMIN' }, { email: `root-${randomUUID()}@example.com`, role: 'SUPER_ADMIN' }] } }, include: { users: true } });
    const admin = tenant.users.find(u => u.role === 'TENANT_ADMIN'), root = tenant.users.find(u => u.role === 'SUPER_ADMIN');
    return { tenant, adminCookie: `${sessionCookie}=${await createSession(admin.id)}`, rootCookie: `${sessionCookie}=${await createSession(root.id)}` };
  };
  const A = await mk('va'), B = await mk('vb');
  const req = (path, method, body, cookie) => new Request(`http://localhost:3000/api/${path}`, { method, headers: { cookie, origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const params = id => ({ params: Promise.resolve({ id }) });
  const icp = await db.iCP.create({ data: { tenantId: A.tenant.id, name: 'QA', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'] } });
  const campaign = await db.campaign.create({ data: { tenantId: A.tenant.id, icpId: icp.id, name: 'Base', senderName: 'Sender', senderEmail: 'sender@example.com', calendlyUrl: 'https://calendly.com/test', status: 'ACTIVE', automationMode: 'REVIEW_BEFORE_SEND', sequenceSteps: { create: steps } } });
  const lead = await db.lead.create({ data: { tenantId: A.tenant.id, company: 'Co', domain: 'co.example' } });
  const contact = await db.contact.create({ data: { tenantId: A.tenant.id, leadId: lead.id, fullName: 'Buyer One', email: 'buyer1@example.com' } });
  const queued = await db.outreachEvent.create({ data: { tenantId: A.tenant.id, campaignId: campaign.id, contactId: contact.id, leadId: lead.id, stepOrder: 2, status: 'QUEUED', approvedAt: new Date(), idempotencyKey: `q-${randomUUID()}` } });
  const put = (cookie, body, id = campaign.id) => editCampaign(req(`campaigns/${id}`, 'PUT', body, cookie), params(id));

  await t.test('non-material edit does not create a version; material edit does, keeps a baseline and revokes approvals', async () => {
    let res = await put(A.adminCookie, { dailySendCap: 10, name: 'Renamed' });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.material, false); assert.equal(body.version, 1);
    assert.equal(await db.campaignVersion.count({ where: { campaignId: campaign.id } }), 0);
    res = await put(A.adminCookie, { sequenceSteps: [{ ...steps[0], body: 'Hi {{firstName}}, new copy {{calendlyUrl}}' }, steps[1]] });
    body = await res.json();
    assert.equal(res.status, 200); assert.equal(body.material, true); assert.equal(body.version, 2);
    const versions = await db.campaignVersion.findMany({ where: { campaignId: campaign.id }, orderBy: { version: 'asc' } });
    assert.deepEqual(versions.map(v => [v.version, v.reason]), [[1, 'baseline'], [2, 'edit']]);
    assert.equal((await db.outreachEvent.findUnique({ where: { id: queued.id } })).approvedAt, null, 'prior approval invalidated');
    assert.equal((await db.auditEvent.count({ where: { tenantId: A.tenant.id, action: 'campaign_version_created', entityId: campaign.id } })), 1);
    assert.equal((await (await getVersions(req(`campaigns/${campaign.id}`, 'GET', undefined, A.adminCookie), params(campaign.id))).json()).versions.length, 2);
  });
  await t.test('invalid edits are rejected with the same rules as creation; unknown fields refused', async () => {
    assert.equal((await put(A.adminCookie, { sequenceSteps: [{ ...steps[0], body: '{{bogus}}' }] })).status, 400);
    assert.equal((await put(A.adminCookie, { sequenceSteps: [steps[0], { ...steps[1], stepOrder: 3 }] })).status, 400);
    assert.equal((await put(A.adminCookie, { tenantId: B.tenant.id })).status, 400);
    assert.equal((await put(A.adminCookie, { status: 'ACTIVE' })).status, 400);
    assert.equal((await put(A.adminCookie, { sendStartHour: 20, sendEndHour: 10 })).status, 400);
    assert.equal((await db.campaign.findUnique({ where: { id: campaign.id } })).version, 2);
  });
  await t.test('another tenant cannot read, edit, clone or roll back the campaign; foreign ICP refused', async () => {
    assert.equal((await put(B.adminCookie, { name: 'hijack' })).status, 404);
    assert.equal((await getVersions(req(`campaigns/${campaign.id}`, 'GET', undefined, B.adminCookie), params(campaign.id))).status, 404);
    assert.equal((await clone(req('x', 'POST', {}, B.adminCookie), params(campaign.id))).status, 404);
    assert.equal((await rollback(req('x', 'POST', { version: 1 }, B.adminCookie), params(campaign.id))).status, 404);
    const foreignIcp = await db.iCP.create({ data: { tenantId: B.tenant.id, name: 'B', offer: 'B', industries: ['x'], companySizes: ['x'], geographies: ['x'], buyerTitles: ['x'], buyingSignals: ['x'] } });
    assert.equal((await put(A.adminCookie, { icpId: foreignIcp.id })).status, 404);
    assert.equal((await put('', { name: 'anon' })).status, 401);
  });
  await t.test('changing the sender of an active campaign pauses it until readiness is re-proven', async () => {
    const res = await put(A.adminCookie, { senderEmail: 'other@example.com' });
    assert.equal(res.status, 200);
    const c = await db.campaign.findUnique({ where: { id: campaign.id } });
    assert.equal(c.status, 'PAUSED'); assert.equal(c.version, 3);
  });
  await t.test('rollback restores old content as a new version without rewriting history', async () => {
    const res = await rollback(req('x', 'POST', { version: 1 }, A.adminCookie), params(campaign.id));
    assert.equal(res.status, 200);
    const c = await db.campaign.findUnique({ where: { id: campaign.id }, include: { sequenceSteps: { orderBy: { stepOrder: 'asc' } } } });
    assert.equal(c.version, 4); assert.equal(c.senderEmail, 'sender@example.com');
    assert.equal(c.sequenceSteps[0].body, steps[0].body);
    assert.equal((await db.campaignVersion.findMany({ where: { campaignId: campaign.id } })).length, 4);
    assert.equal((await rollback(req('x', 'POST', { version: 99 }, A.adminCookie), params(campaign.id))).status, 404);
  });
  await t.test('clone is an independent draft with no enrollments or approvals', async () => {
    await db.enrollment.create({ data: { tenantId: A.tenant.id, campaignId: campaign.id, contactId: contact.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: {} } });
    const res = await clone(req('x', 'POST', { name: 'Copy' }, A.adminCookie), params(campaign.id));
    assert.equal(res.status, 201);
    const copy = await res.json();
    assert.equal(copy.status, 'DRAFT'); assert.equal(copy.name, 'Copy'); assert.equal(copy.version, 1); assert.notEqual(copy.id, campaign.id);
    assert.equal(copy.sequenceSteps.length, 2);
    assert.equal(await db.enrollment.count({ where: { campaignId: copy.id } }), 0);
  });
  await t.test('spend cap is enforced by reservation, retries reuse it, settlement releases unused spend', async () => {
    await db.tenantSetting.update({ where: { tenantId: A.tenant.id }, data: { monthlySpendCapCents: 500, providerCostCents: 100 } });
    const first = await reserveProviderSpend(A.tenant.id, campaign.id, 'k1', 3);
    assert.deepEqual(first, { quantity: 3, reason: 'ok' });
    assert.deepEqual(await reserveProviderSpend(A.tenant.id, campaign.id, 'k1', 3), { quantity: 3, reason: 'ok' }, 'retry does not re-reserve');
    assert.deepEqual(await reserveProviderSpend(A.tenant.id, campaign.id, 'k2', 5), { quantity: 2, reason: 'spend_cap' });
    assert.deepEqual(await reserveProviderSpend(A.tenant.id, campaign.id, 'k3', 5), { quantity: 0, reason: 'spend_cap' });
    assert.equal((await usageSummary(A.tenant.id)).spentCents, 500);
    await settleProviderSpend(A.tenant.id, 'k1', 1);
    const summary = await usageSummary(A.tenant.id);
    assert.equal(summary.spentCents, 300); assert.equal(summary.remainingCents, 200);
    assert.equal((await reserveProviderSpend(A.tenant.id, campaign.id, 'k4', 9)).quantity, 2);
  });
  await t.test('concurrent reservations never exceed the cap (PGlite serializes sessions; native PG needs its own run)', async () => {
    await db.tenantSetting.update({ where: { tenantId: B.tenant.id }, data: { monthlySpendCapCents: 500, providerCostCents: 100 } });
    const results = await Promise.all([1, 2, 3, 4].map(i => reserveProviderSpend(B.tenant.id, null, `c${i}`, 2)));
    assert.ok(results.reduce((n, r) => n + r.quantity, 0) <= 5);
    assert.ok((await usageSummary(B.tenant.id)).spentCents <= 500);
  });
  await t.test('cap of zero blocks all purchases; ledger cannot go negative; cross-tenant ledger rows are isolated', async () => {
    await db.tenantSetting.update({ where: { tenantId: B.tenant.id }, data: { monthlySpendCapCents: 0 } });
    assert.equal((await reserveProviderSpend(B.tenant.id, null, 'z1', 5)).quantity, 0);
    await assert.rejects(db.usageLedger.create({ data: { tenantId: B.tenant.id, kind: 'X', quantity: -1, costCents: 0, idempotencyKey: 'neg' } }));
    await db.$disconnect(); // PGlite closes the connection after a raised constraint error
    assert.equal((await usageSummary(A.tenant.id)).byKind.length, 1);
  });
  await t.test('suspension: only super admin can set it; suspended tenant reserves no provider spend', async () => {
    assert.equal((await suspend(req('x', 'POST', { suspended: true }, A.adminCookie), params(A.tenant.id))).status, 403);
    assert.equal((await suspend(req('x', 'POST', { suspended: true }, A.rootCookie), params(A.tenant.id))).status, 200);
    await db.tenantSetting.update({ where: { tenantId: A.tenant.id }, data: { monthlySpendCapCents: null } });
    assert.deepEqual(await reserveProviderSpend(A.tenant.id, campaign.id, 'susp', 1), { quantity: 0, reason: 'tenant_suspended' });
    assert.equal((await suspend(req('x', 'POST', { suspended: false }, A.rootCookie), params(A.tenant.id))).status, 200);
    assert.equal((await reserveProviderSpend(A.tenant.id, campaign.id, 'unsusp', 1)).quantity, 1);
  });
});
