'use client';
import { useState } from 'react';
import { api } from './api';

const TEMPLATE = 'company,domain,contactName,contactEmail,signalSummary,score\nAcme Robotics,acme.example,Pat Buyer,pat@acme.example,Hiring QA,80\n';

export default function LeadImport({ onImported }: { onImported: () => void }) {
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function readFile(file: File) {
    setBusy(true); setError(''); setNotice('');
    try {
      const csv = await file.text();
      const result = await api<{ created: number; skipped: number; errors: string[] }>('leads', 'POST', { csv });
      setNotice(`Imported ${result.created}. Skipped ${result.skipped} duplicate or existing domains.${result.errors.length ? ` ${result.errors.length} row(s) had invalid fields.` : ''}`);
      onImported();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="editor" onSubmit={e => e.preventDefault()}>
    <h2>Import prospects from CSV</h2>
    <p className="muted">Columns: company (required), domain, contactName, contactEmail, signalSummary, score. Up to 200 rows. Existing domains are skipped.</p>
    <div className="toolbar">
      <label>CSV file <input className="input" type="file" accept=".csv,text/csv" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ''; }}/></label>
      <a className="btn secondary" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="leadmelo-prospects.csv">Download template</a>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </form>;
}
