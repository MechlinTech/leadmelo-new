import { headers } from 'next/headers';
import SiteHeader from '../../components/marketing/SiteHeader';
import SiteFooter from '../../components/marketing/SiteFooter';
import AssistantWidget from '../../components/AssistantWidget';

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const signedIn = (await headers()).get('x-signed-in') === '1';
  return <>
    <SiteHeader signedIn={signedIn} />
    <main id="main">{children}</main>
    <SiteFooter signedIn={signedIn} />
    <AssistantWidget audience="public" />
  </>;
}
