'use client';
import { useState } from 'react';
import { api } from './api';
import { useAppRole } from './AppRole';
import Pager, { pageSlice } from './Pager';
import { showToast } from './Toaster';

type Version = { version: number; reason: string; createdAt: string };
// Version history, rollback and clone for one campaign.
export default function CampaignHistory({ id, name, onChanged }: { id: string; name: string; onChanged: (action: 'add' | 'update', campaign: any) => void }) {
  const { canWrite } = useAppRole();
  const [open, setOpen] = useState(false), [current, setCurrent] = useState(1), [versions, setVersions] = useState<Version[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { showToast((e as Error).message, 'error'); } finally { setBusy(false); } }
  const load = () => run(async () => { const r = await api<{ version: number; versions: Version[] }>(`campaigns/${id}`); setCurrent(r.version); setVersions(r.versions); });
  const pageData = pageSlice(versions, page, 10);
  return <div style={{ display: 'contents' }}>
    <button disabled={busy} aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next) void load(); }}>{open ? 'Hide history' : 'History'}</button>{' '}
    {canWrite && <button disabled={busy} onClick={() => void run(async () => { const clone = await api(`campaigns/${id}/clone`, 'POST', {}); showToast('Draft copy created.'); onChanged('add', clone); })}>Clone</button>}
    {open && <div role="region" aria-label={`History of ${name}`} style={{ width: '100%', marginTop: '8px' }}>
      {error && <p role="alert" className="error" style={{ marginBottom: 16 }}>{error}</p>}
      <p className="muted">Current version {current}. Rolling back restores old content as a new version and clears pending approvals.</p>
      {versions.length === 0 ? <p className="muted">No earlier versions: only material edits (message, sender, targeting, calendar link) create a version.</p>
        : <><ul className="recordList">{pageData.slice.map(v => <li key={v.version}>Version {v.version} &middot; {v.reason.replaceAll('_', ' ')} &middot; {new Date(v.createdAt).toLocaleString()}{canWrite && v.version !== current && <> <button disabled={busy} onClick={() => { if (window.confirm(`Restore version ${v.version}? A sender change will pause the campaign until it is re-checked.`)) void run(async () => { const res = await api<{ campaign: any }>(`campaigns/${id}/rollback`, 'POST', { version: v.version }); showToast(`Restored version ${v.version} as a new version.`); await load(); onChanged('update', res.campaign); }); }}>Restore</button></>}</li>)}</ul>
        <Pager page={pageData.page} pages={pageData.pages} total={pageData.total} label="versions" onPage={setPage} /></>}
    </div>}
  </div>;
}
