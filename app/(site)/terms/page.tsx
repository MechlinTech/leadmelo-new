import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Terms of use' };
export default function Page() {
  return <div className="container">
    <h1>Terms of use</h1>
    <p>LeadMelo is an early-access outbound workspace. Use of the product is by invitation. These terms describe how the software is intended to be used; they are not a substitute for a signed contract or legal advice.</p>
    <h2>What the product does</h2>
    <p>You describe who you want to reach. LeadMelo finds and verifies prospects through providers you connect, sends email you approved, handles replies, and records a meeting only when your calendar confirms a booking.</p>
    <h2>Your responsibilities</h2>
    <ul>
      <li>You supply and verify sender identity and mailbox access.</li>
      <li>You are responsible for lawful outreach in the jurisdictions you target, including consent and unsubscribe handling.</li>
      <li>You must not use the product to send unapproved or deceptive mail.</li>
    </ul>
    <h2>No guaranteed results</h2>
    <p>Meetings, replies and revenue depend on your offer, list quality and market. The software does not guarantee outcomes.</p>
    <p><a href="/">Back to home</a> · <a href="/privacy">Privacy</a></p>
  </div>;
}
