// The preview must never render a template itself. The API renders one canonical
// snapshot with the recipient's values, the signed scheduling link and the required
// footer; approval persists that same snapshot and the worker sends it unchanged.
//
// This module only chooses and validates that snapshot. Keeping the logic here makes
// the queue's display rules testable without a browser or a database.

export type OutreachPreviewContentType = 'HTML' | 'Text';

export type OutreachPreviewRow = {
  status?: string | null;
  subject?: string | null;
  body?: string | null;
  reviewSubject?: string | null;
  reviewBody?: string | null;
  reviewContentType?: unknown;
  previewContentType?: unknown;
  reviewError?: unknown;
};

export type OutreachPreview =
  | { state: 'ready'; subject: string; body: string; contentType: OutreachPreviewContentType }
  | { state: 'empty' }
  | { state: 'error'; code: string };

const UNRESOLVED_PLACEHOLDER = /\{\{[\s\S]*?\}\}/;
// Mirrors emailBodyContentType() for older API responses. New responses include
// previewContentType from the server, so this is only a compatibility fallback.
const HTML_BODY = /<(?:!doctype\s+html|html|head|body|p|div|span|a|br|hr|ul|ol|li|table|tbody|thead|tr|td|th|h[1-6]|strong|em|b|i|img|section|article|blockquote|pre|code)\b[^>]*>/i;

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export function buildOutreachPreview(row: OutreachPreviewRow): OutreachPreview {
  // A queued message whose server-side render failed must say why. It must not
  // fall back to the raw step template, because that is what leaked placeholders.
  if (row.reviewError) return { state: 'error', code: String(row.reviewError) };

  // For a queued message, review* is the exact content the operator is approving.
  // For a sent message there is no review snapshot, so the stored body is final.
  const subject = text(row.reviewSubject ?? row.subject);
  const body = text(row.reviewBody ?? row.body);
  if (!body.trim()) return { state: 'empty' };

  // The server rejects unknown placeholders, but older rows may predate that check.
  // Never show a half-rendered message as if it were the final copy.
  if (UNRESOLVED_PLACEHOLDER.test(subject) || UNRESOLVED_PLACEHOLDER.test(body)) {
    return { state: 'error', code: 'unresolved_template_variable' };
  }

  const declared = row.previewContentType ?? row.reviewContentType;
  const contentType: OutreachPreviewContentType = declared === 'HTML' || (!declared && HTML_BODY.test(body)) ? 'HTML' : 'Text';
  return { state: 'ready', subject, body, contentType };
}
