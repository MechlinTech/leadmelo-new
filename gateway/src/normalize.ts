// Pure mapping between vendor values and an ICP's own wording. LeadMelo matches prospects to an
// ICP by exact (case-insensitive) string equality, so the gateway may translate an equivalent
// vendor value into the ICP's string, but must never relabel a prospect to force a match. When
// nothing is provably equivalent the raw vendor value is returned and LeadMelo will reject it.

const lower = (s: string) => s.trim().toLowerCase();

export type Band = { min: number; max: number };
export function parseBand(band: string): Band | null {
  const s = band.trim().replace(/[–—]/g, '-');
  let m = /^(\d+)\s*-\s*(\d+)$/.exec(s); if (m) return { min: +m[1], max: +m[2] };
  m = /^(\d+)\s*\+$/.exec(s); if (m) return { min: +m[1], max: Number.POSITIVE_INFINITY };
  return null;
}
// The ICP band containing the employee count, else the bare number (which will not match).
export function sizeBandFor(employees: number | null | undefined, bands: string[]): string {
  if (employees === null || employees === undefined || !Number.isFinite(employees)) return '';
  for (const band of bands) { const b = parseBand(band); if (b && employees >= b.min && employees <= b.max) return band; }
  return String(employees);
}
// Apollo's documented format is "min,max" (for example "1,10").
export function apolloEmployeeRanges(bands: string[]): string[] {
  return bands.flatMap(band => { const b = parseBand(band); return b ? [`${b.min},${Number.isFinite(b.max) ? b.max : 1000000}`] : []; });
}

const COUNTRY_GROUPS = [
  ['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.'],
  ['united kingdom', 'uk', 'u.k.', 'great britain', 'gb'],
  ['canada', 'ca'], ['australia', 'au'], ['germany', 'de'], ['france', 'fr'], ['ireland', 'ie'], ['india', 'in'], ['netherlands', 'nl'], ['singapore', 'sg']
];
const groupOf = (name: string) => COUNTRY_GROUPS.find(g => g.includes(lower(name)));
// The ICP's own geography string when it is the same country under another name.
export function geographyFor(country: string | null | undefined, icpGeographies: string[]): string {
  if (!country) return '';
  const c = lower(country), g = groupOf(country);
  return icpGeographies.find(x => lower(x) === c) ?? (g ? icpGeographies.find(x => g.includes(lower(x))) : undefined) ?? country;
}
// A location Apollo is likely to understand: the country's common full name (first entry of its group).
export function apolloLocation(icpGeography: string): string {
  const g = groupOf(icpGeography);
  return g ? g[0].replace(/\b\w/g, ch => ch.toUpperCase()) : icpGeography;
}

// Deliberately small: only unambiguous equivalents. Operators extend it through the taxonomy file.
const TITLE_GROUPS = [
  ['cto', 'chief technology officer'], ['ceo', 'chief executive officer'], ['cio', 'chief information officer'],
  ['vp engineering', 'vp of engineering', 'vice president engineering', 'vice president of engineering', 'vp, engineering'],
  ['head of qa', 'head of quality assurance'], ['qa director', 'director of qa', 'director of quality assurance', 'director, qa'],
  ['qa manager', 'quality assurance manager', 'manager, qa', 'manager of qa']
];
export function titleFor(title: string | null | undefined, icpTitles: string[], extra: Record<string, string> = {}): { title: string; matched: boolean } {
  if (!title) return { title: '', matched: false };
  const t = lower(title);
  const exact = icpTitles.find(x => lower(x) === t);
  if (exact) return { title: exact, matched: true };
  const mapped = extra[t];
  if (mapped) { const hit = icpTitles.find(x => lower(x) === lower(mapped)); if (hit) return { title: hit, matched: true }; }
  const g = TITLE_GROUPS.find(group => group.includes(t));
  const viaGroup = g && icpTitles.find(x => g.includes(lower(x)));
  return viaGroup ? { title: viaGroup, matched: true } : { title, matched: false };
}
export function industryFor(industry: string | null | undefined, icpIndustries: string[], map: Record<string, string> = {}): string {
  if (!industry) return '';
  const i = lower(industry);
  const exact = icpIndustries.find(x => lower(x) === i);
  if (exact) return exact;
  const mapped = map[i];
  return (mapped && icpIndustries.find(x => lower(x) === lower(mapped))) || industry;
}

// Only "Hiring <role>" signals can be expressed as a vendor filter (active job postings). Any other
// signal cannot be evidenced from the vendor and is never claimed.
export function translateSignals(icpSignals: string[]) {
  const byJobTitle = new Map<string, string>();
  for (const signal of icpSignals) { const m = /^hiring\s+(.+)$/i.exec(signal.trim()); if (m) byJobTitle.set(m[1].trim(), signal); }
  return { jobTitles: [...byJobTitle.keys()], signalForJobTitle: byJobTitle };
}
export const technologyUid = (name: string) => lower(name).replace(/\s+/g, '_').replace(/[^a-z0-9_.+-]/g, '');
export const looksLikeDomain = (s: string) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(s.trim());
export const normalizeDomain = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
