import type { Metadata } from 'next';
import RequestAccessForm from '../../../components/marketing/RequestAccessForm';
import { PLANS, TRIAL_DAYS, type PlanId } from '../../../lib/plans';

export const metadata: Metadata = { title: 'Request access', description: 'Request a LeadMelo workspace. Our team sets up your account and a free trial.' };

export default async function Page({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan } = await searchParams;
  const initialPlan = plan && plan in PLANS ? (plan as PlanId) : undefined;
  return <div className="container access-form">
    <h1>Request access</h1>
    <p className="muted">LeadMelo is in early access. Tell us a little about you and we will set up a workspace with a {TRIAL_DAYS}-day trial{initialPlan && initialPlan !== 'FREE' ? `, then the ${PLANS[initialPlan].name} plan` : ''}.</p>
    <RequestAccessForm initialPlan={initialPlan} />
  </div>;
}
