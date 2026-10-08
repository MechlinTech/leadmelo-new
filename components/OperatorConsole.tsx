'use client';
import { useCallback, useEffect, useState } from 'react';
import { PLANS, PUBLIC_PLAN_ORDER, type PlanId } from '../lib/plans';
import { api } from './api';
import Pager, { pageSlice } from './Pager';
import { showToast } from './Toaster';

type Tenant = { id: string; name: string; slug: string; plan: PlanId; createdAt: string; settings: { suspended: boolean; automationEnabled: boolean } | null; _count: { users: number; campaigns: number } };
type Request = { id: string; name: string; email: string; company: string | null; message: string | null; plan: string | null; source: string; status: string; emailError: string | null; lastEmailAt: string | null; handledAt: string | null; createdAt: string };
type Question = { id: string; question: string; audience: string; createdAt: string };

export default function OperatorConsole() {
  const [data, setData] = useState<{ tenants: Tenant[]; requests: Request[]; questions: Question[] } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [rowActioning, setRowActioning] = useState<Record<string, boolean>>({});
  const [tenantPage, setTenantPage] = useState(1);
  const [requestPage, setRequestPage] = useState(1);
  const [questionPage, setQuestionPage] = useState(1);
  const load = useCallback(async () => { try { setData(await api('admin/overview')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function run(fn: () => Promise<unknown>, done: string, actionId?: string) { if (actionId) setRowActioning(p => ({ ...p, [actionId]: true })); else setBusy(true); setError(''); try { await fn(); await load(); showToast(done); } catch (e) { showToast((e as Error).message, 'error'); } finally { if (actionId) setRowActioning(p => ({ ...p, [actionId]: false })); else setBusy(false); } }
  if (error && !data) return <p role="alert" className="error" style={{ marginBottom: 16 }}>{error}</p>;
  if (!data) return <p role="status" className="muted">Loading…</p>;
  const tenantPageData = pageSlice(data.tenants, tenantPage, 10);
  const requestPageData = pageSlice(data.requests, requestPage, 10);
  const questionPageData = pageSlice(data.questions, questionPage, 10);
  return <>
    {error && data && <p role="alert" className="error" style={{ marginBottom: 16 }}>{error}</p>}
    <section aria-labelledby="tenants-title"><h2 id="tenants-title">Tenants</h2>
      <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><caption className="sr-only">Tenants</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Plan</th><th scope="col">Users</th><th scope="col">Campaigns</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{tenantPageData.slice.map(t => <tr key={t.id}><th scope="row">{t.name}<br /><span className="muted">{t.slug}</span></th>
          <td><label className="sr-only" htmlFor={`plan-${t.id}`}>Plan for {t.name}</label><select id={`plan-${t.id}`} value={t.plan} disabled={rowActioning[`${t.id}-plan`]} onChange={e => void run(() => api(`admin/tenants/${t.id}/plan`, 'POST', { plan: e.target.value }), 'Plan updated.', `${t.id}-plan`)}>{PUBLIC_PLAN_ORDER.map(p => <option key={p} value={p}>{PLANS[p].name}</option>)}</select></td>
          <td>{t._count.users}</td><td>{t._count.campaigns}</td>
          <td>{t.settings?.suspended ? <span className="pill" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>suspended</span> : <span className="pill">active</span>}</td>
          <td><button type="button" className="secondary" disabled={rowActioning[`${t.id}-suspend`]} onClick={() => void run(() => api(`admin/tenants/${t.id}/suspend`, 'POST', { suspended: !t.settings?.suspended }), `Tenant ${t.settings?.suspended ? 'reinstated' : 'suspended'}.`, `${t.id}-suspend`)}>{rowActioning[`${t.id}-suspend`] ? <span className="spinner" aria-hidden="true" /> : null}{t.settings?.suspended ? 'Reinstate' : 'Suspend'}</button></td></tr>)}</tbody></table></div>
        <Pager page={tenantPageData.page} pages={tenantPageData.pages} total={tenantPageData.total} label="tenants" onPage={setTenantPage} />
      <p className="muted">Suspending a tenant stops discovery, purchases and sending. Plan limits apply only when the server is started with PLAN_ENFORCEMENT=on.</p>
    </section>
    <section aria-labelledby="requests-title"><h2 id="requests-title">Access requests</h2>
      {data.requests.length === 0 ? <p className="muted">No requests yet.</p> : <><ul className="recordList">{requestPageData.slice.map(r => <li key={r.id}>
        <div className="toolbar"><strong>{r.name}</strong><span className="pill">{r.status === 'APPROVED' ? 'approved' : (r.handledAt ? 'handled' : 'new')}</span></div>
        <p>{r.email}{r.company ? ` · ${r.company}` : ''}{r.plan ? ` · interested in ${r.plan.toLowerCase()}` : ''} · via {r.source}</p>{r.message && <p className="muted">{r.message}</p>}
        {r.emailError && <p role="alert" className="error">Last email attempt failed: {r.emailError}. The user can also request a new setup email.</p>}
        {r.status === 'APPROVED'
          ? <button type="button" className="secondary" disabled={rowActioning[`${r.id}-handle`]} onClick={() => void run(() => api('admin/overview', 'PATCH', { id: r.id, handled: !r.handledAt }), `Request marked as ${r.handledAt ? 'reopened' : 'handled'}.`, `${r.id}-handle`)}>{rowActioning[`${r.id}-handle`] ? <span className="spinner" aria-hidden="true" /> : null}{r.handledAt ? 'Reopen' : 'Mark handled'}</button>
          : <><button type="button" disabled={rowActioning[`${r.id}-approve`]} onClick={() => void run(() => api(`admin/access-requests/${r.id}/approve`, 'POST'), 'Access approved and setup email sent.', `${r.id}-approve`)}>{rowActioning[`${r.id}-approve`] ? <span className="spinner" aria-hidden="true" /> : null}Approve &amp; create account</button>
             <button type="button" className="secondary" disabled={rowActioning[`${r.id}-handle`]} onClick={() => void run(() => api('admin/overview', 'PATCH', { id: r.id, handled: !r.handledAt }), `Request marked as ${r.handledAt ? 'reopened' : 'handled'}.`, `${r.id}-handle`)}>{rowActioning[`${r.id}-handle`] ? <span className="spinner" aria-hidden="true" /> : null}{r.handledAt ? 'Reopen' : 'Mark handled'}</button></>}</li>)}</ul>
      <Pager page={requestPageData.page} pages={requestPageData.pages} total={requestPageData.total} label="requests" onPage={setRequestPage} /></>}
    </section>
    <section aria-labelledby="questions-title"><h2 id="questions-title">Questions the assistant could not answer</h2>
      <p className="muted">Use these to extend <code>lib/assistant/knowledge.ts</code>. Emails and numbers are masked.</p>
      {data.questions.length === 0 ? <p className="muted">None yet.</p> : <><ul className="recordList">{questionPageData.slice.map(q => <li key={q.id}>{q.question} <span className="muted">({q.audience}, {new Date(q.createdAt).toLocaleDateString()})</span></li>)}</ul>
      <Pager page={questionPageData.page} pages={questionPageData.pages} total={questionPageData.total} label="questions" onPage={setQuestionPage} /></>}
    </section>
  </>;
}
