'use client';
import { useEffect } from 'react';

// Registers the static-asset-only service worker. Production or a secure origin only: in development the
// build files are not content-hashed, so caching them would serve stale code.
export default function PwaRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') return;
    const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!secure) return;
    const register = () => { navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => undefined); };
    if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
  }, []);
  return null;
}
