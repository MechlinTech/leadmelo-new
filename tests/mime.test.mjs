import test from 'node:test';
import assert from 'node:assert/strict';
import { mimeMessage } from '../lib/m365/graph.ts';

// Parse a MIME message into its headers and its parts, following RFC 2046 boundaries.
function parseMime(base64) {
  const mime = Buffer.from(base64, 'base64').toString('utf8');
  const split = mime.indexOf('\r\n\r\n');
  const rawHeaders = mime.slice(0, split);
  const rawBody = mime.slice(split + 4);
  const headers = {};
  for (const line of rawHeaders.split('\r\n')) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  const boundary = /boundary="([^"]+)"/.exec(headers['content-type'])?.[1];
  assert.ok(boundary, 'multipart boundary is declared');
  const parts = [];
  for (const chunk of rawBody.split(`--${boundary}`)) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed === '--') continue;
    const at = trimmed.indexOf('\r\n\r\n');
    const pHeaders = {};
    for (const line of trimmed.slice(0, at).split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) pHeaders[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    const content = Buffer.from(trimmed.slice(at + 4).replace(/\s+/g, ''), 'base64').toString('utf8');
    parts.push({ type: pHeaders['content-type'], encoding: pHeaders['content-transfer-encoding'], content });
  }
  return { headers, boundary, parts, closing: rawBody.trimEnd().endsWith(`--${boundary}--`) };
}

const base = {
  tenantId: 't1', campaignId: 'c1', contactId: 'k1',
  from: 'sender@example.com', fromName: 'Sam Seller', to: 'buyer@example.com',
  headers: { 'List-Unsubscribe': '<https://x/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  calendlyUrl: 'https://calendly.com/sam/30min'
};

test('every message offers both a plain-text and an HTML alternative', async t => {
  await t.test('plain-text copy yields a readable text part and an HTML part', () => {
    const body = 'Hi Pat,\n\nQuestion about Acme Robotics.\n\nhttps://calendly.com/sam/30min?utm_source=leadmelo&utm_content=abc\n\nSam Seller';
    const parsed = parseMime(mimeMessage({ ...base, subject: 'Question for Pat', body }, 'key-1'));
    assert.equal(parsed.headers['content-type'], `multipart/alternative; boundary="${parsed.boundary}"`);
    assert.equal(parsed.headers['mime-version'], '1.0');
    assert.ok(parsed.closing, 'the closing boundary is present');
    assert.equal(parsed.parts.length, 2, 'exactly two alternatives');
    const [text, html] = parsed.parts;
    assert.equal(text.type, 'text/plain; charset=UTF-8');
    assert.equal(html.type, 'text/html; charset=UTF-8');
    for (const p of parsed.parts) assert.equal(p.encoding, 'base64');
    // The plain part keeps the approved copy verbatim.
    assert.ok(text.content.includes('Hi Pat,'), 'text alternative is populated');
    assert.ok(text.content.includes('Acme Robotics'));
    assert.ok(text.content.includes('utm_content=abc'), 'the signed link survives');
    // The HTML part is the same copy, escaped, not blank.
    assert.ok(html.content.startsWith('<html><body>'), 'html alternative is a document');
    assert.ok(html.content.includes('<p>'), 'paragraphs are present');
    assert.ok(!/<script/i.test(html.content), 'no script content');
  });

  await t.test('HTML copy yields an HTML part that is unchanged and a text fallback', () => {
    const body = '<html><body><p>Hi Pat</p><p>About <b>Acme</b> &amp; Co</p><a href="https://calendly.com/sam/30min">Book</a></body></html>';
    const parsed = parseMime(mimeMessage({ ...base, subject: 'Question for Pat', body }, 'key-2'));
    assert.equal(parsed.parts.length, 2);
    const [text, html] = parsed.parts;
    assert.equal(html.type, 'text/html; charset=UTF-8');
    assert.equal(html.content, body, 'an HTML body is sent unchanged, so review and send agree');
    assert.equal(text.type, 'text/plain; charset=UTF-8');
    assert.ok(text.content.includes('Hi Pat'), 'text fallback is readable');
    assert.ok(text.content.includes('Acme & Co'), 'entities are decoded for the text fallback');
    assert.ok(!/<[a-z]/i.test(text.content), 'no markup leaks into the text fallback');
  });

  await t.test('a long body survives intact in both alternatives', () => {
    const body = `Hi Pat, ${'x'.repeat(4000)}\nstill on this line\n\nBook: https://calendly.com/sam/30min?utm_content=${'y'.repeat(300)}`;
    const parsed = parseMime(mimeMessage({ ...base, subject: 'Question for Pat', body }, 'key-3'));
    const [text, html] = parsed.parts;
    assert.ok(text.content.includes('x'.repeat(4000)), 'the text part keeps the full body');
    assert.ok(text.content.includes('utm_content=' + 'y'.repeat(300)), 'the signed link is not truncated');
    assert.ok(html.content.includes('x'.repeat(4000)), 'the HTML part keeps the full body');
    assert.ok(html.content.includes('<br>'), 'newlines become breaks in the HTML part');
    // The transport is base64, so no long unbroken run reaches the wire inside a MIME part.
    for (const line of Buffer.from(mimeMessage({ ...base, subject: 'S', body }, 'k-wrap'), 'base64').toString('utf8').split('\r\n')) {
      if (line.startsWith('Content-Transfer-Encoding') || /^[\w+/=]+$/.test(line)) assert.ok(line.length <= 76, 'encoded lines stay wrapped');
    }
  });

  await t.test('both alternatives carry real content, never a blank body', () => {
    for (const [label, body] of [
      ['plain', 'Hi Pat, a real question about Acme.'],
      ['html', '<p>Hi Pat, a real question about Acme.</p>']
    ]) {
      const parsed = parseMime(mimeMessage({ ...base, subject: 'S', body }, `k-${label}`));
      for (const p of parsed.parts) assert.ok(p.content.trim().length > 10, `${label}: ${p.type} is not blank`);
    }
  });

  await t.test('the boundary is deterministic and cannot be injected through the body', () => {
    const a = parseMime(mimeMessage({ ...base, subject: 'S', body: 'Hello there.' }, 'same-key'));
    const b = parseMime(mimeMessage({ ...base, subject: 'S', body: 'Different copy.' }, 'same-key'));
    assert.equal(a.boundary, b.boundary, 'same recipient, subject and key give the same boundary');
    const evil = 'Hi\n----=_LeadMelo_deadbeef\nContent-Type: text/html\n\n<script>alert(1)</script>';
    const parsed = parseMime(mimeMessage({ ...base, subject: 'S', body: evil }, 'k-evil'));
    assert.ok(!parsed.content?.includes?.('x'), 'no crash');
    assert.equal(parsed.parts.length, 2, 'an injected boundary line stays inside the text part');
    assert.ok(parsed.parts[1].content.includes('&lt;script&gt;') || !parsed.parts[1].content.includes('<script>alert'), 'markup in the body is escaped, not executed');
  });
});