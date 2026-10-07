'use client';
import { FormEvent, useState } from 'react';
import { api } from './api';
import { userError } from '../lib/userErrors';

// Step one of password recovery: ask for a reset link.
//
// The answer is deliberately the same for every address, so this screen can never
// confirm whether an account exists. Only a malformed address or an exhausted rate
// limit is reported back, because neither depends on the account.
export default function ForgotPassword() {
  const [email, setEmail] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = email.trim();
    if (!value) { setError('Enter the email address you sign in with.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) || value.length > 254) { setError('Enter a valid email address.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<{ ok: boolean; message?: string }>('auth/forgot-password', 'POST', { email: value });
      setMessage(result.message ?? 'If an account exists for this email address, you will receive a password-reset link shortly.');
      setEmail('');
    } catch (err) {
      setError(userError((err as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return <form onSubmit={submit} className="editor">
    <label>Email<input className="input" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required value={email} onChange={e => setEmail(e.target.value)} autoFocus/></label>
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status">{message}</p>}
    <button disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
    <p className="muted"><a href="/auth/signin">Back to sign in</a></p>
  </form>;
}