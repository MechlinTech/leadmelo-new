import SiteHeader from '../../components/marketing/SiteHeader';
import SiteFooter from '../../components/marketing/SiteFooter';
import AssistantWidget from '../../components/AssistantWidget';

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return <>
    <SiteHeader />
    <main id="main">{children}</main>
    <SiteFooter />
    <AssistantWidget audience="public" />
  </>;
}
