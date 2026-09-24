'use client';
const SAMPLE: Record<string, string> = { firstName: 'Pat', company: 'Acme Robotics', senderName: 'Sam Seller', calendlyUrl: 'https://calendly.com/example/30min', offer: 'QA automation' };
const fill = (t: string) => t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => SAMPLE[name] ?? `{{${name}}}`);

export default function EmailPreview({ subject, body }: { subject: string; body: string }) {
  return <details className="notice" style={{ marginTop: 8 }}>
    <summary>Preview with sample values</summary>
    <p><strong>Subject:</strong> {fill(subject) || '(empty subject)'}</p>
    <pre style={{ whiteSpace: 'pre-wrap' }}>{fill(body) || '(empty message)'}</pre>
    <p className="muted">Sample: {SAMPLE.firstName} at {SAMPLE.company}. Unknown placeholders are left as written.</p>
  </details>;
}
