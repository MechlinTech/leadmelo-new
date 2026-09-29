'use client';
import { useLayoutEffect } from 'react';
import { usePathname } from 'next/navigation';
import { THEME_COOKIE, isThemeId } from '../lib/themes';

// The root layout can reapply its first server theme on client navigation. Put the saved choice back.
export default function ThemeSync() {
  const path = usePathname();
  useLayoutEffect(() => {
    const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${THEME_COOKIE}=`))?.slice(THEME_COOKIE.length + 1);
    if (isThemeId(value)) document.documentElement.setAttribute('data-theme', value);
  }, [path]);
  return null;
}
