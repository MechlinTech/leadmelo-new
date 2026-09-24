import Logo from '../Logo';
import ThemeSelect from './ThemeSelect';
import InstallApp from '../InstallApp';

export default function SiteFooter({ signedIn = false }: { signedIn?: boolean }) {
  return <footer className="site-footer">
    <div className="inner">
      <div style={{ maxWidth: 360 }}>
        <Logo />
        <p className="muted" style={{ marginTop: 10 }}>Outbound that finds the buyer, sends the email and records a meeting only when your calendar confirms it. Early access: no guaranteed results.</p>
      </div>
      <nav aria-label="Footer" style={{ display: 'grid', gap: 6 }}>
        <a href="/#how-it-works">How it works</a><a href="/pricing">Pricing</a><a href="/pricing#faq">FAQ</a><a href="/request-access">Request access</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a>{signedIn ? <a href="/app">Open workspace</a> : <a href="/auth/signin">Sign in</a>}
      </nav>
      <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}><ThemeSelect /><InstallApp /></div>
    </div>
  </footer>;
}
