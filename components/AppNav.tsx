'use client';
import { usePathname } from 'next/navigation';

const items = [['/app', 'Meetings'], ['/app/campaigns', 'Campaigns'], ['/app/icp', 'ICP'], ['/app/autopilot', 'Automation'], ['/app/crm', 'Prospects'], ['/app/settings', 'Settings']] as const;

export default function AppNav({ operator }: { operator?: boolean }) {
  const path = usePathname() ?? '';
  const current = (href: string) => (href === '/app' ? path === '/app' : path === href || path.startsWith(href + '/'));
  return <nav aria-label="Workspace">
    {items.map(([href, label]) => <a key={href} href={href} aria-current={current(href) ? 'page' : undefined}>{label}</a>)}
    {operator && <a href="/app/operator" aria-current={path.startsWith('/app/operator') ? 'page' : undefined}>Operator</a>}
  </nav>;
}
