// LeadMelo service worker. It caches ONLY versioned static assets (build files, icons) so repeat visits are
// fast and the app shell can show an offline page. It never stores HTML, API responses, sessions or any
// tenant data: signed-in pages and /api are always fetched from the network and are never cached.
const VERSION = 'v2';
const STATIC_CACHE = `leadmelo-static-${VERSION}`;
const PRECACHE = ['/offline.html', '/icons/logo.svg', '/icons/icon-192.png', '/icons/icon-512.png'];
// Never touched by the cache, even if a rule below would otherwise match.
const NEVER_CACHE = [/^\/api(\/|$)/, /^\/app(\/|$)/, /^\/auth(\/|$)/, /^\/unsubscribe/, /^\/_next\/data\//, /^\/request-access/];
const isStatic = url => url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/');

self.addEventListener('install', event => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Removes every older LeadMelo cache, including the caches the retired V16 worker left behind.
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('leadmelo-') && key !== STATIC_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });

async function offlineFallback() {
  const cached = await caches.match('/offline.html');
  return cached ?? new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}
// Only successful, same-origin, non-private responses are stored.
function cacheable(response) {
  return response && response.ok && response.type === 'basic' && !/no-store|private/i.test(response.headers.get('Cache-Control') || '');
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // Pages are always network-first and are never stored; offline shows a static page instead.
    event.respondWith(fetch(request).catch(offlineFallback));
    return;
  }
  if (NEVER_CACHE.some(re => re.test(url.pathname)) || !isStatic(url)) return; // let the browser handle it
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(request);
    const refresh = fetch(request).then(response => { if (cacheable(response)) cache.put(request, response.clone()); return response; });
    if (hit) { refresh.catch(() => undefined); return hit; } // stale-while-revalidate
    return refresh;
  })());
});
