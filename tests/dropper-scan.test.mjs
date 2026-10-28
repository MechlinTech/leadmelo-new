import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRoot } from '../scripts/security-scan.mjs';

test('workspace has no known droppers', () => {
  assert.deepEqual(scanRoot(process.cwd()), []);
});

test('scanner rejects a loader, a hooked script, and a hidden dropper name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropper-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node init && next build' } }));
    fs.writeFileSync(path.join(dir, 'init'), 'loader\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'temp_auto_push.bat\n');
    fs.mkdirSync(path.join(dir, 'lib'));
    const marker = 'global.i = ' + "'A10-1'";
    const evalCall = 'ev' + 'al(';
    const decode = 'at' + 'ob(';
    fs.writeFileSync(path.join(dir, 'lib', 'bad.mjs'), marker + '\n' + evalCall + decode + '"YQ=="));\n');
    const findings = scanRoot(dir);
    assert.ok(findings.some(item => item.includes('known dropper filename')));
    assert.ok(findings.some(item => item.includes('launches a known dropper')));
    assert.ok(findings.some(item => item.includes('temp_auto_push.bat')));
    assert.ok(findings.some(item => item.includes('obfuscated loader marker')));
    assert.ok(findings.some(item => item.includes('decoded eval loader')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
