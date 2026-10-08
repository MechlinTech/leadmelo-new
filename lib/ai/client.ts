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

// Providers that reject a short or wrongly-prefixed key outright, so a bad key costs no round trip.
// Each entry pairs a host with a test for that provider's key format. A model field that holds an
// email never names a model, so that is checked for every provider.
const KEY_FORMATS: Array<{ hosts: string[]; invalid: string; ok: (key: string) => boolean }> = [
  // Gemini returns HTTP 400 "Please pass a valid API key" for a wrong key, not 401, and Google AI
  // Studio keys are "AIza" followed by 35 more characters.
  { hosts: ['generativelanguage.googleapis.com'], invalid: 'ai_google_key_invalid', ok: k => k.startsWith('AIza') && k.length >= 35 },
  { hosts: ['api.openai.com'], invalid: 'ai_openai_key_invalid', ok: k => k.startsWith('sk-') && k.length >= 40 }
];

export function explainAiSetup(baseUrl: string, model: string, apiKey?: string): string | null {
  if (model.includes('@')) return 'ai_model_is_email';
  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return null; }
  const provider = KEY_FORMATS.find(p => p.hosts.includes(host));
  // An unrecognised host (a local Ollama, a proxy) is left to the provider, which is the only
  // authority on its own key format.
  if (!provider) return null;
  const key = apiKey?.trim() ?? '';
  if (!key) return 'ai_key_required';
  if (!provider.ok(key)) return provider.invalid;
  return null;
}

export const MAX_RESPONSE_BYTES = 200_000;

// Statuses worth another attempt. Providers return these for temporary conditions only:
// 429 throttling/quota, 5xx capacity and timeouts. Everything else (401/403/404/422) is a
// configuration or request problem that will fail identically on every retry.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function retryAfterMs(res: Response) {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.min(Math.max(when - Date.now(), 0), 10_000) : null;
}

export async function chat(cfg: AiConfig, messages: ChatMessage[], opts: { json?: boolean; maxTokens?: number; timeoutMs?: number; fetcher?: typeof fetch; maxAttempts?: number; retryBaseMs?: number } = {}): Promise<string> {
  const bad = checkAiUrl(cfg.baseUrl);
  if (bad) throw new HttpError(400, `ai_url_rejected: ${bad}`);
  const f = opts.fetcher ?? fetch;
  const ctl = new AbortController();
  // One deadline covers every attempt, so retries cannot extend the caller's timeout.
  const deadline = opts.timeoutMs ?? 90_000;
  const timer = setTimeout(() => ctl.abort(), deadline);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const base = opts.retryBaseMs ?? 500;
  const startedAt = Date.now();
  try {
    let lastError: HttpError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await f(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST', redirect: 'error', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: JSON.stringify({ model: cfg.model, messages, stream: false, temperature: 0.4, max_tokens: opts.maxTokens ?? 900, ...(opts.json ? { response_format: { type: 'json_object' } } : {}) })
        });
        if (!res.ok) {
          const status = res.status;
          if (RETRYABLE_STATUS.has(status) && attempt < maxAttempts) {
            lastError = new HttpError(502, `ai_provider_error_${status}`);
            const wait = retryAfterMs(res) ?? base * 2 ** (attempt - 1);
            // Never sleep past the caller's deadline; just try again immediately instead.
            if (Date.now() - startedAt + wait >= deadline) throw lastError;
            await sleep(wait);
            continue;
          }
          throw new HttpError(502, `ai_provider_error_${status}`);
        }
        const reader = res.body?.getReader();
        if (!reader) throw new HttpError(502, 'ai_empty_response');
        const parts: Uint8Array[] = []; let size = 0;
        for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new HttpError(502, 'ai_response_too_large'); } parts.push(value); }
        let payload: any;
        try { payload = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new HttpError(502, 'ai_invalid_response'); }
        // A reasoning model (Gemini "thinking", o-series) can answer 200 with finish_reason
        // "length" and a body that is present but cut off mid-sentence, because max_tokens was
        // spent on internal reasoning before the visible text began. That is a token budget
        // problem, not a connection failure, and saying so saves a wild goose chase.
        //
        // finish_reason must be read BEFORE the emptiness test. A truncated body is non-empty, so
        // checking emptiness first returns the fragment at line 109 and the length signal is
        // lost: extractJson then fails to find a balanced "}" and the real cause is reported as
        // ai_bad_json. Empty-and-spent stays ai_output_budget_exhausted either way.
        const choice = payload?.choices?.[0];
        if (choice?.finish_reason === 'length') throw new HttpError(502, 'ai_output_budget_exhausted');
        const text = choice?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new HttpError(502, 'ai_empty_response');
        return text;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if ((e as Error).name === 'AbortError') throw new HttpError(504, 'ai_timeout');
        // A transport-level failure (reset, DNS, dropped socket) is worth one more try.
        if (attempt < maxAttempts && Date.now() - startedAt + base * 2 ** (attempt - 1) < deadline) {
          lastError = new HttpError(502, 'ai_unreachable');
          await sleep(base * 2 ** (attempt - 1));
          continue;
        }
        throw new HttpError(502, 'ai_unreachable');
      }
    }
    throw lastError ?? new HttpError(502, 'ai_unreachable');
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
