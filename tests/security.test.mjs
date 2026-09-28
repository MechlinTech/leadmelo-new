import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertTenantScope } from '../lib/tenant.ts';
test('tenant helper rejects missing or other tenant', () => {
  assert.throws(() => assertTenantScope(undefined,'a'));
  assert.throws(() => assertTenantScope('b','a'));
  assert.doesNotThrow(() => assertTenantScope('a','a'));
});
test('CSP uses nonces (service-worker behaviour is tested in pwa.test.mjs)', () => {
  assert.ok(fs.readFileSync('middleware.ts','utf8').includes("'strict-dynamic'"));
});
