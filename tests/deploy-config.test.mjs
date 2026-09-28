import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

// Static checks of the deployment files. Docker is NOT run here: these catch structural and security
// regressions (a secret leaking into the gateway, a published database port, mismatched versions) but
// cannot prove the images build or the stack starts. That still needs a real Docker host.
const compose = parse(readFileSync('docker-compose.selfhosted.yml', 'utf8'), { merge: true });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const envExample = readFileSync('.env.example', 'utf8');
const envKeys = new Set(envExample.split('\n').map(l => /^([A-Z_]+)=/.exec(l)?.[1]).filter(Boolean));
const svc = compose.services;
const posixOnly = process.platform === 'win32' && !process.env.FORCE_POSIX_TESTS ? { skip: 'requires POSIX bash' } : {};

test('compose defines the expected services, with the gateway optional', () => {
  assert.deepEqual(Object.keys(svc).sort(), ['gateway', 'migrate', 'postgres', 'web', 'worker']);
  assert.deepEqual(svc.gateway.profiles, ['gateway'], 'not started unless requested');
  for (const name of ['web', 'worker', 'migrate']) assert.equal(svc[name].profiles, undefined, `${name} always starts`);
});

test('no database port, Docker socket or privileged container is exposed', () => {
  assert.equal(svc.postgres.ports, undefined, 'PostgreSQL is not published');
  const text = readFileSync('docker-compose.selfhosted.yml', 'utf8');
  assert.ok(!/docker\.sock/.test(text) && !/privileged/.test(text) && !/network_mode:\s*host/.test(text));
  for (const [name, s] of Object.entries(svc)) for (const p of s.ports ?? []) assert.match(String(p), /^127\.0\.0\.1:/, `${name} publishes only on localhost: ${p}`);
  for (const [name, s] of Object.entries(svc)) assert.deepEqual(s.security_opt, ['no-new-privileges:true'], `${name} sets no-new-privileges`);
});

test('secret separation: web and worker never see the database owner password; the gateway sees no LeadMelo secrets', () => {
  const env = name => svc[name].environment ?? {};
  for (const name of ['web', 'worker']) {
    assert.match(env(name).DATABASE_URL, /leadmelo_app:/, `${name} connects as the restricted runtime role`);
    assert.ok(!('POSTGRES_PASSWORD' in env(name)));
  }
  assert.match(env('migrate').DATABASE_URL, /postgresql:\/\/leadmelo:\$\{POSTGRES_PASSWORD\}/, 'only the migration service uses the owner');
  const gw = env('gateway');
  for (const forbidden of ['DATABASE_URL', 'SESSION_SECRET', 'DATA_ENCRYPTION_KEY', 'POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'ALERT_WEBHOOK_SECRET']) assert.ok(!(forbidden in gw), `gateway must not receive ${forbidden}`);
  assert.equal(gw.GATEWAY_TENANTS_FILE, '/etc/leadmelo-gateway/tenants.json');
  const mounts = svc.gateway.volumes.map(String);
  assert.ok(mounts.some(m => /:\/etc\/leadmelo-gateway:ro$/.test(m)), 'vendor keys are mounted read-only');
  assert.equal(svc.gateway.read_only, true);
});

test('every compose variable is documented in .env.example, and versions agree everywhere', () => {
  const text = readFileSync('docker-compose.selfhosted.yml', 'utf8');
  const used = new Set([...text.matchAll(/\$\{([A-Z_]+)/g)].map(m => m[1]));
  for (const v of used) assert.ok(envKeys.has(v), `${v} is used by compose but missing from .env.example`);
  assert.match(text, new RegExp(`RELEASE_TAG:-${pkg.version.replace(/\./g, '\\.')}`), 'compose default tag equals package.json version');
  assert.ok(envExample.includes(`RELEASE_TAG=${pkg.version}`), '.env.example RELEASE_TAG equals package.json version');
  assert.ok(readFileSync('package-lock.json', 'utf8').includes(`"version": "${pkg.version}"`));
  assert.ok(!envExample.split('\n').some(l => /^(POSTGRES_PASSWORD|SESSION_SECRET|DATA_ENCRYPTION_KEY|APP_DB_PASSWORD)=(?!CHANGE_ME$)/.test(l)), '.env.example holds placeholders only');
});

test('services run commands that exist, and the health checks target real routes', () => {
  assert.ok(pkg.scripts.gateway && pkg.scripts.worker && pkg.scripts['db:deploy']);
  assert.deepEqual(svc.gateway.command, ['npm', 'run', 'gateway']); assert.deepEqual(svc.worker.command, ['npm', 'run', 'worker']);
  assert.match(svc.migrate.command.join(' '), /npm run db:deploy && node --import tsx scripts\/database-role\.ts/);
  for (const f of ['scripts/database-role.ts', 'scripts/worker-health.ts', 'gateway/src/main.ts', 'worker/index.ts', 'app/api/health/route.ts', 'app/api/ready/route.ts']) assert.ok(existsSync(f), f);
  assert.match(svc.gateway.healthcheck.test.join(' '), /8788\/health/);
  assert.equal(svc.gateway.environment.PORT, '8788'); assert.match(svc.gateway.ports[0], /8788:8788$/);
  assert.match(svc.web.ports[0], /HOST_PORT:-7676|:7676:3000/);
});

test('Dockerfile runs as a non-root user and prepares the gateway state directory', () => {
  const d = readFileSync('Dockerfile', 'utf8');
  assert.match(d, /USER node/); assert.match(d, /mkdir -p \/var\/lib\/leadmelo-gateway && chown node:node \/var\/lib\/leadmelo-gateway/);
  assert.ok(d.indexOf('chown node:node /var/lib/leadmelo-gateway') < d.indexOf('USER node'), 'ownership is set before dropping privileges');
  assert.ok(svc.gateway.volumes.some(v => String(v).startsWith('gatewaydata:/var/lib/leadmelo-gateway')));
  assert.match(readFileSync('.dockerignore', 'utf8'), /node_modules/); assert.match(readFileSync('.dockerignore', 'utf8'), /\.env/);
});

test('proxy examples cover the app and the gateway, and never log request bodies or queries', () => {
  const caddy = readFileSync('deploy/caddy/Caddyfile.example', 'utf8'), nginx = readFileSync('deploy/nginx/leadmelo.conf.example', 'utf8');
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:7676/); assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8788/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:7676/); assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8788/);
  assert.equal((nginx.match(/access_log off;/g) ?? []).length, 2, 'both server blocks disable access logs');
  assert.equal((nginx.match(/client_max_body_size 64k;/g) ?? []).length, 2);
  assert.ok(!/proxy_pass http:\/\/(?!127\.0\.0\.1)/.test(nginx));
});

test('every required file named by the handoff audit exists, and every migration is listed', () => {
  const audit = readFileSync('scripts/handoff_audit.py', 'utf8');
  const required = [...audit.matchAll(/'([^']+\.[A-Za-z0-9]+)'/g)].map(m => m[1]).filter(f => /[\/.]/.test(f) && !f.startsWith('.') || f === '.env.example' || f === '.dockerignore');
  for (const f of required) if (!/^(href|src)/.test(f)) assert.ok(existsSync(f) || f.includes('*'), `handoff_audit requires ${f}`);
  for (const dir of readdirSync('prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory())) assert.ok(audit.includes(dir.name), `handoff_audit lists migration ${dir.name}`);
  for (const f of ['gateway/README.md', 'docs/SCHEMA_REFERENCE.md', 'docs/CALENDLY.md', 'deploy/monitor/external-monitor.sh', 'scripts/privacy-erasures.ts']) assert.ok(audit.includes(f), `handoff_audit requires ${f}`);
});

test('deploy fails unless the new commit image replaced the running web container', () => {
  const deploy = readFileSync('scripts/deploy.ps1', 'utf8');
  const writer = readFileSync('scripts/write-deploy-env.ps1', 'utf8');
  assert.match(deploy, /--force-recreate/);
  assert.match(deploy, /web container was not recreated/);
  assert.match(deploy, /still serving the previous release/);
  assert.match(writer, /RELEASE_TAG'\] = \$ReleaseTag/);
  assert.match(writer, /C:\\leadmelo/);
  for (const workflow of ['.github/workflows/deploy-dev.yml', '.github/workflows/deploy-prod.yml']) {
    const text = readFileSync(workflow, 'utf8');
    assert.match(text, /write-deploy-env\.ps1/);
    assert.match(text, /RELEASE_TAG: "\$\{\{ github\.sha \}\}"/);
  }
});

test('shell scripts are syntactically valid bash', posixOnly, () => {
  const bash = process.env.BASH_BIN ?? 'bash';
  for (const f of ['scripts/backup_postgres.sh', 'scripts/restore_postgres.sh', 'scripts/check_backup.sh', 'scripts/preflight.sh', 'scripts/ci-restore.sh', 'deploy/monitor/external-monitor.sh']) {
    const r = spawnSync(bash, ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
