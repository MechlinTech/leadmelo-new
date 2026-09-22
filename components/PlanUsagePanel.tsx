'use client';
import { useEffect, useState } from 'react';
import { LIMIT_LABELS, formatLimit, type Limits } from '../lib/plans';
import { api } from './api';

type PlanInfo = { plan: string; name: string; enforced: boolean; trialDaysLeft: number | null; trialExpired: boolean; limits: Limits; usage: Limits };

export default function PlanUsagePanel() {
  const [info, setInfo] = useState<PlanInfo | null>(null), [error, setError] = useState('');
  useEffect(() => { api<PlanInfo>('plan').then(setInfo).catch(e => setError((e as Error).message)); }, []);
  if (error) return <p role="alert" className="error">Plan information unavailable: {error}</p>;
  if (!info) return <p role="status" className="muted">Loading plan…</p>;
  return <section aria-labelledby="plan-title">
    <h2 id="plan-title">Plan and usage</h2>
    <p><span className="pill">{info.name}</span> {info.trialDaysLeft !== null && <span className="muted"> {info.trialExpired ? 'Trial ended.' : `${info.trialDaysLeft} day${info.trialDaysLeft === 1 ? '' : 's'} left in the trial.`}</span>}</p>
    {!info.enforced && <p className="notice">Plan limits are not enforced on this installation, so nothing is blocked. The numbers below show usage against this plan's limits for reference.</p>}
    {info.trialExpired && info.enforced && <p role="alert" className="error">Your trial has ended. Sending and discovery are paused until your plan is upgraded. <a href="/request-access">Contact us</a>.</p>}
    <div className="cards">
      {(Object.keys(LIMIT_LABELS) as Array<keyof Limits>).map(k => {
        const used = info.usage[k], limit = info.limits[k], pct = limit === -1 ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
        return <div className="card" key={k}>
          <span className="muted">{LIMIT_LABELS[k]}</span>
          <strong>{used.toLocaleString('en-US')} <span className="muted" style={{ fontSize: 15, fontWeight: 500 }}>/ {formatLimit(limit)}</span></strong>
          {limit !== -1 && <div className="meter" role="progressbar" aria-label={`${LIMIT_LABELS[k]} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></div>}
        </div>;
      })}
    </div>
    <p><a href="/pricing">Compare plans</a></p>
  </section>;
}
