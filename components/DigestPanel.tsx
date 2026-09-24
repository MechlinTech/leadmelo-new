'use client';
import { useEffect, useState } from 'react';
import { api, money } from './api';

type Digest = { activity: Record<string, number>; upcomingMeetings: number; activeCampaigns: number; openAlerts: Record<string, number>; needsAttention: number; spentCentsThisMonth: number; periodStart?: string; periodEnd?: string };
const labels: Record<string, string> = { emailsSent: 'Emails sent', emailsFailed: 'Emails failed', replies: 'Replies', positiveReplies: 'Positive replies', meetingsBooked: 'Meetings booked', meetingsCancelled: 'Meetings cancelled' };
const windows = [[24, 'Last 24 hours'], [168, 'Last 7 days'], [720, 'Last 30 days']] as const;

export default function DigestPanel() {
  const [hours, setHours] = useState(24);
  const [digest, setDigest] = useState<Digest | null>(null), [error, setError] = useState('');
  useEffect(() => { setDigest(null); api<Digest>(`digest?hours=${hours}`).then(setDigest).catch(e => setError((e as Error).message)); }, [hours]);
  if (error) return <p role="alert" className="error">Summary unavailable: {error}</p>;
  if (!digest) return <p role="status" className="muted">Loading summary...</p>;
  const title = windows.find(w => w[0] === hours)?.[1] ?? 'Last 24 hours';
  return <section aria-labelledby="digest-title">
    <div className="toolbar"><h2 id="digest-title">{title}</h2>
      <label>Range <select aria-label="Metrics date range" value={hours} onChange={e => setHours(Number(e.target.value))}>{windows.map(([h, label]) => <option key={h} value={h}>{label}</option>)}</select></label>
    </div>
    <div className="cards">
      <div className="card"><span className="muted">Upcoming meetings</span><strong>{digest.upcomingMeetings}</strong></div>
      <div className="card"><span className="muted">Active campaigns</span><strong>{digest.activeCampaigns}</strong></div>
      <div className={digest.needsAttention ? 'card warn' : 'card'}><span className="muted">Needs attention</span><strong>{digest.needsAttention}</strong>{digest.needsAttention > 0 && <a href="/app/autopilot">Review exceptions</a>}</div>
      <div className="card"><span className="muted">Provider spend this month</span><strong>{money(digest.spentCentsThisMonth)}</strong></div>
      {Object.entries(labels).map(([key, label]) => <div className="card" key={key}><span className="muted">{label}</span><strong>{digest.activity[key] ?? 0}</strong></div>)}
    </div>
    {Object.keys(digest.openAlerts).length > 0 && <p className="muted">Open alerts: {Object.entries(digest.openAlerts).map(([code, n]) => `${code.replaceAll('_', ' ')} (${n})`).join(', ')}</p>}
  </section>;
}
