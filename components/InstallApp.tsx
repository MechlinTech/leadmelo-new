'use client';
import { useEffect, useState } from 'react';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

// "Install app" button (Chrome/Edge/Android) or a plain hint for iOS Safari, which has no install prompt API.
export default function InstallApp({ className }: { className?: string }) {
  const [event, setEvent] = useState<InstallEvent | null>(null), [ios, setIos] = useState(false), [installed, setInstalled] = useState(false);
  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone);
    const before = (e: Event) => { e.preventDefault(); setEvent(e as InstallEvent); };
    const done = () => { setInstalled(true); setEvent(null); };
    window.addEventListener('beforeinstallprompt', before); window.addEventListener('appinstalled', done);
    return () => { window.removeEventListener('beforeinstallprompt', before); window.removeEventListener('appinstalled', done); };
  }, []);
  if (installed) return null;
  if (event) return <button type="button" className={className ?? 'secondary'} onClick={async () => { await event.prompt(); await event.userChoice.catch(() => undefined); setEvent(null); }}>Install app</button>;
  if (ios) return <p className="muted" style={{ fontSize: 14, margin: 0 }}>To install: tap Share, then Add to Home Screen.</p>;
  return null;
}
