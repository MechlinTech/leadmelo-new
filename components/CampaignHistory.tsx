'use client';
import { useState } from 'react';
import { api } from './api';

type Version = { version: number; reason: string; createdAt: string };
// Version history, rollback and clone for one campaign.
export default function CampaignHistory({ id, name, onChanged }: { id: string; name: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false), [current, setCurrent] = useState(1), [versions, setVersions] = useState<Version[]>([]);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const load = () => run(async () => { const r = await api<{ version: number; versions: Version[] }>(`campaigns/${id}`); setCurrent(r.version); setVersions(r.versions); });
  return <div>
    <button disabled={busy} aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next) void load(); }}>{open ? 'Hide history' : 'History'}</button>{' '}
    <button disabled={busy} onClick={() => void run(async () => { await api(`campaigns/${id}/clone`, 'POST', {}); setNotice('Draft copy created.'); onChanged(); })}>Clone</button>
    {open && <div role="region" aria-label={`History of ${name}`}>
      {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
      <p className="muted">Current version {current}. Rolling back restores old content as a new version and clears pending approvals.</p>
      {versions.length === 0 ? <p className="muted">No earlier versions: only material edits (message, sender, targeting, calendar link) create a version.</p>
        : <ul className="recordList">{versions.map(v => <li key={v.version}>Version {v.version} &middot; {v.reason.replaceAll('_', ' ')} &middot; {new Date(v.createdAt).toLocaleString()}{v.version !== current && <> <button disabled={busy} onClick={() => { if (window.confirm(`Restore version ${v.version}? A sender change will pause the campaign until it is re-checked.`)) void run(async () => { await api(`campaigns/${id}/rollback`, 'POST', { version: v.version }); setNotice(`Restored version ${v.version} as a new version.`); await load(); onChanged(); }); }}>Restore</button></>}</li>)}</ul>}
    </div>}
  </div>;
}
