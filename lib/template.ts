export const TEMPLATE_VARIABLES = new Set(['firstName', 'company', 'senderName', 'calendlyUrl', 'offer']);
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

export function templateIssue(template: string) {
  let unknown = false;
  const remainder = template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!TEMPLATE_VARIABLES.has(name)) unknown = true;
    return '';
  });
  return unknown || remainder.includes('{{') || remainder.includes('}}') ? 'unknown_template_variable' : null;
}

export function renderTemplate(template: string, vars: Record<string, string>) {
  if (templateIssue(template)) throw new Error('unknown_template_variable');
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error('unknown_template_variable');
    return (vars[name] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  });
}