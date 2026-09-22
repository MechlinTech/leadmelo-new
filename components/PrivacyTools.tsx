'use client';
import { FormEvent, useState } from 'react';
import { api } from './api';

export default function PrivacyTools() {
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState('');
  async function act(e: FormEvent<HTMLFormElement>, kind: 'export' | 'erase') {
    e.preventDefault(); setBusy(true); setError(''); setNotice(''); setResult('');
    const email = String(new FormData(e.currentTarget).get('email') ?? '');
    try {
      if (kind === 'export') { const data = await api('privacy/export', 'POST', { email }); setResult(JSON.stringify(data, null, 2)); setNotice(data.found ? 'Personal data held for this address is shown below.' : 'Nothing is held for this address.'); }
      else { const r = await api('privacy/erase', 'POST', { email, confirm: true }); setNotice(`Erased. Contact ${r.erased.contact}, replies ${r.erased.replies}, messages ${r.erased.messages}. The address is permanently suppressed.`); }
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <section aria-labelledby="privacy-title">
    <h2 id="privacy-title">Privacy requests</h2>
    <p className="muted">Administrators only. Export shows everything held about an email address in this workspace. Erasure cannot be undone; the address is kept only on the do-not-contact list.</p>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <form className="editor" onSubmit={e => void act(e, 'export')}><label>Email address<input className="input" name="email" type="email" required/></label><button disabled={busy}>Export data</button></form>
    <form className="editor" onSubmit={e => { if (!window.confirm('Permanently erase this person and suppress the address? This cannot be undone.')) { e.preventDefault(); return; } void act(e, 'erase'); }}><label>Email address to erase<input className="input" name="email" type="email" required/></label><button disabled={busy}>Erase and suppress</button></form>
    {result && <pre aria-label="Exported data">{result}</pre>}
  </section>;
}
