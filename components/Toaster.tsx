'use client';
import { useEffect, useState } from 'react';

type Toast = { id: number; message: string; type: 'notice' | 'error' };
let toastId = 0;
export const showToast = (message: string, type: 'notice' | 'error' = 'notice') => typeof window !== 'undefined' && window.dispatchEvent(new CustomEvent('app-toast', { detail: { id: ++toastId, message, type } }));

export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const handler = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setToasts(s => [...s.filter(x => x.message !== t.message), t]);
      setTimeout(() => setToasts(s => s.filter(x => x.id !== t.id)), 4000);
    };
    window.addEventListener('app-toast', handler);
    return () => window.removeEventListener('app-toast', handler);
  }, []);
  return <div style={{ position: 'fixed', top: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', pointerEvents: 'none' }}>
    {toasts.map(t => <div key={t.id} role={t.type === 'error' ? 'alert' : 'status'} className={`${t.type === 'error' ? 'error' : 'notice'} toast-slide`} style={{ background: t.type === 'error' ? 'var(--danger-bg)' : 'var(--surface)', padding: '14px 16px', borderRadius: '0 8px 8px 0', border: t.type === 'error' ? '1px solid var(--danger)' : '1px solid var(--line)', borderLeft: `4px solid ${t.type === 'error' ? 'var(--danger)' : 'var(--accent)'}`, boxShadow: '0 12px 40px rgba(0,0,0,0.15)', maxWidth: '90vw', width: 'max-content', pointerEvents: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
      <span style={{ flex: 1 }}>{t.message}</span>
      <button type="button" aria-label="Dismiss" onClick={() => setToasts(s => s.filter(x => x.id !== t.id))} style={{ background: 'transparent', border: 0, color: 'inherit', padding: 4, cursor: 'pointer', margin: '-4px -4px -4px 0', fontSize: 16 }}>✕</button>
    </div>)}
  </div>;
}
