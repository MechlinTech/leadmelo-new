import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { applyRetention, exportErasureLedger, reapplyErasures, REDACTED } from '../../lib/privacy.ts';
import { POST as exportRoute } from '../../app/api/privacy/export/route.ts';
import { POST as eraseRoute } from '../../app/api/privacy/erase/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString('base64');
process.env.SESSION_SECRET = 'synthetic-test-secret'.repeat(4);
process.env.APP_URL = 'http://localhost:3000';

test('data-subject export, erasure, restore re-application and retention', async t => {
  const mk = async name => {
    const tenant = await db.tenant.create({ data: { name, slug: `${name}-${randomUUID()}`, users: { create: [{ email: `${name}-a-${randomUUID()}@example.com`, role: 'TENANT_ADMIN' }, { email: `${name}-m-${randomUUID()}@example.com`, role: 'MANAGER' }] } }, include: { users: true } });
    const cookieFor = async role => `${sessionCookie}=${await createSession(tenant.users.find(u => u.role === role).id)}`;
    return { tenant, admin: await cookieFor('TENANT_ADMIN'), manager: await cookieFor('MANAGER') };
  };
  const A = await mk('pa'), B = await mk('pb');
  const email = 'subject@example.com';
  const req = (path, body, cookie = '') => new Request(`http://localhost:3000/api/${path}`, { method: 'POST', headers: { cookie, origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // The same person exists in both tenants; each tenant's data is independent.
  const seed = async (T) => {
    const lead = await db.lead.create({ data: { tenantId: T.tenant.id, company: 'Acme', domain: `acme-${randomUUID()}.example`, contactName: 'Sam Subject', contactEmail: email } });
    const contact = await db.contact.create({ data: { tenantId: T.tenant.id, leadId: lead.id, fullName: 'Sam Subject', email, title: 'CTO' } });
    const campaign = await db.campaign.create({ data: { tenantId: T.tenant.id, name: 'Camp', senderName: 'S', senderEmail: 's@example.com', calendlyUrl: 'https://calendly.com/x', status: 'ACTIVE', automationMode: 'FULLY_AUTOMATIC', sequenceSteps: { create: [{ stepOrder: 1, subject: 's', body: 'b' }] } } });
    await db.enrollment.create({ data: { tenantId: T.tenant.id, campaignId: campaign.id, contactId: contact.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: { note: 'hiring' } } });
    const ev = (data) => db.outreachEvent.create({ data: { tenantId: T.tenant.id, campaignId: campaign.id, contactId: contact.id, leadId: lead.id, idempotencyKey: randomUUID(), ...data } });
    await ev({ status: 'SENT', sentAt: new Date(), subject: 'Hello Sam', body: 'Private body text' });
    await ev({ status: 'QUEUED', stepOrder: 1, scheduledAt: new Date(Date.now() + 3600000) });
    await db.reply.create({ data: { tenantId: T.tenant.id, contactId: contact.id, intent: 'NEUTRAL', rawSnippet: 'Reply mentioning my home number 555-0100' } });
    const appt = await db.appointment.create({ data: { tenantId: T.tenant.id, campaignId: campaign.id, contactId: contact.id, providerEventId: randomUUID(), status: 'BOOKED', qualificationNotes: 'Sam said budget is Q4', scheduledStart: new Date(Date.now() + 86400000), scheduledEnd: new Date(Date.now() + 88200000) } });
    return { lead, contact, campaign, appt };
  };
  const a = await seed(A), b = await seed(B);

  await t.test('export is admin-only, tenant-scoped, and includes everything held', async () => {
    assert.equal((await exportRoute(req('privacy/export', { email }, ''))).status, 401);
    assert.equal((await exportRoute(req('privacy/export', { email }, A.manager))).status, 403, 'managers cannot export personal data');
    assert.equal((await exportRoute(req('privacy/export', { email: 'not-an-email' }, A.admin))).status, 400);
    const res = await exportRoute(req('privacy/export', { email: '  SUBJECT@Example.com ' }, A.admin));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.found, true); assert.equal(data.contact.fullName, 'Sam Subject');
    assert.equal(data.messages.length, 2); assert.equal(data.messages.find(m => m.status === 'SENT').body, 'Private body text');
    assert.equal(data.replies.length, 1); assert.equal(data.appointments.length, 1); assert.equal(data.enrollments[0].campaign, 'Camp');
    const unknown = await (await exportRoute(req('privacy/export', { email: 'nobody@example.com' }, A.admin))).json();
    assert.equal(unknown.found, false);
    assert.equal((await db.auditEvent.findMany({ where: { tenantId: A.tenant.id, action: 'privacy_export' } })).some(e => JSON.stringify(e.metadata).includes('@')), false, 'audit log holds no plaintext email');
  });
  await t.test('erasure requires admin and explicit confirmation', async () => {
    assert.equal((await eraseRoute(req('privacy/erase', { email, confirm: true }, A.manager))).status, 403);
    assert.equal((await eraseRoute(req('privacy/erase', { email }, A.admin))).status, 400);
    assert.equal((await eraseRoute(req('privacy/erase', { email, confirm: false }, A.admin))).status, 400);
    assert.ok(await db.contact.findUnique({ where: { id: a.contact.id } }), 'nothing erased yet');
  });
  await t.test('erasure removes personal data, keeps the suppression record, and leaves other tenants untouched', async () => {
    const res = await eraseRoute(req('privacy/erase', { email, confirm: true }, A.admin));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).erased, { contact: 1, replies: 1, messages: 2, appointments: 1, leads: 1 });
    assert.equal(await db.contact.findUnique({ where: { id: a.contact.id } }), null);
    assert.equal(await db.enrollment.count({ where: { campaignId: a.campaign.id } }), 0);
    assert.equal(await db.reply.count({ where: { tenantId: A.tenant.id } }), 0);
    const events = await db.outreachEvent.findMany({ where: { tenantId: A.tenant.id } });
    assert.ok(events.every(e => e.body === null && e.subject === null && e.contactId === null), 'message text removed and detached');
    assert.equal(events.filter(e => e.status === 'QUEUED').length, 0, 'queued sends were canceled');
    const appt = await db.appointment.findUnique({ where: { id: a.appt.id } });
    assert.equal(appt.contactId, null); assert.equal(appt.qualificationNotes, null); assert.equal(appt.status, 'BOOKED', 'business record kept');
    const lead = await db.lead.findUnique({ where: { id: a.lead.id } });
    assert.equal(lead.contactEmail, null); assert.equal(lead.company, 'Acme');
    assert.equal((await db.suppression.findUnique({ where: { tenantId_email: { tenantId: A.tenant.id, email } } })).reason, 'erasure_request');
    assert.equal(JSON.stringify(await db.auditEvent.findMany({ where: { tenantId: A.tenant.id, action: 'privacy_erasure' } })).includes(email), false, 'no plaintext email in audit');
    // Tenant B still holds its own copy, untouched and not suppressed.
    assert.ok(await db.contact.findUnique({ where: { id: b.contact.id } }));
    assert.equal(await db.reply.count({ where: { tenantId: B.tenant.id } }), 1);
    assert.equal(await db.suppression.findUnique({ where: { tenantId_email: { tenantId: B.tenant.id, email } } }), null);
    assert.equal((await (await exportRoute(req('privacy/export', { email }, A.admin))).json()).contact, null, 'export after erasure shows no personal data');
  });
  await t.test('erasure is idempotent and also works for an address we hold nothing on', async () => {
    assert.equal((await eraseRoute(req('privacy/erase', { email, confirm: true }, A.admin))).status, 200);
    const r = await (await eraseRoute(req('privacy/erase', { email: 'never-seen@example.com', confirm: true }, A.admin))).json();
    assert.deepEqual(r.erased, { contact: 0, replies: 0, messages: 0, appointments: 0, leads: 0 });
    assert.ok(await db.suppression.findUnique({ where: { tenantId_email: { tenantId: A.tenant.id, email: 'never-seen@example.com' } } }));
  });
  await t.test('after a restore that resurrects erased data, re-applying the exported ledger removes it again', async () => {
    const ledger = await exportErasureLedger();
    assert.ok(ledger.some(l => l.tenantId === A.tenant.id && l.email === email));
    assert.ok(!ledger.some(l => l.tenantId === B.tenant.id), 'only erased subjects are in the ledger');
    // Simulate restoring an older backup: the person and their suppression are back.
    await db.suppression.delete({ where: { tenantId_email: { tenantId: A.tenant.id, email } } });
    const revived = await db.contact.create({ data: { tenantId: A.tenant.id, fullName: 'Sam Subject', email } });
    await db.reply.create({ data: { tenantId: A.tenant.id, contactId: revived.id, intent: 'NEUTRAL', rawSnippet: 'resurrected' } });
    const result = await reapplyErasures([...ledger, { tenantId: 'deleted-tenant', email: 'x@example.com' }]);
    assert.equal(result.skipped, 1); assert.ok(result.applied >= 2);
    assert.equal(await db.contact.findUnique({ where: { id: revived.id } }), null);
    assert.equal(await db.reply.count({ where: { tenantId: A.tenant.id } }), 0);
    assert.equal((await db.suppression.findUnique({ where: { tenantId_email: { tenantId: A.tenant.id, email } } })).reason, 'erasure_request');
  });
  await t.test('retention redacts old message text and replies but never in-flight sends, recent data, or tenants without a policy', async () => {
    const T = A, other = B;
    const lead = await db.lead.create({ data: { tenantId: T.tenant.id, company: 'R', domain: `r-${randomUUID()}.example` } });
    const contact = await db.contact.create({ data: { tenantId: T.tenant.id, leadId: lead.id, fullName: 'R R', email: `r-${randomUUID()}@example.com` } });
    const old = new Date(Date.now() - 90 * 86400000);
    const ev = (data) => db.outreachEvent.create({ data: { tenantId: T.tenant.id, contactId: contact.id, leadId: lead.id, idempotencyKey: randomUUID(), body: 'text', subject: 'subj', ...data } });
    const oldSent = await ev({ status: 'SENT', createdAt: old }), oldQueued = await ev({ status: 'QUEUED', createdAt: old }), recentSent = await ev({ status: 'SENT' });
    const oldReply = await db.reply.create({ data: { tenantId: T.tenant.id, contactId: contact.id, intent: 'UNSURE', rawSnippet: 'old words', createdAt: old } });
    const recentReply = await db.reply.create({ data: { tenantId: T.tenant.id, contactId: contact.id, intent: 'UNSURE', rawSnippet: 'new words' } });
    const otherLeadEvent = await db.outreachEvent.create({ data: { tenantId: other.tenant.id, contactId: b.contact.id, leadId: b.lead.id, idempotencyKey: randomUUID(), body: 'keep', subject: 'keep', status: 'SENT', createdAt: old } });
    await db.tenantSetting.upsert({ where: { tenantId: T.tenant.id }, update: { messageRetentionDays: 30 }, create: { tenantId: T.tenant.id, messageRetentionDays: 30 } });
    assert.ok(await applyRetention() >= 2);
    const got = async id => db.outreachEvent.findUnique({ where: { id } });
    assert.deepEqual([(await got(oldSent.id)).body, (await got(oldSent.id)).subject], [null, null]);
    assert.equal((await got(oldQueued.id)).body, 'text', 'queued work is never redacted');
    assert.equal((await got(recentSent.id)).body, 'text');
    assert.equal((await db.reply.findUnique({ where: { id: oldReply.id } })).rawSnippet, REDACTED);
    assert.equal((await db.reply.findUnique({ where: { id: recentReply.id } })).rawSnippet, 'new words');
    assert.equal((await got(otherLeadEvent.id)).body, 'keep', 'tenant with no policy is untouched');
    assert.equal(await applyRetention(), 0, 'idempotent');
  });
});
