'use client';
import { FormEvent, useEffect, useState } from 'react';
import { api } from './api';
import { useAppRole } from './AppRole';

type Alert = { id: string; code: string; entityId: string; createdAt: string; deliveredAt: string | null; attempts: number };
type Config = { alerts: { inApp: boolean; recipients: string[]; webhookUrl: string | null; codes: Record<string, boolean> }; rules: unknown[] };
const TESTS = [['booking_failure', 'Simulate booking failure'], ['bounced_email', 'Simulate bounced email'], ['missed_webhook', 'Simulate missed webhook'], ['test_exception', 'Simulate test exception']] as const;
const LABELS: Record<string, string> = {
  sender_health_missing: 'Sender health missing', sender_degraded: 'Sender degraded', sender_health_stale: 'Sender health stale',
  reply_sync_stale: 'Reply sync stale', send_stuck: 'Send stuck', discovery_failed: 'Discovery failed', outreach_failed: 'Outreach failed',
  verification_exhausted: 'Verification exhausted', m365_send_needs_reconciliation: 'Microsoft send needs review',
  booking_failure: 'Booking failure', bounced_email: 'Bounced email', missed_webhook: 'Missed webhook',
  test_exception: 'Test exception', calendly_reconcile_failed: 'Calendly recovery failed',
  bounce_notice_unattributed: 'Unattributed bounce', mail_sync_failed: 'Mail sync failed', test_failure: 'Test failure', reply_review: 'Reply needs review'
};

export default function OperationalAlerts() {
  const { canWrite } = useAppRole();
  const [rows, setRows] = useState<Alert[]>([]), [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function loadAlerts() { setRows(await api<Alert[]>('alerts')); }
  async function loadConfig() { setConfig(await api<Config>('workspace-config')); }
  useEffect(() => { Promise.all([loadAlerts(), loadConfig()]).catch(e => setError((e as Error).message)); }, []);
  async function acknowledge(id: string) {
    try { await api('alerts', 'PATCH', { id }); await loadAlerts(); } catch (e) { setError((e as Error).message); }
  }
  async function simulate(code: typeof TESTS[number][0]) {
    setBusy(true); setError('');
    try { await api('alerts', 'POST', { code }); await loadAlerts(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config) return;
    setBusy(true); setError(''); setNotice('');
    const form = new FormData(event.currentTarget);
    const codes = Object.fromEntries(Object.keys(config.alerts.codes).map(code => [code, form.get(`code_${code}`) === 'on']));
    const next = {
      ...config,
      alerts: {
        inApp: form.get('inApp') === 'on',
        recipients: String(form.get('recipients') ?? '').split(',').map(v => v.trim()).filter(Boolean),
        webhookUrl: String(form.get('webhookUrl') ?? '').trim() || null,
        codes
      }
    };
    try { setConfig(await api<Config>('workspace-config', 'PUT', next)); setNotice('Alert configuration saved.'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <section aria-labelledby="alert-config-title">
      <h2 id="alert-config-title">Alert configuration</h2>
      <p>Choose which events raise an in-app alert, who should watch this page, and an optional HTTPS webhook. The host can also set <code>ALERT_WEBHOOK_URL</code>. Acknowledging an alert does not fix the underlying work.</p>
      {config && <form className="editor" onSubmit={saveConfig}>
        <label><input type="checkbox" name="inApp" defaultChecked={config.alerts.inApp} disabled={!canWrite}/> Show alerts in this workspace</label>
        <div className="formGrid">
          <label>Notify these emails (comma separated)<input className="input" name="recipients" defaultValue={config.alerts.recipients.join(', ')} disabled={!canWrite} placeholder="ops@example.com"/></label>
          <label>Workspace webhook URL (https, optional)<input className="input" name="webhookUrl" type="url" defaultValue={config.alerts.webhookUrl ?? ''} disabled={!canWrite} placeholder="https://example.com/leadmelo-alerts"/></label>
        </div>
        <fieldset><legend>Events that raise an alert</legend>
          <div className="formGrid">{Object.keys(config.alerts.codes).sort().map(code => <label key={code}><input type="checkbox" name={`code_${code}`} defaultChecked={config.alerts.codes[code] !== false} disabled={!canWrite}/> {LABELS[code] ?? code.replaceAll('_', ' ')}</label>)}</div>
        </fieldset>
        {canWrite ? <button disabled={busy}>Save alert configuration</button> : <p className="muted">Ask a manager or administrator to change alert settings.</p>}
      </form>}
    </section>
    <section>
      <h2>Operational alerts</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="button" onClick={() => void loadAlerts().catch(e => setError((e as Error).message))}>Refresh alerts</button>
      {canWrite && <div className="toolbar" style={{ marginTop: 8 }}>{TESTS.map(([code, label]) => <button key={code} type="button" className="secondary" disabled={busy} onClick={() => void simulate(code)}>{label}</button>)}</div>}
      <ul className="recordList">{rows.map(r => <li key={r.id}><strong>{(LABELS[r.code] ?? r.code).replaceAll('_', ' ')}</strong><p>Reference: {r.entityId}</p><p>{new Date(r.createdAt).toLocaleString()} — {r.deliveredAt ? 'Notification accepted by alert receiver' : r.attempts >= 6 ? 'Notification retries exhausted' : 'Notification pending or receiver not configured'}</p>{canWrite && <button type="button" onClick={() => void acknowledge(r.id)}>Acknowledge</button>}</li>)}</ul>
      {!rows.length && <p>No unacknowledged alerts in the latest 100 records.</p>}
    </section>
  </>;
}
