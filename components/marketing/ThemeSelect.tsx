'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { THEME_COOKIE, THEME_IDS, THEME_LABELS, isThemeId, type ThemeId } from '../../lib/themes';

// Applies a theme immediately and remembers it in a cookie so the server renders it on the next request.
export function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme);
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
export default function ThemeSelect({ label = 'Theme' }: { label?: string }) {
  const [theme, setTheme] = useState<ThemeId>('system');
  const path = usePathname();
  useEffect(() => {
    const saved = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${THEME_COOKIE}=`))?.slice(THEME_COOKIE.length + 1);
    const current = isThemeId(saved) ? saved : document.documentElement.getAttribute('data-theme');
    if (!isThemeId(current)) return;
    setTheme(current);
    document.documentElement.setAttribute('data-theme', current);
  }, [path]);
  return <label style={{ maxWidth: 220 }}>{label}
    <select value={theme} onChange={e => { const v = e.target.value; if (isThemeId(v)) { setTheme(v); applyTheme(v); } }}>
      {THEME_IDS.map(id => <option key={id} value={id}>{THEME_LABELS[id]}</option>)}
    </select>
  </label>;
}
