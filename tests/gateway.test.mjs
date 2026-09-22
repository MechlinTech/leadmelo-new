import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

// MOCK-BASED. Vendor responses below are shaped from Apollo's and Hunter's published documentation.
// These tests check the gateway's own logic and the LeadMelo gateway contract. They do NOT prove the
// vendors behave as documented; live acceptance with real accounts is still required.
process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const { encrypt } = await import('../lib/crypto.ts');
const { gateway, discoveredSchema } = await import('../lib/providers.ts');
const { qualifyProspect } = await import('../lib/policy.ts');
const { createGatewayServer } = await import('../gateway/src/server.ts');
const { GatewayStore } = await import('../gateway/src/store.ts');
const { ApolloClient } = await import('../gateway/src/apollo.ts');
const { HunterClient, mapHunterStatus } = await import('../gateway/src/hunter.ts');
const N = await import('../gateway/src/normalize.ts');

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const sha = s => createHash('sha256').update(s).digest('hex');

test('normalization: exact ICP wording only for provably equivalent values', () => {
  assert.equal(N.sizeBandFor(120, ['10-49', '50-1000']), '50-1000'); assert.equal(N.sizeBandFor(5000, ['50-1000']), '5000', 'no band contains it: stays raw and will not match');
  assert.equal(N.sizeBandFor(2000, ['1001+']), '1001+'); assert.equal(N.sizeBandFor(null, ['50-1000']), '');
  assert.deepEqual(N.apolloEmployeeRanges(['50-1000', '1001+', 'junk']), ['50,1000', '1001,1000000']);
  assert.equal(N.geographyFor('United States', ['US', 'Canada']), 'US'); assert.equal(N.geographyFor('Canada', ['US', 'Canada']), 'Canada');
  assert.equal(N.geographyFor('Brazil', ['US']), 'Brazil'); assert.equal(N.geographyFor(null, ['US']), '');
  assert.equal(N.apolloLocation('US'), 'United States'); assert.equal(N.apolloLocation('UK'), 'United Kingdom'); assert.equal(N.apolloLocation('Narnia'), 'Narnia');
  assert.deepEqual(N.titleFor('Chief Technology Officer', ['CTO']), { title: 'CTO', matched: true });
  assert.deepEqual(N.titleFor('cto', ['CTO']), { title: 'CTO', matched: true });
  assert.equal(N.titleFor('Engineering Manager', ['CTO']).matched, false, 'never relabel a different role');
  assert.equal(N.titleFor('Staff Engineer', ['CTO'], { 'staff engineer': 'CTO' }).matched, true, 'operator taxonomy is honoured');
  assert.equal(N.industryFor('Computer Software', ['SaaS'], { 'computer software': 'SaaS' }), 'SaaS');
  assert.equal(N.industryFor('Computer Software', ['SaaS']), 'Computer Software', 'no mapping: raw value, LeadMelo will reject');
  const s = N.translateSignals(['Hiring QA', 'Raised Series B', 'hiring  SDET ']);
  assert.deepEqual(s.jobTitles.sort(), ['QA', 'SDET']); assert.equal(s.signalForJobTitle.get('QA'), 'Hiring QA');
  assert.equal(N.technologyUid('Google Analytics 4'), 'google_analytics_4'); assert.equal(N.normalizeDomain('https://www.Example.com/x'), 'example.com');
});

test('Hunter client: documented request shape and conservative status mapping', async () => {
  const calls = [];
  const client = (status, body, headers) => new HunterClient(async (url, init) => { calls.push({ url: String(url), init }); return json(body ?? {}, status, headers); }, 'hunter-key-123');
  const ok = await client(200, { data: { status: 'valid', result: 'deliverable', email: 'a@b.example' } }).verify('a@b.example');
  assert.deepEqual(ok, { verification: 'VALID', vendorStatus: 'valid' });
  assert.equal(calls[0].url, 'https://api.hunter.io/v2/email-verifier?email=a%40b.example'); assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.headers['X-API-KEY'], 'hunter-key-123');
  assert.equal(calls[0].init.redirect, 'error'); assert.ok(!calls[0].url.includes('hunter-key'), 'key never in the URL');
  for (const [status, result, expected] of [['valid', 'risky', 'RISKY'], ['valid', 'undeliverable', 'INVALID'], ['invalid', undefined, 'INVALID'], ['accept_all', undefined, 'RISKY'], ['webmail', undefined, 'RISKY'], ['disposable', undefined, 'INVALID'], ['unknown', undefined, 'UNKNOWN'], ['something_new', undefined, 'UNKNOWN']]) assert.equal(mapHunterStatus(status, result), expected, status);
  assert.equal((await client(202).verify('a@b.example')).verification, 'UNKNOWN');
  assert.equal((await client(222).verify('a@b.example')).verification, 'UNKNOWN');
  assert.equal((await client(451).verify('a@b.example')).verification, 'INVALID', 'owner asked us to stop processing');
  await assert.rejects(client(401).verify('a@b.example'), { code: 'vendor_auth' });
  await assert.rejects(client(403).verify('a@b.example'), { code: 'vendor_rate_limited' });
  await assert.rejects(client(429).verify('a@b.example'), { code: 'vendor_quota_exhausted' });
  await assert.rejects(client(503, {}, { 'retry-after': '9' }).verify('a@b.example'), e => e.code === 'vendor_unavailable' && e.retryAfterSeconds === 9);
  await assert.rejects(client(200, { nope: true }).verify('a@b.example'), { code: 'vendor_response_invalid' });
});

test('Apollo client: documented request shape, no personal-data reveal, tolerant parsing', async () => {
  const calls = [];
  const apollo = new ApolloClient(async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return String(url).includes('mixed_people') ? json({ total_entries: 2, people: [{ id: 'p1', title: 'CTO', organization: { name: 'Buyer One' }, has_email: true }, { id: 'p2', title: null }] })
      : json({ person: { id: 'p1', first_name: 'Alex', last_name: 'Example', title: 'CTO', email: 'alex@buyer1.example', organization: { name: 'Buyer One', primary_domain: 'buyer1.example', estimated_num_employees: 120, current_technologies: [{ uid: 'playwright', name: 'Playwright' }] } } });
  }, 'apollo-key-123');
  const s = await apollo.searchPeople({ titles: ['CTO'], locations: ['United States'], employeeRanges: ['50,1000'], technologyUids: ['playwright'], jobTitles: ['QA'], excludeDomains: ['bad.example'], page: 2, perPage: 40 });
  const u = calls[0].url;
  assert.equal(calls[0].init.method, 'POST'); assert.equal(u.origin + u.pathname, 'https://api.apollo.io/api/v1/mixed_people/api_search');
  assert.equal(calls[0].init.headers['x-api-key'], 'apollo-key-123'); assert.ok(!u.search.includes('apollo-key'));
  assert.deepEqual(u.searchParams.getAll('person_titles[]'), ['CTO']); assert.equal(u.searchParams.get('include_similar_titles'), 'false');
  assert.deepEqual(u.searchParams.getAll('organization_num_employees_ranges[]'), ['50,1000']); assert.deepEqual(u.searchParams.getAll('q_organization_job_titles[]'), ['QA']);
  assert.deepEqual(u.searchParams.getAll('currently_using_any_of_technology_uids[]'), ['playwright']); assert.deepEqual(u.searchParams.getAll('not_organization_websites_list[]'), ['bad.example']);
  assert.equal(u.searchParams.get('page'), '2'); assert.equal(u.searchParams.get('per_page'), '40');
  assert.deepEqual(s.candidates, [{ id: 'p1', title: 'CTO', organizationName: 'Buyer One' }, { id: 'p2', title: null, organizationName: null }]);
  const e = await apollo.enrich('p1');
  assert.equal(calls[1].url.pathname, '/api/v1/people/match'); assert.equal(calls[1].url.searchParams.get('id'), 'p1'); assert.equal(calls[1].url.searchParams.get('reveal_personal_emails'), 'false');
  assert.equal(calls[1].url.searchParams.get('reveal_phone_number'), null, 'never buys phone numbers');
  assert.equal(e.fullName, 'Alex Example'); assert.deepEqual(e.organization.technologies, ['Playwright', 'playwright']);
  const status = c => new ApolloClient(async () => json({}, c, c === 429 ? { 'retry-after': '30' } : {}), 'apollo-key-123');
  await assert.rejects(status(401).enrich('x'), { code: 'vendor_auth' });
  await assert.rejects(status(429).searchPeople({ titles: [], locations: [], employeeRanges: [], technologyUids: [], jobTitles: [], excludeDomains: [], page: 1, perPage: 10 }), e => e.code === 'vendor_rate_limited' && e.retryAfterSeconds === 30);
  assert.equal(await new ApolloClient(async () => json({ person: null }), 'apollo-key-123').enrich('x'), null);
});

// ---- Full path: LeadMelo's real gateway client -> gateway server -> mocked vendors ----
const BEARER = 'tenant-one-bearer-token-123456', OTHER_BEARER = 'tenant-two-bearer-token-654321', WRONG = 'not-a-configured-token-999999';
const icp = { name: 'QA', industries: ['SaaS'], companySizes: ['50-1000'], geographies: ['US'], technologies: ['Playwright'], buyingSignals: ['Hiring QA'], buyerTitles: ['CTO'], exclusionRules: [], minScore: 75 };
const people = {
  p1: { id: 'p1', name: 'Alex Example', title: 'Chief Technology Officer', email: 'alex@buyer1.example', country: 'United States', organization: { name: 'Buyer One', primary_domain: 'buyer1.example', website_url: 'https://buyer1.example', industry: 'computer software', estimated_num_employees: 120, current_technologies: [{ uid: 'playwright', name: 'Playwright' }] } },
  p3: { id: 'p3', name: 'Casey Catchall', title: 'CTO', email: 'cto@buyer2.example', country: 'United States', organization: { name: 'Buyer Two', primary_domain: 'buyer2.example', website_url: 'https://buyer2.example', industry: 'computer software', estimated_num_employees: 300 } },
  p4: { id: 'p4', name: 'No Evidence', title: 'CTO', email: 'cto@buyer3.example', country: 'United States', organization: { name: 'Buyer Three', primary_domain: 'buyer3.example', industry: 'computer software', estimated_num_employees: 90 } },
  p5: { id: 'p5', name: 'Nina Next', title: 'CTO', email: 'nina@buyer4.example', country: 'United States', organization: { name: 'Buyer Four', primary_domain: 'buyer4.example', website_url: 'https://buyer4.example', industry: 'computer software', estimated_num_employees: 500 } }
};
const pages = { 1: [{ id: 'p1', title: 'Chief Technology Officer' }, { id: 'p2', title: 'Software Engineer' }, { id: 'p3', title: 'CTO' }, { id: 'p4', title: 'CTO' }], 2: [{ id: 'p5', title: 'CTO' }], 3: [] };
const hunterStatus = { 'alex@buyer1.example': 'valid', 'cto@buyer2.example': 'accept_all', 'nina@buyer4.example': 'valid' };

function vendors(opts = {}) {
  const v = { calls: [], delayMs: 0, hunterFail: null, apolloFail: null };
  v.fetcher = async (url, init) => {
    const u = new URL(String(url)); v.calls.push({ host: u.hostname, path: u.pathname, params: u.searchParams });
    if (v.delayMs) await new Promise(r => setTimeout(r, v.delayMs));
    if (u.hostname === 'api.apollo.io') {
      if (v.apolloFail) return json({}, v.apolloFail.status, v.apolloFail.headers);
      if (u.pathname.endsWith('mixed_people/api_search')) return json({ total_entries: 5, people: pages[u.searchParams.get('page')] ?? [] });
      return json({ person: people[u.searchParams.get('id')] ?? null });
    }
    if (v.hunterFail?.(u.searchParams.get('email'))) return json({}, 403);
    const email = u.searchParams.get('email');
    if (email.startsWith('unk')) return json({}, 202);
    return json({ data: { status: hunterStatus[email] ?? 'unknown', result: hunterStatus[email] === 'valid' ? 'deliverable' : 'risky', email } });
  };
  v.count = (host, pathEnd) => v.calls.filter(c => c.host === host && (!pathEnd || c.path.endsWith(pathEnd))).length;
  return v;
}
async function start(fetcher, overrides = {}) {
  const config = {
    tenants: new Map([[sha(BEARER), { tenantId: 't1', apolloKey: 'apollo-key-123', hunterKey: 'hunter-key-123' }], [sha(OTHER_BEARER), { tenantId: 't2', apolloKey: 'apollo-key-456' }]]),
    taxonomy: { industries: { 'computer software': 'SaaS' }, titles: {} }, syncWaitMs: 5000, discoveryDeadlineMs: 30000, maxEnrichPerRequest: 60, maxPages: 3, ...overrides
  };
  const server = createGatewayServer(config, { fetcher, store: new GatewayStore() });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.PROVIDER_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  return { server, url: process.env.PROVIDER_GATEWAY_URL, stop: () => new Promise(r => server.close(r)) };
}
const discover = (token, key, body, schema = discoveredSchema) => gateway(encrypt(token), 'discover', key, body, schema);
const request = (t1 = 't1', extra = {}) => ({ tenantId: t1, campaignId: 'c1', icp, limit: 5, ...extra });

test('discovery end to end: contract-valid, ICP-qualifying, evidence-backed and credit-frugal', async t => {
  const logs = []; const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));
  const v = vendors(); const g = await start(v.fetcher);
  try {
    await t.test('returns only verified, matching, evidenced prospects, in the ICP\'s own wording', async () => {
      const r = await discover(BEARER, 'discover-key-0001', request('t1', { limit: 1 }));
      assert.equal(r.prospects.length, 1);
      const p = r.prospects[0];
      assert.deepEqual([p.email, p.title, p.industry, p.companySize, p.geography, p.domain], ['alex@buyer1.example', 'CTO', 'SaaS', '50-1000', 'US', 'buyer1.example']);
      assert.deepEqual(p.signals, ['Hiring QA']); assert.deepEqual(p.technologies, ['Playwright']);
      assert.match(p.evidenceSummary, /not independently confirmed/); assert.equal(p.verification, 'VALID');
      assert.ok(Math.abs(Date.now() - Date.parse(p.verifiedAt)) < 60000);
      assert.equal(qualifyProspect(icp, p).eligible, true, 'LeadMelo accepts it against the ICP');
      // Search was free-filtered; only relevant titles were enriched; the risky mailbox and no-evidence org were dropped.
      const search = v.calls.find(c => c.path.endsWith('api_search')).params;
      assert.deepEqual(search.getAll('q_organization_job_titles[]'), ['QA']); assert.deepEqual(search.getAll('organization_locations[]'), ['United States']);
      assert.deepEqual(v.calls.filter(c => c.path.endsWith('people/match')).map(c => c.params.get('id')), ['p1'], 'stops buying as soon as the limit is met');
      assert.equal(v.count('api.hunter.io'), 1);
    });
    await t.test('a retry with the same key returns the same answer and buys nothing', async () => {
      const before = v.calls.length;
      assert.equal((await discover(BEARER, 'discover-key-0001', request('t1', { limit: 1 }))).prospects.length, 1);
      assert.equal(v.calls.length, before);
    });
    await t.test('the same key with a different request is refused', async () => {
      await assert.rejects(discover(BEARER, 'discover-key-0001', request('t1', { limit: 3 })), /gateway_http_422/);
    });
    await t.test('a new run does not re-enrich people it already paid for, and the search cursor advances then wraps', async () => {
      let before = v.calls.length;
      const r = await discover(BEARER, 'discover-key-0002', request('t1', { limit: 1 }));
      assert.deepEqual(r.prospects.map(p => p.email), ['nina@buyer4.example']);
      let fresh = v.calls.slice(before);
      assert.deepEqual(fresh.filter(c => c.path.endsWith('people/match')).map(c => c.params.get('id')), ['p3', 'p4', 'p5'], 'p1 was already paid for; p2 fails the free title check');
      before = v.calls.length;
      assert.deepEqual((await discover(BEARER, 'discover-key-0006', request('t1', { limit: 1 }))).prospects, [], 'nothing new on the next page');
      fresh = v.calls.slice(before);
      assert.deepEqual(fresh.map(c => c.path.split('/').pop() + ':' + (c.params.get('page') ?? '')), ['api_search:3'], 'resumed at page 3, found it empty, spent nothing');
      before = v.calls.length;
      await discover(BEARER, 'discover-key-0007', request('t1', { limit: 1 }));
      assert.equal(v.calls.slice(before).find(c => c.path.endsWith('api_search')).params.get('page'), '1', 'wrapped back to the start');
      assert.equal(v.calls.slice(before).filter(c => c.path.endsWith('people/match')).length, 0, 'everyone on the first pages was already bought');
    });
    await t.test('authentication, tenant binding and configuration are enforced without spending credits', async () => {
      const before = v.calls.length;
      await assert.rejects(discover(WRONG, 'discover-key-0003', request()), /gateway_http_401/);
      await assert.rejects(discover(BEARER, 'discover-key-0003', request('t2')), /gateway_http_403/, 'body tenant must equal the credential\'s tenant');
      await assert.rejects(discover(OTHER_BEARER, 'discover-key-0003', request('t2')), /gateway_http_409/, 'tenant without a Hunter key cannot discover');
      await assert.rejects(discover(BEARER, 'discover-key-0004', request('t1', { icp: { ...icp, buyingSignals: ['Raised Series B'] } })), /gateway_http_422/, 'unsupported signals fail before spending');
      await assert.rejects(discover(BEARER, 'x', request()), /gateway_http_400/, 'idempotency key required');
      assert.deepEqual((await discover(BEARER, 'discover-key-0005', request('t1', { limit: 0 }))).prospects, []);
      assert.equal(v.calls.length, before);
    });
    await t.test('/send is not supported and /health answers', async () => {
      const send = await fetch(`${g.url}/send`, { method: 'POST', headers: { authorization: `Bearer ${BEARER}`, 'idempotency-key': 'send-key-00001', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(send.status, 501);
      assert.equal((await fetch(`${g.url}/health`)).status, 200);
    });
  } finally { console.log = realLog; await g.stop(); }
  assert.ok(!logs.some(l => /@|api-key|bearer/i.test(l)), 'logs contain no emails or credentials');
});

test('vendor failures: rate limits are retryable, partial results survive, slow jobs answer "in progress"', async t => {
  await t.test('a vendor rate limit becomes 503 with Retry-After, and no credentials leak', async () => {
    const v = vendors(); v.apolloFail = { status: 429, headers: { 'retry-after': '7' } }; const g = await start(v.fetcher);
    try {
      const res = await fetch(`${g.url}/discover`, { method: 'POST', headers: { authorization: `Bearer ${BEARER}`, 'idempotency-key': 'rate-key-00001', 'content-type': 'application/json' }, body: JSON.stringify(request()) });
      assert.equal(res.status, 503); assert.equal(res.headers.get('retry-after'), '7');
      const text = await res.text(); assert.match(text, /vendor_rate_limited/); assert.ok(!/apollo-key|hunter-key/.test(text));
      v.apolloFail = { status: 401 };
      const bad = await fetch(`${g.url}/discover`, { method: 'POST', headers: { authorization: `Bearer ${BEARER}`, 'idempotency-key': 'rate-key-00002', 'content-type': 'application/json' }, body: JSON.stringify(request()) });
      assert.equal(bad.status, 502, 'a rejected vendor key is an operator problem, not retryable');
    } finally { await g.stop(); }
  });
  await t.test('if a vendor fails after some prospects were bought, those are returned and the failed retry is not lost', async () => {
    const v = vendors(); v.hunterFail = email => email === 'cto@buyer2.example'; const g = await start(v.fetcher);
    try {
      const r = await discover(BEARER, 'partial-key-0001', request());
      assert.deepEqual(r.prospects.map(p => p.email), ['alex@buyer1.example']);
      // p3 was never marked seen as verified-and-dropped? It WAS enriched (and paid for); it is remembered so it is not bought twice.
      v.hunterFail = null;
      const again = await discover(BEARER, 'partial-key-0002', request());
      assert.equal(v.calls.filter(c => c.path.endsWith('people/match') && c.params.get('id') === 'p3').length, 1, 'p3 is not enriched twice');
      assert.ok(again.prospects.every(p => p.email !== 'alex@buyer1.example'));
    } finally { await g.stop(); }
  });
  await t.test('a job slower than the sync window answers 503 in_progress, then the retry returns the finished result without a second purchase', async () => {
    const v = vendors(); v.delayMs = 120; const g = await start(v.fetcher, { syncWaitMs: 60 });
    try {
      const call = () => fetch(`${g.url}/discover`, { method: 'POST', headers: { authorization: `Bearer ${BEARER}`, 'idempotency-key': 'slow-key-00001', 'content-type': 'application/json' }, body: JSON.stringify(request('t1', { limit: 1 })) });
      const first = await call();
      assert.equal(first.status, 503); assert.equal(first.headers.get('retry-after'), '15'); assert.match(await first.text(), /in_progress/);
      await new Promise(r => setTimeout(r, 1500));
      const second = await call();
      assert.equal(second.status, 200); assert.equal((await second.json()).prospects.length, 1);
      assert.equal(v.count('api.apollo.io', 'api_search'), 1, 'the retry did not start a second search');
      assert.equal(v.count('api.hunter.io'), 1, 'and did not verify anyone twice');
    } finally { await g.stop(); }
  });
});

test('verification: definitive answers are remembered, UNKNOWN stays retryable, tenant is bound', async () => {
  const v = vendors(); const g = await start(v.fetcher);
  try {
    const verificationResult = z.object({ email: z.string().email(), verification: z.enum(['VALID', 'INVALID', 'RISKY', 'UNKNOWN']), verifiedAt: z.string().datetime() }).strict(); // same shape LeadMelo requires
    const verify = (key, body, token = BEARER) => gateway(encrypt(token), 'verify', key, body, verificationResult);
    const ok = await verify('verify-key-0001', { tenantId: 't1', contactId: 'ct1', email: 'Alex@Buyer1.example' });
    assert.deepEqual([ok.email, ok.verification], ['alex@buyer1.example', 'VALID']);
    await verify('verify-key-0001', { tenantId: 't1', contactId: 'ct1', email: 'alex@buyer1.example' });
    assert.equal(v.count('api.hunter.io'), 1, 'VALID is cached under the idempotency key');
    const unknown = await verify('verify-key-0002', { tenantId: 't1', contactId: 'ct2', email: 'unknown@buyer5.example' });
    assert.equal(unknown.verification, 'UNKNOWN');
    await verify('verify-key-0002', { tenantId: 't1', contactId: 'ct2', email: 'unknown@buyer5.example' });
    assert.equal(v.count('api.hunter.io'), 3, 'UNKNOWN was re-checked, not frozen');
    await assert.rejects(verify('verify-key-0003', { tenantId: 't2', contactId: 'ct3', email: 'a@b.example' }), /gateway_http_403/);
    await assert.rejects(verify('verify-key-0004', { tenantId: 't2', contactId: 'ct3', email: 'a@b.example' }, OTHER_BEARER), /gateway_http_409/);
  } finally { await g.stop(); }
});
