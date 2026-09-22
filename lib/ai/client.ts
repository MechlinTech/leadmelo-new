import { HttpError } from '../http';

// Optional, bring-your-own-model AI. Any OpenAI-compatible chat endpoint works (Ollama's /v1, hosted providers).
// The tenant supplies the URL, so it is treated as untrusted: it must be HTTPS to a public host, unless the operator
// has explicitly allow-listed a host (for example a local Ollama) in AI_ALLOWED_HOSTS. DNS rebinding of a public
// name to a private address is not defended here; restrict egress at the network layer for hosted multi-tenant use.

export type AiConfig = { baseUrl: string; model: string; apiKey?: string };
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export function allowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.AI_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Returns null when acceptable, else a short reason. Used at save time and again before every call.
export function checkAiUrl(raw: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Enter a full URL such as https://api.example.com/v1'; }
  if (u.username || u.password) return 'Do not put credentials in the URL';
  if (u.search || u.hash) return 'The URL must not contain a query string or fragment';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only http and https are supported';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hostPort = u.port ? `${host}:${u.port}` : host;
  if (allowedHosts(env).some(a => a === hostPort || a === host)) return null;
  if (u.protocol !== 'https:') return 'Plain http is allowed only for hosts the operator lists in AI_ALLOWED_HOSTS';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'Local addresses must be allow-listed by the operator in AI_ALLOWED_HOSTS';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.test(host)) return 'Private addresses must be allow-listed by the operator in AI_ALLOWED_HOSTS';
  if (host.includes(':') && (host === '::1' || /^(fc|fd|fe80)/.test(host))) return 'Private addresses must be allow-listed by the operator in AI_ALLOWED_HOSTS';
  return null;
}

export const MAX_RESPONSE_BYTES = 200_000;

export async function chat(cfg: AiConfig, messages: ChatMessage[], opts: { json?: boolean; maxTokens?: number; timeoutMs?: number; fetcher?: typeof fetch } = {}): Promise<string> {
  const bad = checkAiUrl(cfg.baseUrl);
  if (bad) throw new HttpError(400, `ai_url_rejected: ${bad}`);
  const f = opts.fetcher ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 90_000);
  try {
    const res = await f(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, messages, stream: false, temperature: 0.4, max_tokens: opts.maxTokens ?? 900, ...(opts.json ? { response_format: { type: 'json_object' } } : {}) })
    });
    if (!res.ok) throw new HttpError(502, `ai_provider_error_${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) throw new HttpError(502, 'ai_empty_response');
    const parts: Uint8Array[] = []; let size = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new HttpError(502, 'ai_response_too_large'); } parts.push(value); }
    let payload: any;
    try { payload = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new HttpError(502, 'ai_invalid_response'); }
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(502, 'ai_empty_response');
    return text;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as Error).name === 'AbortError') throw new HttpError(504, 'ai_timeout');
    throw new HttpError(502, 'ai_unreachable');
  } finally { clearTimeout(timer); }
}

// Models often wrap JSON in prose or code fences. Accept the first balanced object; never eval.
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new HttpError(502, 'ai_no_json');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { throw new HttpError(502, 'ai_bad_json'); }
    }
  }
  throw new HttpError(502, 'ai_bad_json');
}
