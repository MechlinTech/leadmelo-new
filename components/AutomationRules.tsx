'use client';
import { FormEvent, useEffect, useState, useRef } from 'react';
import { api } from './api';
import { useAppRole } from './AppRole';
import { showToast } from './Toaster';

type Rule = { id: string; name: string; enabled: boolean; system?: boolean; when: string; action: string };
type Config = { alerts: { inApp: boolean; recipients: string[]; webhookUrl: string | null; codes: Record<string, boolean> }; rules: Rule[] };
const WHEN = [['bounced_email', 'Email bounced'], ['booking_failure', 'Booking failed'], ['missed_webhook', 'Missed calendar webhook'], ['discovery_failed', 'Discovery failed'], ['outreach_failed', 'Send failed'], ['positive_reply', 'Positive reply'], ['negative_reply', 'Negative reply']];
const ACTION = [['raise_alert', 'Raise an alert'], ['pause_active_campaigns', 'Pause active campaigns']];

export default function AutomationRules() {
  const { canWrite } = useAppRole();
  const [config, setConfig] = useState<Config | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [updatingRules, setUpdatingRules] = useState<Record<string, boolean>>({});
  const pendingConfigRef = useRef<Config | null>(null);
  
  async function load() { 
    const data = await api<Config>('workspace-config');
    setConfig(data);
    pendingConfigRef.current = data;
  }
  useEffect(() => { load().catch(e => setError((e as Error).message)); }, []);
  const saveQueueRef = useRef<Promise<any>>(Promise.resolve());

  async function queuedApiPut(next: Config): Promise<Config> {
    return new Promise((resolve, reject) => {
      saveQueueRef.current = saveQueueRef.current
        .then(async () => {
          try {
            resolve(await api<Config>('workspace-config', 'PUT', next));
          } catch (e) {
            reject(e);
          }
        })
        .catch(() => {}); // catch to allow subsequent queued items to run even if one fails
    });
  }

  async function save(next: Config) {
    setBusy(true); setError('');
    try { 
      const result = await queuedApiPut(next);
      setConfig(result); 
      pendingConfigRef.current = result;
      showToast('Rules saved.'); 
    }
    catch (e) { showToast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  async function toggle(id: string, enabled: boolean) {
    if (!pendingConfigRef.current) return;
    
    setUpdatingRules(prev => ({ ...prev, [id]: true }));
    setError('');

    const previousRuleState = pendingConfigRef.current.rules.find(r => r.id === id)?.enabled ?? !enabled;

    const nextConfig = {
      ...pendingConfigRef.current,
      rules: pendingConfigRef.current.rules.map(r => r.id === id ? { ...r, enabled } : r)
    };
    pendingConfigRef.current = nextConfig;
    setConfig(nextConfig);

    try {
      await queuedApiPut(nextConfig);
      showToast('Rules saved.');
    } catch (e) {
      if (pendingConfigRef.current) {
        const revertedConfig = {
          ...pendingConfigRef.current,
          rules: pendingConfigRef.current.rules.map(r => r.id === id ? { ...r, enabled: previousRuleState } : r)
        };
        pendingConfigRef.current = revertedConfig;
        setConfig(revertedConfig);
      }
      showToast((e as Error).message, 'error');
    } finally {
      setUpdatingRules(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }
  function remove(id: string) {
    if (!pendingConfigRef.current) return;
    void save({ ...pendingConfigRef.current, rules: pendingConfigRef.current.rules.filter(r => r.id !== id) });
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingConfigRef.current) return;
    const form = new FormData(event.currentTarget);
    const rule: Rule = {
      id: `custom-${Date.now()}`,
      name: String(form.get('name') ?? '').trim(),
      enabled: true,
      when: String(form.get('when')),
      action: String(form.get('action'))
    };
    if (rule.name.length < 2) return;
    void save({ ...pendingConfigRef.current, rules: [...pendingConfigRef.current.rules, rule] });
    event.currentTarget.reset();
  }
  if (!config) return error ? <p role="alert" className="error">{error}</p> : <p className="muted">Loading automation rules...</p>;
  const system = config.rules.filter(r => r.system || r.id.startsWith('sys_'));
  const custom = config.rules.filter(r => !r.system && !r.id.startsWith('sys_'));
  return <section aria-labelledby="rules-title">
    <h2 id="rules-title">Automation rules</h2>
    <p>Built-in rules are the worker’s defaults. You can switch them off, or add a rule that pauses every active campaign when a chosen event happens.</p>
    {error && <p role="alert" className="error" style={{ marginBottom: 16 }}>{error}</p>}
    <h3>Built-in</h3>
    <ul className="recordList">{system.map(r => <li key={r.id}><strong>{r.name}</strong><p className="muted">When {r.when.replaceAll('_', ' ')} → {r.action.replaceAll('_', ' ')}</p>{canWrite && <label><input type="checkbox" checked={r.enabled} disabled={busy || updatingRules[r.id]} onChange={e => toggle(r.id, e.target.checked)} /> Enabled</label>}</li>)}</ul>
    <h3>Your rules</h3>
    {!custom.length && <p className="muted">No custom rules yet.</p>}
    <ul className="recordList">{custom.map(r => <li key={r.id}><strong>{r.name}</strong><p className="muted">When {r.when.replaceAll('_', ' ')} → {r.action.replaceAll('_', ' ')}</p>{canWrite && <div className="toolbar"><label><input type="checkbox" checked={r.enabled} disabled={busy || updatingRules[r.id]} onChange={e => toggle(r.id, e.target.checked)} /> Enabled</label><button type="button" className="secondary" disabled={busy} onClick={() => remove(r.id)}>Remove</button></div>}</li>)}</ul>
    {canWrite && <form className="editor" onSubmit={add}><div className="formGrid">
      <label>Rule name<input className="input" name="name" required minLength={2} maxLength={120}/></label>
      <label>When<select name="when">{WHEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>Then<select name="action">{ACTION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
    </div><button disabled={busy}>Add rule</button></form>}
  </section>;
}
