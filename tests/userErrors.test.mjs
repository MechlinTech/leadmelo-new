import test from 'node:test';
import assert from 'node:assert/strict';
import { userError } from '../lib/userErrors.ts';

test('API codes become readable sentences', () => {
  assert.equal(userError('invalid_credentials'), 'Invalid email or password. Please try again.');
  assert.equal(userError('invalid_request'), 'Some fields are invalid. Check the values and try again.');
  assert.equal(userError('role_not_allowed'), 'Your role cannot do that.');
  assert.match(userError('campaign_not_ready:tenant_automation_enabled,postal_address'), /tenant automation is off/);
  assert.match(userError('campaign_not_ready:tenant_automation_enabled,postal_address'), /business postal address is missing/);
  assert.equal(userError('Please sign in'), 'Please sign in');
});
