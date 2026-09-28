import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Privacy' };
export default function Page() {
  return <div className="container">
    <h1>Privacy</h1>
    <p>LeadMelo stores workspace data you enter or that connected providers return: users, campaigns, prospects, email content, replies and calendar-confirmed meetings. This page describes the product’s data handling. It is not a formal privacy notice or DPA.</p>
    <h2>What is stored</h2>
    <ul>
      <li>Account and role information for people in your workspace.</li>
      <li>Campaign copy, ICP criteria, prospect and meeting records.</li>
      <li>Encrypted secrets for mail, calendar and data-provider connections.</li>
    </ul>
    <h2>Your controls</h2>
    <p>A workspace administrator can export or erase tenant data from Settings → Privacy requests. Message text can be redacted after a retention period you set. Session cookies are HttpOnly.</p>
    <h2>Hosting</h2>
    <p>Data lives in the database of the installation you deploy. LeadMelo does not sell prospect lists. Outbound email uses the mailbox you connect.</p>
    <p><a href="/">Back to home</a> · <a href="/terms">Terms of use</a></p>
  </div>;
}
