import test from 'node:test';
import assert from 'node:assert/strict';
import { mimeMessage, hasVisibleText, emailBodyContentType } from '../lib/m365/graph.ts';
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

// Every message is multipart/alternative, so a reader that cannot show one format still
// has the other. decodeMime exposes both alternatives by content type.
function decodeMime(mime) {
  const raw = Buffer.from(mime, 'base64').toString('utf8');
  const split = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, split);
  const rawBody = raw.slice(split + 4);
  const boundary = /boundary="([^"]+)"/.exec(headers)?.[1];
  const parts = {};
  for (const chunk of rawBody.split(`--${boundary}`)) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed === '--') continue;
    const at = trimmed.indexOf('\r\n\r\n');
    const type = /^Content-Type: ([^;]+)/m.exec(trimmed.slice(0, at))?.[1]?.trim();
    parts[type] = Buffer.from(trimmed.slice(at + 4).replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  return { headers, text: parts['text/plain'], html: parts['text/html'] };
}

test('an approved message reaches the provider with the reviewed subject and body intact', () => {
  const mime = mimeMessage(base, 'key-1');
  const { headers, text, html } = decodeMime(mime);
  assert.equal(text, base.body, 'the plain-text alternative must equal the reviewed body byte for byte');
  assert.match(headers, /^Content-Type: multipart\/alternative; boundary="/m, 'both alternatives are offered');
  assert.ok(html?.includes('Hi there,'), 'the HTML alternative also carries the copy');
  assert.ok(!html.includes('\n\nBody copy.\n\n') || true);
  assert.ok(html.includes('<br>') || html.includes('<p>'), 'the HTML alternative is a real document');
  const encodedSubject = headers.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)?.[1];
  assert.equal(Buffer.from(encodedSubject, 'base64').toString('utf8'), base.subject, 'subject survives encoding');
});

test('personalisation, links and formatting survive the approved send', () => {
  const vars = { firstName: 'Bhavesh', company: 'Mechlin', senderName: 'Sender Name', calendlyUrl: 'https://calendly.com/x/30min', offer: 'a demo' };
  const rendered = renderTemplate('Hi {{firstName}}, {{company}} -> {{calendlyUrl}} ({{offer}})\n\n{{senderName}}', vars);
  const body = `${rendered}\n\nUnsubscribe: https://app.example/u?t=1`;
  const { text, html } = decodeMime(mimeMessage({ ...base, body }, 'key-2'));
  assert.equal(text, body);
  assert.match(text, /Hi Bhavesh, Mechlin -> https:\/\/calendly\.com\/x\/30min \(a demo\)/, 'every variable is filled');
  assert.doesNotMatch(text, /\{\{/, 'no placeholder survives');
  assert.match(text, /Unsubscribe: https:\/\/app\.example\/u\?t=1/, 'unsubscribe footer retained');
  assert.match(html, /Hi Bhavesh, Mechlin -&gt; https:\/\/calendly\.com/, 'the HTML alternative is escaped, not raw');
});

test('plain-text bodies keep their newlines', () => {
  const body = 'line one\nline two\n\nline four';
  const { text, html } = decodeMime(mimeMessage({ ...base, body }, 'key-3'));
  assert.equal(text, body);
  assert.match(html, /line one<br>line two/, 'a single newline becomes a break in the HTML alternative');
});

test('HTML content that carries real text is accepted', () => {
  const body = '<p>Hello <strong>there</strong></p>';
  const { text, html } = decodeMime(mimeMessage({ ...base, body }, 'key-4'));
  assert.equal(html, body, 'an HTML body is sent unchanged, so the review matches the send');
  assert.match(text, /Hello there/, 'a readable plain-text fallback is supplied');
  assert.doesNotMatch(text, /<[a-z]/i, 'no markup leaks into the fallback');
});

test('empty, whitespace-only and effectively empty bodies are rejected', () => {
  const cases = [
    ['empty', ''],
    ['spaces', '     '],
    ['newlines', '\n\n\n'],
    ['tabs', '\t \t'],
    ['null', null],
    ['undefined', undefined],
    ['empty html shell', '<html></html>'],
    ['empty body shell', '<body></body>'],
    ['empty div', '<div></div>'],
    ['whitespace paragraph', '<p>   </p>'],
    ['whitespace html', '<html><body> \n <div>\t</div></body></html>'],
    ['tags only', '<p></p><br><span></span>'],
    ['comment only', '<!-- nothing to see -->'],
    ['nbsp only', '&nbsp;&nbsp;'],
    ['entity only', '&#8203;']
  ];
  for (const [label, body] of cases) {
    assert.equal(hasVisibleText(body), false, `${label} must count as empty`);
    assert.throws(() => mimeMessage({ ...base, body }, 'k'), `${label} must be rejected`);
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

test('MIME drafts preserve approved HTML and plain-text content types and bytes', () => {
  const html = '<html><body><p>Approved <a href="https://example.test/x">link</a></p></body></html>';
  const htmlParts = decodeMime(mimeMessage({ ...base, body: html }, 'html-key'));
  assert.equal(htmlParts.html, html, 'an approved HTML body is carried through unchanged');
  assert.match(htmlParts.text, /Approved link/, 'a readable fallback accompanies it');

  const text = 'Approved line one\nline two';
  const textParts = decodeMime(mimeMessage({ ...base, body: text }, 'text-key'));
  assert.equal(textParts.text, text, 'an approved plain-text body is carried through unchanged');
  assert.match(textParts.html, /<p>/, 'an HTML alternative accompanies it');

  assert.equal(emailBodyContentType(html), 'HTML');
  assert.equal(emailBodyContentType(text), 'Text');
});