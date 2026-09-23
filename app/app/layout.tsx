import { cache } from 'react';
import { cookies } from 'next/headers';
import { sessionCookie, sessionUser } from '../../lib/auth';
import Logo from '../../components/Logo';
import Logout from '../../components/Logout';
import AppNav from '../../components/AppNav';
import AssistantWidget from '../../components/AssistantWidget';
import InstallApp from '../../components/InstallApp';

export const dynamic = 'force-dynamic';

const chromeGate = cache(() => ({ taken: false }));

export default async function Layout({ children }: { children: React.ReactNode }) {
  const user = await sessionUser((await cookies()).get(sessionCookie)?.value);
  if (!user?.tenantId) return children;
  const gate = chromeGate();
  if (gate.taken) return children;
  gate.taken = true;
  return <div className="appShell">
    <aside className="side"><a href="/app" className="brand" aria-label="LeadMelo home"><Logo /></a><AppNav operator={user.role === 'SUPER_ADMIN'} /><div style={{ display: 'grid', gap: 8 }}><InstallApp /><Logout /></div></aside>
    <main id="main" className="main">{children}<AssistantWidget audience="app" /></main>
  </div>;
}
