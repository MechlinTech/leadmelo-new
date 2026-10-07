'use client';
import { FormEvent, useState } from 'react';
import { api } from './api';

// Accept an invitation or complete a password reset (self-service or administrator-issued).
// The token decides everything: an unknown, expired, superseded or already used token is
// refused by the server and the form says so without hinting at the account behind it.
export default function AccountLink({ mode, token }: { mode: 'accept' | 'reset'; token: string }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const [revealed, setRevealed] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError('');
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirm') ?? '')) { setError('The two passwords do not match.'); return; }
    if (!/\S/.test(password)) { setError('Password cannot contain only blank spaces. Please enter a valid password.'); return; }
    if (password.trim().length < 12) { setError('Use at least 12 characters, not counting blank spaces.'); return; }
    setBusy(true);
    try {
      await api(mode === 'accept' ? 'invites/accept' : 'auth/reset', 'POST', mode === 'accept' ? { token, password, name: String(form.get('name') ?? '') || undefined } : { token, password });
      setDone(true);
    } catch (err) { setError(`${(err as Error).message || 'This link is invalid, expired, or already used.'} You can request a new setup email below.`); }
    finally { setBusy(false); }
  }
  if (!token) return <p role="alert" className="error">This link is missing its token. Request a new one below.</p>;
  if (done) return mode === 'accept'
    ? <p role="status">Your account is ready. <a href="/auth/signin">Sign in</a></p>
    : <div role="status">
        <p>Your password has been reset successfully. Please sign in with your new password.</p>
        <p><a className="btn" href="/auth/signin">Sign in</a></p>
      </div>;
  return <form onSubmit={submit} className="editor">
    {mode === 'accept' && <label>Your name (optional)<input className="input" name="name" autoComplete="name" maxLength={200}/></label>}
    <label>New password (12 characters or more)
      <input className="input" id="new-password" name="password" type={revealed ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={256} aria-describedby="password-hint" required/>
    </label>
    <label>Confirm password
      <input className="input" id="confirm-password" name="confirm" type={revealed ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={256} required/>
    </label>
    <button type="button" className="secondary" aria-pressed={revealed} aria-controls="new-password confirm-password" onClick={() => setRevealed(v => !v)}>{revealed ? 'Hide password' : 'Show password'}</button>
    <p className="muted" id="password-hint">Use at least 12 characters. Signing in again anywhere else ends the old session.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={busy}>{busy ? 'Saving...' : mode === 'accept' ? 'Create account' : 'Set new password'}</button>
  </form>;
}