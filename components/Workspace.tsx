'use client';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
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
import EmailPreview from './EmailPreview';
import LeadImport from './LeadImport';
import AutomationRules from './AutomationRules';
import Pager, { pageSlice } from './Pager';
import { api } from './api';
import { userError } from '../lib/userErrors';
import { useAppRole } from './AppRole';

type Row = Record<string, any>;
type Section = 'overview' | 'icps' | 'campaigns' | 'settings' | 'leads' | 'automation-runs';
const list = (form: FormData, key: string) => String(form.get(key) ?? '').split(',').map(v => v.trim()).filter(Boolean);
const value = (form: FormData, key: string) => String(form.get(key) ?? '');
const number = (form: FormData, key: string) => Number(form.get(key));
const FIRST_BODY = 'Hi {{firstName}},\n\nI am reaching out because {{company}} appears relevant to {{offer}}.\n\nWould a short conversation help? {{calendlyUrl}}\n\n{{senderName}}';
const ICP_FIELDS = [['industries', 'Industries'], ['companySizes', 'Company size bands'], ['geographies', 'Countries / regions'], ['technologies', 'Technologies'], ['buyingSignals', 'Buying signals'], ['buyerTitles', 'Buyer titles'], ['exclusionRules', 'Excluded domains, companies or industries']] as const;
const MEETING_WINDOWS = [[0, 'All meetings'], [24, 'Last 24 hours'], [168, 'Last 7 days'], [720, 'Last 30 days']] as const;
function Field({ name, label, type = 'text', initial = '', required = true, step, min, max, minLength, hint }: { name: string; label: string; type?: string; initial?: string | number; required?: boolean; step?: string; min?: number; max?: number; minLength?: number; hint?: string }) {
  return <label>{label}<input className="input" name={name} type={type} step={step} min={min} max={max} minLength={minLength} defaultValue={initial} required={required} onBlur={e => e.currentTarget.reportValidity()} />{hint && <span className="muted">{hint}</span>}</label>;
}
function fillField(name: string, value: string | number) {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`form.editor [name="${name}"]`);
  if (el) el.value = String(value);
}
export default function Workspace({ section }: { section: Section }) {
  const { canWrite, role } = useAppRole();
  const isAdmin = role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';
  const [rows, setRows] = useState<Row[]>([]), [icps, setIcps] = useState<Row[]>([]), [settings, setSettings] = useState<Row | null>(null);
  const [outreach, setOutreach] = useState<Row[]>([]), [replies, setReplies] = useState<Row[]>([]);
  const [campaigns, setCampaigns] = useState<Row[]>([]);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [icpMode, setIcpMode] = useState<'new' | 'existing'>('new');
  const [icpFormKey, setIcpFormKey] = useState(0);
  const [campaignFormKey, setCampaignFormKey] = useState(0);
  const [editingIcpId, setEditingIcpId] = useState<string | null>(null);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [campaignQuery, setCampaignQuery] = useState('');
  const [campaignSort, setCampaignSort] = useState<'newest' | 'name' | 'status'>('newest');
  const [campaignStatus, setCampaignStatus] = useState('all');
  const [campaignPage, setCampaignPage] = useState(1);
  const [leadQuery, setLeadQuery] = useState('');
  const [leadPage, setLeadPage] = useState(1);
  const [meetingPage, setMeetingPage] = useState(1);
  const [icpPage, setIcpPage] = useState(1);
  const [meetingHours, setMeetingHours] = useState(0);
  const [steps, setSteps] = useState([{ id: 1, delay: 0, subject: '', body: FIRST_BODY }]);
  const snapshotSteps = () => steps.map((st, i) => ({
    ...st,
    delay: Number(document.querySelector<HTMLInputElement>(`[name="delay${i}"]`)?.value ?? st.delay),
    subject: document.querySelector<HTMLInputElement>(`[name="subject${i}"]`)?.value ?? st.subject,
    body: document.querySelector<HTMLTextAreaElement>(`[name="body${i}"]`)?.value ?? st.body
  }));
  const applyAi = (sg: Suggestion) => {
    setIcpMode('new');
    setSteps(sg.steps.map((st, i) => ({ id: i + 1, delay: st.waitBusinessDays, subject: st.subject, body: st.body })));
    setTimeout(() => {
      const pre = section === 'icps' ? '' : 'icp_';
      fillField('name', sg.name); fillField('offer', sg.offer); if (section !== 'icps') fillField('icpName', sg.icp.name);
      for (const key of ['industries', 'companySizes', 'geographies', 'technologies', 'buyingSignals', 'buyerTitles', 'exclusionRules']) fillField(pre + key, (sg.icp[key] ?? []).join(', '));
    }, 60);
  };
  const load = useCallback(async () => {
    setError('');
    try {
      if (section === 'settings') setSettings(await api('settings'));
      else if (section === 'overview') {
        setRows(await api(`appointments${meetingHours ? `?hours=${meetingHours}` : ''}`));
        setCampaigns(await api('campaigns'));
      }
      else setRows(await api(section));
      if (section === 'campaigns') setIcps(await api('icps'));
      if (section === 'automation-runs') { setOutreach(await api('outreach')); setReplies(await api('replies')); }
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [section, meetingHours]);
  useEffect(() => { void load(); }, [load]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api(path, method, body);
      setNotice(result.activation?.requested ? result.activation.started ? 'Campaign saved and autopilot started.' : `Campaign saved as draft. ${userError(result.activation.reason)}` : 'Saved');
      await load();
      return true;
    }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  function icpBody(form: FormData, prefix = '') {
    const body: Row = { name: value(form, prefix + 'name'), offer: value(form, prefix + 'offer' || 'offer'), minScore: number(form, prefix + 'minScore'), weeklyAppointmentGoal: number(form, prefix + 'weeklyAppointmentGoal') };
    if (prefix === 'icp_') { body.name = value(form, 'icpName'); body.offer = value(form, 'offer'); }
    for (const key of ['industries', 'companySizes', 'geographies', 'technologies', 'buyingSignals', 'buyerTitles', 'exclusionRules']) body[key] = list(form, prefix + key);
    return body;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (section === 'icps') {
      const body = icpBody(form);
      if (editingIcpId) {
        if (await mutate('icps', 'PATCH', { id: editingIcpId, ...body })) { setNotice(`Updated ICP “${body.name}”.`); setEditingIcpId(null); setIcpFormKey(k => k + 1); }
      } else if (await mutate('icps', 'POST', body)) { setNotice(`Created ICP “${body.name}”.`); setIcpFormKey(k => k + 1); }
    } else if (section === 'campaigns') {
      const body: Row = {};
      for (const key of ['name', 'offer', 'senderName', 'senderEmail', 'calendlyUrl', 'timezone', 'automationMode', 'outcomeType']) body[key] = value(form, key);
      for (const key of ['dailySendCap', 'weeklyProspectCap', 'weeklyAppointmentGoal', 'minScore', 'minAppointmentQualityScore', 'sendStartHour', 'sendEndHour']) body[key] = number(form, key);
      body.holidays = list(form, 'holidays');
      body.sequenceSteps = snapshotSteps().map((st, i) => ({ stepOrder: i + 1, waitBusinessDays: st.delay, subject: st.subject, body: st.body }));
      if (editingCampaignId) {
        body.icpId = value(form, 'icpId');
        if (await mutate(`campaigns/${editingCampaignId}`, 'PUT', body)) {
          setNotice('Campaign updated.');
          setEditingCampaignId(null);
          setIcpMode('new');
          setSteps([{ id: 1, delay: 0, subject: '', body: FIRST_BODY }]);
          setCampaignFormKey(k => k + 1);
        }
      } else {
        body.startImmediately = form.get('startImmediately') === 'on';
        if (icpMode === 'existing') body.icpId = value(form, 'icpId');
        else {
          body.icp = { name: value(form, 'icpName'), offer: body.offer, minScore: body.minScore, weeklyAppointmentGoal: body.weeklyAppointmentGoal };
          for (const key of ['industries', 'companySizes', 'geographies', 'technologies', 'buyingSignals', 'buyerTitles', 'exclusionRules']) body.icp[key] = list(form, `icp_${key}`);
        }
        await mutate('campaigns', 'POST', body);
      }
    } else if (section === 'settings') {
      const body: Row = { automationEnabled: form.get('automationEnabled') === 'on', dailySendCap: number(form, 'dailySendCap'), weeklyProspectCap: number(form, 'weeklyProspectCap'), postalAddress: value(form, 'postalAddress') };
      const companyName = value(form, 'companyName').trim();
      if (companyName) body.companyName = companyName;
      for (const key of ['gatewayKey', 'webhookSecret', 'calendlySigningKey', 'calendlyToken']) if (value(form, key)) body[key] = value(form, key);
      body.calendlyOrganizationUri = value(form, 'calendlyOrganizationUri').trim() || null;
      const dollars = (key: string) => value(form, key).trim() === '' ? null : Math.round(Number(value(form, key)) * 100);
      body.monthlySpendCapCents = dollars('monthlySpendCap');
      body.providerCostCents = dollars('providerCost') ?? 0;
      body.messageRetentionDays = value(form, 'messageRetentionDays').trim() === '' ? null : number(form, 'messageRetentionDays');
      await mutate('settings', 'PUT', body);
    }
  }
  async function submitLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Row = { company: value(form, 'company'), domain: value(form, 'domain') || undefined, contactName: value(form, 'contactName') || undefined, contactEmail: value(form, 'contactEmail') || undefined, signalSummary: value(form, 'signalSummary') || undefined };
    if (value(form, 'score')) body.score = number(form, 'score');
    if (await mutate('leads', 'POST', body)) { setNotice('Prospect added for review.'); event.currentTarget.reset(); }
  }
  async function submitMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Row = { buyerName: value(form, 'buyerName'), buyerEmail: value(form, 'buyerEmail'), scheduledStart: value(form, 'scheduledStart'), notes: value(form, 'notes') || undefined };
    if (value(form, 'campaignId')) body.campaignId = value(form, 'campaignId');
    if (await mutate('appointments', 'POST', body)) { setNotice('Meeting recorded.'); event.currentTarget.reset(); }
  }
  function beginEditIcp(r: Row) {
    setEditingIcpId(r.id);
    setIcpFormKey(k => k + 1);
  }
  function beginEditCampaign(r: Row) {
    setEditingCampaignId(r.id);
    setIcpMode('existing');
    const sorted = [...(r.sequenceSteps ?? [])].sort((a: Row, b: Row) => a.stepOrder - b.stepOrder);
    setSteps(sorted.length ? sorted.map((s: Row, i: number) => ({ id: i + 1, delay: s.waitBusinessDays, subject: s.subject ?? '', body: s.body ?? '' })) : [{ id: 1, delay: 0, subject: '', body: FIRST_BODY }]);
    setCampaignFormKey(k => k + 1);
  }
  function cancelCampaignEdit() {
    setEditingCampaignId(null);
    setIcpMode('new');
    setSteps([{ id: 1, delay: 0, subject: '', body: FIRST_BODY }]);
    setCampaignFormKey(k => k + 1);
  }
  const editingIcp = rows.find(r => r.id === editingIcpId);
  const editingCampaign = rows.find(r => r.id === editingCampaignId);
  const visibleCampaigns = useMemo(() => {
    const q = campaignQuery.trim().toLowerCase();
    const filtered = rows.filter(r => (campaignStatus === 'all' || r.status === campaignStatus) && (!q || [r.name, r.icp?.name, r.status, r.senderEmail].some(v => String(v ?? '').toLowerCase().includes(q))));
    return filtered.slice().sort((a, b) => {
      if (campaignSort === 'name') return String(a.name).localeCompare(String(b.name));
      if (campaignSort === 'status') return String(a.status).localeCompare(String(b.status)) || String(a.name).localeCompare(String(b.name));
      return 0;
    });
  }, [rows, campaignQuery, campaignSort, campaignStatus]);
  const campaignPageData = pageSlice(visibleCampaigns, campaignPage, 10);
  const visibleLeads = useMemo(() => {
    const q = leadQuery.trim().toLowerCase();
    return rows.filter(r => !q || [r.company, r.contactName, r.contactEmail, r.domain, r.qualification].some(v => String(v ?? '').toLowerCase().includes(q)));
  }, [rows, leadQuery]);
  const leadPageData = pageSlice(visibleLeads, leadPage, 10);
  const meetingPageData = pageSlice(rows, meetingPage, 10);
  const icpPageData = pageSlice(rows, icpPage, 10);
  const title = { overview: 'Meetings', icps: 'Ideal customer profiles', campaigns: 'Campaigns', settings: 'Workspace settings', leads: 'Prospects', 'automation-runs': 'Automation & exceptions' }[section];
  return <>
    <div className="toolbar"><h1>{title}</h1><button onClick={() => void load()} disabled={loading || busy}>Refresh</button></div>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading...</p> : <>
      {section === 'overview' && <DigestPanel/>}
      {section === 'settings' && <><PlanUsagePanel/><AppearanceSettings/><AiSettings/><MicrosoftSettings/><SecuritySettings/><TeamMembers/><PrivacyTools/></>}
      {section === 'automation-runs' && <OperationalAlerts/>}
      {section === 'overview' && <>
        <div className="toolbar">
          <p>{rows.filter(r => r.qualified && r.status === 'BOOKED').length} qualified booked meetings in this view.</p>
          <label>Show <select aria-label="Meeting date range" value={meetingHours} onChange={e => { setMeetingHours(Number(e.target.value)); setMeetingPage(1); }}>{MEETING_WINDOWS.map(([h, label]) => <option key={h} value={h}>{label}</option>)}</select></label>
        </div>
        <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><thead><tr><th>Buyer</th><th>Campaign</th><th>Time</th><th>Status</th><th>Qualification</th><th>Outcome</th></tr></thead><tbody>{meetingPageData.slice.map(r => <tr key={r.id}><td>{r.contact?.fullName}<br/>{r.contact?.email}</td><td>{r.campaign?.name}</td><td>{r.scheduledStart ? new Date(r.scheduledStart).toLocaleString() : 'Pending'}</td><td>{r.status}</td><td>{r.qualified ? 'Qualified' : <><span>Review required</span>{canWrite && r.status === 'BOOKED' && <button disabled={busy} onClick={() => void mutate('appointments', 'PATCH', { id: r.id, qualified: true, outcomeReason: 'Buyer, need and ICP evidence reviewed by meeting owner' })}>Approve</button>}</>}</td><td>{canWrite ? <select aria-label="Record meeting outcome" defaultValue="" disabled={busy || r.status === 'CANCELED'} onChange={e => { if (e.target.value) void mutate('appointments', 'PATCH', { id: r.id, status: e.target.value, outcomeReason: 'Recorded by meeting owner' }); }}><option value="">Record outcome</option>{['COMPLETED', 'NO_SHOW', 'DISQUALIFIED', 'WON', 'LOST'].map(v => <option key={v}>{v}</option>)}</select> : '—'}</td></tr>)}</tbody></table></div>
        <Pager page={meetingPageData.page} pages={meetingPageData.pages} total={meetingPageData.total} label="meetings" onPage={setMeetingPage}/>
        {canWrite && <><h2>Record a meeting</h2><p className="muted">Use this for a booking that arrived outside Calendly, or to verify the meetings table.</p>
        <form className="editor" onSubmit={submitMeeting}><div className="formGrid">
          <Field name="buyerName" label="Buyer name"/>
          <Field name="buyerEmail" label="Buyer email" type="email"/>
          <Field name="scheduledStart" label="Start time" type="datetime-local"/>
          <label>Campaign (optional)<select name="campaignId" defaultValue=""><option value="">None</option>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <Field name="notes" label="Notes (optional)" required={false}/>
        </div><button disabled={busy}>Record meeting</button></form></>}
      </>}
      {section === 'icps' && <><ul className="recordList">{icpPageData.slice.map(r => <li key={r.id}><strong>{r.name}</strong> &middot; {r.offer}{r.active === false && <span className="pill">Inactive</span>}<p>{(r.geographies ?? []).join(', ')} &middot; Minimum score {r.minScore}{r.weeklyAppointmentGoal != null && <> &middot; Weekly goal {r.weeklyAppointmentGoal}</>}</p><p className="muted">Industries: {(r.industries ?? []).join(', ') || '—'}. Sizes: {(r.companySizes ?? []).join(', ') || '—'}. Titles: {(r.buyerTitles ?? []).join(', ') || '—'}. Signals: {(r.buyingSignals ?? []).join(', ') || '—'}. Technologies: {(r.technologies ?? []).join(', ') || '—'}. Exclusions: {(r.exclusionRules ?? []).join(', ') || '—'}.</p>{canWrite && <div className="toolbar"><button type="button" className="secondary" disabled={busy} onClick={() => beginEditIcp(r)}>Edit</button><button type="button" className="secondary" disabled={busy} onClick={() => void mutate('icps', 'POST', { duplicateFrom: r.id }).then(ok => { if (ok) setNotice(`Duplicated “${r.name}”.`); })}>Duplicate</button><button type="button" className="secondary" disabled={busy} onClick={() => { if (window.confirm(`Remove “${r.name}”? Campaigns that use it will keep a deactivated copy.`)) void mutate(`icps?id=${encodeURIComponent(r.id)}`, 'DELETE').then(ok => { if (ok) setNotice('ICP removed.'); }); }}>Delete</button></div>}</li>)}</ul>
        <h2>{editingIcpId ? 'Edit ICP' : 'Create ICP'}</h2>
        {canWrite ? <><AiAssist onApply={applyAi}/>
        <form key={icpFormKey} onSubmit={submit} className="editor"><div className="formGrid">
          <Field name="name" label="Profile name" initial={editingIcp?.name ?? ''}/>
          <Field name="offer" label="Offer" initial={editingIcp?.offer ?? ''}/>
          {ICP_FIELDS.map(([name, label]) => <Field key={name} name={name} label={`${label} (comma separated)`} initial={(editingIcp?.[name] ?? []).join(', ')} required={!['technologies', 'exclusionRules'].includes(name)}/>)}
          <Field name="minScore" label="Minimum fit score" type="number" initial={editingIcp?.minScore ?? 75} min={50} max={100} hint="50 to 100"/>
          <Field name="weeklyAppointmentGoal" label="Weekly meeting goal" type="number" initial={editingIcp?.weeklyAppointmentGoal ?? 5} min={1}/>
        </div>
        <div className="toolbar"><button disabled={busy}>{editingIcpId ? 'Save ICP' : 'Create ICP'}</button>{editingIcpId && <button type="button" className="secondary" onClick={() => { setEditingIcpId(null); setIcpFormKey(k => k + 1); }}>Cancel edit</button>}</div>
        </form></> : <p className="muted">Members can view profiles. Ask an administrator to create one.</p>}
        <Pager page={icpPageData.page} pages={icpPageData.pages} total={icpPageData.total} label="profiles" onPage={setIcpPage}/>
      </>}
      {section === 'campaigns' && <>
        <p><a href="/app/experiments">Copy experiments (A/B tests)</a></p>
        <div className="toolbar">
          <label>Search <input className="input" aria-label="Search campaigns" value={campaignQuery} onChange={e => { setCampaignQuery(e.target.value); setCampaignPage(1); }} placeholder="Name, ICP, sender"/></label>
          <label>Status <select aria-label="Filter campaigns by status" value={campaignStatus} onChange={e => { setCampaignStatus(e.target.value); setCampaignPage(1); }}><option value="all">All</option><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option><option value="COMPLETE">Complete</option></select></label>
          <label>Sort <select aria-label="Sort campaigns" value={campaignSort} onChange={e => { setCampaignSort(e.target.value as typeof campaignSort); setCampaignPage(1); }}><option value="newest">Newest</option><option value="name">Name</option><option value="status">Status</option></select></label>
        </div>
        <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><thead><tr><th>Campaign</th><th>ICP</th><th>Status</th><th>Mode</th><th>Goal</th><th>Control</th></tr></thead><tbody>{campaignPageData.slice.map(r => <tr key={r.id}><td>{r.name}</td><td>{r.icp?.name}</td><td>{r.status}</td><td>{r.automationMode.replaceAll('_', ' ').toLowerCase()}</td><td>{r.weeklyAppointmentGoal}/week</td><td>{canWrite ? <><button disabled={busy} onClick={() => void mutate('campaigns', 'PATCH', { id: r.id, status: r.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>{r.status === 'ACTIVE' ? 'Pause' : 'Activate'}</button><button type="button" className="secondary" disabled={busy} onClick={() => beginEditCampaign(r)}>Edit</button></> : <span className="muted">View only</span>}<CampaignHistory id={r.id} name={r.name} onChanged={() => void load()}/></td></tr>)}</tbody></table></div>
        <Pager page={campaignPageData.page} pages={campaignPageData.pages} total={campaignPageData.total} label="campaigns" onPage={setCampaignPage}/>
        <h2>{editingCampaignId ? 'Edit campaign' : 'Create self-running campaign'}</h2>
        {!canWrite && <p className="muted">Members can view campaigns. Creating or starting one requires a manager or administrator.</p>}
        {canWrite && <><AiAssist onApply={applyAi}/>
        <form key={campaignFormKey} className="editor" onSubmit={submit}>
          <div className="formGrid">
            <Field name="name" label="Campaign name" initial={editingCampaign?.name ?? ''}/>
            <Field name="offer" label="Offer / outcome promised" initial={editingCampaign?.offer ?? ''}/>
            {!editingCampaignId && <label>ICP setup<select value={icpMode} onChange={e => setIcpMode(e.target.value as 'new' | 'existing')}><option value="new">Define ICP in this campaign</option>{icps.length > 0 && <option value="existing">Use an existing ICP</option>}</select></label>}
            {(editingCampaignId || icpMode === 'existing') && <label>Existing ICP<select name="icpId" defaultValue={editingCampaign?.icpId}>{icps.filter(r => r.active !== false || r.id === editingCampaign?.icpId).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
            <Field name="senderName" label="Sender name" initial={editingCampaign?.senderName ?? ''}/>
            <Field name="senderEmail" label="Connected sender email" type="email" initial={editingCampaign?.senderEmail ?? ''}/>
            <Field name="calendlyUrl" label="Tenant booking link" type="url" initial={editingCampaign?.calendlyUrl ?? ''}/>
            <Field name="timezone" label="IANA timezone" initial={editingCampaign?.timezone ?? 'America/Los_Angeles'}/>
            <Field name="holidays" label="No-send holidays, YYYY-MM-DD, comma separated (optional)" required={false} initial={(editingCampaign?.holidays ?? []).join(', ')}/>
            <label>Automation mode<select name="automationMode" defaultValue={editingCampaign?.automationMode ?? 'REVIEW_BEFORE_SEND'}><option value="FULLY_AUTOMATIC">Fully automatic</option><option value="REVIEW_BEFORE_SEND">Review messages first</option><option value="REVIEW_BEFORE_BOOKING">Automatic outreach, review meeting qualification</option></select></label>
            <label>Campaign outcome<select name="outcomeType" defaultValue={editingCampaign?.outcomeType ?? 'APPOINTMENT_BOOKED'}><option value="APPOINTMENT_BOOKED">Booked appointment</option><option value="QUALIFIED_OPPORTUNITY">Qualified opportunity</option></select></label>
            {!editingCampaignId && icpMode === 'new' && <>
              <Field name="icpName" label="ICP name"/>
              {ICP_FIELDS.map(([name, label]) => <Field key={name} name={`icp_${name}`} label={`${label} (comma separated)`} required={!['technologies', 'exclusionRules'].includes(name)}/>)}
            </>}
            {([['dailySendCap', 'Daily email cap', editingCampaign?.dailySendCap ?? 25, 1, 10000], ['weeklyProspectCap', 'Weekly prospect cap', editingCampaign?.weeklyProspectCap ?? 50, 1, 100000], ['weeklyAppointmentGoal', 'Weekly appointment goal', editingCampaign?.weeklyAppointmentGoal ?? 5, 1, 1000], ['minScore', 'Minimum ICP score', editingCampaign?.minScore ?? 75, 50, 100], ['minAppointmentQualityScore', 'Minimum appointment quality', editingCampaign?.minAppointmentQualityScore ?? 80, 0, 100], ['sendStartHour', 'Send from hour (0-23)', editingCampaign?.sendStartHour ?? 9, 0, 23], ['sendEndHour', 'Send until hour (1-24)', editingCampaign?.sendEndHour ?? 17, 1, 24]] as const).map(([name, label, initial, min, max]) => <Field key={name} name={name} label={label} initial={initial} type="number" min={min} max={max}/>)}
          </div>
          <h3>Automatic email sequence</h3>
          {steps.map((st, i) => <fieldset key={st.id}><legend>Email {i + 1}</legend><Field name={`delay${i}`} label="Wait business days after previous email" type="number" initial={st.delay} min={0}/><label>Subject<input className="input" name={`subject${i}`} required defaultValue={st.subject} onChange={e => setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, subject: e.target.value } : s))}/></label><label>Message<textarea name={`body${i}`} required rows={5} defaultValue={st.body} onChange={e => setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, body: e.target.value } : s))}/></label><EmailPreview subject={st.subject} body={st.body}/>{i > 0 && <div className="toolbar"><button type="button" className="secondary" onClick={() => setSteps(snapshotSteps().filter((_, idx) => idx !== i))}>Remove this follow-up</button><button type="button" className="secondary" onClick={() => { const n = snapshotSteps(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; setSteps(n); }}>Move up</button>{i < steps.length - 1 && <button type="button" className="secondary" onClick={() => { const n = snapshotSteps(); [n[i], n[i + 1]] = [n[i + 1], n[i]]; setSteps(n); }}>Move down</button>}</div>}</fieldset>)}
          {!editingCampaignId && <label><input type="checkbox" name="startImmediately"/> Start the autonomous campaign immediately when all safety and integration checks pass</label>}
          <div className="toolbar"><button type="button" disabled={steps.length >= 10} onClick={() => setSteps([...snapshotSteps(), { id: Date.now(), delay: 3, subject: '', body: '' }])}>Add follow-up</button><button disabled={busy}>{editingCampaignId ? 'Save campaign' : 'Create campaign'}</button>{editingCampaignId && <button type="button" className="secondary" onClick={cancelCampaignEdit}>Cancel edit</button>}</div>
        </form></>}
      </>}
      {section === 'settings' && settings && <form key={String(settings.automationEnabled) + settings.postalAddress + settings.companyName} className="editor" onSubmit={submit} aria-labelledby="workspace-settings-title"><h2 id="workspace-settings-title">Workspace sending and integrations</h2><p>Gateway: {settings.gatewayConfigured ? 'Configured' : 'Not connected'}. Webhooks: {settings.webhookConfigured ? 'Configured' : 'Not connected'}. Calendly: {settings.calendlyConfigured ? 'Signing key set' : 'Not connected'}{settings.calendlyReconcileConfigured ? `, missed-booking recovery on${settings.calendlyReconciledAt ? ` (last run ${new Date(settings.calendlyReconciledAt).toLocaleString()})` : ''}` : ''}. Sending: {settings.outboundEnabled ? 'Enabled by operator' : 'Disabled by operator'}.</p><label><input type="checkbox" name="automationEnabled" defaultChecked={settings.automationEnabled} disabled={!isAdmin}/> Enable tenant automation</label><div className="formGrid"><Field name="companyName" label="Company / workspace name" initial={settings.companyName ?? ''} minLength={2} hint="Shown to your team and on legal pages"/><Field name="dailySendCap" label="Tenant daily email cap" type="number" initial={settings.dailySendCap} min={1} hint="At least 1"/><Field name="weeklyProspectCap" label="Tenant weekly prospect cap" type="number" initial={settings.weeklyProspectCap} min={1}/><Field name="postalAddress" label="Business postal address" initial={settings.postalAddress} minLength={10} hint="Full street address, at least 10 characters"/><Field name="gatewayKey" label="Replace gateway credential" type="password" required={false}/><Field name="webhookSecret" label="Replace webhook signing secret" type="password" required={false}/><Field name="calendlySigningKey" label="Replace Calendly webhook signing key" type="password" required={false}/><Field name="calendlyToken" label="Calendly access token for missed-booking recovery (read-only use)" type="password" required={false}/><Field name="calendlyOrganizationUri" label="Calendly organization URI (https://api.calendly.com/organizations/...)" initial={settings.calendlyOrganizationUri ?? ''} required={false}/><Field name="monthlySpendCap" label="Monthly provider spend cap in USD (blank = no cap)" type="number" step="0.01" initial={settings.monthlySpendCapCents === null || settings.monthlySpendCapCents === undefined ? '' : settings.monthlySpendCapCents / 100} required={false}/><Field name="providerCost" label="Cost per discovered prospect in USD" type="number" step="0.01" initial={(settings.providerCostCents ?? 0) / 100} required={false}/><Field name="messageRetentionDays" label="Redact message text and replies after N days (30 or more; blank = keep)" type="number" initial={settings.messageRetentionDays ?? ''} required={false} min={30}/></div><p className="muted">Spend caps only limit what the discovery step buys; they need a cost per prospect above zero to take effect.</p>{isAdmin ? <button disabled={busy}>Save settings</button> : <p className="muted">Only a workspace administrator can save these settings.</p>}</form>}
      {section === 'leads' && <><p className="muted">Prospects appear after a running campaign discovers them, or when someone on the workspace adds or imports them for review.</p>
        {canWrite && <><form className="editor" onSubmit={submitLead}><h2>Add a prospect</h2><div className="formGrid">
          <Field name="company" label="Company"/>
          <Field name="domain" label="Domain (optional)" required={false}/>
          <Field name="contactName" label="Contact name (optional)" required={false}/>
          <Field name="contactEmail" label="Contact email (optional)" type="email" required={false}/>
          <Field name="signalSummary" label="Why they fit (optional)" required={false}/>
          <Field name="score" label="Score 0–100 (optional)" type="number" min={0} max={100} required={false}/>
        </div><button disabled={busy}>Add prospect</button></form>
        <LeadImport onImported={() => { setLeadPage(1); void load(); }}/></>}
        <div className="toolbar"><label>Search <input className="input" aria-label="Search prospects" value={leadQuery} onChange={e => { setLeadQuery(e.target.value); setLeadPage(1); }} placeholder="Company, name, email"/></label></div>
        <div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><thead><tr><th>Company</th><th>Score</th><th>Qualification</th><th>Signal</th><th>Source</th></tr></thead><tbody>{leadPageData.slice.map(r => <tr key={r.id}><td>{r.company}{r.contactName && <><br/>{r.contactName}</>}{r.contactEmail && <><br/>{r.contactEmail}</>}</td><td>{r.score}</td><td>{r.qualification}</td><td>{r.signalSummary}</td><td>{r.source && /^https?:\/\//.test(r.source) ? <a href={r.source} rel="noreferrer" target="_blank">Evidence</a> : r.source || '—'}</td></tr>)}</tbody></table></div>
        <Pager page={leadPageData.page} pages={leadPageData.pages} total={leadPageData.total} label="prospects" onPage={setLeadPage}/>
      </>}
      {section === 'automation-runs' && <><AutomationRules/>
        <h2>Runs</h2><div className="tableWrap" tabIndex={0} role="region" aria-label="Data table"><table><thead><tr><th>Run</th><th>Status</th><th>Discovered</th><th>Queued</th><th>Error</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{new Date(r.createdAt).toLocaleString()}</td><td>{r.status}</td><td>{r.prospectsFound}</td><td>{r.messagesQueued}</td><td>{r.errors?.code}</td></tr>)}</tbody></table></div>
        <h2>Outreach queue</h2>{outreach.length > 25 && <p className="muted">Showing the latest 25 of {outreach.length}.</p>}<ul className="recordList">{outreach.slice(0, 25).map(r => <li key={r.id}><strong>{r.contact?.email}</strong> &middot; {r.status} &middot; {r.error}<details><summary>Review message</summary><p>{r.subject ?? r.campaign?.sequenceSteps?.find((s: Row) => s.stepOrder === r.stepOrder)?.subject}</p><pre>{r.body ?? r.campaign?.sequenceSteps?.find((s: Row) => s.stepOrder === r.stepOrder)?.body}</pre></details>{canWrite && r.status === 'QUEUED' && !r.approvedAt && <button disabled={busy} onClick={() => void mutate('outreach', 'PATCH', { id: r.id })}>Approve send</button>}</li>)}</ul>
        <h2>Replies</h2><p className="muted">Replies are classified automatically. Use the buttons when a person needs to qualify, suppress or dismiss one.</p>{replies.length > 25 && <p className="muted">Showing the latest 25 of {replies.length}.</p>}<ul className="recordList">{replies.slice(0, 25).map(r => <li key={r.id}><strong>{r.intent}</strong><p>{r.rawSnippet}</p><p>{r.recommendedAction}</p><ReplyAi replyId={r.id}/>{canWrite && <div className="toolbar"><button type="button" disabled={busy} onClick={() => void mutate('replies', 'PATCH', { id: r.id, action: 'qualify' })}>Mark positive</button><button type="button" className="secondary" disabled={busy} onClick={() => void mutate('replies', 'PATCH', { id: r.id, action: 'suppress' })}>Suppress sender</button><button type="button" className="secondary" disabled={busy} onClick={() => void mutate('replies', 'PATCH', { id: r.id, action: 'dismiss' })}>Dismiss</button></div>}</li>)}</ul></>}
      {section !== 'settings' && rows.length === 0 && <p className="muted">No records yet.</p>}
    </>}
  </>;
}
