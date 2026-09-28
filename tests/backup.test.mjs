import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// These run the real shell scripts against stub `docker`, `age`, `rsync` and `flock` executables, so
// they test the scripts' ordering, failure handling and refusals, NOT PostgreSQL, age or rsync themselves.
// They need POSIX bash: skipped on Windows unless FORCE_POSIX_TESTS=1 (and BASH_BIN=path to Git Bash).
const posixOnly = process.platform === 'win32' && !process.env.FORCE_POSIX_TESTS ? { skip: 'requires POSIX bash; runs in Linux CI' } : {};
const BASH = process.env.BASH_BIN ?? 'bash';
const repo = resolve('.');

// A throwaway project root containing copies of the scripts (they `cd` to their own parent directory)
// and a .env, so nothing in the repository is touched.
function project() {
  const root = mkdtempSync(join(tmpdir(), 'leadmelo-shell-'));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'backups'));
  for (const f of ['backup_postgres.sh', 'restore_postgres.sh', 'check_backup.sh']) copyFileSync(join(repo, 'scripts', f), join(root, 'scripts', f));
  writeFileSync(join(root, '.env'), 'POSTGRES_PASSWORD=ownerpw\n');
  const exe = (name, script) => writeFileSync(join(root, 'bin', name), '#!/usr/bin/env bash\nset -u\n' + script, { mode: 0o700 });
  exe('flock', 'exit 0');
  exe('rsync', `echo "$*" >> "${root}/rsync.log"\n[[ "\${TEST_FAILURE:-}" != offsite ]] || exit 2`);
  exe('age', `dec=0; prev=""; out=""; last=""
for a in "$@"; do [[ "$a" == --decrypt ]] && dec=1; [[ "$prev" == --output ]] && out="$a"; prev="$a"; last="$a"; done
[[ "$dec" == 1 || "\${TEST_FAILURE:-}" != encrypt ]] || exit 2
cp "$last" "$out"`);
  exe('docker', `echo "$*" >> "${root}/docker.log"
f="\${TEST_FAILURE:-}"
case "$*" in
  *pg_dump*) [[ "$f" != dump ]] || exit 2; printf 'test archive' ;;
  *"pg_restore --list"*) cat >/dev/null; [[ "$f" != verify ]] || exit 2; printf 'table of contents' ;;
  *"privacy-erasures.ts export"*) [[ "$f" != ledger ]] || exit 2; printf '[{"tenantId":"t1","email":"gone@example.com"}]' ;;
  *"reapply -"*) cat > "${root}/reapplied.json"; printf '%s' "\${DATABASE_URL:-}" > "${root}/reapply-url.txt"; echo '{"applied":1,"skipped":0}' ;;
  *"node -e"*) cat >/dev/null; [[ "$f" != ledger_invalid ]] || exit 1 ;;
  *"FROM pg_database"*) [[ -z "\${TEST_DB_EXISTS:-}" ]] || echo 1 ;;
  *) cat >/dev/null ;;
esac`);
  return { root, env: (extra = {}) => ({ ...process.env, PATH: join(root, 'bin') + delimiter + process.env.PATH, ...extra }) };
}
const run = (p, script, args, extra) => spawnSync(BASH, [join(p.root, 'scripts', script), ...args], { encoding: 'utf8', cwd: p.root, env: p.env(extra) });
const backupEnv = p => ({ BACKUP_DIR: join(p.root, 'backups'), AGE_RECIPIENT: 'synthetic-test-key', BACKUP_OFFSITE_TARGET: 'test@offsite:/backups/' });
const cleanup = p => rmSync(p.root, { recursive: true, force: true });
const sha = buf => createHash('sha256').update(buf).digest('hex');
const listing = p => readdirSync(join(p.root, 'backups'));

test('backup failure at dump, validation, ledger, encryption or offsite transfer cannot mark success', posixOnly, () => {
  for (const failure of ['dump', 'verify', 'ledger', 'ledger_invalid', 'encrypt', 'offsite']) {
    const p = project();
    try {
      const r = run(p, 'backup_postgres.sh', [], { ...backupEnv(p), TEST_FAILURE: failure });
      assert.notEqual(r.status, 0, failure);
      assert.ok(!existsSync(join(p.root, 'backups', 'last-success')), failure);
      assert.ok(!listing(p).some(n => n.startsWith('.work-')), 'temporary plaintext removed: ' + failure);
    } finally { cleanup(p); }
  }
});

test('a successful backup produces an encrypted dump AND erasure ledger, both checksummed and replicated', posixOnly, () => {
  const p = project();
  try {
    const r = run(p, 'backup_postgres.sh', [], backupEnv(p));
    assert.equal(r.status, 0, r.stderr);
    const files = listing(p);
    const dump = files.find(n => n.endsWith('.dump.age')), ledger = files.find(n => n.endsWith('.erasures.age'));
    assert.ok(dump && ledger, files.join(','));
    assert.ok(files.includes(dump + '.sha256') && files.includes(ledger + '.sha256'));
    assert.equal(readFileSync(join(p.root, 'backups', 'last-success'), 'utf8').trim(), dump);
    const rsync = readFileSync(join(p.root, 'rsync.log'), 'utf8');
    for (const n of [dump, dump + '.sha256', ledger, ledger + '.sha256']) assert.ok(rsync.includes(n), `replicated ${n}`);
    // The ledger is exported from the running web container, not from the dump.
    assert.match(readFileSync(join(p.root, 'docker.log'), 'utf8'), /exec -T web node --import tsx scripts\/privacy-erasures\.ts export/);
    assert.ok(!files.some(n => n.endsWith('.json')), 'no plaintext ledger left behind');
  } finally { cleanup(p); }
});

test('freshness check verifies marker age, both files, and their checksums', posixOnly, () => {
  const p = project();
  try {
    assert.notEqual(run(p, 'check_backup.sh', [], backupEnv(p)).status, 0, 'no backup yet');
    assert.equal(run(p, 'backup_postgres.sh', [], backupEnv(p)).status, 0);
    const check = () => run(p, 'check_backup.sh', [], backupEnv(p));
    assert.equal(check().status, 0, check().stdout + check().stderr);
    const dir = join(p.root, 'backups'), ledger = listing(p).find(n => n.endsWith('.erasures.age'));
    writeFileSync(join(dir, ledger), 'tampered');
    assert.match(check().stdout, /fail their checksums/); assert.notEqual(check().status, 0);
    rmSync(join(dir, ledger)); rmSync(join(dir, ledger + '.sha256'));
    assert.match(check().stdout, /erasure ledger .* missing/); assert.notEqual(check().status, 0);
  } finally { cleanup(p); }
  const q = project();
  try {
    assert.equal(run(q, 'backup_postgres.sh', [], backupEnv(q)).status, 0);
    const old = new Date(Date.now() - 30 * 3600000);
    utimesSync(join(q.root, 'backups', 'last-success'), old, old);
    const r = run(q, 'check_backup.sh', [], backupEnv(q));
    assert.notEqual(r.status, 0); assert.match(r.stdout, /stale/);
  } finally { cleanup(q); }
});

// ---- restore ----
function restoreFixtures(p) {
  const dir = join(p.root, 'restore-in'); mkdirSync(dir);
  const dump = Buffer.from('dump-bytes'), ledgerBytes = Buffer.from('[{"tenantId":"t1","email":"gone@example.com"}]');
  writeFileSync(join(dir, 'leadmelo-1.dump.age'), dump); writeFileSync(join(dir, 'leadmelo-1.dump.age.sha256'), `${sha(dump)}  leadmelo-1.dump.age\n`);
  writeFileSync(join(dir, 'leadmelo-1.erasures.age'), ledgerBytes); writeFileSync(join(dir, 'leadmelo-1.erasures.age.sha256'), `${sha(ledgerBytes)}  leadmelo-1.erasures.age\n`);
  writeFileSync(join(dir, 'identity.key'), 'AGE-SECRET-KEY-synthetic');
  return { dump: join(dir, 'leadmelo-1.dump.age'), ledger: join(dir, 'leadmelo-1.erasures.age'), key: join(dir, 'identity.key'), ledgerBytes: ledgerBytes.toString() };
}

test('restore refuses unsafe names and refuses to run without an erasure decision', posixOnly, () => {
  const p = project();
  try {
    const f = restoreFixtures(p);
    const env = { AGE_IDENTITY_FILE: f.key };
    const badName = run(p, 'restore_postgres.sh', [f.dump, 'leadmelo'], { ...env, ERASURE_LEDGER_FILE: f.ledger });
    assert.notEqual(badName.status, 0); assert.match(badName.stderr, /Target must start/);
    const noLedger = run(p, 'restore_postgres.sh', [f.dump, 'leadmelo_restore_x'], env);
    assert.notEqual(noLedger.status, 0); assert.match(noLedger.stderr, /ERASURE_LEDGER_FILE/);
    assert.ok(!existsSync(join(p.root, 'docker.log')), 'nothing touched the database');
  } finally { cleanup(p); }
});

test('restore with a ledger restores into a new database and re-applies erasures with owner credentials', posixOnly, () => {
  const p = project();
  try {
    const f = restoreFixtures(p);
    const r = run(p, 'restore_postgres.sh', [f.dump, 'leadmelo_restore_test'], { AGE_IDENTITY_FILE: f.key, ERASURE_LEDGER_FILE: f.ledger });
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(p.root, 'docker.log'), 'utf8');
    assert.match(log, /createdb -U leadmelo leadmelo_restore_test/);
    assert.match(log, /pg_restore -U leadmelo --dbname=leadmelo_restore_test .*--single-transaction/);
    assert.match(log, /UPDATE "TenantSetting" SET "automationEnabled"=false/);
    assert.match(log, /run --rm --no-deps -T -e DATABASE_URL web node --import tsx scripts\/privacy-erasures\.ts reapply -/);
    assert.equal(readFileSync(join(p.root, 'reapplied.json'), 'utf8'), f.ledgerBytes, 'the decrypted ledger was streamed to the re-apply step');
    assert.equal(readFileSync(join(p.root, 'reapply-url.txt'), 'utf8'), 'postgresql://leadmelo:ownerpw@postgres:5432/leadmelo_restore_test');
    assert.ok(!log.includes('ownerpw'), 'the password never appears on a command line');
    assert.ok(log.indexOf('pg_restore -U') < log.indexOf('reapply -'), 're-apply happens after the restore');
    assert.match(r.stdout, /re-applied/);
  } finally { cleanup(p); }
});

test('restore can skip the ledger only explicitly, and says so loudly', posixOnly, () => {
  const p = project();
  try {
    const f = restoreFixtures(p);
    const r = run(p, 'restore_postgres.sh', [f.dump, 'leadmelo_restore_drill'], { AGE_IDENTITY_FILE: f.key, SKIP_ERASURE_LEDGER: 'yes' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARNING: no erasure ledger was applied/);
    assert.ok(!readFileSync(join(p.root, 'docker.log'), 'utf8').includes('reapply'));
  } finally { cleanup(p); }
});

test('restore refuses an existing database, a bad checksum and a missing ledger checksum before changing anything', posixOnly, () => {
  const p = project();
  try {
    const f = restoreFixtures(p), env = { AGE_IDENTITY_FILE: f.key, ERASURE_LEDGER_FILE: f.ledger };
    const exists = run(p, 'restore_postgres.sh', [f.dump, 'leadmelo_restore_test'], { ...env, TEST_DB_EXISTS: '1' });
    assert.notEqual(exists.status, 0); assert.match(exists.stderr, /Refusing to overwrite/);
    assert.ok(!/createdb/.test(readFileSync(join(p.root, 'docker.log'), 'utf8')));
    writeFileSync(f.dump, 'tampered');
    assert.notEqual(run(p, 'restore_postgres.sh', [f.dump, 'leadmelo_restore_test2'], env).status, 0, 'bad database checksum');
    writeFileSync(f.dump, 'dump-bytes');
    rmSync(f.ledger + '.sha256');
    const noSum = run(p, 'restore_postgres.sh', [f.dump, 'leadmelo_restore_test3'], env);
    assert.notEqual(noSum.status, 0); assert.match(noSum.stderr, /ledger or its checksum/);
  } finally { cleanup(p); }
});
