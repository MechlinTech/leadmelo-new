'use client';
import { useEffect, useState } from 'react';
import { api, money } from './api';

type Digest = { activity: Record<string, number>; upcomingMeetings: number; activeCampaigns: number; openAlerts: Record<string, number>; needsAttention: number; spentCentsThisMonth: number };
const labels: Record<string, string> = { emailsSent: 'Emails sent', emailsFailed: 'Emails failed', replies: 'Replies', positiveReplies: 'Positive replies', meetingsBooked: 'Meetings booked', meetingsCancelled: 'Meetings cancelled' };

// Last-24-hours operating summary from saved records only; shows an error, never placeholder numbers.
export default function DigestPanel() {
  const [digest, setDigest] = useState<Digest | null>(null), [error, setError] = useState('');
  useEffect(() => { api<Digest>('digest').then(setDigest).catch(e => setError((e as Error).message)); }, []);
  if (error) return <p role="alert" className="error">Summary unavailable: {error}</p>;
  if (!digest) return <p role="status" className="muted">Loading summary...</p>;
  return <section aria-labelledby="digest-title">
    <h2 id="digest-title">Last 24 hours</h2>
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
