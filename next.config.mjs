const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
];
// The service worker script must never be cached by the browser or a proxy, or updates (and the cache-cleanup on
// activation) would be delayed; it may control the whole origin.
const serviceWorkerHeaders = [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }, { key: 'Content-Type', value: 'application/javascript; charset=utf-8' }, { key: 'Service-Worker-Allowed', value: '/' }];
export default { reactStrictMode: true, poweredByHeader: false, eslint: { ignoreDuringBuilds: true }, async headers() { return [{ source: '/(.*)', headers: securityHeaders }, { source: '/sw.js', headers: serviceWorkerHeaders }]; } };
