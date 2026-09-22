'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

const PRESETS = [
  { id: 'ollama', label: 'Ollama on this network (local)', url: 'http://localhost:11434/v1', model: 'llama3.1' },
  { id: 'custom', label: 'Other OpenAI-compatible service', url: 'https://', model: '' }
];

export default function AiSettings() {
  const [s, setS] = useState<any>(null), [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState('');
  const [enabled, setEnabled] = useState(false), [url, setUrl] = useState(''), [model, setModel] = useState(''), [key, setKey] = useState(''), [features, setFeatures] = useState<string[]>([]);
  useEffect(() => { api('settings').then(v => { setS(v); setEnabled(!!v.aiEnabled); setUrl(v.aiBaseUrl ?? ''); setModel(v.aiModel ?? ''); setFeatures(v.aiFeatures ?? []); }).catch(e => setError((e as Error).message)); }, []);
  if (!s) return error ? <p role="alert" className="error">{error}</p> : null;
  const toggle = (f: string) => setFeatures(list => list.includes(f) ? list.filter(x => x !== f) : [...list, f]);
  async function save() {
    setBusy(true); setError(''); setStatus('');
    try {
      await api('settings', 'PUT', { automationEnabled: s.automationEnabled, dailySendCap: s.dailySendCap, weeklyProspectCap: s.weeklyProspectCap, postalAddress: s.postalAddress, aiEnabled: enabled, aiBaseUrl: url || null, aiModel: model || null, aiFeatures: features, ...(key ? { aiKey: key } : {}) });
      setKey(''); setStatus('AI settings saved.'); setS({ ...s, aiKeyConfigured: s.aiKeyConfigured || !!key, aiBaseUrl: url });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(''); setStatus('Contacting the model. A local model can take a minute on its first call…');
    try { const r = await api('ai/test', 'POST', {}); setStatus(`Connected. The model answered: "${r.sample}".`); }
    catch (e) { setStatus(''); setError(`Connection failed: ${(e as Error).message}. Save your settings first, then test.`); } finally { setBusy(false); }
  }
  return <section aria-labelledby="ai-title">
    <h2 id="ai-title">AI assist (optional)</h2>
    <p className="muted">Bring your own model: Ollama or any OpenAI-compatible service. When on, AI drafts campaign ideas and suggests replies. It never sends anything and never changes who is suppressed; a person always reviews. Prospect and reply text is sent to the model you choose, so pick one you are allowed to share it with. Off by default.</p>
    <div className="editor">
      <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/> Turn on AI assist for this workspace</label>
      <label>Provider preset<select defaultValue="" onChange={e => { const p = PRESETS.find(x => x.id === e.target.value); if (p) { setUrl(p.url); if (!model) setModel(p.model); } }}><option value="" disabled>Choose to fill the fields below</option>{PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <div className="formGrid">
        <label>Base URL (ends in /v1)<input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:11434/v1" inputMode="url"/></label>
        <label>Model name<input className="input" value={model} onChange={e => setModel(e.target.value)} placeholder="llama3.1"/></label>
        <label>API key {s.aiKeyConfigured ? '(saved; leave blank to keep)' : '(leave blank for Ollama)'}<input className="input" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)}/></label>
      </div>
      <fieldset><legend>Features</legend>
        <label><input type="checkbox" checked={features.includes('campaign_assist')} onChange={() => toggle('campaign_assist')}/> Campaign assist: suggest ICP and email sequence</label>
        <label><input type="checkbox" checked={features.includes('reply_assist')} onChange={() => toggle('reply_assist')}/> Reply assist: summarise replies and draft a response</label>
      </fieldset>
      <p className="muted">Plain http or private addresses (such as a local Ollama) are accepted only if the server operator lists the host in <code>AI_ALLOWED_HOSTS</code>. Public services must use https.</p>
      {error && <p role="alert" className="error">{error}</p>}{status && <p role="status" className="muted">{status}</p>}
      <div className="toolbar"><button type="button" disabled={busy} onClick={() => void save()}>Save AI settings</button><button type="button" disabled={busy || !s.aiBaseUrl} onClick={() => void test()}>Test connection</button></div>
    </div>
  </section>;
}
