'use client';
import { FormEvent, useState } from 'react';
import { api } from './api';

// Resend the one-time setup email. The answer is deliberately generic: it never reveals
// whether an address has an account. Delivery failures are surfaced, never swallowed.
export default function ResendSetupEmail() {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'failed'>('idle'), [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); setState('busy');
    const f = new FormData(e.currentTarget);
    try {
      await api('public/access-request/resend', 'POST', { email: String(f.get('email') ?? '') });
      setState('sent');
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('delivered') || message.includes('wait') || message.includes('valid email')) { setState('failed'); setError(message); }
      else { setState('sent'); }
    }
  }
  return <section className="form" style={{ marginTop: 24 }}><h2>Link expired or already used?</h2>
    <p className="muted">Enter the email you registered with. If your access has been granted, we will send a new secure setup link.</p>
    {state === 'sent' && <p role="status">If your address is registered and approved, a new setup email is on its way. Please check your inbox (and spam folder).</p>}
    {state === 'failed' && <p role="alert" className="error">{error}</p>}
    <form onSubmit={submit} noValidate={false}><label>Registered email<input name="email" type="email" required maxLength={254} autoComplete="email"/></label><button disabled={state === 'busy'}>{state === 'busy' ? 'Sending…' : 'Resend setup email'}</button></form>
  </section>;
}
