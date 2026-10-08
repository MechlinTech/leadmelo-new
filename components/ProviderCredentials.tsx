'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import { showToast } from './Toaster';

// Provider credentials: the tenant bearer token plus the Apollo and Hunter keys the gateway uses for
// discovery and email verification. The server never returns a stored value, so every field starts
// empty and is labelled from a boolean; "leave blank to keep" is how an existing key is preserved.
type Status = {
  gatewayConfigured: boolean; apolloConfigured: boolean; hunterConfigured: boolean;
  gatewaySynced: boolean | null;
};
type Verdict = { provider: string; ok: boolean; code: string; detail: string };
const PROVIDERS = [
  { id: 'gateway', label: 'Bearer token', hint: 'Identifies this workspace to the provider gateway. One is generated for you and must also be registered in the gateway’s tenants file.' },
  { id: 'apollo', label: 'Apollo API key', hint: 'Used for prospect discovery. From Apollo → Settings → API Keys.' },
  { id: 'hunter', label: 'Hunter API key', hint: 'Used to verify prospect email addresses. From Hunter → Settings → API Key.' }
] as const;

export default function ProviderCredentials() {
  const [status, setStatus] = useState<Status | null>(null), [values, setValues] = useState<Record<string, string>>({}), [busy, setBusy] = useState('');
  const [error, setError] = useState(''), [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const load = async () => setStatus(await api<Status>('integrations/providers'));
  useEffect(() => { load().catch(e => setError((e as Error).message)); }, []);

  const configured = (id: string) => status ? !!(status as any)[`${id}Configured`] : false;
  const blank = Object.values(values).every(v => !v);

  async function save() {
    setBusy('save'); setError(''); setVerdicts({});
    try {
      const body: Record<string, unknown> = {};
      for (const p of PROVIDERS) if (values[p.id]?.trim()) body[p.id] = values[p.id].trim();
      const r = await api<Status & { saved: boolean; gatewaySyncError: string | null }>('integrations/providers', 'PUT', body);
      setValues({});
      setStatus({ ...r });
      if (r.gatewaySyncError) showToast('Saved, but the gateway has not been updated yet. Discovery will send the keys automatically.', 'error');
      else showToast('Credentials saved and sent to the gateway.');
      setError('');
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  // Update replaces one credential on its own, so a rotation does not require retyping the others.
  async function update(id: string) {
    const value = values[id]?.trim();
    if (!value) { setError(`Enter a new ${PROVIDERS.find(p => p.id === id)?.label.toLowerCase()} first.`); return; }
    setBusy(id); setError('');
    try {
      const r = await api<Status & { gatewaySyncError: string | null }>('integrations/providers', 'PUT', { [id]: value });
      setValues(v => ({ ...v, [id]: '' }));
      setStatus({ ...r });
      setVerdicts(v => ({ ...v, [id]: { provider: id, ok: true, code: 'saved', detail: 'Saved and sent to the gateway.' } }));
      showToast(`${PROVIDERS.find(p => p.id === id)?.label} updated.`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  async function test(id: string) {
    setBusy(`test-${id}`); setError('');
    try {
      const r = await api<Verdict>('integrations/providers', 'POST', { provider: id });
      setVerdicts(v => ({ ...v, [id]: r }));
      showToast(r.detail, r.ok ? 'notice' : 'error');
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  async function clear(id: string) {
    setBusy(`clear-${id}`); setError('');
    try {
      const r = await api<Status>('integrations/providers', 'PUT', { clear: [id] });
      setValues(v => ({ ...v, [id]: '' }));
      setStatus({ ...r });
      setVerdicts(v => { const n = { ...v }; delete n[id]; return n; });
      showToast(`${PROVIDERS.find(p => p.id === id)?.label} removed.`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }

  return <section aria-labelledby="provider-creds-title">
    <h2 id="provider-creds-title">Provider credentials</h2>
    <p className="muted">The credentials this workspace uses to find prospects (Apollo) and verify their email addresses (Hunter), plus the bearer token that identifies the workspace to the provider gateway. Values are encrypted before they are stored and are never sent back to this page: an existing key is shown only as saved. Leave a field blank to keep what is stored.</p>
    {status && <p className="muted">Gateway keys: {status.gatewaySynced === null ? 'gateway not reachable, so the state is unknown' : status.gatewaySynced ? 'sent to the gateway' : 'not sent yet'}. The gateway holds them in memory only, so they are re-sent automatically whenever a discovery or verification run needs them.</p>}
    {error && <p role="alert" className="error" style={{ marginBottom: 16 }}>{error}</p>}
    <div className="editor">
      <div className="formGrid">
        {PROVIDERS.map(p => <label key={p.id}>{p.label} {configured(p.id) ? '(saved; leave blank to keep)' : '(not set)'}
          <input className="input" type="password" autoComplete="off" value={values[p.id] ?? ''} onChange={e => setValues(v => ({ ...v, [p.id]: e.target.value }))} aria-describedby={`${p.id}-hint`}/>
          <span className="muted" id={`${p.id}-hint`}>{p.hint}</span>
        </label>)}
      </div>
      {PROVIDERS.map(p => {
        const v = verdicts[p.id], on = configured(p.id), working = busy === p.id || busy === `test-${p.id}` || busy === `clear-${p.id}`;
        return <div key={p.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <p style={{ margin: '0 0 8px', fontWeight: 500 }}>{p.label}: <span className="pill">{on ? 'Saved' : 'Not set'}</span></p>
          <div className="toolbar" style={{ justifyContent: 'flex-start' }}>
            {on && <button type="button" className="secondary" disabled={busy !== '' || !values[p.id]?.trim()} onClick={() => void update(p.id)}>Update</button>}
            <button type="button" className="secondary" disabled={busy !== '' || !on} onClick={() => void test(p.id)}>Test connection</button>
            {on && <button type="button" className="secondary" disabled={busy !== ''} onClick={() => void clear(p.id)}>Remove</button>}
            {working && <span className="spinner" aria-hidden="true" />}
          </div>
          {v && <p role="status" className="muted" style={{ marginTop: 8 }}>{v.detail}</p>}
        </div>;
      })}
      <div className="toolbar">
        <button type="button" disabled={busy !== '' || blank} onClick={() => void save()}>Save credentials</button>
        <button type="button" className="secondary" disabled={busy !== '' || blank} onClick={() => { setValues({}); setVerdicts({}); }}>Clear form</button>
      </div>
    </div>
  </section>;
}
