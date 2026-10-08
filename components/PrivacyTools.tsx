'use client';
import { FormEvent, useState } from 'react';
import { api } from './api';
import { showToast } from './Toaster';

export default function PrivacyTools() {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState('');
  async function act(e: FormEvent<HTMLFormElement>, kind: 'export' | 'erase') {
    e.preventDefault(); setBusy(true); setError(''); setResult('');
    const email = String(new FormData(e.currentTarget).get('email') ?? '');
    try {
      if (kind === 'export') { const data = await api('privacy/export', 'POST', { email }); setResult(JSON.stringify(data, null, 2)); showToast(data.found ? 'Personal data held for this address is shown below.' : 'Nothing is held for this address.'); }
      else {
        const r = await api('privacy/erase', 'POST', { email, confirm: true });
        showToast(r.erased?.found ? `Erased. Contact ${r.erased.contact}, replies ${r.erased.replies}, messages ${r.erased.messages}. The address is permanently suppressed.` : 'No matching workspace records were found for this address. Nothing was erased.');
      }
    } catch (err) { showToast((err as Error).message, 'error'); } finally { setBusy(false); }
  }
  return <section aria-labelledby="privacy-title">
    <h2 id="privacy-title">Privacy requests</h2>
    <p className="muted">Administrators only. Export shows everything held about an email address in this workspace. Erasure cannot be undone; the address is kept only on the do-not-contact list.</p>
    {error && <p role="alert" className="error" style={{ marginBottom: 16 }}>{error}</p>}
    <form className="editor" onSubmit={e => void act(e, 'export')}><label>Email address<input className="input" name="email" type="email" required/></label><button disabled={busy}>Export data</button></form>
    <form className="editor" onSubmit={e => { if (!window.confirm('Permanently erase this person and suppress the address? This cannot be undone.')) { e.preventDefault(); return; } void act(e, 'erase'); }}><label>Email address to erase<input className="input" name="email" type="email" required/></label><button disabled={busy}>Erase and suppress</button></form>
    {result && <pre aria-label="Exported data">{result}</pre>}
  </section>;
}
