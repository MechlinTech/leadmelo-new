import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
Object.assign(process.env, { DATABASE_URL: 'postgresql://unavailable:unavailable@127.0.0.1:55440/unavailable?connect_timeout=1', APP_URL: 'http://127.0.0.1:4317', DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), SESSION_SECRET: randomBytes(32).toString('hex'), OUTBOUND_ENABLED: 'false', NODE_ENV: 'production' });
const env = { ...process.env };
let web;
try {
  web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', '4317', '-H', '127.0.0.1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  web.stderr.on('data', data => process.stderr.write(data));
  const origin = process.env.APP_URL;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'web server starts');
  assert.equal((await fetch(origin + '/api/icps')).status, 401);
  assert.equal((await fetch(origin + '/app', { redirect: 'manual' })).status, 307);
  const loginPage = await fetch(origin + '/auth/signin');
  const csp = loginPage.headers.get('content-security-policy');
  assert.match(csp, /nonce-/);
  const html = await loginPage.text();
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.ok(html.includes(`nonce="${nonce}"`), 'Next bootstrap scripts carry matching nonce');
  assert.equal((await fetch(origin + '/api/icps', { headers: { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' } })).status, 401);
  console.log('PASS: production HTTP startup, protected redirect, unauthenticated API rejection, middleware bypass rejection and nonce CSP');
} catch (e) { console.error(e); process.exitCode = 1; }
finally {
  if (web && web.exitCode === null && web.signalCode === null) { web.kill('SIGTERM'); await new Promise(resolve => web.once('exit', resolve)); }
}
