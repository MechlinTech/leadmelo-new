import type { Metadata } from 'next';
import PricingPlans from '../../../components/marketing/PricingPlans';
import { ENTRIES } from '../../../lib/assistant/knowledge';

export const metadata: Metadata = { title: 'Pricing', description: 'LeadMelo plans: a free trial, then Starter, Growth, Scale and Enterprise, with limits enforced in the product.' };
const FAQ_IDS = ['trial', 'payment', 'limits-what', 'guarantee', 'email-providers', 'sources', 'security', 'hosting', 'status'];

export default function Page() {
  // The FAQ reuses the assistant's knowledge base so the page and the chatbot can never disagree.
  const faq = FAQ_IDS.map(id => ENTRIES.find(e => e.id === id)!).filter(Boolean);
  return <div className="container">
    <PricingPlans />
    <section id="faq" className="faq section" aria-labelledby="faq-title">
      <h2 id="faq-title" style={{ marginTop: 0 }}>Frequently asked questions</h2>
      {faq.map(e => <details key={e.id}><summary>{e.title}</summary><p>{e.answer}</p></details>)}
      <p className="muted">Not answered here? Ask the assistant in the corner, or <a href="/request-access">contact the team</a>.</p>
    </section>
  </div>;
}
