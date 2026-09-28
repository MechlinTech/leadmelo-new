'use client';
import { FormEvent, useEffect, useState } from 'react';
import { api } from './api';
import { useAppRole } from './AppRole';

type Rule = { id: string; name: string; enabled: boolean; system?: boolean; when: string; action: string };
type Config = { alerts: { inApp: boolean; recipients: string[]; webhookUrl: string | null; codes: Record<string, boolean> }; rules: Rule[] };
const WHEN = [['bounced_email', 'Email bounced'], ['booking_failure', 'Booking failed'], ['missed_webhook', 'Missed calendar webhook'], ['discovery_failed', 'Discovery failed'], ['outreach_failed', 'Send failed'], ['positive_reply', 'Positive reply'], ['negative_reply', 'Negative reply']];
const ACTION = [['raise_alert', 'Raise an alert'], ['pause_active_campaigns', 'Pause active campaigns']];

export default function AutomationRules() {
  const { canWrite } = useAppRole();
  const [config, setConfig] = useState<Config | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function load() { setConfig(await api<Config>('workspace-config')); }
  useEffect(() => { load().catch(e => setError((e as Error).message)); }, []);
  async function save(next: Config) {
    setBusy(true); setError(''); setNotice('');
    try { setConfig(await api<Config>('workspace-config', 'PUT', next)); setNotice('Rules saved.'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function toggle(id: string, enabled: boolean) {
    if (!config) return;
    void save({ ...config, rules: config.rules.map(r => r.id === id ? { ...r, enabled } : r) });
  }
  function remove(id: string) {
    if (!config) return;
    void save({ ...config, rules: config.rules.filter(r => r.id !== id) });
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config) return;
    const form = new FormData(event.currentTarget);
    const rule: Rule = {
      id: `custom-${Date.now()}`,
      name: String(form.get('name') ?? '').trim(),
      enabled: true,
      when: String(form.get('when')),
      action: String(form.get('action'))
    };
    if (rule.name.length < 2) return;
    void save({ ...config, rules: [...config.rules, rule] });
    event.currentTarget.reset();
  }
  if (!config) return error ? <p role="alert" className="error">{error}</p> : <p className="muted">Loading automation rules...</p>;
  const system = config.rules.filter(r => r.system || r.id.startsWith('sys_'));
  const custom = config.rules.filter(r => !r.system && !r.id.startsWith('sys_'));
  return <section aria-labelledby="rules-title">
    <h2 id="rules-title">Automation rules</h2>
    <p>Built-in rules are the worker’s defaults. You can switch them off, or add a rule that pauses every active campaign when a chosen event happens.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <h3>Built-in</h3>
    <ul className="recordList">{system.map(r => <li key={r.id}><strong>{r.name}</strong><p className="muted">When {r.when.replaceAll('_', ' ')} → {r.action.replaceAll('_', ' ')}</p>{canWrite && <label><input type="checkbox" checked={r.enabled} disabled={busy} onChange={e => toggle(r.id, e.target.checked)} /> Enabled</label>}</li>)}</ul>
    <h3>Your rules</h3>
    {!custom.length && <p className="muted">No custom rules yet.</p>}
    <ul className="recordList">{custom.map(r => <li key={r.id}><strong>{r.name}</strong><p className="muted">When {r.when.replaceAll('_', ' ')} → {r.action.replaceAll('_', ' ')}</p>{canWrite && <div className="toolbar"><label><input type="checkbox" checked={r.enabled} disabled={busy} onChange={e => toggle(r.id, e.target.checked)} /> Enabled</label><button type="button" className="secondary" disabled={busy} onClick={() => remove(r.id)}>Remove</button></div>}</li>)}</ul>
    {canWrite && <form className="editor" onSubmit={add}><div className="formGrid">
      <label>Rule name<input className="input" name="name" required minLength={2} maxLength={120}/></label>
      <label>When<select name="when">{WHEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>Then<select name="action">{ACTION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
    </div><button disabled={busy}>Add rule</button></form>}
  </section>;
}
