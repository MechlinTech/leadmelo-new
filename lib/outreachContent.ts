import { renderTemplate } from './policy';
import { emailBodyContentType, hasVisibleText } from './m365/graph';

type OutreachContentInput = {
  existingSubject: string | null;
  existingBody: string | null;
  subjectTemplate: string;
  bodyTemplate: string;
  variables: Record<string, string>;
  postalAddress: string;
  unsubscribeUrl: string;
};

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function addFooter(body: string, contentType: 'HTML' | 'Text', postalAddress: string, unsubscribeUrl: string) {
  if (body.includes('\nUnsubscribe: ') || /<a\b[^>]*>\s*Unsubscribe\s*<\/a>/i.test(body)) return body;
  if (contentType === 'Text') return `${body}\n\n${postalAddress}\nUnsubscribe: ${unsubscribeUrl}`;
  const footer = `<p>${escapeHtml(postalAddress)}</p><p><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`;
  if (/<\/body\s*>/i.test(body)) return body.replace(/<\/body\s*>/i, `${footer}</body>`);
  if (/<\/html\s*>/i.test(body)) return body.replace(/<\/html\s*>/i, `${footer}</html>`);
  return `${body}${footer}`;
}

export function renderOutreachContent(input: OutreachContentInput) {
  const htmlTemplate = input.existingBody ?? input.bodyTemplate;
  const contentType = emailBodyContentType(htmlTemplate);
  const variables = contentType === 'HTML'
    ? Object.fromEntries(Object.entries(input.variables).map(([name, value]) => [name, escapeHtml(value)]))
    : input.variables;
  const subject = input.existingSubject ?? renderTemplate(input.subjectTemplate, input.variables);
  const content = input.existingBody ?? renderTemplate(input.bodyTemplate, variables);
  if (!subject.trim()) throw new Error(input.existingSubject === null ? 'mail_subject_template_empty' : 'mail_subject_blank');
  if (!hasVisibleText(content)) throw new Error(input.existingBody === null ? 'mail_body_template_empty' : 'mail_body_effectively_empty');
  if (!input.postalAddress.trim()) throw new Error('postal_address_missing');
  const body = addFooter(content, contentType, input.postalAddress, input.unsubscribeUrl);
  if (!hasVisibleText(body)) throw new Error('mail_body_effectively_empty');
  return { subject, body, contentType };
}