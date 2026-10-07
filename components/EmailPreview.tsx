'use client';
import { renderTemplate } from '../lib/template';

const SAMPLE: Record<string, string> = { firstName: 'Pat', company: 'Acme Robotics', senderName: 'Sam Seller', calendlyUrl: 'https://calendly.com/example/30min', offer: 'QA automation' };
function fill(template: string) {
  try { return renderTemplate(template, SAMPLE); } catch { return null; }
}

export default function EmailPreview({ subject, body }: { subject: string; body: string }) {
  const previewSubject = fill(subject), previewBody = fill(body);
  return <details className="notice" style={{ marginTop: 8 }}>
    <summary>Preview with sample values</summary>
    {previewSubject === null || previewBody === null
      ? <p role="alert" className="error">Preview unavailable: use supported placeholders with complete braces.</p>
      : <><p><strong>Subject:</strong> {previewSubject || '(empty subject)'}</p><pre style={{ whiteSpace: 'pre-wrap' }}>{previewBody || '(empty message)'}</pre><p className="muted">Sample: {SAMPLE.firstName} at {SAMPLE.company}.</p></>}
  </details>;
}
