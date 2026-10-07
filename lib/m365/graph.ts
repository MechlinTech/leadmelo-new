import { z } from 'zod';
import { decrypt } from '../crypto';

export const connectionInput = z.object({
  directoryId: z.string().uuid(), clientId: z.string().uuid(),
  clientSecret: z.string().min(16).max(2000),
  mailboxes: z.array(z.string().email().transform(x => x.toLowerCase())).min(1).max(20),
  mailboxScopeConfirmed: z.literal(true)
}).strict();

export type MailConnection = { directoryId: string; clientId: string; encryptedSecret: string; mailboxes: string[] };
export type MailContentType = 'HTML' | 'Text';
export class GraphError extends Error {
  constructor(public status: number) { super(`m365_http_${status}`); }
}
export async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('m365_empty_response');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const {done, value} = await reader.read(); if (done) break;
    size += value.length;
    if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('m365_response_too_large'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export class GraphClient {
  private token?: string;
  constructor(private config: MailConnection, private transport: typeof fetch = fetch) {}
  async request(path: string, method = 'GET', body?: string, mime = false): Promise<any> {
    const url = new URL(path, 'https://graph.microsoft.com');
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/users/') || url.username || url.password || url.hash) throw new Error('m365_invalid_url');
    const mailbox = decodeURIComponent(url.pathname.split('/')[3]).toLowerCase();
    if (!this.config.mailboxes.includes(mailbox)) throw new Error('m365_sender_not_allowed');
    if (!this.token) {
      if (!z.string().uuid().safeParse(this.config.directoryId).success) throw new Error('m365_invalid_directory');
      const response = await this.transport(`https://login.microsoftonline.com/${this.config.directoryId}/oauth2/v2.0/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {'Content-Type':'application/x-www-form-urlencoded'},
        body: new URLSearchParams({client_id:this.config.clientId, client_secret:decrypt(this.config.encryptedSecret), scope:'https://graph.microsoft.com/.default', grant_type:'client_credentials'})
      });
      if (!response.ok) throw new GraphError(response.status);
      this.token = z.object({access_token:z.string().min(1)}).parse(await boundedJson(response)).access_token;
    }
    const response = await this.transport(url, {method, body, redirect:'error', signal:AbortSignal.timeout(10000), headers:{Authorization:`Bearer ${this.token}`, 'Content-Type':mime?'text/plain':'application/json', Prefer:'IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=50'}});
    if (url.pathname.includes('/messages')) console.log(JSON.stringify({ event: 'm365_graph_response', status: response.status, providerRequestId: response.headers.get('request-id') ?? undefined }));
    if (!response.ok) throw new GraphError(response.status);
    return response.status === 202 || response.status === 204 ? null : boundedJson(response);
  }
}
export const mailboxPath = (mailbox: string) => `/v1.0/users/${encodeURIComponent(mailbox)}`;

export const mailInput = z.object({
  tenantId:z.string(), campaignId:z.string(), contactId:z.string(),
  from:z.string().email(), fromName:z.string().max(200), to:z.string().email(),
  subject:z.string().min(1).max(200), body:z.string().min(1).max(10000),
  headers:z.object({'List-Unsubscribe':z.string(), 'List-Unsubscribe-Post':z.literal('List-Unsubscribe=One-Click')}).strict(),
  calendlyUrl:z.string().url()
}).strict().superRefine((v, ctx) => {
  // A body that is only whitespace, or only markup with no visible text, sends successfully but
  // arrives visually empty. Reject it here so it can never be marked SENT.
  if (!hasVisibleText(v.body)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'mail_body_effectively_empty' });
  if (!v.subject.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'], message: 'mail_subject_blank' });
});
export type MailInput = z.infer<typeof mailInput>;

export function emailBodyContentType(body: string): MailContentType {
  return /<(?:!doctype\s+html|html|head|body|p|div|span|a|br|hr|ul|ol|li|table|tbody|thead|tr|td|th|h[1-6]|strong|em|b|i|img|section|article|blockquote|pre|code)\b[^>]*>/i.test(body) ? 'HTML' : 'Text';
}

// True when the string carries something a recipient can actually read: non-whitespace text, or
// HTML/entities that decode to text. Tags, entities, comments and whitespace alone are empty.
export function hasVisibleText(body: string | null | undefined): boolean {
  if (typeof body !== 'string' || !body.trim()) return false;
  const withoutMarkup = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  const decoded = withoutMarkup
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // Zero-width and other invisible formatting characters read as blank to a recipient.
  const INVISIBLE = /[\s\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u{E0001}-\u{E007F}\u{FE00}-\u{FE0F}\u{1F3FB}-\u{1F3FF}]/u;
  return [...decoded].some(ch => ch.trim() !== '' && !INVISIBLE.test(ch));
}
export function mimeMessage(input: MailInput, key: string) {
  mailInput.parse(input);
  for (const text of [input.from, input.to, input.subject, input.fromName, key, ...Object.values(input.headers)]) if (/[\r\n]/.test(text)) throw new Error('mail_header_injection');
  const subject = `=?UTF-8?B?${Buffer.from(input.subject).toString('base64')}?=`;
  const content = Buffer.from(input.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  const contentType = emailBodyContentType(input.body) === 'HTML' ? 'text/html' : 'text/plain';
  return Buffer.from([
    `From: ${input.from}`, `To: ${input.to}`, `Subject: ${subject}`, 'MIME-Version: 1.0',
    `Content-Type: ${contentType}; charset=UTF-8`, 'Content-Transfer-Encoding: base64',
    `X-LeadMelo-Key: ${key}`, ...Object.entries(input.headers).map(([k,v])=>`${k}: ${v}`), '', content
  ].join('\r\n')).toString('base64');
}
