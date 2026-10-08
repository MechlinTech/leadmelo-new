'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import { showToast } from './Toaster';

export type Suggestion = { name: string; offer: string; icp: Record<string, any>; steps: Array<{ stepOrder: number; waitBusinessDays: number; subject: string; body: string }> };

// Shown only when the workspace has campaign assist switched on. The suggestion is handed to the form, which the
// user reviews and submits through the ordinary validated path.
export default function AiAssist({ onApply }: { onApply: (s: Suggestion) => void }) {
  const [available, setAvailable] = useState(false), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { api('ai/status').then(s => setAvailable(!!s.enabled && s.canUse && s.features.includes('campaign_assist'))).catch(() => setAvailable(false)); }, []);
  if (!available) return null;
  async function run() {
    setBusy(true); setError('');
    try { const r = await api('ai/assist', 'POST', { description: text, steps: 3 }); onApply(r.suggestion); showToast(r.notice); }
    catch (e) { showToast((e as Error).message, 'error'); } finally { setBusy(false); }
  }
  return <section className="aiAssist" aria-labelledby="ai-assist-title">
    <h3 id="ai-assist-title">Draft with AI</h3>
    <label>Describe what you sell and who you want to reach (20+ characters)<textarea value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={2000}/></label>
    <div className="toolbar"><button type="button" disabled={busy || text.trim().length < 20} onClick={() => void run()}>{busy ? 'Thinking…' : 'Suggest ICP and emails'}</button></div>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
