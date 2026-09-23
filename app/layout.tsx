import './globals.css';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { THEME_COOKIE, isThemeId } from '../lib/themes';
import PwaRegister from '../components/PwaRegister';

export const dynamic = 'force-dynamic';
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover',
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f6f7f6' }, { media: '(prefers-color-scheme: dark)', color: '#0e1512' }]
};
export const metadata: Metadata = {
  title: { default: 'LeadMelo: outbound that books meetings', template: '%s | LeadMelo' },
  description: 'Define who you want to reach. LeadMelo finds and verifies prospects, sends your approved emails, handles replies and records a meeting only when the calendar confirms it.',
  applicationName: 'LeadMelo', manifest: '/manifest.webmanifest', formatDetection: { telephone: false },
  icons: { icon: [{ url: '/icons/logo.svg', type: 'image/svg+xml' }, { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }], apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'LeadMelo', statusBarStyle: 'default' }
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const stored = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isThemeId(stored) ? stored : 'system';
  return <html lang="en" data-theme={theme}>
    <body>
      <link rel="stylesheet" href="/leadmelo.css" precedence="default" />
      <a className="skip" href="#main">Skip to content</a>{children}<PwaRegister />
    </body>
  </html>;
}
