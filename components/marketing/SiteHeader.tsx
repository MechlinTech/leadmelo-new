'use client';
import { useState } from 'react';
import Logo from '../Logo';

const links = [{ href: '/#how-it-works', label: 'How it works' }, { href: '/#features', label: 'Features' }, { href: '/pricing', label: 'Pricing' }, { href: '/pricing#faq', label: 'FAQ' }];

export default function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  const [open, setOpen] = useState(false);
  return <header className="site-header">
    <div className="inner">
      <a href="/" aria-label="LeadMelo home" className="brand"><Logo /></a>
      <button type="button" className="menu-toggle secondary" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(v => !v)}>{open ? 'Close' : 'Menu'}</button>
      <nav id="site-nav" className="site-nav" data-open={open} aria-label="Main">
        {links.map(l => <a key={l.href} href={l.href} onClick={() => setOpen(false)}>{l.label}</a>)}
        {signedIn ? <a href="/app">Open workspace</a> : <a href="/auth/signin">Sign in</a>}
        <a className="btn" href="/request-access">Request access</a>
      </nav>
    </div>
  </header>;
}
