import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// MOCK-BASED. The probes below are driven by an injected fetcher, so this file proves how a vendor
// response is interpreted. It does NOT prove Apollo or Hunter accept a real key; live acceptance with
// real accounts is still required (the same caveat the gateway clients carry).
process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const { probeApollo, probeHunter, probeGateway, configuredFlags } = await import('../lib/providerCredentials.ts');

const json = (status, body = {}) => new Response(JSON.stringify(body), { status });
const fail = () => { throw new TypeError('fetch failed'); };

test('Apollo key probe: a refusal is named as an auth failure, not a dead connection', async t => {
  await t.test('200 means the vendor accepted the key', async () => {
    const r = await probeApollo('AIza-good-key', async () => json(200, { is_authenticated: true }));
    assert.equal(r.ok, true); assert.equal(r.code, 'vendor_auth_ok');
  });
  await t.test('401 and 403 are reported as a rejected key', async () => {
    for (const status of [401, 403]) {
      const r = await probeApollo('bad', async () => json(status));
      assert.equal(r.ok, false); assert.equal(r.code, 'vendor_auth');
    }
  });
  await t.test('429 is distinguished from a wrong key', async () => {
    assert.equal((await probeApollo('k', async () => json(429))).code, 'vendor_rate_limited');
  });
  await t.test('a retired endpoint never reports a false pass', async () => {
    const r = await probeApollo('good', async () => json(404));
    assert.equal(r.ok, false, '404 must not be read as a valid key');
    assert.equal(r.code, 'apollo_probe_unsupported');
  });
  await t.test('an unreachable vendor is its own outcome', async () => {
    assert.equal((await probeApollo('k', async () => fail())).code, 'vendor_unreachable');
    assert.equal((await probeApollo('k', async () => json(503))).code, 'vendor_unavailable');
  });
  await t.test('the key is sent in the vendor header, never in the URL', async () => {
    let seen;
    await probeApollo('AIza-secret-value', async (url, init) => { seen = { url: String(url), headers: init.headers }; return json(200); });
    assert.equal(seen.headers['x-api-key'], 'AIza-secret-value');
    assert.ok(!seen.url.includes('AIza-secret-value'), 'the key must not appear in the request URL');
  });
});

test('Hunter key probe: a valid key rejects the malformed address, a bad key does not', async t => {
  await t.test('400 means the key itself was accepted', async () => {
    const r = await probeHunter('good', async () => json(400, { errors: [{ code: 'BAD_EMAIL' }] }));
    assert.equal(r.ok, true); assert.equal(r.code, 'vendor_auth_ok');
  });
  await t.test('401 and 403 are a rejected key', async () => {
    assert.equal((await probeHunter('bad', async () => json(401))).code, 'vendor_auth');
    assert.equal((await probeHunter('bad', async () => json(403))).code, 'vendor_auth');
  });
  await t.test('exhausted credits are reported separately from a wrong key', async () => {
    const r = await probeHunter('good', async () => json(429));
    assert.equal(r.ok, false); assert.equal(r.code, 'vendor_quota_exhausted');
    assert.match(r.detail, /credits/);
  });
  await t.test('the probe spends no verification credit', async () => {
    // The address is deliberately invalid so a real account rejects it without verifying anything.
    let seen;
    await probeHunter('good', async (url, init) => { seen = String(url); return json(400); });
    assert.match(seen, /email=not-an-email-address/);
  });
  await t.test('the key travels in the X-API-KEY header', async () => {
    let headers;
    await probeHunter('hunter-secret', async (_u, init) => { headers = init.headers; return json(400); });
    assert.equal(headers['X-API-KEY'], 'hunter-secret');
  });
});

test('gateway bearer probe: the meaningful check is an authenticated request', async t => {
  await t.test('no stored token is reported before any request', async () => {
    const r = await probeGateway({}, async () => { throw new Error('must not be called'); });
    assert.equal(r.ok, false); assert.equal(r.code, 'gateway_credential_missing');
  });
  await t.test('401 means the gateway does not know this token', async () => {
    process.env.PROVIDER_GATEWAY_URL = 'http://127.0.0.1:9';
    const r = await probeGateway({ gatewayKey: 'x'.repeat(40) }, async () => json(401));
    assert.equal(r.ok, false); assert.equal(r.code, 'gateway_http_401');
    assert.match(r.detail, /SHA-256/, 'the message must say what the operator has to add');
  });
  await t.test('a gateway without the credential endpoint is named, not called a bad token', async () => {
    const r = await probeGateway({ gatewayKey: 'x'.repeat(40) }, async () => json(404));
    assert.equal(r.code, 'gateway_credentials_unsupported');
  });
  await t.test('an unreachable gateway is reported as unreachable', async () => {
    const r = await probeGateway({ gatewayKey: 'x'.repeat(40) }, async () => fail());
    assert.equal(r.code, 'gateway_unreachable');
  });
});

test('the status shape the UI receives carries no secret', () => {
  const flags = configuredFlags({ gatewayKey: 'super-secret-token', apolloKey: 'AIza-secret', hunterKey: 'hunter-secret' });
  assert.deepEqual(flags, { gatewayConfigured: true, apolloConfigured: true, hunterConfigured: true });
  // The whole point of the shape: booleans only. A leaked value here would reach the browser.
  for (const v of Object.values(flags)) assert.equal(typeof v, 'boolean');
  assert.ok(!JSON.stringify(flags).match(/secret|AIza/));
});
