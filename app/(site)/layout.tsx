import { headers } from 'next/headers';
import SiteHeader from '../../components/marketing/SiteHeader';
import SiteFooter from '../../components/marketing/SiteFooter';
import AssistantWidget from '../../components/AssistantWidget';
import ThemeBoot from '../../components/ThemeBoot';

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const signedIn = (await headers()).get('x-signed-in') === '1';
  return <>
    <ThemeBoot />
    <SiteHeader signedIn={signedIn} />
    <main id="main">{children}</main>
    <SiteFooter signedIn={signedIn} />
    <AssistantWidget audience="public" />
  </>;
}
