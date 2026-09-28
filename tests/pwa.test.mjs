import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';

// The service worker is executed for real inside a sandbox with a fake Cache Storage, so these tests check what it
// actually caches and answers, not what its source text says.
function makeWorker({ online = () => true, responses = {} } = {}) {
  const listeners = {}, stores = new Map(), fetched = [];
  const key = r => (typeof r === 'string' ? new URL(r, 'https://app.example').href : r.url);
  const cacheApi = name => ({
    async addAll(urls) { for (const u of urls) { const r = await fetchImpl(new Request(new URL(u, 'https://app.example'))); stores.get(name).set(key(u), r.clone()); } },
    async match(req) { return stores.get(name)?.get(key(req))?.clone(); },
    async put(req, res) { stores.get(name).set(key(req), res); }
  });
  const caches = {
    async open(name) { if (!stores.has(name)) stores.set(name, new Map()); return cacheApi(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(req) { for (const [n, m] of stores) { const hit = m.get(key(req)); if (hit) return hit.clone(); } return undefined; }
  };
  const fetchImpl = async request => {
    fetched.push(new URL(request.url).pathname);
    if (!online()) throw new TypeError('offline');
    const path = new URL(request.url).pathname;
    const res = responses[path] ? responses[path]() : new Response(`body of ${path}`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    Object.defineProperty(res, 'type', { value: 'basic' }); // what a real same-origin fetch returns
    return res;
  };
  const self = { location: new URL('https://app.example/sw.js'), addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting: async () => undefined, clients: { claim: async () => undefined } };
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, caches, fetch: fetchImpl, URL, Response, Request, Promise });
  return {
    stores, fetched,
    async install() { let p; listeners.install({ waitUntil: x => { p = x; } }); await p; },
    async activate() { let p; listeners.activate({ waitUntil: x => { p = x; } }); await p; },
    // Returns the response the worker produced, or undefined when it declined to handle the request.
    async request(url, { method = 'GET', mode = 'cors', origin = 'https://app.example' } = {}) {
      let answer; const req = new Request(new URL(url, origin), { method });
      Object.defineProperty(req, 'mode', { value: mode });
      listeners.fetch({ request: req, respondWith: p => { answer = p; } });
      return answer === undefined ? undefined : await answer;
    },
    allCachedPaths: () => [...stores.values()].flatMap(m => [...m.keys()].map(k => new URL(k).pathname))
  };
}

test('install precaches only the offline page and icons', async () => {
  const w = makeWorker(); await w.install();
  assert.deepEqual([...w.stores.keys()], ['leadmelo-static-v2']);
  assert.deepEqual(w.allCachedPaths().sort(), ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/logo.svg', '/offline.html']);
});
test('signed-in pages and API responses are never cached and never intercepted', async () => {
  const w = makeWorker(); await w.install(); const before = w.allCachedPaths().length;
  for (const path of ['/api/campaigns', '/api/settings', '/api/plan', '/api/auth/login', '/app/settings?_rsc=1', '/auth/signin', '/unsubscribe?token=x', '/_next/data/build/app.json', '/request-access', '/pricing', '/api/assistant']) {
    assert.equal(await w.request(path), undefined, `${path} must be left to the browser`);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(await w.request('/_next/static/a.js', { method }), undefined, method + ' is never handled');
  assert.equal(await w.request('https://cdn.other.example/_next/static/a.js', { origin: 'https://cdn.other.example' }), undefined, 'cross-origin is never handled');
  assert.equal(w.allCachedPaths().length, before, 'nothing was added to the cache');
});
test('page navigations are network-first, never stored, and fall back to the offline page', async () => {
  let online = true; const w = makeWorker({ online: () => online }); await w.install();
  const before = w.allCachedPaths().length;
  const live = await w.request('/app', { mode: 'navigate' });
  assert.equal(await live.text(), 'body of /app'); assert.equal(w.allCachedPaths().length, before, 'the page was not stored');
  assert.equal(await (await w.request('/', { mode: 'navigate' })).text(), 'body of /');
  online = false;
  const offline = await w.request('/app/campaigns', { mode: 'navigate' });
  assert.equal(await offline.text(), 'body of /offline.html', 'offline shows the precached offline page, never a stale private page');
  assert.ok(!w.allCachedPaths().some(p => p.startsWith('/app')), 'no signed-in path is ever in the cache');
});
test('static assets: cached after first use, served from cache, refreshed in the background; private or failed responses are not stored', async () => {
  const state = { chunk: 'v1' }; const w = makeWorker({ responses: {
    '/_next/static/chunks/main.js': () => new Response(state.chunk, { status: 200, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }),
    '/_next/static/chunks/private.js': () => new Response('secret', { status: 200, headers: { 'Cache-Control': 'private, no-store' } }),
    '/_next/static/chunks/missing.js': () => new Response('nope', { status: 404 }),
    '/icons/logo.svg': () => new Response('<svg/>', { status: 200 })
  } });
  await w.install();
  assert.equal(await (await w.request('/_next/static/chunks/main.js')).text(), 'v1');
  assert.ok(w.allCachedPaths().includes('/_next/static/chunks/main.js'));
  state.chunk = 'v2';
  assert.equal(await (await w.request('/_next/static/chunks/main.js')).text(), 'v1', 'served from cache immediately');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await (await w.request('/_next/static/chunks/main.js')).text(), 'v2', 'background refresh updated it');
  await w.request('/_next/static/chunks/private.js'); await w.request('/_next/static/chunks/missing.js');
  assert.ok(!w.allCachedPaths().some(p => /private|missing/.test(p)), 'no-store and error responses are not cached');
});
test('the cache only ever holds allow-listed static paths', async () => {
  const w = makeWorker(); await w.install();
  for (const p of ['/_next/static/a.js', '/_next/static/b.css', '/icons/x.png', '/app', '/api/x', '/pricing', '/_next/image?url=x', '/favicon.ico', '/manifest.webmanifest']) await w.request(p);
  await new Promise(r => setTimeout(r, 10));
  assert.ok(w.allCachedPaths().every(p => p.startsWith('/_next/static/') || p.startsWith('/icons/') || p === '/offline.html'), w.allCachedPaths().join(', '));
});
test('activation removes every older LeadMelo cache (including the retired V16 worker\'s) and leaves other sites\' caches alone', async () => {
  const w = makeWorker(); w.stores.set('leadmelo-v16-pages', new Map([['https://app.example/app', new Response('private')]])); w.stores.set('leadmelo-static-v1', new Map()); w.stores.set('someone-elses-cache', new Map());
  await w.install(); await w.activate();
  assert.deepEqual([...w.stores.keys()].sort(), ['leadmelo-static-v2', 'someone-elses-cache']);
});

test('manifest is valid, complete and points at real files', () => {
  const m = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.deepEqual([m.name, m.short_name, m.display, m.scope, m.start_url], ['LeadMelo', 'LeadMelo', 'standalone', '/', '/app']);
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i); assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  for (const size of ['192x192', '512x512']) assert.ok(m.icons.some(i => i.sizes === size && i.type === 'image/png' && /any/.test(i.purpose ?? 'any')), 'any-purpose ' + size);
  assert.ok(m.icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512'), 'a maskable icon exists');
  for (const icon of m.icons.filter(i => i.type === 'image/png')) {
    const file = 'public' + icon.src; assert.ok(existsSync(file), file);
    const buf = readFileSync(file);
    assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file + ' is a PNG');
    const [w, h] = icon.sizes.split('x').map(Number); assert.equal(buf.readUInt32BE(16), w, file + ' width'); assert.equal(buf.readUInt32BE(20), h, file + ' height');
  }
  for (const s of m.shortcuts) assert.ok(existsSync(`app${s.url === '/app' ? '/app' : s.url}/page.tsx`) || existsSync(`app${s.url}/page.tsx`), 'shortcut route exists: ' + s.url);
  assert.ok(m.start_url.startsWith('/') && m.start_url.startsWith(m.scope === '/' ? '/' : m.scope));
  assert.ok(existsSync('public/icons/apple-touch-icon.png'));
});
test('layout declares mobile viewport, theme colour, manifest and Apple web-app metadata; offline page is self-contained', () => {
  const layout = readFileSync('app/layout.tsx', 'utf8');
  for (const needle of ["width: 'device-width'", "initialScale: 1", "viewportFit: 'cover'", "manifest: '/manifest.webmanifest'", 'apple-touch-icon.png', "appleWebApp: { capable: true", 'themeColor', '<PwaRegister']) assert.ok(layout.includes(needle), needle);
  const offline = readFileSync('public/offline.html', 'utf8');
  assert.match(offline, /name="viewport"[^>]*width=device-width/); assert.ok(!/<script/i.test(offline), 'no script (the CSP would block it and it must work offline)');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(offline.replace(/<a[^>]*>/g, '')), 'no external requests');
  const reg = readFileSync('components/PwaRegister.tsx', 'utf8');
  assert.ok(reg.includes("process.env.NODE_ENV !== 'production'") && reg.includes("updateViaCache: 'none'") && reg.includes("scope: '/'"));
});
test('service worker and manifest are excluded from the nonce middleware and served without caching', async () => {
  assert.ok(readFileSync('middleware.ts', 'utf8').includes('manifest.webmanifest|sw.js'));
  const config = (await import('../next.config.mjs')).default;
  const rules = await config.headers();
  const sw = rules.find(r => r.source === '/sw.js');
  assert.ok(sw && sw.headers.some(h => h.key === 'Cache-Control' && /no-cache/.test(h.value)) && sw.headers.some(h => h.key === 'Service-Worker-Allowed' && h.value === '/'));
});
test('mobile styling: 16px inputs (no iOS zoom), 44px touch targets, bottom navigation, safe areas, reduced motion', () => {
  const css = readFileSync('app/globals.css', 'utf8');
  assert.match(css, /input:not\(\[type=checkbox\]\)[^{]*\{[^}]*font-size:16px/); assert.match(css, /button,\.btn\{[^}]*min-height:44px/);
  assert.match(css, /@media\(max-width:760px\)\{[^@]*\.side nav\{position:fixed;left:0;right:0;bottom:0/);
  for (const needle of ['env(safe-area-inset-bottom)', 'env(safe-area-inset-left)', 'prefers-reduced-motion:reduce', '100dvh', ':focus-visible']) assert.ok(css.includes(needle), needle);
  assert.ok(!/font:\s*15px/.test(css), 'body text is at least 16px');
});
