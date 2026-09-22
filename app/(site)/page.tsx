import { PLANS, TRIAL_DAYS } from '../../lib/plans';

const steps = [
  ['Describe who you want', 'Pick industries, company sizes, regions, buyer titles and a "hiring" signal. Reuse the profile across campaigns.'],
  ['Find and verify', 'LeadMelo searches through your data provider, checks each email with an independent verifier and skips anyone suppressed or already contacted.'],
  ['Send with guardrails', 'Your approved first email and timed follow-ups go out from your Microsoft 365 mailbox within daily caps, business hours and holidays.'],
  ['Handle the reply', 'Any reply stops the sequence. Clear opt-outs are suppressed forever; clear interest gets your booking link; everything unclear waits for a person.'],
  ['Meeting confirmed', 'A meeting is recorded only when Calendly confirms the buyer booked a time. Cancellations update it.'],
  ['Learn what works', 'Test subject lines and copy against each other, with a winner only when the numbers justify it and a person approves.']
];
const features = [
  ['Campaign autopilot', 'Discovery, qualification, sending, follow-ups and reply handling run as one durable loop, not a pile of manual steps.'],
  ['Review or run automatic', 'Approve every message first, run fully automatic, or automate outreach and review meeting qualification. Edits create versions and revoke old approvals.'],
  ['Only real meetings', 'Positive replies and link clicks are never counted as meetings. Only a calendar-confirmed booking is.'],
  ['Deliverability guardrails', 'Bounce and complaint monitoring, SPF and DMARC checks, gradual volume ramp, per-day caps and automatic sender blocking.'],
  ['Conservative reply handling', 'Rule-based and deliberately cautious: uncertain replies, questions, referrals and bounce notices go to a human, never to a guess.'],
  ['Versioning and rollback', 'Every material change is a version. Restore an earlier one, or clone a campaign as a draft.'],
  ['Copy experiments', 'Test alternative subject and body copy with stable assignment, minimum samples and an unsubscribe guard.'],
  ['Team, security and privacy', 'Roles, two-factor authentication, tenant isolation, encrypted secrets, data export and erasure on request.'],
  ['Mobile-ready and installable', 'Works on phones and tablets, installs to your home screen, and never stores your data offline. Six themes, contrast-checked.']
];

export default function Page() {
  return <>
    <div className="container">
      <section className="hero" aria-labelledby="hero-title">
        <div>
          <span className="badge">Early access</span>
          <h1 id="hero-title">Outbound that finds the buyer, sends the email and books the meeting</h1>
          <p className="lead">Describe your ideal customer once. LeadMelo finds and verifies matching prospects, sends your approved emails and follow-ups, handles replies safely, and records a meeting only when your calendar confirms the buyer booked it.</p>
          <div className="hero-actions">
            <a className="btn" href="/request-access">Request access</a>
            <a className="btn secondary" href="/pricing">See pricing</a>
          </div>
          <p className="muted" style={{ marginTop: 14 }}>{TRIAL_DAYS}-day trial. No promise of results: outcomes depend on your offer, market and list quality.</p>
        </div>
        <div className="panel" aria-label="The autopilot loop">
          <h2 style={{ marginTop: 0, fontSize: 20 }}>The autopilot loop</h2>
          <ol className="flow">{steps.slice(0, 5).map(([t], i) => <li key={t}><span className="n" aria-hidden="true">{i + 1}</span><span>{t}</span></li>)}</ol>
        </div>
      </section>
    </div>

    <section id="how-it-works" className="section" aria-labelledby="how-title">
      <div className="container">
        <h2 id="how-title" style={{ marginTop: 0 }}>How it works</h2>
        <div className="grid3">{steps.map(([t, d], i) => <div className="feature" key={t}><h3><span className="pill">{i + 1}</span> {t}</h3><p className="muted" style={{ margin: 0 }}>{d}</p></div>)}</div>
      </div>
    </section>

    <section id="features" className="section" aria-labelledby="feat-title">
      <div className="container">
        <h2 id="feat-title" style={{ marginTop: 0 }}>Built for teams that need control, not just volume</h2>
        <div className="grid3">{features.map(([t, d]) => <div className="feature" key={t}><h3>{t}</h3><p className="muted" style={{ margin: 0 }}>{d}</p></div>)}</div>
      </div>
    </section>

    <section className="section" aria-labelledby="honest-title">
      <div className="container grid2">
        <div className="panel">
          <h2 id="honest-title" style={{ marginTop: 0 }}>What LeadMelo does not do</h2>
          <ul>
            <li>It does not guarantee meetings, replies or revenue.</li>
            <li>It does not sell you a contact list: you connect your own data provider.</li>
            <li>It does not negotiate with buyers; ambiguous replies go to a person.</li>
            <li>It does not count interest or clicks as meetings.</li>
            <li>It is not legal advice or a certified compliance product.</li>
          </ul>
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Where it fits today</h2>
          <p>Microsoft 365 mailboxes and Calendly bookings are built in. Apollo and Hunter connect through a reference gateway (bring your own accounts). Google Workspace mailboxes are not supported yet.</p>
          <p className="notice" style={{ marginBottom: 0 }}><strong>Early access.</strong> LeadMelo is heavily tested but has not yet been run against live Microsoft, Calendly, Apollo or Hunter accounts. Start with small volumes and review-first sending.</p>
        </div>
      </div>
    </section>

    <section className="section" aria-labelledby="cta-title">
      <div className="container">
        <div className="panel" style={{ textAlign: 'center', padding: '36px 20px' }}>
          <h2 id="cta-title" style={{ marginTop: 0 }}>Try it on one campaign</h2>
          <p className="muted">Plans start at {PLANS.STARTER.monthlyUsd !== null ? `$${PLANS.STARTER.monthlyUsd}` : ''} a month after a free {TRIAL_DAYS}-day trial. Our team sets up your workspace.</p>
          <div className="hero-actions" style={{ justifyContent: 'center' }}><a className="btn" href="/request-access">Request access</a><a className="btn secondary" href="/pricing">Compare plans</a></div>
        </div>
      </div>
    </section>
  </>;
}
