import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { sessionCookie, sessionUser } from '../../../lib/auth';
import OperatorConsole from '../../../components/OperatorConsole';

export const metadata: Metadata = { title: 'Operator console' };
export const dynamic = 'force-dynamic';
export default async function Page() {
  const user = await sessionUser((await cookies()).get(sessionCookie)?.value);
  if (user?.role !== 'SUPER_ADMIN') redirect('/app');
  return <><h1>Operator console</h1><p className="muted">Platform-level controls. Visible to platform administrators only.</p><OperatorConsole /></>;
}
