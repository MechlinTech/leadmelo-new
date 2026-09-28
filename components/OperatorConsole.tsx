'use client';
import { useCallback, useEffect, useState } from 'react';
import { PLANS, PUBLIC_PLAN_ORDER, type PlanId } from '../lib/plans';
import { api } from './api';

type Tenant = { id: string; name: string; slug: string; plan: PlanId; createdAt: string; settings: { suspended: boolean; automationEnabled: boolean } | null; _count: { users: number; campaigns: number } };
type Request = { id: string; name: string; email: string; company: string | null; message: string | null; plan: string | null; source: string; handledAt: string | null; createdAt: string };
type Question = { id: string; question: string; audience: string; createdAt: string };

export default function OperatorConsole() {
  const [data, setData] = useState<{ tenants: Tenant[]; requests: Request[]; questions: Question[] } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setData(await api('admin/overview')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function run(fn: () => Promise<unknown>) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  if (error && !data) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p role="status" className="muted">Loading…</p>;
  return <>
    {error && <p role="alert" className="error">{error}</p>}
    <section aria-labelledby="tenants-title"><h2 id="tenants-title">Tenants</h2>
      <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><caption className="sr-only">Tenants</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Plan</th><th scope="col">Users</th><th scope="col">Campaigns</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{data.tenants.map(t => <tr key={t.id}><th scope="row">{t.name}<br /><span className="muted">{t.slug}</span></th>
          <td><label className="sr-only" htmlFor={`plan-${t.id}`}>Plan for {t.name}</label><select id={`plan-${t.id}`} value={t.plan} disabled={busy} onChange={e => void run(() => api(`admin/tenants/${t.id}/plan`, 'POST', { plan: e.target.value }))}>{PUBLIC_PLAN_ORDER.map(p => <option key={p} value={p}>{PLANS[p].name}</option>)}</select></td>
          <td>{t._count.users}</td><td>{t._count.campaigns}</td>
          <td>{t.settings?.suspended ? <span className="pill" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>suspended</span> : <span className="pill">active</span>}</td>
          <td><button type="button" className="secondary" disabled={busy} onClick={() => void run(() => api(`admin/tenants/${t.id}/suspend`, 'POST', { suspended: !t.settings?.suspended }))}>{t.settings?.suspended ? 'Reinstate' : 'Suspend'}</button></td></tr>)}</tbody></table></div>
      <p className="muted">Suspending a tenant stops discovery, purchases and sending. Plan limits apply only when the server is started with PLAN_ENFORCEMENT=on.</p>
    </section>
    <section aria-labelledby="requests-title"><h2 id="requests-title">Access requests</h2>
      {data.requests.length === 0 ? <p className="muted">No requests yet.</p> : <ul className="recordList">{data.requests.map(r => <li key={r.id}>
        <div className="toolbar"><strong>{r.name}</strong><span className="pill">{r.handledAt ? 'handled' : 'new'}</span></div>
        <p>{r.email}{r.company ? ` · ${r.company}` : ''}{r.plan ? ` · interested in ${r.plan.toLowerCase()}` : ''} · via {r.source}</p>{r.message && <p className="muted">{r.message}</p>}
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => api('admin/overview', 'PATCH', { id: r.id, handled: !r.handledAt }))}>{r.handledAt ? 'Reopen' : 'Mark handled'}</button></li>)}</ul>}
    </section>
    <section aria-labelledby="questions-title"><h2 id="questions-title">Questions the assistant could not answer</h2>
      <p className="muted">Use these to extend <code>lib/assistant/knowledge.ts</code>. Emails and numbers are masked.</p>
      {data.questions.length === 0 ? <p className="muted">None yet.</p> : <ul className="recordList">{data.questions.map(q => <li key={q.id}>{q.question} <span className="muted">({q.audience}, {new Date(q.createdAt).toLocaleDateString()})</span></li>)}</ul>}
    </section>
  </>;
}
