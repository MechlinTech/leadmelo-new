'use client';
import { FormEvent, useState } from 'react';
import { api } from '../api';
import { PLANS, PUBLIC_PLAN_ORDER, type PlanId } from '../../lib/plans';

export default function RequestAccessForm({ initialPlan }: { initialPlan?: PlanId }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle'), [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); setState('busy');
    const f = new FormData(e.currentTarget);
    try {
      await api('public/access-request', 'POST', { name: String(f.get('name')), email: String(f.get('email')), company: String(f.get('company') || '') || undefined, plan: String(f.get('plan') || '') || undefined, message: String(f.get('message') || '') || undefined, source: f.get('plan') ? 'pricing' : 'contact', website: String(f.get('website') || '') });
      setState('sent');
    } catch (err) { setState('idle'); setError((err as Error).message === 'rate_limit_exceeded' ? 'Too many requests from your network. Please try again later.' : 'Please check the fields and try again.'); }
  }
  if (state === 'sent') return <div className="notice" role="status"><strong>Thank you.</strong> Your request was received. Our team sets up workspaces by hand and will contact you at the email you gave. We cannot promise a response time.</div>;
  return <form className="editor" onSubmit={submit} noValidate={false}>
    <label>Your name<input name="name" required maxLength={120} autoComplete="name" /></label>
    <label>Work email<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>
    <label>Company (optional)<input name="company" maxLength={160} autoComplete="organization" /></label>
    <label>Plan you are interested in
      <select name="plan" defaultValue={initialPlan ?? ''}><option value="">Not sure yet</option>{PUBLIC_PLAN_ORDER.map(id => <option key={id} value={id}>{PLANS[id].name}</option>)}</select></label>
    <label>What do you want to achieve? (optional)<textarea name="message" rows={4} maxLength={2000} /></label>
    <input className="hp" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={state === 'busy'}>{state === 'busy' ? 'Sending…' : 'Request access'}</button>
    <p className="muted" style={{ fontSize: 14 }}>We use your details only to reply about LeadMelo. Please do not include passwords or sensitive data.</p>
  </form>;
}
