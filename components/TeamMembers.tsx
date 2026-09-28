'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

type Member = { id: string; email: string; name: string | null; role: string; disabled: boolean; mfaEnabled: boolean; you: boolean };

export default function TeamMembers() {
  const [members, setMembers] = useState<Member[] | null>(null), [denied, setDenied] = useState(false), [link, setLink] = useState<{ email: string; url: string } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { api<Member[]>('users').then(setMembers).catch(e => { if ((e as Error).message === 'admin_required') setDenied(true); else setError((e as Error).message); }); }, []);
  if (denied) return null;
  async function reset(m: Member) {
    setBusy(true); setError(''); setLink(null);
    try { const r = await api<{ resetUrl: string }>(`users/${m.id}/reset`, 'POST', {}); setLink({ email: m.email, url: r.resetUrl }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section aria-labelledby="members-title">
    <h2 id="members-title">Members</h2>
    {error && <p role="alert" className="error">{error}</p>}
    {link && <div className="notice" role="status"><p style={{ margin: 0 }}>One-time password reset link for <strong>{link.email}</strong> (valid 1 hour; it signs them out everywhere). Send it to them yourself; it is not shown again:</p><p><code>{link.url}</code></p></div>}
    {!members ? <p role="status" className="muted">Loading members…</p> : <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table>
      <caption className="sr-only">Members of this workspace</caption>
      <thead><tr><th scope="col">Email</th><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Two-factor</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{members.map(m => <tr key={m.id}><td>{m.email}{m.you && <span className="pill" style={{ marginLeft: 6 }}>You</span>}</td><td>{m.name?.trim() || m.email.split('@')[0]}</td><td>{m.role.replace('_', ' ').toLowerCase()}</td><td>{m.mfaEnabled ? 'On' : 'Off'}</td>
        <td>{!m.you && !m.disabled && <button type="button" className="secondary" disabled={busy} onClick={() => void reset(m)}>Create reset link</button>}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}
