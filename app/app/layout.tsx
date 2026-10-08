import { cache } from 'react';
import { cookies } from 'next/headers';
import { sessionCookie, sessionUser } from '../../lib/auth';
import Logo from '../../components/Logo';
import Logout from '../../components/Logout';
import AppNav from '../../components/AppNav';
import AssistantWidget from '../../components/AssistantWidget';
import InstallApp from '../../components/InstallApp';
import { AppRoleProvider } from '../../components/AppRole';
import ThemeBoot from '../../components/ThemeBoot';

export const dynamic = 'force-dynamic';



export default async function Layout({ children }: { children: React.ReactNode }) {
  const user = await sessionUser((await cookies()).get(sessionCookie)?.value);
  if (!user?.tenantId) return children;
  
  const canWrite = ['TENANT_ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(user.role);
  return <AppRoleProvider canWrite={canWrite} role={user.role}><ThemeBoot /><div className="appShell">
    <aside className="side">
      <style>{`@media(max-width:760px){.userProfile{display:none!important}}`}</style>
      <a href="/app" className="brand" aria-label="LeadMelo home"><Logo /></a>
      <AppNav operator={user.role === 'SUPER_ADMIN'} />
      <div className="sideActions" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '32px' }}>
        <div className="userProfile" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px', marginBottom: '8px' }}>
          <div className="avatar" style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', flexShrink: 0, textTransform: 'uppercase', fontSize: '14px' }}>
            {((user.name || user.email) || '?').charAt(0)}
          </div>
          <div style={{ overflow: 'hidden' }}>
            <div style={{ fontWeight: 600, fontSize: '14px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{user.name || 'User'}</div>
            <div style={{ fontSize: '12px', color: 'var(--muted)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', textTransform: 'capitalize' }}>{user.role.replace('_', ' ').toLowerCase()}</div>
          </div>
        </div>
        <InstallApp />
        <Logout />
      </div>
    </aside>
    <main id="main" className="main">{children}<AssistantWidget audience="app" /></main>
  </div></AppRoleProvider>;
}
