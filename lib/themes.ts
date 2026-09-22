// Single source of truth for themes. The CSS variables injected into every page and the contrast test
// (tests/themes.test.mjs, WCAG AA) both read this object, so a theme cannot ship unreadable.
export type ThemeId = 'system' | 'light' | 'dark' | 'ocean' | 'forest' | 'sunset';
export type Palette = { bg: string; surface: string; surface2: string; text: string; muted: string; line: string; accent: string; accentText: string; accentSoft: string; link: string; danger: string; dangerBg: string; focus: string; scheme: 'light' | 'dark' };

export const PALETTES: Record<Exclude<ThemeId, 'system'>, Palette> = {
  light: { bg: '#f6f7f6', surface: '#ffffff', surface2: '#eaf0ec', text: '#18231e', muted: '#55625b', line: '#c9d3ce', accent: '#176449', accentText: '#ffffff', accentSoft: '#e1f0e8', link: '#176449', danger: '#8c211e', dangerBg: '#fff1f0', focus: '#0b5fa5', scheme: 'light' },
  dark: { bg: '#0e1512', surface: '#16201b', surface2: '#1d2a24', text: '#e8efe9', muted: '#a6b6ac', line: '#33443b', accent: '#46d391', accentText: '#04241a', accentSoft: '#173a2b', link: '#7be3b3', danger: '#ffb4ae', dangerBg: '#3a1614', focus: '#7cc4ff', scheme: 'dark' },
  ocean: { bg: '#eef6fb', surface: '#ffffff', surface2: '#dcebf5', text: '#0b2233', muted: '#45606f', line: '#bcd3e2', accent: '#0a68a6', accentText: '#ffffff', accentSoft: '#d6eaf8', link: '#0a5f96', danger: '#8c211e', dangerBg: '#fff1f0', focus: '#8a3ffc', scheme: 'light' },
  forest: { bg: '#f2f4ea', surface: '#fbfcf6', surface2: '#e4e9d3', text: '#1c2a16', muted: '#55644a', line: '#c6cfb2', accent: '#3d6b1c', accentText: '#ffffff', accentSoft: '#e0ebc9', link: '#35601a', danger: '#8c211e', dangerBg: '#fff1f0', focus: '#8a3ffc', scheme: 'light' },
  sunset: { bg: '#fff6ee', surface: '#ffffff', surface2: '#fde8d6', text: '#2c1a11', muted: '#6b4b3b', line: '#efcdb4', accent: '#b8410a', accentText: '#ffffff', accentSoft: '#fde0cc', link: '#a33a08', danger: '#8c211e', dangerBg: '#fff1f0', focus: '#0b5fa5', scheme: 'light' }
};
export const THEME_IDS: ThemeId[] = ['system', 'light', 'dark', 'ocean', 'forest', 'sunset'];
export const THEME_LABELS: Record<ThemeId, string> = { system: 'System (follows your device)', light: 'Light', dark: 'Dark', ocean: 'Ocean', forest: 'Forest', sunset: 'Sunset' };
export const THEME_COOKIE = 'lm_theme';
export const isThemeId = (v: unknown): v is ThemeId => typeof v === 'string' && (THEME_IDS as string[]).includes(v);

const declarations = (p: Palette) => `--bg:${p.bg};--surface:${p.surface};--surface-2:${p.surface2};--text:${p.text};--muted:${p.muted};--line:${p.line};--accent:${p.accent};--accent-text:${p.accentText};--accent-soft:${p.accentSoft};--link:${p.link};--danger:${p.danger};--danger-bg:${p.dangerBg};--focus:${p.focus};color-scheme:${p.scheme};`;
// `system` uses the light palette unless the device prefers dark.
export function themeCss() {
  const parts = [`:root,[data-theme="light"],[data-theme="system"]{${declarations(PALETTES.light)}}`];
  for (const id of ['dark', 'ocean', 'forest', 'sunset'] as const) parts.push(`[data-theme="${id}"]{${declarations(PALETTES[id])}}`);
  parts.push(`@media (prefers-color-scheme: dark){[data-theme="system"]{${declarations(PALETTES.dark)}}}`);
  return parts.join('\n');
}
// Runs before first paint (an external script would be blocked by the nonce CSP if inline): the server
// reads the cookie instead, so there is no flash and no inline script.
export function themeFromCookie(header: string | null | undefined): ThemeId {
  const match = header?.split(';').map(x => x.trim()).find(x => x.startsWith(`${THEME_COOKIE}=`))?.slice(THEME_COOKIE.length + 1);
  return isThemeId(match) ? match : 'system';
}

// WCAG 2.x contrast ratio.
export function contrast(a: string, b: string) {
  const lum = (hex: string) => { const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Cookie the server reads for the first paint. Not HttpOnly on purpose: the picker also writes it in the browser.
export function themeCookieHeader(theme: ThemeId, secure = (process.env.APP_URL ?? '').startsWith('https:')) {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
}
