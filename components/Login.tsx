'use client';
import { FormEvent, useState } from 'react';
import { userError } from '../lib/userErrors';
export default function Login({ notice }: { notice?: string }) {
  const [error, setError] = useState(notice ?? ''), [busy, setBusy] = useState(false), [needCode, setNeedCode] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError('');
    const form = new FormData(e.currentTarget);
    const code = String(form.get('code') ?? '').trim();
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password'), ...(code ? { code } : {}) }) });
      if (!r.ok) {
        const message = (await r.json()).error;
        if (message === 'mfa_required') { setNeedCode(true); setError(userError(message)); }
        else if (message === 'invalid_mfa_code') setError(userError(message));
        else throw new Error(userError(message));
        setBusy(false); return;
      }
      window.location.assign('/app');
    } catch (e) { setError(userError((e as Error).message)); setBusy(false); }
  }
  return <form onSubmit={submit} className="editor"><label>Email<input className="input" name="email" type="email" autoComplete="username" required/></label><label>Password<input className="input" name="password" type="password" autoComplete="current-password" required/></label>{needCode && <label>Authentication code<input className="input" name="code" inputMode="text" autoComplete="one-time-code" autoFocus required maxLength={32}/></label>}{error && <p role={needCode ? 'status' : 'alert'} className={needCode ? 'muted' : 'error'}>{error}</p>}<p className="muted">Signing in ends any other open session for this account.</p><button disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button></form>;
}
