'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from './api';

type Invite = { id: string; email: string; role: string; expiresAt: string };
export default function SecuritySettings() {
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState<{ secret: string; otpauthUri: string } | null>(null), [codes, setCodes] = useState<string[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]), [link, setLink] = useState('');
  const loadInvites = useCallback(async () => { try { setInvites(await api('invites')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void loadInvites(); }, [loadInvites]);
  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const invite = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); return run(async () => {
    const r = await api<{ acceptUrl: string }>('invites', 'POST', { email: data.get('email'), role: data.get('role') });
    setLink(r.acceptUrl); setNotice('Invitation created. Copy the link below and send it to the person; it is shown only once.'); form.reset(); await loadInvites();
  }); };
  const enable = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const data = new FormData(e.currentTarget); return run(async () => {
    setCodes((await api<{ recoveryCodes: string[] }>('auth/mfa/enable', 'POST', { code: String(data.get('code')) })).recoveryCodes); setMfa(null);
  }); };
  return <>
  <section aria-labelledby="security-title">
    <h2 id="security-title">Your sign-in security</h2>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {codes ? <div role="status"><p><strong>Two-factor authentication is on.</strong> Save these recovery codes now. Each works once and they will not be shown again.</p><pre>{codes.join('\n')}</pre><button onClick={() => setCodes(null)}>I have saved them</button></div>
      : mfa ? <form className="editor" onSubmit={enable}><p>Add this key to an authenticator app (manual entry, time-based), then enter the 6-digit code it shows.</p><pre aria-label="Authenticator key">{mfa.secret}</pre><details><summary>Setup URI</summary><pre>{mfa.otpauthUri}</pre></details><label>6-digit code<input className="input" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required/></label><button disabled={busy}>Turn on two-factor authentication</button></form>
      : <button disabled={busy} onClick={() => void run(async () => setMfa(await api('auth/mfa/setup', 'POST', {})))}>Set up two-factor authentication</button>}
  </section>
    <section aria-labelledby="team-title">
    <h2 id="team-title">Team</h2>
    <form className="editor" onSubmit={invite}><div className="formGrid"><label>Invite by email<input className="input" name="email" type="email" required/></label><label>Role<select name="role" defaultValue="MEMBER"><option value="MEMBER">Member (view)</option><option value="MANAGER">Manager (run campaigns)</option><option value="TENANT_ADMIN">Administrator</option></select></label></div><button disabled={busy}>Create invitation</button></form>
    {link && <p>Invitation link: <code>{link}</code></p>}
    {invites.length > 0 && <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><caption className="muted">Pending invitations</caption><thead><tr><th>Email</th><th>Role</th><th>Expires</th><th><span className="skip">Action</span></th></tr></thead><tbody>{invites.map(i => <tr key={i.id}><td>{i.email}</td><td>{i.role}</td><td>{new Date(i.expiresAt).toLocaleString()}</td><td><button disabled={busy} onClick={() => void run(async () => { await api(`invites?id=${encodeURIComponent(i.id)}`, 'DELETE'); await loadInvites(); })}>Revoke</button></td></tr>)}</tbody></table></div>}
  </section>
  </>;
}
