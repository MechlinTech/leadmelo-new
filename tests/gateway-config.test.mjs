import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../gateway/src/config.ts';
import { createGatewayServer } from '../gateway/src/server.ts';
import { GatewayStore } from '../gateway/src/store.ts';

const root = mkdtempSync(join(tmpdir(), 'gateway-config-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a missing taxonomy file is a visible fallback, not a startup failure', () => {
  const missing = join(root, 'does-not-exist.json');
  const config = loadConfig({ GATEWAY_TAXONOMY_FILE: missing });
  assert.deepEqual(config.taxonomy, { industries: {}, titles: {} });
  assert.equal(config.taxonomyFile, missing);
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /was not found/);
  assert.match(config.warnings[0], /built-in mappings only/);
});

test('a valid taxonomy file is loaded exactly, with case-insensitive vendor keys', () => {
  const file = join(root, 'valid-taxonomy.json');
  writeFileSync(file, JSON.stringify({
    industries: { ' Computer Software ': 'SaaS' },
    titles: { 'Head of Engineering': 'VP Engineering' }
  }));
  const config = loadConfig({ GATEWAY_TAXONOMY_FILE: file });
  assert.deepEqual(config.taxonomy, {
    industries: { 'computer software': 'SaaS' },
    titles: { 'head of engineering': 'VP Engineering' }
  });
  assert.deepEqual(config.warnings, []);
});

test('the checked-in empty template loads without pretending it has custom mappings', () => {
  const config = loadConfig({ GATEWAY_TAXONOMY_FILE: 'gateway/taxonomy.empty.json' });
  assert.deepEqual(config.taxonomy, { industries: {}, titles: {} });
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /defines no custom mappings/);
});

test('malformed JSON and invalid taxonomy shapes fail loudly with the file named', () => {
  const malformed = join(root, 'malformed-taxonomy.json');
  writeFileSync(malformed, '{ "industries": ');
  assert.throws(
    () => loadConfig({ GATEWAY_TAXONOMY_FILE: malformed }),
    error => error instanceof Error && error.message.includes(malformed) && /not valid JSON/.test(error.message)
  );

  const invalid = join(root, 'invalid-taxonomy.json');
  writeFileSync(invalid, JSON.stringify({ industries: { 'computer software': 'SaaS' }, unexpected: true }));
  assert.throws(
    () => loadConfig({ GATEWAY_TAXONOMY_FILE: invalid }),
    error => error instanceof Error && error.message.includes(invalid) && /is invalid/.test(error.message) && /Unrecognized key/.test(error.message)
  );
});

test('a configured tenants file that disappears is still fatal, so self-registration cannot reopen', () => {
  const missing = join(root, 'missing-tenants.json');
  assert.throws(
    () => loadConfig({ GATEWAY_TENANTS_FILE: missing }),
    error => error instanceof Error && error.message.includes(missing) && /was not found/.test(error.message)
  );
});

test('the gateway starts and answers its health check when taxonomy.json is absent', async () => {
  const config = loadConfig({ GATEWAY_TAXONOMY_FILE: join(root, 'still-missing.json') });
  const server = createGatewayServer(config, { store: new GatewayStore() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the real entry point starts with a missing taxonomy file and reports its warning', { timeout: 15000 }, async () => {
  const missing = join(root, 'entry-missing.json');
  const child = spawn(process.execPath, ['--import', 'tsx', 'gateway/src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GATEWAY_HOST: '127.0.0.1', PORT: '0',
      GATEWAY_TAXONOMY_FILE: missing,
      GATEWAY_TENANTS_FILE: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const listening = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway did not start: ${stderr || stdout}`)), 10000);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const line = stdout.split(/\r?\n/).find(item => item.includes('"gateway_listening"'));
        if (!line) return;
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
      child.on('exit', code => {
        clearTimeout(timer);
        reject(new Error(`gateway exited ${code}: ${stderr || stdout}`));
      });
    });
    assert.equal(listening.taxonomyFile, missing);
    assert.deepEqual(listening.taxonomy, { industries: 0, titles: 0 });
    assert.match(stderr, /gateway_config_warning/);
    assert.match(stderr, /was not found/);
    const health = await fetch(`http://127.0.0.1:${listening.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
  }
});
