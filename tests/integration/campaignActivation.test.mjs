import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt, hashPassword } from '../../lib/crypto.ts';
import { createSession, sessionCookie } from '../../lib/auth.ts';
import { campaignReady } from '../../lib/campaigns.ts';
import { PATCH as patchCampaign } from '../../app/api/campaigns/route.ts';

if (process.env.TEST_DATABASE_CONFIRM !== 'isolated') throw new Error('Use an isolated database and TEST_DATABASE_CONFIRM=isolated');
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.OUTBOUND_ENABLED = 'true';
process.env.SENDER_HEALTH_AUTO = 'off';

// A BLOCKED sender used to make activation impossible, so a campaign could not be set up or
// approved until the sender recovered - which only clears once real outreach resumes, which
// activation itself prevented. Sending stays blocked; only activation is decoupled.
test('an unhealthy sender blocks sending but no longer blocks activation', async t => {
  const tenant = await db.tenant.create({
    data: {
      name: 'Ready', slug: `rd-${randomUUID()}`,
      settings: { create: { automationEnabled: true, postalAddress: '221B Test Street', dailySendCap: 50, weeklyProspectCap: 100, gatewayKey: encrypt('g'), webhookSecret: encrypt('w'.repeat(40)) } },
      users: { create: { email: `a-${randomUUID()}@example.com`, role: 'TENANT_ADMIN', passwordHash: hashPassword('long-test-password-123') } }
    }
  });
  const savedGateway = process.env.PROVIDER_GATEWAY_URL;
  process.env.PROVIDER_GATEWAY_URL = 'http://127.0.0.1:1';
  t.after(() => { if (savedGateway === undefined) delete process.env.PROVIDER_GATEWAY_URL; else process.env.PROVIDER_GATEWAY_URL = savedGateway; });

  const senderEmail = 'blocked@sender.example';
  const icp = await db.iCP.create({ data: { tenantId: tenant.id, name: 'ICP', offer: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], buyerTitles: ['CTO'], buyingSignals: ['Hiring QA'], technologies: ['P'] } });
  const campaign = await db.campaign.create({
    data: {
      tenantId: tenant.id, icpId: icp.id, name: 'Blocked sender campaign', senderName: 'Sender', senderEmail,
      calendlyUrl: 'https://calendly.com/test', status: 'DRAFT', automationMode: 'FULLY_AUTOMATIC',
      sequenceSteps: { create: [{ stepOrder: 1, waitBusinessDays: 0, subject: 'Hi', body: 'Hi {{firstName}}' }] }
    }
  });
  // The sender is blocked by a bounce rate above the policy threshold.
  await db.deliverabilityProfile.create({ data: { tenantId: tenant.id, senderEmail, domain: 'sender.example', status: 'BLOCKED', dailyCap: 0, bounceRate: 0.1, lastCheckedAt: new Date() } });

  await t.test('strict readiness still refuses an unhealthy sender', async () => {
    await assert.rejects(campaignReady(tenant.id, campaign.id), /campaign_not_ready:fresh_sender_health/);
  });

  await t.test('activation allows it, and reports that nothing will send yet', async () => {
    const admin = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const cookie = `${sessionCookie}=${await createSession(admin.id)}`;
    const res = await patchCampaign(new Request('http://localhost:3000/api/campaigns', {
      method: 'PATCH',
      headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ id: campaign.id, status: 'ACTIVE' })
    }));
    assert.equal(res.status, 200, 'Activate succeeds despite the blocked sender');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.warning, 'sender_health_not_ready', 'the operator is told mail is held back');
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'ACTIVE');
  });

  await t.test('a structurally broken campaign is still refused', async () => {
    const bare = await db.campaign.create({
      data: { tenantId: tenant.id, icpId: icp.id, name: 'No postal address campaign', senderName: 'S', senderEmail, calendlyUrl: 'https://calendly.com/test', status: 'DRAFT', automationMode: 'FULLY_AUTOMATIC', sequenceSteps: { create: [{ stepOrder: 1, subject: 'Hi', body: 'Hi' }] } }
    });
    await db.tenantSetting.update({ where: { tenantId: tenant.id }, data: { postalAddress: null } });
    await assert.rejects(campaignReady(tenant.id, bare.id, { allowUnhealthySender: true }), /campaign_not_ready:[a-z_,]*postal_address/);
    await db.tenantSetting.update({ where: { tenantId: tenant.id }, data: { postalAddress: '221B Test Street' } });
  });
});