import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { pickVariant, evaluateExperiments, experimentResults } from '../../lib/experiments/index.ts';
import { sampleRatioMismatch } from '../../lib/experiments/stats.ts';
import { GET as listRoute, POST as createRoute, PATCH as statusRoute } from '../../app/api/experiments/route.ts';
import { POST as decisionRoute } from '../../app/api/experiments/[id]/decision/route.ts';
import { PUT as editCampaign } from '../../app/api/campaigns/[id]/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';

test('experiments: lifecycle, stable assignment, statistics-gated recommendations, human decision', async t => {
  const mk = async name => {
    const tenant = await db.tenant.create({ data: { name, slug: `${name}-${randomUUID()}`, users: { create: [{ email: `${name}-m-${randomUUID()}@example.com`, role: 'MANAGER' }, { email: `${name}-v-${randomUUID()}@example.com`, role: 'MEMBER' }] } }, include: { users: true } });
    const ck = async role => `${sessionCookie}=${await createSession(tenant.users.find(u => u.role === role).id)}`;
    return { tenant, manager: await ck('MANAGER'), member: await ck('MEMBER') };
  };
  const A = await mk('ea'), B = await mk('eb');
  const req = (path, method, body, cookie = '') => new Request(`http://localhost:3000/api/${path}`, { method, headers: { cookie, origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const params = id => ({ params: Promise.resolve({ id }) });
  const icps = {};
  const icpFor = async T => icps[T.tenant.id] ??= (await db.iCP.create({ data: { tenantId: T.tenant.id, name: 'QA', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring'] } })).id;
  const newCampaign = async (T, name) => db.campaign.create({ data: { tenantId: T.tenant.id, icpId: await icpFor(T), name, senderName: 'S', senderEmail: `${randomUUID()}@example.com`, calendlyUrl: 'https://calendly.com/x', status: 'PAUSED', automationMode: 'REVIEW_BEFORE_SEND', sequenceSteps: { create: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Control subject', body: 'Control body {{firstName}}' }, { stepOrder: 2, waitBusinessDays: 2, subject: 'Follow up', body: 'Following up' }] } } });
  const spec = (campaignId, extra = {}) => ({ campaignId, stepOrder: 1, name: 'Subject test', minSample: 100, variants: [{ label: 'B', subject: 'Variant subject', body: 'Variant body {{firstName}}' }], ...extra });
  const create = async (T, body, cookie = T.manager) => createRoute(req('experiments', 'POST', body, cookie));
  const start = async (T, id) => statusRoute(req('experiments', 'PATCH', { id, status: 'RUNNING' }, T.manager));
  // Seed one arm's outcomes directly: n enrollments that were assigned and sent step 1.
  const seedArm = async (T, campaign, experiment, variant, n, positives, unsubs = 0) => {
    const contacts = Array.from({ length: n }, () => ({ id: randomUUID(), tenantId: T.tenant.id, fullName: 'X Y', email: `${randomUUID()}@example.com` }));
    await db.contact.createMany({ data: contacts });
    const enrollments = contacts.map(c => ({ id: randomUUID(), tenantId: T.tenant.id, campaignId: campaign.id, contactId: c.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: {} }));
    await db.enrollment.createMany({ data: enrollments });
    await db.experimentAssignment.createMany({ data: enrollments.map(e => ({ tenantId: T.tenant.id, experimentId: experiment.id, variantId: variant.id, enrollmentId: e.id })) });
    await db.outreachEvent.createMany({ data: contacts.map(c => ({ tenantId: T.tenant.id, campaignId: campaign.id, contactId: c.id, stepOrder: 1, status: 'SENT', sentAt: new Date(), idempotencyKey: randomUUID() })) });
    if (positives) await db.reply.createMany({ data: contacts.slice(0, positives).map(c => ({ tenantId: T.tenant.id, contactId: c.id, intent: 'POSITIVE', rawSnippet: 'yes' })) });
    if (unsubs) await db.suppression.createMany({ data: contacts.slice(n - unsubs).map(c => ({ tenantId: T.tenant.id, email: c.email, reason: 'unsubscribe' })) });
  };
  const arms = e => Object.fromEntries(e.variants.map(v => [v.label, v]));

  await t.test('creation is validated, role-checked and tenant-scoped', async () => {
    const c = await newCampaign(A, 'Validation');
    assert.equal((await create(A, spec(c.id), A.member)).status, 403, 'members cannot create');
    assert.equal((await create(A, spec(c.id), '')).status, 401);
    assert.equal((await create(A, spec(c.id, { variants: [{ label: 'B', subject: '{{nope}}', body: 'x' }] }))).status, 400, 'unknown template variable');
    assert.equal((await create(A, spec(c.id, { variants: [{ label: 'control', subject: 's', body: 'b' }] }))).status, 400, 'reserved label');
    assert.equal((await create(A, spec(c.id, { variants: [{ label: 'B', subject: 's', body: 'b' }, { label: 'b', subject: 's2', body: 'b2' }] }))).status, 400, 'duplicate label');
    assert.equal((await create(A, spec(c.id, { stepOrder: 7 }))).status, 404, 'no such step');
    assert.equal((await create(B, spec(c.id), B.manager)).status, 404, 'other tenant cannot target this campaign');
    const ok = await create(A, spec(c.id));
    assert.equal(ok.status, 201);
    const e = await ok.json();
    assert.deepEqual(e.variants.map(v => [v.label, v.isControl]).sort(), [['B', false], ['control', true]]);
    await assert.rejects(db.experimentVariant.create({ data: { tenantId: A.tenant.id, experimentId: e.id, label: 'second-control', isControl: true } }), 'a second control (and a control-less copy) is refused by the database');
    await db.$disconnect(); // PGlite closes the connection after a raised constraint error
  });
  await t.test('start rules: one running experiment per step, and the tested copy is frozen while it runs', async () => {
    const c = await newCampaign(A, 'Lifecycle');
    const e1 = await (await create(A, spec(c.id))).json(), e2 = await (await create(A, spec(c.id, { name: 'Second' }))).json();
    assert.equal((await start(A, e1.id)).status, 200);
    assert.equal((await start(A, e1.id)).status, 409, 'already running');
    assert.equal((await start(A, e2.id)).status, 409, 'second experiment on the same step refused');
    await db.$disconnect(); // PGlite closes the connection after a raised unique violation
    assert.equal((await start(B, e2.id)).status, 404, 'other tenant cannot start');
    const edit = body => editCampaign(req(`campaigns/${c.id}`, 'PUT', body, A.manager), params(c.id));
    assert.equal((await edit({ sequenceSteps: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Changed control', body: 'Control body {{firstName}}' }, { stepOrder: 2, waitBusinessDays: 2, subject: 'Follow up', body: 'Following up' }] })).status, 409);
    assert.equal((await edit({ sequenceSteps: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Control subject', body: 'Control body {{firstName}}' }, { stepOrder: 2, waitBusinessDays: 2, subject: 'Follow up v2', body: 'Different follow up' }] })).status, 200, 'other steps stay editable');
    assert.equal((await edit({ dailySendCap: 9 })).status, 200);
    assert.equal((await statusRoute(req('experiments', 'PATCH', { id: e1.id, status: 'STOPPED' }, A.manager))).status, 200);
    assert.equal((await start(A, e2.id)).status, 200, 'step is free once the first stops');
  });
  await t.test('assignment is stable, persisted, follows the weights, and control keeps the original copy', async () => {
    const c = await newCampaign(A, 'Assignment');
    const e = await (await create(A, spec(c.id))).json();
    await start(A, e.id);
    const ids = Array.from({ length: 300 }, () => randomUUID()), contacts = ids.map(() => ({ id: randomUUID(), tenantId: A.tenant.id, fullName: 'A B', email: `${randomUUID()}@example.com` }));
    await db.contact.createMany({ data: contacts });
    await db.enrollment.createMany({ data: ids.map((id, i) => ({ id, tenantId: A.tenant.id, campaignId: c.id, contactId: contacts[i].id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: {} })) });
    const pick = id => db.$transaction(tx => pickVariant(tx, A.tenant.id, c.id, id, 1));
    const first = [];
    for (const id of ids) first.push(await pick(id));
    const second = [];
    for (const id of ids.slice(0, 50)) second.push(await pick(id));
    assert.deepEqual(second, first.slice(0, 50), 'same enrollment always gets the same arm');
    assert.equal(await db.experimentAssignment.count({ where: { experimentId: e.id } }), 300, 'one persisted assignment per enrollment');
    const variantCount = first.filter(Boolean).length;
    assert.ok(first.filter(Boolean).every(v => v.subject === 'Variant subject'));
    assert.ok(sampleRatioMismatch([300 - variantCount, variantCount], [1, 1]).p > 0.001, `1:1 split looks sound (${variantCount}/300)`);
    assert.equal(await db.$transaction(tx => pickVariant(tx, A.tenant.id, c.id, ids[0], 2)), null, 'other steps are never touched');
    assert.equal(await db.$transaction(tx => pickVariant(tx, B.tenant.id, c.id, ids[0], 1)), null, 'no cross-tenant experiment lookup');
  });
  await t.test('a real winner is recommended once; insufficient data and unsubscribe-driven wins are not', async () => {
    // Winner: 10% vs ~27% over 150 sends each.
    const cw = await newCampaign(A, 'Winner');
    const ew = await (await create(A, spec(cw.id))).json(); await start(A, ew.id);
    const full = await db.experiment.findUniqueOrThrow({ where: { id: ew.id }, include: { variants: true } }), v = arms(full);
    await seedArm(A, cw, full, v.control, 150, 15); await seedArm(A, cw, full, v.B, 150, 40);
    // Not enough data.
    const cs = await newCampaign(A, 'Small');
    const es = await (await create(A, spec(cs.id))).json(); await start(A, es.id);
    const fs = await db.experiment.findUniqueOrThrow({ where: { id: es.id }, include: { variants: true } }), sv = arms(fs);
    await seedArm(A, cs, fs, sv.control, 30, 1); await seedArm(A, cs, fs, sv.B, 30, 15);
    // Wins on replies but drives unsubscribes.
    const cg = await newCampaign(A, 'Guardrail');
    const eg = await (await create(A, spec(cg.id))).json(); await start(A, eg.id);
    const fg = await db.experiment.findUniqueOrThrow({ where: { id: eg.id }, include: { variants: true } }), gv = arms(fg);
    await seedArm(A, cg, fg, gv.control, 150, 15, 2); await seedArm(A, cg, fg, gv.B, 150, 40, 40);

    assert.equal(await evaluateExperiments(), 1);
    assert.equal(await evaluateExperiments(), 0, 'no duplicate recommendation');
    assert.equal(await db.experimentRecommendation.count({ where: { experimentId: ew.id } }), 1);
    assert.equal(await db.experimentRecommendation.count({ where: { experimentId: { in: [es.id, eg.id] } } }), 0);
    assert.equal((await experimentResults(A.tenant.id, es.id)).verdict.status, 'INSUFFICIENT_DATA');
    assert.equal((await experimentResults(A.tenant.id, eg.id)).verdict.status, 'GUARDRAIL_BLOCKED');
    const res = await (await listRoute(req(`experiments?id=${ew.id}`, 'GET', undefined, A.manager))).json();
    assert.equal(res.verdict.status, 'WINNER');
    assert.deepEqual(res.arms.map(a => [a.label, a.sent, a.primary]).sort(), [['B', 150, 40], ['control', 150, 15]]);
    await assert.rejects(experimentResults(B.tenant.id, ew.id), /experiment_not_found/, 'other tenant cannot read results');
  });
  await t.test('only a human decision applies the winner, through the normal version history', async () => {
    const rec = await db.experimentRecommendation.findFirstOrThrow({ where: { tenantId: A.tenant.id, status: 'OPEN' }, include: { experiment: true } });
    assert.equal((await decisionRoute(req('x', 'POST', { decision: 'accept' }, B.manager), params(rec.id))).status, 404, 'other tenant cannot decide');
    assert.equal((await decisionRoute(req('x', 'POST', { decision: 'accept' }, A.member), params(rec.id))).status, 403);
    const before = await db.campaign.findUniqueOrThrow({ where: { id: rec.experiment.campaignId } });
    assert.equal(before.version, 1, 'nothing changed before the decision');
    const queued = await db.outreachEvent.create({ data: { tenantId: A.tenant.id, campaignId: before.id, stepOrder: 1, status: 'QUEUED', approvedAt: new Date(), idempotencyKey: randomUUID() } });
    const res = await decisionRoute(req('x', 'POST', { decision: 'accept' }, A.manager), params(rec.id));
    assert.equal(res.status, 200); assert.equal((await res.json()).applied, true);
    const after = await db.campaign.findUniqueOrThrow({ where: { id: before.id }, include: { sequenceSteps: { orderBy: { stepOrder: 'asc' } } } });
    assert.equal(after.version, 2);
    assert.deepEqual([after.sequenceSteps[0].subject, after.sequenceSteps[1].subject], ['Variant subject', 'Follow up'], 'only the tested step changed');
    assert.equal((await db.campaignVersion.findFirstOrThrow({ where: { campaignId: before.id, version: 2 } })).reason, `experiment_winner_${rec.experimentId}`);
    assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: queued.id } })).approvedAt, null, 'earlier approvals were revoked');
    assert.equal((await db.experiment.findUniqueOrThrow({ where: { id: rec.experimentId } })).status, 'CONCLUDED');
    assert.equal((await db.experimentRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status, 'ACCEPTED');
    assert.equal((await decisionRoute(req('x', 'POST', { decision: 'accept' }, A.manager), params(rec.id))).status, 404, 'a decision is final');
  });
  await t.test('rejecting keeps the copy unchanged, leaves the test running and is not re-recommended', async () => {
    const c = await newCampaign(A, 'Reject');
    const e = await (await create(A, spec(c.id))).json(); await start(A, e.id);
    const full = await db.experiment.findUniqueOrThrow({ where: { id: e.id }, include: { variants: true } }), v = arms(full);
    await seedArm(A, c, full, v.control, 150, 15); await seedArm(A, c, full, v.B, 150, 40);
    assert.equal(await evaluateExperiments(), 1);
    const rec = await db.experimentRecommendation.findFirstOrThrow({ where: { experimentId: e.id } });
    assert.equal((await decisionRoute(req('x', 'POST', { decision: 'reject' }, A.manager), params(rec.id))).status, 200);
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).version, 1);
    assert.equal((await db.experiment.findUniqueOrThrow({ where: { id: e.id } })).status, 'RUNNING');
    assert.equal(await evaluateExperiments(), 0, 'rejected winner is not proposed again');
    assert.equal((await db.experimentRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status, 'REJECTED');
    assert.equal(await db.auditEvent.count({ where: { tenantId: A.tenant.id, action: { in: ['experiment_recommendation_accepted', 'experiment_recommendation_rejected'] } } }), 2);
  });
});
