import type { Metadata } from 'next';
import Workspace from '../../../components/Workspace';
export const metadata: Metadata = { title: 'Automation' };
export default function Page() { return <Workspace section="automation-runs"/>; }
