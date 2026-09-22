'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import MicrosoftSettings from './MicrosoftSettings';
import OperationalAlerts from './OperationalAlerts';
import DigestPanel from './DigestPanel';
import SecuritySettings from './SecuritySettings';
import PrivacyTools from './PrivacyTools';
import CampaignHistory from './CampaignHistory';
import PlanUsagePanel from './PlanUsagePanel';
import AppearanceSettings from './AppearanceSettings';
import TeamMembers from './TeamMembers';
import AiSettings from './AiSettings';
import AiAssist, { type Suggestion } from './AiAssist';
import ReplyAi from './ReplyAi';

type Row = Record<string, any>;
type Section = 'overview' | 'icps' | 'campaigns' | 'settings' | 'leads' | 'automation-runs';
const list = (form: FormData, key: string) => String(form.get(key) ?? '').split(',').map(v => v.trim()).filter(Boolean);
const value = (form: FormData, key: string) => String(form.get(key) ?? '');
const number = (form: FormData, key: string) => Number(form.get(key));
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  if (response.status === 401) { window.location.assign('/auth/signin'); throw new Error('Please sign in'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result;
}
function Field({ name, label, type = 'text', initial = '', required = true, step }: { name: string; label: string; type?: string; initial?: string | number; required?: boolean; step?: string }) {
  return <label>{label}<input className="input" name={name} type={type} step={step} defaultValue={initial} required={required} /></label>;
}
function fillField(name: string, value: string | number) {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`form.editor [name="${name}"]`);
  if (el) el.value = String(value);
}
export default function Workspace({ section }: { section: Section }) {
  const [rows, setRows] = useState<Row[]>([]), [icps, setIcps] = useState<Row[]>([]), [settings, setSettings] = useState<Row | null>(null);
  const [outreach, setOutreach] = useState<Row[]>([]), [replies, setReplies] = useState<Row[]>([]);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [stepCount, setStepCount] = useState(1), [icpMode, setIcpMode] = useState<'new' | 'existing'>('new');
  const applyAi = (sg: Suggestion) => {
    setIcpMode('new'); setStepCount(sg.steps.length);
    // Wait one paint so the extra step fields exist before they are filled.
    setTimeout(() => {
      const pre = section === 'icps' ? '' : 'icp_';
      fillField('name', sg.name); fillField('offer', sg.offer); if (section !== 'icps') fillField('icpName', sg.icp.name);
      for (const key of ['industries', 'companySizes', 'geographies', 'technologies', 'buyingSignals', 'buyerTitles', 'exclusionRules']) fillField(pre + key, (sg.icp[key] ?? []).join(', '));
      if (section === 'campaigns') sg.steps.forEach((st, i) => { fillField(`delay${i}`, st.waitBusinessDays); fillField(`subject${i}`, st.subject); fillField(`body${i}`, st.body); });
    }, 60);
  };
  const load = useCallback(async () => {
    setError('');
    try {
      if (section === 'settings') setSettings(await api('settings'));
      else setRows(await api(section === 'overview' ? 'appointments' : section));
      if (section === 'campaigns') setIcps(await api('icps'));
      if (section === 'automation-runs') { setOutreach(await api('outreach')); setReplies(await api('replies')); }
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [section]);
  useEffect(() => { void load(); }, [load]);
  async function mutate(path: string, method: string, body: unknown) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api(path, method, body);
      setNotice(result.activation?.requested ? result.activation.started ? 'Campaign saved and autopilot started.' : `Campaign saved as draft. Activation blocked: ${result.activation.reason}` : 'Saved');
      await load();
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (section === 'icps') {
      const body: Row = { name: value(form, 'name'), offer: value(form, 'offer'), minScore: number(form, 'minScore'), weeklyAppointmentGoal: number(form, 'weeklyAppointmentGoal') };
      for (const key of ['industries', 'companySizes', 'geographies', 'technologies', 'buyingSignals', 'buyerTitles', 'exclusionRules']) body[key] = list(form, key);
      await mutate('icps', 'POST', body);
    } else if (section === 'campaigns') {
      const body: Row = {};
      for (const key of ['name', 'offer', 'senderName', 'senderEmail', 'calendlyUrl', 'timezone', 'automationMode', 'outcomeType']) body[key] = value(form, key);
      for (const key of ['dailySendCap', 'weeklyProspectCap', 'weeklyAppointmentGoal', 'minScore', 'minAppointmentQualityScore', 'sendStartHour', 'sendEndHour']) body[key] = number(form, key);
      body.startImmediately = form.get('startImmediately') === 'on';
      body.holidays = list(form, 'holidays');
      if (icpMode === 'existing') body.icpId = value(form, 'icpId');
      else {
        body.icp = { name: value(form, 'icpName'), offer: body.offer, minScore: body.minScore, weeklyAppointmentGoal: body.weeklyAppointmentGoal };
        for (const key of ['industries', 'companySizes', 'geographies', 'technologies', 'buyingSignals', 'buyerTitles', 'exclusionRules']) body.icp[key] = list(form, `icp_${key}`);
      }
      body.sequenceSteps = Array.from({ length: stepCount }, (_, i) => ({ stepOrder: i + 1, waitBusinessDays: number(form, `delay${i}`), subject: value(form, `subject${i}`), body: value(form, `body${i}`) }));
      await mutate('campaigns', 'POST', body);
    } else if (section === 'settings') {
      const body: Row = { automationEnabled: form.get('automationEnabled') === 'on', dailySendCap: number(form, 'dailySendCap'), weeklyProspectCap: number(form, 'weeklyProspectCap'), postalAddress: value(form, 'postalAddress') };
      for (const key of ['gatewayKey', 'webhookSecret', 'calendlySigningKey', 'calendlyToken']) if (value(form, key)) body[key] = value(form, key);
      body.calendlyOrganizationUri = value(form, 'calendlyOrganizationUri').trim() || null;
      // Blank means "no cap" / "keep forever"; dollars are converted to the cents the API stores.
      const dollars = (key: string) => value(form, key).trim() === '' ? null : Math.round(Number(value(form, key)) * 100);
      body.monthlySpendCapCents = dollars('monthlySpendCap');
      body.providerCostCents = dollars('providerCost') ?? 0;
      body.messageRetentionDays = value(form, 'messageRetentionDays').trim() === '' ? null : number(form, 'messageRetentionDays');
      await mutate('settings', 'PUT', body);
    }
  }
  const title = { overview: 'Meetings', icps: 'Ideal customer profiles', campaigns: 'Campaigns', settings: 'Workspace settings', leads: 'Prospects', 'automation-runs': 'Automation & exceptions' }[section];
  return <>
    <div className="toolbar"><h1>{title}</h1><button onClick={() => void load()} disabled={loading || busy}>Refresh</button></div>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading...</p> : <>
      {section === 'overview' && <DigestPanel/>}
      {section === 'settings' && <><PlanUsagePanel/><AppearanceSettings/><AiSettings/><MicrosoftSettings/><SecuritySettings/><TeamMembers/><PrivacyTools/></>}
      {section === 'automation-runs' && <OperationalAlerts/>}
      {section === 'overview' && <><p>{rows.filter(r => r.qualified && r.status === 'BOOKED').length} qualified booked meetings in the latest 100 records.</p><div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><thead><tr><th>Buyer</th><th>Campaign</th><th>Time</th><th>Status</th><th>Qualification</th><th>Outcome</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.contact?.fullName}<br/>{r.contact?.email}</td><td>{r.campaign?.name}</td><td>{r.scheduledStart ? new Date(r.scheduledStart).toLocaleString() : 'Pending'}</td><td>{r.status}</td><td>{r.qualified ? 'Qualified' : <><span>Review required</span>{r.status === 'BOOKED' && <button disabled={busy} onClick={() => void mutate('appointments', 'PATCH', { id: r.id, qualified: true, outcomeReason: 'Buyer, need and ICP evidence reviewed by meeting owner' })}>Approve</button>}</>}</td><td><select aria-label="Record meeting outcome" defaultValue="" disabled={busy || r.status === 'CANCELED'} onChange={e => { if (e.target.value) void mutate('appointments', 'PATCH', { id: r.id, status: e.target.value, outcomeReason: 'Recorded by meeting owner' }); }}><option value="">Record outcome</option>{['COMPLETED', 'NO_SHOW', 'DISQUALIFIED', 'WON', 'LOST'].map(v => <option key={v}>{v}</option>)}</select></td></tr>)}</tbody></table></div></>}
      {section === 'icps' && <><ul className="recordList">{rows.map(r => <li key={r.id}><strong>{r.name}</strong> &middot; {r.offer}<p>{r.geographies.join(', ')} &middot; Minimum score {r.minScore}</p></li>)}</ul><h2>Create ICP</h2><AiAssist onApply={applyAi}/><form onSubmit={submit} className="editor"><div className="formGrid"><Field name="name" label="Profile name"/><Field name="offer" label="Offer"/>{[['industries', 'Industries'], ['companySizes', 'Company size bands'], ['geographies', 'Countries / regions'], ['technologies', 'Technologies'], ['buyingSignals', 'Buying signals'], ['buyerTitles', 'Buyer titles'], ['exclusionRules', 'Excluded domains, companies or industries']].map(([name, label]) => <Field key={name} name={name} label={`${label} (comma separated)`} required={!['technologies', 'exclusionRules'].includes(name)}/>)}<Field name="minScore" label="Minimum fit score" type="number" initial={75}/><Field name="weeklyAppointmentGoal" label="Weekly meeting goal" type="number" initial={5}/></div><button disabled={busy}>Create ICP</button></form></>}
      {section === 'campaigns' && <>
        <p><a href="/app/experiments">Copy experiments (A/B tests)</a></p>
        <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><thead><tr><th>Campaign</th><th>ICP</th><th>Status</th><th>Mode</th><th>Goal</th><th>Control</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.name}</td><td>{r.icp?.name}</td><td>{r.status}</td><td>{r.automationMode.replaceAll('_', ' ').toLowerCase()}</td><td>{r.weeklyAppointmentGoal}/week</td><td><button disabled={busy} onClick={() => void mutate('campaigns', 'PATCH', { id: r.id, status: r.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>{r.status === 'ACTIVE' ? 'Pause' : 'Activate'}</button><CampaignHistory id={r.id} name={r.name} onChanged={() => void load()}/></td></tr>)}</tbody></table></div>
        <h2>Create self-running campaign</h2>
        <AiAssist onApply={applyAi}/>
        <form className="editor" onSubmit={submit}>
          <div className="formGrid">
            <Field name="name" label="Campaign name"/>
            <Field name="offer" label="Offer / outcome promised"/>
            <label>ICP setup<select value={icpMode} onChange={e => setIcpMode(e.target.value as 'new' | 'existing')}><option value="new">Define ICP in this campaign</option>{icps.length > 0 && <option value="existing">Use an existing ICP</option>}</select></label>
            {icpMode === 'existing' && <label>Existing ICP<select name="icpId">{icps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
            <Field name="senderName" label="Sender name"/>
            <Field name="senderEmail" label="Connected sender email" type="email"/>
            <Field name="calendlyUrl" label="Tenant booking link" type="url"/>
            <Field name="timezone" label="IANA timezone" initial="America/Los_Angeles"/>
            <Field name="holidays" label="No-send holidays, YYYY-MM-DD, comma separated (optional)" required={false}/>
            <label>Automation mode<select name="automationMode" defaultValue="REVIEW_BEFORE_SEND"><option value="FULLY_AUTOMATIC">Fully automatic</option><option value="REVIEW_BEFORE_SEND">Review messages first</option><option value="REVIEW_BEFORE_BOOKING">Automatic outreach, review meeting qualification</option></select></label>
            <label>Campaign outcome<select name="outcomeType"><option value="APPOINTMENT_BOOKED">Booked appointment</option><option value="QUALIFIED_OPPORTUNITY">Qualified opportunity</option></select></label>
            {icpMode === 'new' && <>
              <Field name="icpName" label="ICP name"/>
              {([['industries', 'Industries'], ['companySizes', 'Company size bands'], ['geographies', 'Countries / regions'], ['technologies', 'Technologies'], ['buyingSignals', 'Buying signals'], ['buyerTitles', 'Buyer titles'], ['exclusionRules', 'Excluded domains, companies or industries']] as const).map(([name, label]) => <Field key={name} name={`icp_${name}`} label={`${label} (comma separated)`} required={!['technologies', 'exclusionRules'].includes(name)}/>)}
            </>}
            {([['dailySendCap', 'Daily email cap', 25], ['weeklyProspectCap', 'Weekly prospect cap', 50], ['weeklyAppointmentGoal', 'Weekly appointment goal', 5], ['minScore', 'Minimum ICP score', 75], ['minAppointmentQualityScore', 'Minimum appointment quality', 80], ['sendStartHour', 'Send from hour (0-23)', 9], ['sendEndHour', 'Send until hour (1-24)', 17]] as const).map(([name, label, initial]) => <Field key={name} name={name} label={label} initial={initial} type="number"/>)}
          </div>
          <h3>Automatic email sequence</h3>
          {Array.from({ length: stepCount }, (_, i) => <fieldset key={i}><legend>Email {i + 1}</legend><Field name={`delay${i}`} label="Wait business days after previous email" type="number" initial={i === 0 ? 0 : 3}/><Field name={`subject${i}`} label="Subject"/><label>Message<textarea name={`body${i}`} required rows={5} defaultValue={i === 0 ? 'Hi {{firstName}},\n\nI am reaching out because {{company}} appears relevant to {{offer}}.\n\nWould a short conversation help? {{calendlyUrl}}\n\n{{senderName}}' : ''}/></label></fieldset>)}
          <label><input type="checkbox" name="startImmediately" defaultChecked/> Start the autonomous campaign immediately when all safety and integration checks pass</label>
          <div className="toolbar"><button type="button" disabled={stepCount >= 10} onClick={() => setStepCount(n => n + 1)}>Add follow-up</button><button disabled={busy}>Create campaign and start autopilot</button></div>
        </form>
      </>}
      {section === 'settings' && settings && <form key={String(settings.automationEnabled) + settings.postalAddress} className="editor" onSubmit={submit}><p>Gateway: {settings.gatewayConfigured ? 'Configured' : 'Not connected'}. Webhooks: {settings.webhookConfigured ? 'Configured' : 'Not connected'}. Calendly: {settings.calendlyConfigured ? 'Signing key set' : 'Not connected'}{settings.calendlyReconcileConfigured ? `, missed-booking recovery on${settings.calendlyReconciledAt ? ` (last run ${new Date(settings.calendlyReconciledAt).toLocaleString()})` : ''}` : ''}. Sending: {settings.outboundEnabled ? 'Enabled by operator' : 'Disabled by operator'}.</p><label><input type="checkbox" name="automationEnabled" defaultChecked={settings.automationEnabled}/> Enable tenant automation</label><div className="formGrid"><Field name="dailySendCap" label="Tenant daily email cap" type="number" initial={settings.dailySendCap}/><Field name="weeklyProspectCap" label="Tenant weekly prospect cap" type="number" initial={settings.weeklyProspectCap}/><Field name="postalAddress" label="Business postal address" initial={settings.postalAddress}/><Field name="gatewayKey" label="Replace gateway credential" type="password" required={false}/><Field name="webhookSecret" label="Replace webhook signing secret" type="password" required={false}/><Field name="calendlySigningKey" label="Replace Calendly webhook signing key" type="password" required={false}/><Field name="calendlyToken" label="Calendly access token for missed-booking recovery (read-only use)" type="password" required={false}/><Field name="calendlyOrganizationUri" label="Calendly organization URI (https://api.calendly.com/organizations/...)" initial={settings.calendlyOrganizationUri ?? ''} required={false}/><Field name="monthlySpendCap" label="Monthly provider spend cap in USD (blank = no cap)" type="number" step="0.01" initial={settings.monthlySpendCapCents === null || settings.monthlySpendCapCents === undefined ? '' : settings.monthlySpendCapCents / 100} required={false}/><Field name="providerCost" label="Cost per discovered prospect in USD" type="number" step="0.01" initial={(settings.providerCostCents ?? 0) / 100} required={false}/><Field name="messageRetentionDays" label="Redact message text and replies after N days (30 or more; blank = keep)" type="number" initial={settings.messageRetentionDays ?? ''} required={false}/></div><p className="muted">Spend caps only limit what the discovery step buys; they need a cost per prospect above zero to take effect.</p><button disabled={busy}>Save settings</button></form>}
      {section === 'leads' && <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><thead><tr><th>Company</th><th>Score</th><th>Qualification</th><th>Signal</th><th>Source</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.company}</td><td>{r.score}</td><td>{r.qualification}</td><td>{r.signalSummary}</td><td>{r.source && /^https?:\/\//.test(r.source) && <a href={r.source} rel="noreferrer" target="_blank">Evidence</a>}</td></tr>)}</tbody></table></div>}
      {section === 'automation-runs' && <><h2>Runs</h2><div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><thead><tr><th>Run</th><th>Status</th><th>Discovered</th><th>Queued</th><th>Error</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{new Date(r.createdAt).toLocaleString()}</td><td>{r.status}</td><td>{r.prospectsFound}</td><td>{r.messagesQueued}</td><td>{r.errors?.code}</td></tr>)}</tbody></table></div><h2>Outreach queue</h2>{outreach.length > 25 && <p className="muted">Showing the latest 25 of {outreach.length}.</p>}<ul className="recordList">{outreach.slice(0, 25).map(r => <li key={r.id}><strong>{r.contact?.email}</strong> &middot; {r.status} &middot; {r.error}<details><summary>Review message</summary><p>{r.subject ?? r.campaign?.sequenceSteps?.find((s: Row) => s.stepOrder === r.stepOrder)?.subject}</p><pre>{r.body ?? r.campaign?.sequenceSteps?.find((s: Row) => s.stepOrder === r.stepOrder)?.body}</pre></details>{r.status === 'QUEUED' && !r.approvedAt && <button disabled={busy} onClick={() => void mutate('outreach', 'PATCH', { id: r.id })}>Approve send</button>}</li>)}</ul><h2>Replies</h2>{replies.length > 25 && <p className="muted">Showing the latest 25 of {replies.length}.</p>}<ul className="recordList">{replies.slice(0, 25).map(r => <li key={r.id}><strong>{r.intent}</strong><p>{r.rawSnippet}</p><p>{r.recommendedAction}</p><ReplyAi replyId={r.id}/></li>)}</ul></>}
      {section !== 'settings' && rows.length === 0 && <p className="muted">No records yet.</p>}
    </>}
  </>;
}
