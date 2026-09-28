import test from 'node:test';
import assert from 'node:assert/strict';
import { csvToLeadRows, parseCsv } from '../lib/csv.ts';
import { mergeConfig, defaultConfig, alertCodeEnabled } from '../lib/workspaceConfig.ts';
import { shouldRaise } from '../lib/automationRules.ts';

test('CSV parser handles quotes, commas and header aliases', () => {
  const rows = csvToLeadRows('Company,Website,Email\n"Acme, Inc",acme.example,pat@acme.example\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, 'Acme, Inc');
  assert.equal(rows[0].domain, 'acme.example');
  assert.equal(rows[0].contactEmail, 'pat@acme.example');
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('workspace config keeps system rules and honors disabled alert codes', () => {
  const next = mergeConfig({
    alerts: { inApp: true, recipients: ['ops@example.com'], webhookUrl: null, codes: { bounced_email: false } },
    rules: [{ id: 'sys_bounce_alert', name: 'x', enabled: false, when: 'bounced_email', action: 'raise_alert' }, { id: 'custom-1', name: 'Pause on bounce', enabled: true, when: 'bounced_email', action: 'pause_active_campaigns' }]
  });
  assert.equal(next.alerts.recipients[0], 'ops@example.com');
  assert.equal(next.alerts.codes.bounced_email, false);
  assert.ok(next.rules.some(r => r.id === 'sys_bounce_alert' && r.enabled === false));
  assert.ok(next.rules.some(r => r.id === 'custom-1'));
  assert.equal(alertCodeEnabled(next, 'bounced_email'), false);
  assert.equal(shouldRaise('bounced_email', next), false);
  assert.equal(shouldRaise('test_failure', defaultConfig()), true);
});
