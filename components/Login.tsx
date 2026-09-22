'use client';
import { FormEvent, useState } from 'react';
export default function Login() {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [needCode, setNeedCode] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError('');
    const form = new FormData(e.currentTarget);
    const code = String(form.get('code') ?? '').trim();
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password'), ...(code ? { code } : {}) }) });
      if (!r.ok) {
        const message = (await r.json()).error;
        if (message === 'mfa_required') { setNeedCode(true); setError('Enter the 6-digit code from your authenticator app, or a recovery code.'); }
        else if (message === 'invalid_mfa_code') setError('That code was not accepted. Codes can be used once; wait for the next code and try again.');
        else throw new Error(message);
        setBusy(false); return;
      }
      window.location.assign('/app');
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <form onSubmit={submit} className="editor"><label>Email<input className="input" name="email" type="email" autoComplete="username" required/></label><label>Password<input className="input" name="password" type="password" autoComplete="current-password" required/></label>{needCode && <label>Authentication code<input className="input" name="code" inputMode="text" autoComplete="one-time-code" autoFocus required maxLength={32}/></label>}{error && <p role={needCode ? 'status' : 'alert'} className={needCode ? 'muted' : 'error'}>{error}</p>}<button disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button></form>;
}
