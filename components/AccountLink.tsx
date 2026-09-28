'use client';
import { FormEvent, useState } from 'react';
import { api } from './api';

// Accept an invitation or complete an administrator-issued password reset.
export default function AccountLink({ mode, token }: { mode: 'accept' | 'reset'; token: string }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError('');
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirm') ?? '')) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      await api(mode === 'accept' ? 'invites/accept' : 'auth/reset', 'POST', mode === 'accept' ? { token, password, name: String(form.get('name') ?? '') || undefined } : { token, password });
      setDone(true);
    } catch (err) { setError(mode === 'accept' ? 'This invitation is invalid, expired or already used, or the password is too short.' : 'This reset link is invalid, expired or already used, or the password is too short.'); void err; }
    finally { setBusy(false); }
  }
  if (!token) return <p role="alert" className="error">This link is missing its token. Ask your administrator for a new one.</p>;
  if (done) return <p role="status">{mode === 'accept' ? 'Your account is ready.' : 'Your password has been changed and other sessions were signed out.'} <a href="/auth/signin">Sign in</a></p>;
  return <form onSubmit={submit} className="editor">
    {mode === 'accept' && <label>Your name (optional)<input className="input" name="name" autoComplete="name" maxLength={200}/></label>}
    <label>New password (12 characters or more)<input className="input" name="password" type="password" autoComplete="new-password" minLength={12} required/></label>
    <label>Confirm password<input className="input" name="confirm" type="password" autoComplete="new-password" minLength={12} required/></label>
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={busy}>{busy ? 'Saving...' : mode === 'accept' ? 'Create account' : 'Set new password'}</button>
  </form>;
}
