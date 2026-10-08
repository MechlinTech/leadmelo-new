import { headers } from 'next/headers';
import SiteHeader from '../../components/marketing/SiteHeader';
import SiteFooter from '../../components/marketing/SiteFooter';
import AssistantWidget from '../../components/AssistantWidget';
import ThemeBoot from '../../components/ThemeBoot';

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const signedIn = (await headers()).get('x-signed-in') === '1';
  return <>
    <style dangerouslySetInnerHTML={{ __html: `
      .appShell { display: block !important; min-height: 0 !important; }
      .appShell > .side { display: none !important; }
      .appShell > .main { padding: 0 !important; max-width: none !important; }
      .appShell > .main > .assistant-fab { display: none !important; }
    ` }} />
    <ThemeBoot />
    <SiteHeader signedIn={signedIn} />
    <main id="main">{children}</main>
    <SiteFooter signedIn={signedIn} />
    <AssistantWidget audience="public" />
  </>;
}
