'use client';
import { useEffect, useState } from 'react';
import { PALETTES, THEME_IDS, THEME_LABELS, isThemeId, type ThemeId } from '../lib/themes';
import { api } from './api';
import { applyTheme } from './marketing/ThemeSelect';
import { showToast } from './Toaster';

const swatchesFor = (id: ThemeId) => { const p = id === 'system' ? PALETTES.light : PALETTES[id]; return [p.bg, p.surface, p.accent, p.text]; };

export default function AppearanceSettings() {
  const [theme, setTheme] = useState<ThemeId>('system'), [error, setError] = useState('');
  useEffect(() => { const current = document.documentElement.getAttribute('data-theme'); if (isThemeId(current)) setTheme(current); }, []);
  async function choose(next: ThemeId) {
    setTheme(next); applyTheme(next); setError('');
    try { await api('profile/theme', 'PUT', { theme: next }); showToast(`Theme set to ${THEME_LABELS[next].split(' (')[0]}. It follows your account on every device.`); }
    catch (e) { setError(`Applied on this device, but it could not be saved to your account: ${(e as Error).message}`); }
  }
  return <section aria-labelledby="appearance-title">
    <h2 id="appearance-title">Appearance</h2>
    <p className="muted">Pick a look. Every theme is checked for readable text contrast.</p>
    <fieldset className="themeGrid">
      <legend className="sr-only">Theme</legend>
      {THEME_IDS.map(id => <label key={id}>
        <input type="radio" name="theme" value={id} checked={theme === id} onChange={() => void choose(id)} />
        <span className="swatchRow" aria-hidden="true">{swatchesFor(id).map((c, i) => <span key={i} className="swatch" style={{ background: c }} />)}</span>
        <span>{THEME_LABELS[id]}</span>
      </label>)}
    </fieldset>
    {error && <p role="alert" className="error" style={{ marginBottom: 16 }}>{error}</p>}
  </section>;
}
