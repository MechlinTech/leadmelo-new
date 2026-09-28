'use client';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

type Link = { label: string; href: string };
type Msg = { role: 'user' | 'bot'; text: string; links?: Link[]; suggestions?: string[]; handoff?: boolean };
type Reply = { answer: string; links: Link[]; suggestions: string[]; handoff: boolean; audience: 'public' | 'app' };
const KEY = 'lm_chat_v1';
const START: Record<'public' | 'app', string[]> = { public: ['How does it work?', 'What does it cost?', 'Do you guarantee meetings?', 'Is it secure?'], app: ['Why is my campaign not sending?', 'How do I invite a teammate?', 'How do I change my theme?'] };

// A grounded FAQ assistant (no language model): it answers from LeadMelo's own knowledge base and plan data and
// says so when it does not know. Conversation stays in this tab's sessionStorage; nothing is stored server-side
// except unanswered questions (with emails and numbers masked).
export default function AssistantWidget({ audience = 'public' }: { audience?: 'public' | 'app' }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [text, setText] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]), [mode, setMode] = useState<'public' | 'app'>(audience), [lead, setLead] = useState<'idle' | 'form' | 'sent'>('idle');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), log = useRef<HTMLDivElement>(null), fab = useRef<HTMLButtonElement>(null);

  useEffect(() => { try { const raw = sessionStorage.getItem(KEY); if (raw) setMsgs(JSON.parse(raw)); } catch { /* storage unavailable */ } }, []);
  useEffect(() => { try { sessionStorage.setItem(KEY, JSON.stringify(msgs.slice(-30))); } catch { /* storage unavailable */ } log.current?.scrollTo({ top: log.current.scrollHeight }); }, [msgs]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const close = useCallback(() => { setOpen(false); fab.current?.focus(); }, []);
  useEffect(() => { if (!open) return; const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [open, close]);

  async function ask(question: string) {
    const q = question.trim(); if (!q || busy) return;
    setError(''); setText(''); setBusy(true); setMsgs(m => [...m, { role: 'user', text: q }]);
    try {
      const r = await api<Reply>('assistant', 'POST', { message: q });
      setMode(r.audience); setMsgs(m => [...m, { role: 'bot', text: r.answer, links: r.links, suggestions: r.suggestions, handoff: r.handoff }]);
      if (r.handoff) setLead(l => (l === 'sent' ? l : 'form'));
    } catch (e) {
      const message = (e as Error).message;
      setMsgs(m => [...m, { role: 'bot', text: message === 'rate_limit_exceeded' ? 'You are asking very quickly. Please wait a minute and try again.' : 'I could not reach the assistant. Please try again, or use Request access to contact the team.' }]);
    } finally { setBusy(false); input.current?.focus(); }
  }
  async function sendLead(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError('');
    const f = new FormData(e.currentTarget);
    const lastQuestion = [...msgs].reverse().find(m => m.role === 'user')?.text;
    try {
      await api('public/access-request', 'POST', { name: String(f.get('name')), email: String(f.get('email')), message: String(f.get('message') || lastQuestion || '').slice(0, 2000), source: 'assistant', website: String(f.get('website') ?? '') });
      setLead('sent'); setMsgs(m => [...m, { role: 'bot', text: 'Thanks. Your message was passed to the team. I cannot promise when they will reply.' }]);
    } catch (err) { setError((err as Error).message === 'rate_limit_exceeded' ? 'Too many requests. Please try again later.' : 'Please check your name and email and try again.'); }
  }

  if (!open) return <button ref={fab} type="button" className="assistant-fab" onClick={() => setOpen(true)} aria-haspopup="dialog">Ask LeadMelo</button>;
  return <section className="assistant-panel" role="dialog" aria-label="LeadMelo assistant" aria-modal="false">
    <div className="assistant-head"><strong>LeadMelo assistant</strong><button type="button" onClick={close} aria-label="Close assistant">Close</button></div>
    <div ref={log} className="assistant-log" role="log" aria-live="polite" aria-relevant="additions">
      {msgs.length === 0 && <div className="msg bot">Hi! Ask me how LeadMelo works, what plans include, security, or setup. I answer from our documentation and will say when I do not know.
        <div className="chips">{START[mode].map(s => <button key={s} type="button" onClick={() => void ask(s)}>{s}</button>)}</div></div>}
      {msgs.map((m, i) => <div key={i} className={`msg ${m.role}`}>{m.text}
        {m.links && m.links.length > 0 && <div className="chips">{m.links.map(l => <a key={l.href + l.label} className="btn secondary" style={{ minHeight: 36, padding: '4px 12px', fontSize: 14 }} href={l.href}>{l.label}</a>)}</div>}
        {m.suggestions && m.suggestions.length > 0 && i === msgs.length - 1 && <div className="chips">{m.suggestions.map(s => <button key={s} type="button" onClick={() => void ask(s)}>{s}</button>)}</div>}
      </div>)}
      {busy && <div className="msg bot" role="status">Thinking…</div>}
      {lead === 'form' && <form className="handoff msg bot" onSubmit={sendLead} style={{ maxWidth: '100%' }}>
        <strong>Leave your details and the team will reply</strong>
        <label>Name<input name="name" required maxLength={120} autoComplete="name" /></label>
        <label>Email<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>
        <label>Message (optional)<input name="message" maxLength={500} /></label>
        <input className="hp" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
        {error && <p role="alert" className="error">{error}</p>}
        <button>Send to the team</button>
      </form>}
    </div>
    <p className="assistant-note">Automated assistant. It answers from LeadMelo documentation and can be incomplete; confirm prices on the pricing page. Do not type passwords or sensitive data.</p>
    <form className="assistant-form" onSubmit={e => { e.preventDefault(); void ask(text); }}>
      <label className="sr-only" htmlFor="assistant-input">Your question</label>
      <input id="assistant-input" ref={input} value={text} onChange={e => setText(e.target.value)} maxLength={500} placeholder="Ask a question…" autoComplete="off" enterKeyHint="send" />
      <button disabled={busy || !text.trim()}>Send</button>
    </form>
  </section>;
}
