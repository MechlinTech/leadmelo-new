import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildOutreachPreview } from '../lib/outreachPreview.ts';
import OutreachQueue from '../components/OutreachQueue.tsx';

// The test runner compiles TSX with the classic runtime; the app uses Next's
// automatic runtime, so expose React for this server-render check only.
globalThis.React = React;

const rendered = {
  subject: 'Question for Pat',
  body: 'Hi Pat,\n\nAcme Robotics needs QA.\n\nhttps://calendly.com/sam/30min?utm_source=leadmelo&utm_content=signed\n\n221B Test Street\nUnsubscribe: https://app.example/unsubscribe?token=abc',
  contentType: 'Text'
};

test('the queue preview uses the server-rendered snapshot, not the raw step template', () => {
  const preview = buildOutreachPreview({
    status: 'QUEUED',
    subject: 'Question for {{firstName}}',
    body: 'Hi {{firstName}}, {{company}}',
    reviewSubject: rendered.subject,
    reviewBody: rendered.body,
    reviewContentType: rendered.contentType
  });
  assert.deepEqual(preview, { state: 'ready', ...rendered });
});

test('a sent message falls back to the exact content that was stored and delivered', () => {
  const preview = buildOutreachPreview({ status: 'SENT', ...rendered, previewContentType: 'Text' });
  assert.deepEqual(preview, { state: 'ready', ...rendered });
});

test('HTML previews are identified without exposing raw tags as the text body', () => {
  const body = '<p>Hi Pat at Acme &amp; Co</p><a href="https://calendly.com/sam/30min">Book</a>';
  const preview = buildOutreachPreview({ reviewBody: body, reviewSubject: 'Hello', reviewContentType: 'HTML' });
  assert.equal(preview.state, 'ready');
  assert.equal(preview.body, body);
  assert.equal(preview.contentType, 'HTML');
  // Compatibility fallback for an older response that did not send a content type.
  assert.equal(buildOutreachPreview({ body }).contentType, 'HTML');
});

test('the preview is withheld when the server could not render it', () => {
  assert.deepEqual(buildOutreachPreview({ reviewError: 'unknown_template_variable', body: 'Hi {{firstName}}' }), {
    state: 'error', code: 'unknown_template_variable'
  });
  assert.deepEqual(buildOutreachPreview({ reviewError: 'postal_address_missing', reviewBody: 'Hi Pat' }), {
    state: 'error', code: 'postal_address_missing'
  });
});

test('legacy rows with unresolved placeholders never look like final copy', () => {
  for (const body of ['Hi {{firstName}}', 'Hi {{ firstName }}', '<p>{{company}}</p>']) {
    assert.deepEqual(buildOutreachPreview({ body }), { state: 'error', code: 'unresolved_template_variable' });
  }
  assert.deepEqual(buildOutreachPreview({ subject: 'For {{firstName}}', body: 'Hello Pat' }), {
    state: 'error', code: 'unresolved_template_variable'
  });
});

test('an empty or redacted body reports unavailable instead of a blank message', () => {
  assert.deepEqual(buildOutreachPreview({ body: null, subject: 'Old subject' }), { state: 'empty' });
  assert.deepEqual(buildOutreachPreview({ body: '   \n\t', subject: 'Old subject' }), { state: 'empty' });
});

test('the queue markup shows the resolved subject and body, and sandboxes HTML copy', () => {
  const text = renderToStaticMarkup(React.createElement(OutreachQueue, {
    canWrite: false,
    rowActioning: {},
    onApprove: () => undefined,
    rows: [{
      id: 'row-1', status: 'QUEUED', stepOrder: 1, reviewToken: 'token',
      reviewSubject: rendered.subject, reviewBody: rendered.body, reviewContentType: 'Text',
      contact: { email: 'pat@acme.example' }
    }]
  }));
  assert.match(text, /Question for Pat/);
  assert.match(text, /Hi Pat,/);
  assert.match(text, /Acme Robotics needs QA/);
  assert.doesNotMatch(text, /\{\{|\}\}/);
  assert.match(text, /pat@acme\.example/);

  const html = renderToStaticMarkup(React.createElement(OutreachQueue, {
    canWrite: false,
    rowActioning: {},
    onApprove: () => undefined,
    rows: [{
      id: 'row-2', status: 'QUEUED', stepOrder: 2,
      reviewSubject: 'HTML for Pat', reviewBody: '<p>Hi Pat at Acme &amp; Co</p>', reviewContentType: 'HTML',
      contact: { email: 'pat@acme.example' }
    }]
  }));
  assert.match(html, /<iframe/);
  assert.match(html, /sandbox=""/);
  assert.match(html, /HTML for Pat/);
  assert.doesNotMatch(html, /\{\{|\}\}/);
});
