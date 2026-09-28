import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, THEME_IDS, THEME_LABELS, themeCss, themeFromCookie, themeFromHeader, contrast, isThemeId } from '../lib/themes.ts';

test('every theme meets WCAG AA contrast for text, muted text, links, buttons, errors and focus rings', () => {
  const failures = [];
  const need = (theme, label, a, b, min) => { const r = contrast(a, b); if (r < min) failures.push(`${theme} ${label}: ${r.toFixed(2)} < ${min}`); };
  for (const [id, p] of Object.entries(PALETTES)) {
    for (const surface of [p.bg, p.surface, p.surface2]) { need(id, `text on ${surface}`, p.text, surface, 4.5); need(id, `muted on ${surface}`, p.muted, surface, 4.5); need(id, `link on ${surface}`, p.link, surface, 4.5); }
    need(id, 'button text on accent', p.accentText, p.accent, 4.5);
    need(id, 'link on accent-soft', p.link, p.accentSoft, 4.5);
    need(id, 'error on error background', p.danger, p.dangerBg, 4.5);
    for (const surface of [p.bg, p.surface]) need(id, `focus ring on ${surface}`, p.focus, surface, 3);
    need(id, 'accent as UI colour on surface', p.accent, p.surface, 3);
    need(id, 'border visible on background', p.line, p.bg, 1.15);
  }
  assert.deepEqual(failures, []);
});

test('theme list, labels, CSS and cookie parsing agree', () => {
  assert.deepEqual(THEME_IDS, ['system', 'light', 'dark', 'ocean', 'forest', 'sunset']);
  for (const id of THEME_IDS) assert.ok(THEME_LABELS[id], id);
  const css = themeCss();
  for (const id of ['light', 'dark', 'ocean', 'forest', 'sunset']) assert.ok(css.includes(`[data-theme="${id}"]`), id);
  assert.match(css, /prefers-color-scheme: dark\)\{\[data-theme="system"\]/);
  assert.equal(themeFromCookie('a=1; lm_theme=ocean; b=2'), 'ocean');
  assert.equal(themeFromCookie('lm_theme=hacker'), 'system', 'unknown values fall back to system');
  assert.equal(themeFromCookie(null), 'system');
  assert.equal(themeFromHeader('ocean'), 'ocean');
  assert.equal(themeFromHeader('nope'), 'system');
  assert.ok(!isThemeId('"><script>'), 'a cookie value can never inject markup into the html attribute');
  assert.ok(contrast('#000000', '#ffffff') > 20.9);
});
