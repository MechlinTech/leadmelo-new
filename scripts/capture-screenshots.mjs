// Drives a real browser (Edge or Chrome via playwright-core) against a RUNNING app seeded with scripts/seed-demo.mjs.
// Saves a screenshot of every page (desktop + 375px mobile, plus alternate themes) and runs an axe-core
// accessibility scan on each. Usage: BASE_URL=http://localhost:3000 node scripts/capture-screenshots.mjs
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123456';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT, { recursive: true });
const axeSource = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH ?? exe, headless: true });
const report = [];

async function scan(page, name) {
  await page.evaluate(axeSource);
  const r = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  const bad = r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' '), help: v.help }));
  report.push({ page: name, violations: bad });
  if (bad.length) console.log(`A11Y ${name}:`, JSON.stringify(bad));
}
async function shot(page, name, { scan: doScan = true, full = true } = {}) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: full });
  if (doScan) await scan(page, name);
  console.log('shot', name);
}
async function login(ctx, email) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/auth/signin`);
  await page.fill('input[type=email]', email); await page.fill('input[type=password]', PASSWORD);
  await Promise.all([page.waitForURL(/\/app/), page.getByRole('button', { name: /^sign in/i }).click()]);
  return page;
}
const errors = [];
const watch = (page, tag) => { page.on('console', m => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); }); page.on('pageerror', e => errors.push(`${tag}: ${e.message}`)); };

// ---- Public site, desktop
for (const [label, viewport, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['mobile', { width: 375, height: 812 }, true]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage(); watch(page, `public-${label}`);
  await page.goto(`${BASE}/`); await shot(page, `${label}-01-landing`);
  await page.goto(`${BASE}/pricing`); await page.waitForTimeout(1200); await page.getByRole('button', { name: /^monthly/i }).click(); await page.waitForFunction(() => document.querySelector('button[aria-pressed=true]')?.textContent === 'Monthly'); await shot(page, `${label}-02-pricing-monthly`);
  await page.getByRole('button', { name: /annual/i }).first().click(); await shot(page, `${label}-03-pricing-annual`, { scan: false });
  await page.goto(`${BASE}/request-access`); await shot(page, `${label}-04-request-access`);
  await page.goto(`${BASE}/auth/signin`); await shot(page, `${label}-05-signin`);
  // Assistant conversation
  await page.goto(`${BASE}/pricing`);
  await page.getByRole('button', { name: /assistant|chat|ask/i }).first().click();
  const box = page.getByRole('dialog');
  await box.locator('input, textarea').first().fill('What is the difference between Starter and Growth?');
  await page.keyboard.press('Enter'); await page.waitForTimeout(900);
  await shot(page, `${label}-06-assistant-plans-answer`, { full: false });
  await box.locator('input, textarea').first().fill('Can I book a demo with a person?');
  await page.keyboard.press('Enter'); await page.waitForTimeout(900);
  await shot(page, `${label}-07-assistant-handoff`, { full: false });
  await ctx.close();
}

// ---- Themes on the landing page
for (const t of ['dark', 'ocean', 'forest', 'sunset']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await ctx.addCookies([{ name: 'lm_theme', value: t, url: BASE }]);
  const page = await ctx.newPage(); await page.goto(`${BASE}/pricing`); await shot(page, `theme-${t}-pricing`, { full: false });
  await ctx.close();
}

// ---- Signed-in app
const appPages = [['dashboard', '/app'], ['icp', '/app/icp'], ['campaigns', '/app/campaigns'], ['autopilot', '/app/autopilot'], ['crm', '/app/crm'], ['experiments', '/app/experiments'], ['settings', '/app/settings']];
for (const [label, viewport, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['mobile', { width: 375, height: 812 }, true]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const page = await login(ctx, 'admin@northwind.example'); watch(page, `app-${label}`);
  let n = 10;
  for (const [name, path] of appPages) { await page.goto(`${BASE}${path}`); await shot(page, `${label}-${n++}-app-${name}`, { full: !mobile }); }
  if (!mobile) {
    await page.goto(`${BASE}/app/settings`);
    await page.waitForTimeout(1000);
    await page.getByRole('radio', { name: /ocean/i }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'ocean');
    await shot(page, 'theme-ocean-app-settings', { scan: true, full: false });
    await page.reload(); await page.waitForTimeout(500);
    report.push({ page: 'theme-persists-after-reload', theme: await page.evaluate(() => document.documentElement.dataset.theme) });
    await page.getByRole('radio', { name: /^system/i }).check(); await page.waitForTimeout(500);
    await page.goto(`${BASE}/app/operator`); await page.waitForTimeout(300);
    report.push({ page: 'admin-blocked-from-operator', url: page.url() });
  }
  await ctx.close();
}

// ---- Optional AI assist, driven through the real UI against scripts/mock-llm.mjs (set AI_MOCK=1 to include)
if (process.env.AI_MOCK === '1') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await login(ctx, 'admin@northwind.example'); watch(page, 'ai');
  await page.goto(`${BASE}/app/settings`); await page.waitForTimeout(1000);
  await page.getByLabel(/Turn on AI assist/).check();
  await page.getByLabel(/^Base URL/).fill(process.env.AI_URL ?? 'http://127.0.0.1:11555/v1');
  await page.getByLabel(/^Model name/).fill('llama3.1');
  await page.getByLabel(/Campaign assist/).check(); await page.getByLabel(/Reply assist/).check();
  await page.getByRole('button', { name: 'Save AI settings' }).click(); await page.getByText('AI settings saved.').waitFor();
  await page.getByRole('button', { name: 'Test connection' }).click(); await page.getByText(/Connected\. The model answered/).waitFor();
  await page.locator('#ai-title').scrollIntoViewIfNeeded(); await shot(page, 'desktop-17-ai-settings', { full: false });
  await page.goto(`${BASE}/app/campaigns`); await page.waitForTimeout(800);
  await page.getByLabel(/Describe what you sell/).fill('We migrate QA test suites from Selenium to Playwright for US software companies that are hiring SDETs.');
  await page.getByRole('button', { name: 'Suggest ICP and emails' }).click(); await page.getByText(/Review every line/).waitFor();
  await page.waitForTimeout(400);
  const filled = await page.evaluate(() => ({ subject0: document.querySelector('[name=subject0]')?.value, body2: document.querySelector('[name=body2]')?.value, titles: document.querySelector('[name=icp_buyerTitles]')?.value }));
  if (!filled.subject0?.includes('{{company}}') || !filled.body2 || !filled.titles?.includes('VP Engineering')) throw new Error('AI suggestion did not fill the form: ' + JSON.stringify(filled));
  await page.locator('[name=subject0]').scrollIntoViewIfNeeded(); await shot(page, 'desktop-18-ai-campaign-draft', { full: false });
  await page.goto(`${BASE}/app/autopilot`); await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Analyse with AI' }).first().click(); await page.getByText(/AI summary/).first().waitFor();
  await page.getByText(/AI summary/).first().scrollIntoViewIfNeeded(); await shot(page, 'desktop-19-ai-reply-insight', { full: false });
  report.push({ page: 'ai-flow', ok: true, filled: Object.keys(filled) });
  await ctx.close();
}
// ---- Operator
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await login(ctx, 'operator@leadmelo.example'); watch(page, 'operator');
  await page.goto(`${BASE}/app/operator`); await shot(page, 'desktop-30-operator');
  await ctx.close();
}
// ---- Offline page + service worker registration (production build over localhost counts as secure)
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`); await page.waitForTimeout(1500);
  const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker?.getRegistration(); return { registered: !!r, scope: r?.scope, active: !!r?.active }; });
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  report.push({ page: 'pwa', reg, manifestName: manifest.name, icons: manifest.icons.length });
  await page.goto(`${BASE}/offline.html`); await shot(page, 'mobile-40-offline', { scan: false });
  await ctx.close();
}
await browser.close();
writeFileSync(`${OUT}accessibility-report.json`, JSON.stringify({ report, consoleErrors: errors }, null, 2));
const total = report.reduce((n, r) => n + (r.violations?.length ?? 0), 0);
console.log(`DONE. axe violation groups: ${total}. console errors: ${errors.length}`);
if (errors.length) console.log(errors.join('\n'));
