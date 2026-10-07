import test from 'node:test';
import assert from 'node:assert/strict';
import { mimeMessage, hasVisibleText } from '../lib/m365/graph.ts';
import { renderTemplate } from '../lib/policy.ts';

// A reviewed/approved email must reach the provider carrying exactly the subject and body the
// review screen showed, and a message with no readable text must never be sent.

const base = {
  tenantId: 't1', campaignId: 'c1', contactId: 'ct1',
  from: 'sender@example.com', fromName: 'Sender Name', to: 'lead@example.com',
  subject: 'Reviewed subject',
  body: 'Hi there,\n\nBody copy.\n\nUnsubscribe: https://app.example/unsubscribe?token=t',
  headers: { 'List-Unsubscribe': '<https://app.example/unsubscribe?token=t>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  calendlyUrl: 'https://calendly.com/x/30min'
};

function decodeMime(mime) {
  const raw = Buffer.from(mime, 'base64').toString('utf8');
  const split = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, split);
  const body = Buffer.from(raw.slice(split + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { headers, body };
}

test('an approved message reaches the provider with the reviewed subject and body intact', () => {
  const mime = mimeMessage(base, 'key-1');
  const { headers, body } = decodeMime(mime);
  assert.equal(body, base.body, 'decoded MIME body must equal the reviewed body byte for byte');
  assert.match(headers, /^Content-Type: text\/plain; charset=UTF-8$/m, 'plain-text content type is declared');
  assert.match(headers, /^Content-Transfer-Encoding: base64$/m);
  const encodedSubject = headers.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)?.[1];
  assert.equal(Buffer.from(encodedSubject, 'base64').toString('utf8'), base.subject, 'subject survives encoding');
});

test('personalisation, links and formatting survive the approved send', () => {
  const vars = { firstName: 'Bhavesh', company: 'Mechlin', senderName: 'Sender Name', calendlyUrl: 'https://calendly.com/x/30min', offer: 'a demo' };
  const rendered = renderTemplate('Hi {{firstName}}, {{company}} -> {{calendlyUrl}} ({{offer}})\n\n{{senderName}}', vars);
  const body = `${rendered}\n\nUnsubscribe: https://app.example/u?t=1`;
  const { body: decoded } = decodeMime(mimeMessage({ ...base, body }, 'key-2'));
  assert.equal(decoded, body);
  assert.match(decoded, /Hi Bhavesh, Mechlin -> https:\/\/calendly\.com\/x\/30min \(a demo\)/, 'every variable is filled');
  assert.doesNotMatch(decoded, /\{\{/, 'no placeholder survives');
  assert.match(decoded, /Unsubscribe: https:\/\/app\.example\/u\?t=1/, 'unsubscribe footer retained');
});

test('plain-text bodies keep their newlines', () => {
  const body = 'line one\nline two\n\nline four';
  const { body: decoded } = decodeMime(mimeMessage({ ...base, body }, 'key-3'));
  assert.equal(decoded, body);
});

test('HTML content that carries real text is accepted', () => {
  const body = '<p>Hello <strong>there</strong></p>';
  const { body: decoded } = decodeMime(mimeMessage({ ...base, body }, 'key-4'));
  assert.equal(decoded, body);
});

test('empty, whitespace-only and effectively empty bodies are rejected', () => {
  const cases = [
    ['empty', ''],
    ['spaces', '     '],
    ['newlines', '\n\n\n'],
    ['tabs', '\t \t'],
    ['tags only', '<p></p><br><span></span>'],
    ['comment only', '<!-- nothing to see -->'],
    ['nbsp only', '&nbsp;&nbsp;'],
    ['entity only', '&#8203;']
  ];
  for (const [label, body] of cases) {
    assert.equal(hasVisibleText(body), false, `${label} must count as empty`);
    assert.throws(() => mimeMessage({ ...base, body }, 'k'), /mail_body_effectively_empty|too_small/, `${label} must be rejected`);
  }
});

test('a blank subject is rejected', () => {
  assert.throws(() => mimeMessage({ ...base, subject: '   ' }, 'k'), /too_small|mail_subject_blank/);
});

test('hasVisibleText keeps genuinely empty-looking but real text', () => {
  assert.equal(hasVisibleText('a'), true);
  assert.equal(hasVisibleText('&amp;'), true, 'an ampersand entity is visible text');
  assert.equal(hasVisibleText('0'), true, 'a zero is visible text');
  assert.equal(hasVisibleText(null), false);
  assert.equal(hasVisibleText(undefined), false);
});

test('header injection is still rejected', () => {
  assert.throws(() => mimeMessage({ ...base, subject: 'ok\r\nBcc: victim@example.com' }, 'k'), /mail_header_injection/);
});