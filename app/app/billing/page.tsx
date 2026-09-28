import { redirect } from 'next/navigation';
// Paid checkout is not live. Plan, limits and usage are shown under Settings.
export default function Page() { redirect('/app/settings'); }
