import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, templateIssue } from '../lib/template.ts';

test('preview and sending use the same supported placeholder renderer', () => {
  const template = 'Hi {{ firstName }}, {{company}}. {{offer}} from {{senderName}}: {{calendlyUrl}}';
  const vars = { firstName: 'Pat', company: 'Acme', offer: 'QA', senderName: 'Sam', calendlyUrl: 'https://calendly.com/acme/30min' };
  assert.equal(renderTemplate(template, vars), 'Hi Pat, Acme. QA from Sam: https://calendly.com/acme/30min');
  assert.equal(templateIssue(template), null);
});

test('missing values are safely blanked and personalization cannot add header line breaks', () => {
  assert.equal(renderTemplate('Hello {{firstName}} at {{company}}', { firstName: 'Pat\r\nBcc: attacker@example.com', company: '' }), 'Hello Pat Bcc: attacker@example.com at ');
});

test('unknown and malformed placeholders are rejected instead of reaching a recipient', () => {
  for (const template of ['{{internalNote}}', '{{first-name}}', '{{firstName', 'firstName}}']) {
    assert.equal(templateIssue(template), 'unknown_template_variable');
    assert.throws(() => renderTemplate(template, { firstName: 'Pat' }), /unknown_template_variable/);
  }
});