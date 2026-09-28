'use client';
import { useState } from 'react';
import { LIMIT_LABELS, MOST_POPULAR, PLANS, PUBLIC_PLAN_ORDER, annualMonthlyEquivalent, annualSavingsPercent, formatLimit, usd, type Limits } from '../../lib/plans';

const FEATURE_ROWS: Array<[string, (id: string) => boolean]> = [
  ['Approve-before-send mode', () => true],
  ['Campaign versioning, rollback and cloning', id => id !== 'FREE'],
  ['Copy experiments', id => PLANS[id as keyof typeof PLANS].limits.experiments !== 0],
  ['Daily summary and alerts', () => true],
  ['Two-factor authentication and roles', () => true],
  ['Priority onboarding', id => id === 'SCALE' || id === 'ENTERPRISE'],
  ['Custom contract, DPA and security questionnaire support', id => id === 'ENTERPRISE']
];

export default function PricingPlans() {
  const [annual, setAnnual] = useState(true);
  return <>
    <div className="pricing-head">
      <h1>Simple plans that grow with your outbound</h1>
      <p className="muted" style={{ maxWidth: '60ch', margin: '0 auto' }}>Every plan starts with a free trial. Limits are enforced in the product, so what you see here is what you get.</p>
      <div className="billing-toggle" role="group" aria-label="Billing period">
        <button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>Monthly</button>
        <button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>Annual, save up to {annualSavingsPercent(PLANS.STARTER)}%</button>
      </div>
    </div>
    <div className="plans">
      {PUBLIC_PLAN_ORDER.map(id => {
        const p = PLANS[id], eq = annualMonthlyEquivalent(p);
        return <article key={id} className={`plan${id === MOST_POPULAR ? ' popular' : ''}`} aria-labelledby={`plan-${id}`}>
          {id === MOST_POPULAR && <span className="tag">Most popular</span>}
          <h2 id={`plan-${id}`} style={{ margin: 0, fontSize: 22 }}>{p.name}</h2>
          <p className="muted" style={{ minHeight: 44 }}>{p.tagline}</p>
          {p.monthlyUsd === null ? <div className="price">Custom</div>
            : p.monthlyUsd === 0 ? <div className="price">Free<small> for 14 days</small></div>
            : <>
              <div className="was" aria-hidden={!annual}>{annual ? `${usd(p.monthlyUsd)}/mo monthly` : ''}</div>
              <div className="price">{usd(annual && eq !== null ? eq : p.monthlyUsd)}<small>/month</small></div>
              <p className="muted" style={{ margin: 0, minHeight: 22 }}>{annual ? `Billed ${usd(p.annualUsd!)} a year` : 'Billed monthly'}</p>
            </>}
          <ul>{p.features.map(f => <li key={f}>{f}</li>)}</ul>
          <a className={id === MOST_POPULAR ? 'btn' : 'btn secondary'} href={`/request-access?plan=${id}`}>{p.cta}</a>
        </article>;
      })}
    </div>
    <p className="muted" style={{ textAlign: 'center' }}>Prices are in US dollars and are confirmed when your workspace is set up. Online checkout is not live yet.</p>

    <div className="compare">
      <h2>Compare plans</h2>
      <div className="tableWrap" role="region" aria-label="Plan comparison table" tabIndex={0}>
        <table>
          <caption className="sr-only">Limits and features by plan</caption>
          <thead><tr><th scope="col">Feature</th>{PUBLIC_PLAN_ORDER.map(id => <th scope="col" key={id}>{PLANS[id].name}</th>)}</tr></thead>
          <tbody>
            {(Object.keys(LIMIT_LABELS) as Array<keyof Limits>).map(k => <tr key={k}><th scope="row">{LIMIT_LABELS[k]}</th>{PUBLIC_PLAN_ORDER.map(id => <td key={id}>{formatLimit(PLANS[id].limits[k])}</td>)}</tr>)}
            {FEATURE_ROWS.map(([label, has]) => <tr key={label}><th scope="row">{label}</th>{PUBLIC_PLAN_ORDER.map(id => <td key={id}>{has(id) ? <><span aria-hidden="true">✓</span><span className="sr-only">Included</span></> : <><span aria-hidden="true">–</span><span className="sr-only">Not included</span></>}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </>;
}
