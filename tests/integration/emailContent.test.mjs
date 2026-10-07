import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt } from '../../lib/crypto.ts';
import { tick, processOutreach } from '../../lib/worker.ts';
import { GET as getOutreach, PATCH as approveOutreach } from '../../app/api/outreach/route.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('Use an isolated database and TEST_DATABASE_CONFIRM=isolated');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://leadmelo.example.com';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.OUTBOUND_ENABLED = 'true';
process.env.SENDER_HEALTH_AUTO = 'off';
process.env.TEMP_QA_FOLLOWUP_MINUTES = '5';

// Every draft the Microsoft 365 adapter submits, captured at the wire.
const drafts = [];
let graphFails = false;
const graphTransport = async (url, options = {}) => {
  const u = String(url);
  if (u.includes('login.microsoftonline.com')) return Response.json({ access_token: 'token' });
  if (options.method === 'POST' && u.endsWith('/messages')) {
    if (graphFails) { graphFails = false; return new Response(JSON.stringify({ error: { code: 'serviceNotAvailable' } }), { status: 503 }); }
    drafts.push(String(options.body));
    return Response.json({ id: `draft-${drafts.length}`, internetMessageId: `<draft${drafts.length}@example.com>`, conversationId: 'conv' }, { status: 201 });
  }
  if (options.method === 'POST' && u.endsWith('/send')) return new Response(null, { status: 202 });
  throw new Error(`unexpected Graph call: ${options.method ?? 'GET'} ${u}`);
};

// An independent MIME reader written from RFC 2045, deliberately not sharing code with
// lib/m365/graph.ts, so a bug in the writer cannot hide behind a matching bug in the reader.
function readDeliveredMessage(base64) {
  const mime = Buffer.from(base64, 'base64').toString('utf8');
  const sections = mime.split(/\r?\n\r?\n/);
  const rawHeaders = sections.shift();
  const rawBody = sections.join('\n\n');
  const headers = {};
  for (const line of rawHeaders.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  const encoding = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase();
  const body = encoding === 'base64' ? Buffer.from(rawBody.replace(/\s+/g, ''), 'base64').toString('utf8') : rawBody;
  const encodedSubject = headers.subject?.match(/^=\?UTF-8\?B\?(.+)\?=$/);
  return {
    to: headers.to,
    subject: encodedSubject ? Buffer.from(encodedSubject[1], 'base64').toString('utf8') : headers.subject,
    contentType: headers['content-type'],
    body
  };
}

const COPY = {
  subject: 'Quick QA question for {{firstName}}',
  text: 'Hi {{firstName}},\n\nI noticed {{company}} is hiring QA engineers.\n\nWorth 15 minutes?\n{{calendlyUrl}}\n\nBest,\n{{senderName}}',
  html: '<html><body><p>Hi {{firstName}},</p><p>I noticed {{company}} is hiring QA engineers.</p><p><a href="{{calendlyUrl}}">Worth 15 minutes?</a></p><p>Best,<br>{{senderName}}</p></body></html>'
};

const parked = new Date('2099-01-01');
// Tenants created here are removed afterwards. These tests connect a Microsoft mailbox, and
// the shared database is reused by later files that assert no mailbox is connected at all.
const created = [];
async function scenario({ automationMode = 'REVIEW_BEFORE_SEND', steps } = {}) {
  await db.outreachEvent.updateMany({ where: { status: { in: ['QUEUED', 'SENDING'] } }, data: { scheduledAt: parked, leaseUntil: null } });
  await db.campaign.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'PAUSED' } });
  drafts.length = 0;
  const tenant = await db.tenant.create({
    data: {
      name: 'Content', slug: `content-${randomUUID()}`,
      settings: { create: { automationEnabled: true, postalAddress: '221B Test Street', dailySendCap: 25, weeklyProspectCap: 50, gatewayKey: encrypt('content-gateway'), webhookSecret: encrypt('w'.repeat(40)) } },
      users: { create: { email: `admin-${randomUUID()}@example.com`, role: 'TENANT_ADMIN' } }
    }
  });
  created.push(tenant.id);
  const senderEmail = `content-${randomUUID().slice(0, 6)}@sender.example`;
  const lead = await db.lead.create({ data: { tenantId: tenant.id, company: 'Acme Robotics', domain: `acme-${randomUUID()}.example` } });
  const contact = await db.contact.create({ data: { tenantId: tenant.id, leadId: lead.id, fullName: 'Pat Buyer', email: `pat-${randomUUID()}@acme.example`, verification: 'VALID', lastVerifiedAt: new Date() } });
  const icp = await db.iCP.create({ data: { tenantId: tenant.id, name: 'ICP', offer: 'QA automation', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['Playwright'] } });
  const campaign = await db.campaign.create({
    data: {
      tenantId: tenant.id, icpId: icp.id, name: 'Content', offer: 'QA automation', senderName: 'Sam Seller', senderEmail,
      calendlyUrl: 'https://calendly.com/sam/30min', status: 'ACTIVE', automationMode,
      businessDaysOnly: false, sendStartHour: 0, sendEndHour: 24, weeklyProspectCap: 50, dailySendCap: 25, holidays: [],
      sequenceSteps: { create: steps ?? [
        { stepOrder: 1, waitBusinessDays: 0, subject: COPY.subject, body: COPY.text },
        { stepOrder: 2, waitBusinessDays: 3, subject: `Following up, {{firstName}}`, body: 'Still relevant, {{firstName}}?\n\n{{calendlyUrl}}' }
      ] }
    }
  });
  await db.enrollment.create({ data: { tenantId: tenant.id, campaignId: campaign.id, contactId: contact.id, score: 90, hasBuyer: true, hasPainSignal: true, evidence: { synthetic: true } } });
  await db.deliverabilityProfile.create({ data: { tenantId: tenant.id, senderEmail, domain: 'sender.example', status: 'HEALTHY', dailyCap: 25, lastCheckedAt: new Date() } });
  await db.m365Connection.create({ data: { tenantId: tenant.id, directoryId: randomUUID(), clientId: randomUUID(), encryptedSecret: encrypt('secret-1234567890'), mailboxes: [senderEmail], enabled: true } });
  await db.mailCursor.create({ data: { tenantId: tenant.id, mailbox: senderEmail, lastSuccessAt: new Date(), nextPollAt: parked } });

  const admin = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const cookie = `${sessionCookie}=${await createSession(admin.id)}`;
  const request = (method = 'GET', payload) => new Request('https://leadmelo.example.com/api/outreach', {
    method, headers: { cookie, origin: 'https://leadmelo.example.com', 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  return { tenant, campaign, contact, request };
}

// Review preview -> approval -> send, for one specific outreach event.
async function reviewApproveSend(context, event) {
  const row = (await (await getOutreach(context.request())).json()).find(r => r.id === event.id);
  const preview = { subject: row.reviewSubject ?? row.subject, body: row.reviewBody ?? row.body, reviewError: row.reviewError };
  const approval = await approveOutreach(context.request('PATCH', { id: event.id, reviewToken: row.reviewToken }));
  return { preview, approval, approved: approval.status };
}

test('the recipient gets the complete approved content, for the initial email and for follow-ups', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = graphTransport;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    // Deleting each tenant cascades to its campaigns, contacts, outreach events,
    // Microsoft connections and mail cursors, so no connected mailbox is left
    // behind for the later files in this isolated run, which assert that none
    // is connected.
    for (const tenantId of created) await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    return db.outreachEvent.updateMany({ where: { status: { in: ['QUEUED', 'SENDING'] } }, data: { scheduledAt: parked } });
  });

  await t.test('the initial email matches the review preview exactly, for text and HTML copy', async () => {
    for (const [kind, body] of [['text', COPY.text], ['html', COPY.html]]) {
      const context = await scenario({ steps: [{ stepOrder: 1, waitBusinessDays: 0, subject: COPY.subject, body }] });
      // The initial outreach event, exactly as discovery leaves it: nothing stored yet.
      const initial = await db.outreachEvent.create({
        data: { tenantId: context.tenant.id, campaignId: context.campaign.id, contactId: context.contact.id, leadId: context.contact.leadId, stepOrder: 1, idempotencyKey: `initial-${kind}-${randomUUID()}`, scheduledAt: new Date() }
      });
      const { preview, approved } = await reviewApproveSend(context, initial);
      assert.equal(approved, 200, `${kind}: approval succeeds`);
      assert.ok(preview.reviewError === undefined, `${kind}: review preview rendered, got ${preview.reviewError}`);

      await tick();
      const sent = await db.outreachEvent.findUniqueOrThrow({ where: { id: initial.id } });
      assert.equal(sent.status, 'SENT', `${kind}: initial email sent; error=${sent.error ?? 'none'}`);

      const delivered = readDeliveredMessage(drafts.at(-1));
      assert.equal(delivered.to, context.contact.email, `${kind}: delivered to the enrolled contact`);
      assert.equal(delivered.subject, 'Quick QA question for Pat', `${kind}: subject is the approved subject`);
      assert.equal(delivered.body, preview.body, `${kind}: the delivered body is the approved body, byte for byte`);
      assert.equal(delivered.body, sent.body, `${kind}: the delivered body is what was persisted`);
      assert.ok(delivered.body.trim().length > 40, `${kind}: the delivered body is not empty`);
      assert.match(delivered.body, /Hi Pat,/, `${kind}: first name is personalised`);
      assert.match(delivered.body, /Acme Robotics/, `${kind}: company is personalised`);
      assert.match(delivered.body, /https:\/\/calendly\.com\/sam\/30min\?utm_source=leadmelo(?:&|&amp;)utm_content=/, `${kind}: the scheduling link carries signed attribution`);
      assert.match(delivered.body, /Sam Seller/, `${kind}: sender name is present`);
      assert.match(delivered.body, /221B Test Street/, `${kind}: postal address is present`);
      assert.match(delivered.body, kind === 'html'
        ? /<a href="https:\/\/leadmelo\.example\.com\/unsubscribe\?[^"]+">Unsubscribe<\/a>/
        : /Unsubscribe: https:\/\/leadmelo\.example\.com\/unsubscribe\?/, `${kind}: unsubscribe link is present`);
      assert.match(delivered.contentType, kind === 'html' ? /^text\/html/ : /^text\/plain/, `${kind}: correct content type`);
    }
  });

  await t.test('a follow-up email matches the review preview exactly, independently of the initial email', async () => {
    const context = await scenario();
    const initial = await db.outreachEvent.create({
      data: { tenantId: context.tenant.id, campaignId: context.campaign.id, contactId: context.contact.id, leadId: context.contact.leadId, stepOrder: 1, idempotencyKey: `follow-initial-${randomUUID()}`, scheduledAt: new Date() }
    });
    await reviewApproveSend(context, initial);
    await tick();
    const first = await db.outreachEvent.findUniqueOrThrow({ where: { id: initial.id } });
    assert.equal(first.status, 'SENT');

    const followUp = await db.outreachEvent.findFirstOrThrow({ where: { campaignId: context.campaign.id, stepOrder: 2 } });
    assert.equal(followUp.status, 'QUEUED');
    assert.equal(followUp.scheduledAt.getTime() - first.sentAt.getTime(), 5 * 60 * 1000, 'the follow-up is due five minutes after the initial email was SENT');

    await db.outreachEvent.update({ where: { id: followUp.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    const { preview, approved } = await reviewApproveSend(context, followUp);
    assert.equal(approved, 200);
    await tick();

    const sent = await db.outreachEvent.findUniqueOrThrow({ where: { id: followUp.id } });
    assert.equal(sent.status, 'SENT', `follow-up sent; error=${sent.error ?? 'none'}`);
    const delivered = readDeliveredMessage(drafts.at(-1));
    assert.equal(delivered.subject, 'Following up, Pat', 'the follow-up carries its own approved subject');
    assert.equal(delivered.body, preview.body, 'the delivered follow-up body is the approved body, byte for byte');
    assert.match(delivered.body, /^Still relevant, Pat\?/, 'the follow-up body is personalised');
    assert.match(delivered.body, /utm_content=/, 'the follow-up link carries signed attribution');
    assert.ok(delivered.body.trim().length > 40, 'the follow-up body is not empty');
    // The follow-up is a distinct message, not a resend of the first.
    assert.equal(drafts.length, 2, 'exactly one draft per approved message');
    assert.notEqual(readDeliveredMessage(drafts[0]).body, delivered.body, 'the follow-up is not a copy of the initial email');
  });

  await t.test('an empty, whitespace-only or markup-only body is refused before any provider request', async () => {
    for (const [label, body] of [
      ['empty', ''],
      ['whitespace', '   \n\t  \n '],
      ['markup-only', '<div><span></span></div>'],
      ['zero-width only', '\u200B\u200C\uFEFF']
    ]) {
      const context = await scenario({
        automationMode: 'FULLY_AUTOMATIC',
        steps: [{ stepOrder: 1, waitBusinessDays: 0, subject: COPY.subject, body }]
      });
      const initial = await db.outreachEvent.create({
        data: { tenantId: context.tenant.id, campaignId: context.campaign.id, contactId: context.contact.id, leadId: context.contact.leadId, stepOrder: 1, idempotencyKey: `empty-${label}-${randomUUID()}`, scheduledAt: new Date() }
      });
      const before = drafts.length;
      await tick();
      const row = await db.outreachEvent.findUniqueOrThrow({ where: { id: initial.id } });
      assert.notEqual(row.status, 'SENT', `${label}: never marked SENT`);
      assert.equal(row.status, 'FAILED', `${label}: a message with nothing readable fails; got ${row.status} (${row.error})`);
      assert.match(row.error, /^mail_(body|subject)_/, `${label}: records a clear failure reason, got ${row.error}`);
      assert.equal(drafts.length - before, 0, `${label}: nothing was submitted to the provider`);
    }
  });

  await t.test('an approved message whose stored body is emptied fails instead of sending a blank email', async () => {
    const context = await scenario({ automationMode: 'FULLY_AUTOMATIC' });
    const initial = await db.outreachEvent.create({
      data: { tenantId: context.tenant.id, campaignId: context.campaign.id, contactId: context.contact.id, leadId: context.contact.leadId, stepOrder: 1, idempotencyKey: `blanked-${randomUUID()}`, scheduledAt: new Date() }
    });
    // An approved snapshot whose body was blanked after approval (bad import, partial write).
    await db.outreachEvent.update({ where: { id: initial.id }, data: { approvedAt: new Date(), subject: COPY.subject, body: '   ' } });
    const before = drafts.length;
    await tick();
    const row = await db.outreachEvent.findUniqueOrThrow({ where: { id: initial.id } });
    assert.equal(row.status, 'FAILED', 'a blanked approved body fails rather than sending');
    assert.equal(row.error, 'mail_body_effectively_empty');
    assert.equal(drafts.length - before, 0, 'no blank email was submitted');
  });

  await t.test('a failed send is retried and delivers once, with the complete body', async () => {
    const context = await scenario({ automationMode: 'FULLY_AUTOMATIC' });
    const initial = await db.outreachEvent.create({
      data: { tenantId: context.tenant.id, campaignId: context.campaign.id, contactId: context.contact.id, leadId: context.contact.leadId, stepOrder: 1, idempotencyKey: `retry-${randomUUID()}`, scheduledAt: new Date() }
    });
    graphFails = true;
    await db.outreachEvent.update({ where: { id: initial.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    await tick();
    const failed = await db.outreachEvent.findUniqueOrThrow({ where: { id: initial.id } });
    assert.equal(failed.status, 'QUEUED', 'a provider fault re-queues rather than failing');
    assert.ok(failed.error, 'the failure reason is recorded');
    assert.equal(drafts.length, 0, 'nothing reached the provider on the failed attempt');

    await db.outreachEvent.update({ where: { id: initial.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    await tick();
    const retried = await db.outreachEvent.findUniqueOrThrow({ where: { id: initial.id } });
    assert.equal(retried.status, 'SENT', `the retry delivers; error=${retried.error ?? 'none'}`);
    assert.equal(drafts.length, 1, 'exactly one draft was ever created');
    const delivered = readDeliveredMessage(drafts[0]);
    assert.equal(delivered.body, retried.body, 'the retried message carries the complete body');
    assert.match(delivered.body, /Hi Pat,/, 'personalisation survived the retry');
  });

  await t.test('a message already marked SENT is never sent again, however often it becomes due', async () => {
    const context = await scenario({ automationMode: 'FULLY_AUTOMATIC' });
    const initial = await db.outreachEvent.create({
      data: { tenantId: context.tenant.id, campaignId: context.campaign.id, contactId: context.contact.id, leadId: context.contact.leadId, stepOrder: 1, idempotencyKey: `once-${randomUUID()}`, scheduledAt: new Date() }
    });
    await tick();
    assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: initial.id } })).status, 'SENT');
    const afterFirstSend = drafts.length;
    for (let i = 0; i < 4; i++) {
      // Even if the row is forced back to due, a SENT message is off the queue.
      await db.outreachEvent.update({ where: { id: initial.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
      assert.equal(await processOutreach(), false, 'a SENT message is never claimed');
    }
    assert.equal(drafts.length, afterFirstSend, 'no duplicate was ever created');
    assert.equal((await db.outreachEvent.findUniqueOrThrow({ where: { id: initial.id } })).status, 'SENT');
  });
});