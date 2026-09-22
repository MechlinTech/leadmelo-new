import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const posixOnly = process.platform === 'win32' && !process.env.FORCE_POSIX_TESTS ? { skip: 'requires POSIX bash; runs in Linux CI' } : {};
const BASH = process.env.BASH_BIN ?? 'bash';
// A stub curl records page posts and fails or succeeds readiness on demand.
function run(dir, { ready, webhookOk = true }) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
for a in "$@"; do case "$a" in *"/api/ready") [[ "${ready}" == up ]] && exit 0 || exit 22;; esac; done
echo "$*" >> "${dir}/pages.log"
[[ "${webhookOk}" == true ]] || exit 22
`, { mode: 0o700 });
  return spawnSync(BASH, ['deploy/monitor/external-monitor.sh'], { cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, PATH: bin + delimiter + process.env.PATH, CURL_BIN: join(bin, 'curl').split('\\').join('/'), LEADMELO_URL: 'https://app.example.com', PAGE_WEBHOOK_URL: 'https://hooks.example.com/x', STATE_DIR: join(dir, 'state'), FAILURES_TO_PAGE: '3' } });
}
const pages = dir => existsSync(join(dir, 'pages.log')) ? readFileSync(join(dir, 'pages.log'), 'utf8').trim().split('\n').filter(Boolean) : [];

test('external monitor pages after consecutive failures, once, and reports recovery', posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'leadmelo-monitor-'));
  try {
    assert.equal(run(dir, { ready: 'down' }).status, 1); assert.equal(run(dir, { ready: 'down' }).status, 1);
    assert.equal(pages(dir).length, 0, 'no page before threshold');
    run(dir, { ready: 'down' });
    assert.equal(pages(dir).length, 1); assert.match(pages(dir)[0], /"status":"down"/);
    run(dir, { ready: 'down' }); run(dir, { ready: 'down' });
    assert.equal(pages(dir).length, 1, 'does not re-page while still down');
    assert.equal(run(dir, { ready: 'up' }).status, 0);
    assert.equal(pages(dir).length, 2); assert.match(pages(dir)[1], /"status":"recovered"/);
    assert.equal(run(dir, { ready: 'up' }).status, 0); assert.equal(pages(dir).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('external monitor retries the page when the webhook itself fails and refuses non-https config', posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), 'leadmelo-monitor-'));
  try {
    for (let i = 0; i < 3; i++) run(dir, { ready: 'down', webhookOk: false });
    assert.equal(existsSync(join(dir, 'state', 'paged')), false, 'failed page is not marked delivered');
    run(dir, { ready: 'down', webhookOk: true });
    assert.equal(existsSync(join(dir, 'state', 'paged')), true);
    const bad = spawnSync(BASH, ['deploy/monitor/external-monitor.sh'], { encoding: 'utf8', env: { ...process.env, LEADMELO_URL: 'http://insecure.example', PAGE_WEBHOOK_URL: 'https://x.example', STATE_DIR: join(dir, 's2') } });
    assert.equal(bad.status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
