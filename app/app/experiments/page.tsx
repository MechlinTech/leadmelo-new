import type { Metadata } from 'next';
import ExperimentsPanel from '../../../components/ExperimentsPanel';

export const metadata: Metadata = { title: 'Experiments' };
export default function Page() {
  return <><div className="toolbar"><h1>Copy experiments</h1><a className="btn secondary" href="/app/campaigns">Back to campaigns</a></div><ExperimentsPanel /></>;
}
