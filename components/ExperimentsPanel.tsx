'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from './api';

type Variant = { id: string; label: string; isControl: boolean; weight: number };
type Rec = { id: string; variantId: string; status: string; verdict: { status?: string } };
type Experiment = { id: string; name: string; campaignId: string; stepOrder: number; status: string; primaryMetric: string; minSample: number; variants: Variant[]; recommendations: Rec[] };
type Campaign = { id: string; name: string; sequenceSteps: Array<{ stepOrder: number; subject: string | null }> };
type Results = { arms: Array<{ label: string; isControl: boolean; sent: number; primary: number; unsubscribed: number }>; verdict: { status: string; detail: Record<string, unknown> } };

const VERDICT_TEXT: Record<string, string> = { INSUFFICIENT_DATA: 'Not enough sends yet to compare.', NO_SIGNIFICANT_DIFFERENCE: 'No reliable difference yet.', WINNER: 'A variant is winning. Review the recommendation below.', GUARDRAIL_BLOCKED: 'A variant wins on replies but raises unsubscribes, so it is not recommended.', SAMPLE_RATIO_MISMATCH: 'Assignment looks skewed; results are not trustworthy.' };
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '–');

export default function ExperimentsPanel() {
  const [items, setItems] = useState<Experiment[] | null>(null), [campaigns, setCampaigns] = useState<Campaign[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, Results>>({});
  const load = useCallback(async () => { try { setItems(await api<Experiment[]>('experiments')); setCampaigns(await api<Campaign[]>('campaigns')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function run(fn: () => Promise<void>, done?: string) { setBusy(true); setError(''); setNotice(''); try { await fn(); if (done) setNotice(done); await load(); } catch (e) { setError(friendly((e as Error).message)); } finally { setBusy(false); } }
  const friendly = (m: string) => m.startsWith('plan_limit') ? 'Your plan does not allow another experiment right now. See Settings, then Plan and usage.' : m === 'already_exists' ? 'Another experiment is already running on that step.' : m === 'experiment_running_on_step' ? 'That step is under test; stop the experiment before editing its copy.' : m;
  const create = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget; return run(async () => {
    await api('experiments', 'POST', { campaignId: f.get('campaignId'), stepOrder: Number(f.get('stepOrder')), name: f.get('name'), primaryMetric: f.get('primaryMetric'), minSample: Number(f.get('minSample')), variants: [{ label: String(f.get('label')), subject: f.get('subject'), body: f.get('body') }] });
    form.reset();
  }, 'Experiment created as a draft. Start it when you are ready.'); };

  return <>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <p className="muted">Test alternative subject and body copy on one email step. Results are only compared once each arm has enough sends; a winner is recommended, and you decide whether to apply it. This tests copy only.</p>
    {!items ? <p role="status" className="muted">Loading experiments…</p> : items.length === 0 ? <p className="muted">No experiments yet.</p> : <ul className="recordList">
      {items.map(x => {
        const campaign = campaigns.find(c => c.id === x.campaignId), open = x.recommendations.find(r => r.status === 'OPEN'), res = results[x.id];
        return <li key={x.id}>
          <div className="toolbar"><strong>{x.name}</strong><span className="pill">{x.status.toLowerCase()}</span></div>
          <p className="muted">{campaign?.name ?? 'Campaign'} · email {x.stepOrder} · goal: {x.primaryMetric.replace('_', ' ').toLowerCase()} · minimum {x.minSample} sends per variant</p>
          <div className="hero-actions" style={{ marginTop: 0 }}>
            {(x.status === 'DRAFT' || x.status === 'STOPPED') && <button type="button" disabled={busy} onClick={() => void run(() => api('experiments', 'PATCH', { id: x.id, status: 'RUNNING' }), 'Experiment started.')}>Start</button>}
            {x.status === 'RUNNING' && <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => api('experiments', 'PATCH', { id: x.id, status: 'STOPPED' }), 'Experiment stopped.')}>Stop</button>}
            <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => { const r = await api<Results>(`experiments?id=${x.id}`); setResults(s => ({ ...s, [x.id]: r })); })}>View results</button>
          </div>
          {res && <div style={{ marginTop: 10 }}>
            <p role="status">{VERDICT_TEXT[res.verdict.status] ?? res.verdict.status}</p>
            <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><caption className="sr-only">Results for {x.name}</caption><thead><tr><th scope="col">Variant</th><th scope="col">Sent</th><th scope="col">Goal reached</th><th scope="col">Rate</th><th scope="col">Unsubscribed</th></tr></thead>
              <tbody>{res.arms.map(a => <tr key={a.label}><th scope="row">{a.label}{a.isControl ? ' (original)' : ''}</th><td>{a.sent}</td><td>{a.primary}</td><td>{pct(a.primary, a.sent)}</td><td>{a.unsubscribed}</td></tr>)}</tbody></table></div>
          </div>}
          {open && <div className="notice" style={{ marginTop: 10 }}><strong>Recommendation:</strong> apply the winning variant to the campaign as a new version. Earlier approvals will be revoked.
            <div className="hero-actions"><button type="button" disabled={busy} onClick={() => void run(() => api(`experiments/${open.id}/decision`, 'POST', { decision: 'accept' }), 'Applied as a new campaign version.')}>Apply winner</button><button type="button" className="secondary" disabled={busy} onClick={() => void run(() => api(`experiments/${open.id}/decision`, 'POST', { decision: 'reject' }), 'Recommendation rejected.')}>Reject</button></div></div>}
        </li>;
      })}
    </ul>}
    <h2>New experiment</h2>
    <form className="editor" onSubmit={create}>
      <div className="formGrid">
        <label>Campaign<select name="campaignId" required>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Email step to test<input name="stepOrder" type="number" min={1} max={10} defaultValue={1} required /></label>
        <label>Experiment name<input name="name" required maxLength={200} /></label>
        <label>Goal<select name="primaryMetric" defaultValue="POSITIVE_REPLY"><option value="POSITIVE_REPLY">Positive replies</option><option value="BOOKED">Meetings booked</option><option value="ATTENDED">Meetings attended</option></select></label>
        <label>Minimum sends per variant<input name="minSample" type="number" min={20} max={100000} defaultValue={100} required /></label>
        <label>Variant name<input name="label" defaultValue="B" required maxLength={60} /></label>
      </div>
      <label>Variant subject<input name="subject" required maxLength={200} /></label>
      <label>Variant message (variables: {'{{firstName}}'}, {'{{company}}'}, {'{{senderName}}'}, {'{{calendlyUrl}}'}, {'{{offer}}'})<textarea name="body" rows={6} required maxLength={4000} /></label>
      <button disabled={busy || campaigns.length === 0}>Create experiment</button>
    </form>
  </>;
}
