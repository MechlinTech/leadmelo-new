import test from 'node:test';
import assert from 'node:assert/strict';
import { userError } from '../lib/userErrors.ts';
import { safeError } from '../lib/worker.ts';

test('API codes become readable sentences', () => {
  assert.equal(userError('invalid_credentials'), 'Invalid email or password. Please try again.');
  assert.equal(userError('invalid_request'), 'Some fields are invalid. Check the values and try again.');
  assert.equal(userError('role_not_allowed'), 'Your role cannot do that.');
  assert.match(userError('campaign_not_ready:tenant_automation_enabled,postal_address'), /tenant automation is off/);
  assert.match(userError('campaign_not_ready:tenant_automation_enabled,postal_address'), /business postal address is missing/);
  assert.equal(userError('Please sign in'), 'Please sign in');
});

test('run failures keep a safe, actionable code and never leak internals', () => {
  // Codes that used to be swallowed into integration_or_database_error.
  assert.equal(safeError(new Error('Invalid URL')), 'integration_or_database_error');
  assert.equal(safeError(new Error('fetch failed')), 'integration_or_database_error');
  assert.equal(safeError(new TypeError('fetch failed')), 'integration_or_database_error');
  for (const code of ['gateway_not_configured', 'gateway_unreachable', 'gateway_timeout', 'gateway_invalid_response', 'gateway_requires_https', 'gateway_http_422', 'gateway_http_502', 'provider_exceeded_limit'])
    assert.equal(safeError(new Error(code)), code, `${code} must survive so the user sees the real cause`);
  // Sensitive detail stays in the worker log only.
  for (const leaky of ['postgres://leadmelo:hunter2@db/leadmelo', 'Bearer sk-live-abc123', 'SELECT * FROM "TenantSetting"', 'at Object.processRun (file:///app/lib/worker.ts:64:11)'])
    assert.equal(safeError(new Error(leaky)), 'integration_or_database_error', `must not persist ${leaky}`);
  // A Prisma/JS error object without a usable message is still reported generically.
  assert.equal(safeError(undefined), 'integration_or_database_error');
  assert.equal(safeError(new Error('gateway_http_9999')), 'integration_or_database_error', 'only real HTTP codes pass');
});

test('every gateway failure code tells the user what to do next', () => {
  for (const code of ['gateway_not_configured', 'gateway_credential_missing', 'gateway_unreachable', 'gateway_timeout', 'gateway_invalid_response', 'gateway_http_409', 'max_attempts_exhausted', 'integration_or_database_error']) {
    const message = userError(code);
    assert.notEqual(message, code, `${code} must not fall through to the raw code`);
    // The only underscores allowed are literal config keys or file names the user must act on.
    assert.deepEqual(message.replace(/PROVIDER_GATEWAY_URL|PROVIDER_GATEWAY\.md/g, '').match(/_/g), null, `${code} must render as a sentence, got: ${message}`);
    assert.ok(message.length > 30, `${code} needs an actionable message`);
  }
  assert.match(userError('gateway_not_configured'), /PROVIDER_GATEWAY_URL/);
  assert.match(userError('gateway_unreachable'), /gateway service is running/);
  assert.match(userError('gateway_http_409'), /tenants\.json/);
  assert.match(userError('max_attempts_exhausted'), /three attempts/);
});
