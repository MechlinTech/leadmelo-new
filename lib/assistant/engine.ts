import { PLANS, PUBLIC_PLAN_ORDER, TRIAL_DAYS, annualSavingsPercent, formatLimit, MOST_POPULAR, usd, type PlanId } from '../plans';
import { ENTRIES, planDetail, planOverview, type Entry, type Link } from './knowledge';

// A deterministic, grounded assistant: it can only say what is in knowledge.ts or lib/plans.ts. It never
// executes, obeys or repeats user text, so prompt injection has nothing to grab. When unsure it says so
// and offers a human. No language model is involved; that is a deliberate safety and accuracy choice.
export type Reply = { answer: string; links: Link[]; suggestions: string[]; confidence: 'high' | 'medium' | 'low'; handoff: boolean; matched: string[] };
export type Audience = 'public' | 'app';

const STOP = new Set('a an the and or but if then of to in on at by for with about as is are was were be been being do does did can could would should will may might i you we they it this that these those my your our me us am what who whom which when where why how any some there here so not no yes please tell get got many onto also just really exactly actually look like'.split(' '));
const SYNONYMS: Record<string, string> = { price: 'pricing', prices: 'pricing', cost: 'pricing', costs: 'pricing', expensive: 'pricing', cheap: 'pricing', fee: 'pricing', fees: 'pricing', plans: 'plan', tier: 'plan', tiers: 'plan', subscription: 'plan', meeting: 'meetings', appointment: 'meetings', appointments: 'meetings', demo: 'trial', gmail: 'google', workspace: 'google', outlook: 'microsoft', office365: 'microsoft', m365: 'microsoft', o365: 'microsoft', spam: 'deliverability', inbox: 'deliverability', dmarc: 'deliverability', spf: 'deliverability', dkim: 'deliverability', warmup: 'deliverability', gdpr: 'privacy', ccpa: 'privacy', erase: 'privacy', delete: 'privacy', dsar: 'privacy', encrypt: 'security', encrypted: 'security', encryption: 'security', mfa: 'security', '2fa': 'security', soc2: 'security', iso: 'security', safe: 'security', phone: 'mobile', android: 'mobile', ios: 'mobile', iphone: 'mobile', ipad: 'mobile', tablet: 'mobile', pwa: 'mobile', theme: 'themes', dark: 'themes', appearance: 'themes', colors: 'themes', colours: 'themes', ab: 'experiments', abtest: 'experiments', split: 'experiments', selfhost: 'hosting', 'self-host': 'hosting', docker: 'hosting', server: 'hosting', premise: 'hosting', hubspot: 'api', salesforce: 'api', zapier: 'api', crm: 'api', sso: 'team', seats: 'team', roles: 'team', invite: 'team', card: 'payment', invoice: 'payment', billing: 'payment', pay: 'payment', refund: 'payment', cancel: 'payment' };

Object.assign(SYNONYMS, { promise: 'guarantee', promises: 'guarantee', assure: 'guarantee', ensure: 'guarantee', colleague: 'team', colleagues: 'team', coworker: 'team', coworkers: 'team', employees: 'team', staff: 'team', permission: 'team', permissions: 'team', check: 'review', vet: 'review', proofread: 'review', writes: 'reply', responds: 'reply', respond: 'reply', responded: 'reply', responses: 'reply', replies: 'reply', servers: 'hosting', infrastructure: 'hosting', install: 'hosting', laptop: 'mobile', responsive: 'mobile', protect: 'security', protected: 'security', protection: 'security', safely: 'security', privacy: 'privacy', systems: 'providers', platforms: 'providers', provider: 'providers', deployed: 'hosting', deploy: 'hosting', deployment: 'hosting', plug: 'integration', tools: 'integration', integrate: 'integration', integrations: 'integration', reach: 'target', aim: 'target', schedule: 'calendar', login: 'team', log: 'team', people: 'team', teammates: 'team', teammate: 'team', screens: 'dashboard', reporting: 'analytics', reports: 'analytics', metrics: 'analytics', realistic: 'guarantee', try: 'trial', test: 'trial', employee: 'team', member: 'team', members: 'team', user: 'team', users: 'team', audience: 'target', targeting: 'target' });

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9+\-\s']/g, ' ').split(/\s+/).map(w => w.replace(/^['-]+|['-]+$/g, '')).filter(Boolean)
    .map(w => SYNONYMS[w] ?? w).filter(w => !STOP.has(w) && w.length > 1)
    .map(w => (w.length > 4 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

type Doc = { entry: Entry; tf: Map<string, number>; len: number };
const docs: Doc[] = ENTRIES.map(entry => {
  const tf = new Map<string, number>();
  const add = (text: string, weight: number) => { for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + weight); };
  add(entry.title, 3); for (const e of entry.examples) add(e, 3); for (const k of entry.keywords) add(k, 2); add(entry.answer, 0.5);
  return { entry, tf, len: [...tf.values()].reduce((a, b) => a + b, 0) };
});
const avgLen = docs.reduce((n, d) => n + d.len, 0) / docs.length;
const df = new Map<string, number>();
for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
const idf = (t: string) => Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));

// BM25 over the knowledge base.
export function search(query: string, audience: Audience) {
  const q = [...new Set(tokenize(query))];
  const scored = docs.filter(d => d.entry.audience === 'both' || d.entry.audience === audience).map(d => {
    let score = 0;
    for (const t of q) { const f = d.tf.get(t) ?? 0; if (f) score += idf(t) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avgLen)); }
    return { entry: d.entry, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return { scored, queryTokens: q };
}

const PLAN_WORDS: Array<[RegExp, PlanId]> = [[/\b(trial|free)\b/i, 'FREE'], [/\bstarter\b/i, 'STARTER'], [/\bgrowth\b/i, 'GROWTH'], [/\bscale\b/i, 'SCALE'], [/\benterprise\b/i, 'ENTERPRISE']];
const plansIn = (t: string) => { const ids = PLAN_WORDS.filter(([re]) => re.test(t)).map(([, id]) => id); if (!ids.length && /\b(middle|mid|mid-tier|popular|main)\b.*\bplan\b|\bplan\b.*\b(middle|mid-tier)\b/i.test(t)) ids.push(MOST_POPULAR); return ids; };
const isPricing = (t: string) => /\b(pric|cost|how much|plan|tier|subscription|per month|monthly|annual|yearly|cheap|afford|expensive|discount)/i.test(t);
const rep = (over: Partial<Reply> & { answer: string }): Reply => ({ links: [], suggestions: [], confidence: 'high', handoff: false, matched: [], ...over });
const PRICING_LINK: Link = { label: 'See full comparison', href: '/pricing' };
const ACCESS_LINK: Link = { label: 'Request access', href: '/request-access' };

// "I send about 5000 emails" -> smallest plan whose monthly email allowance covers it.
function recommend(text: string): Reply | null {
  const m = /(\d[\d,\.]*)\s*(k)?\s*(?:cold\s*)?(emails?|messages?|prospects?|leads?|contacts?)/i.exec(text);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, '')); if (!Number.isFinite(n)) return null; if (m[2]) n *= 1000;
  const prospects = /prospect|lead|contact/i.test(m[3]);
  const fit = PUBLIC_PLAN_ORDER.filter(id => id !== 'FREE').find(id => { const l = PLANS[id].limits; const v = prospects ? l.monthlyProspects : l.monthlyEmails; return v === -1 || v >= n; });
  if (!fit) return null;
  const p = PLANS[fit];
  return rep({ answer: `For about ${n.toLocaleString('en-US')} ${prospects ? 'prospects' : 'emails'} a month, ${p.name} is the smallest plan that covers it. ${planDetail(fit)} Try it free first for ${TRIAL_DAYS} days.`, links: [PRICING_LINK, ACCESS_LINK], suggestions: ['What is included in the trial?'], matched: ['plan-recommendation'] });
}

export function answer(input: string, audience: Audience = 'public'): Reply {
  const text = input.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) return rep({ answer: 'Ask me anything about how LeadMelo works, its plans, security or setup.', confidence: 'low', suggestions: defaultSuggestions(audience) });
  if (/^(hi|hello|hey|good (morning|afternoon|evening)|yo|hola)\b/i.test(text) && text.length < 40) return rep({ answer: 'Hi! I can explain how LeadMelo finds prospects and books meetings, walk through plans and limits, or point you to setup help. What would you like to know?', suggestions: defaultSuggestions(audience), matched: ['greeting'] });
  if (/^(thanks|thank you|thx|cheers|great|ok(ay)?|cool)\b/i.test(text) && text.length < 40) return rep({ answer: 'You are welcome. Anything else I can help with?', suggestions: defaultSuggestions(audience), matched: ['thanks'] });
  if (/^(bye|goodbye|see you)\b/i.test(text)) return rep({ answer: 'Goodbye! If you want to try it, you can request access any time.', links: [ACCESS_LINK], matched: ['bye'] });
  if (audience === 'public' && /\b(talk|speak|chat|contact|reach)\b.*\b(human|person|sales|someone|team|agent|rep)\b|\b(human|sales|agent)\b.*\b(please|now|help)\b|\bbook (a )?(demo|call)\b/i.test(text)) return rep({ answer: 'Happy to connect you. Leave your name and email and the team will reply. I cannot promise a response time.', links: [ACCESS_LINK], handoff: true, confidence: 'high', matched: ['handoff'] });

  // Live plan answers first: they are generated from lib/plans.ts.
  if (isPricing(text) || plansIn(text).length) {
    const named = plansIn(text);
    if (/\b(vs|versus|compare|difference between|or)\b/i.test(text) && named.length >= 2) {
      const [a, b] = named;
      return rep({ answer: `${planDetail(a)} Compared with: ${planDetail(b)}`, links: [PRICING_LINK], matched: ['plan-compare'], suggestions: ['Is there a free trial?'] });
    }
    if (/\b(annual|yearly|year|discount|save)\b/i.test(text)) {
      const p = PLANS.GROWTH;
      return rep({ answer: `Annual billing is ${annualSavingsPercent(p)}% cheaper than monthly on Starter, Growth and Scale (for example ${p.name}: ${usd(p.monthlyUsd!)} a month, or ${usd(p.annualUsd!)} a year). Prices are illustrative until you confirm them when you request access.`, links: [PRICING_LINK], matched: ['annual'] });
    }
    if (/\b(popular|recommend|best|which plan|what plan|suggest)\b/i.test(text) && !named.length) {
      const r = recommend(text);
      if (r) return r;
      return rep({ answer: `${PLANS[MOST_POPULAR].name} is the most popular: ${planDetail(MOST_POPULAR)} Tell me roughly how many emails a month you plan to send and I can suggest the smallest plan that covers it.`, links: [PRICING_LINK], matched: ['plan-recommend'] });
    }
    if (/\btrial\b/i.test(text) && /\b(how long|days|length|duration|expire|last)\b/i.test(text)) return rep({ answer: `The trial lasts ${TRIAL_DAYS} days. ${planDetail('FREE')}`, links: [ACCESS_LINK], matched: ['trial-length'] });
    if (named.length === 1) return rep({ answer: planDetail(named[0]), links: [PRICING_LINK, ACCESS_LINK], matched: ['plan-detail:' + named[0]], suggestions: ['Compare Growth and Scale'] });
    const r = recommend(text);
    if (r) return r;
    if (isPricing(text)) return rep({ answer: planOverview(), links: [PRICING_LINK, ACCESS_LINK], matched: ['plan-overview'], suggestions: ['Which plan is best for 5000 emails a month?', 'Is there a free trial?', 'What happens if I hit a limit?'] });
  }
  const r = recommend(text);
  if (r && /\b(plan|need|send|month)\b/i.test(text)) return r;

  const { scored } = search(text, audience);
  const top = scored[0], second = scored[1];
  if (!top) return lowConfidence(audience);
  // Confidence from absolute score and margin over the runner-up.
  const margin = top.score - (second?.score ?? 0);
  const confidence: Reply['confidence'] = top.score >= 6 && margin >= 1 ? 'high' : top.score >= 3.5 ? 'medium' : 'low';
  if (confidence === 'low') return lowConfidence(audience);
  const followups = (top.entry.followups ?? []).map(id => ENTRIES.find(e => e.id === id)?.title).filter((t): t is string => !!t);
  const extra = confidence === 'medium' && second && second.score >= 3 ? [second.entry.title] : [];
  return rep({ answer: top.entry.answer, links: top.entry.links ?? [], suggestions: [...extra, ...followups].slice(0, 3), confidence, matched: [top.entry.id] });
}

export function defaultSuggestions(audience: Audience) {
  return audience === 'app' ? ['Why is my campaign not sending?', 'How do I invite a teammate?', 'How do I change my theme?'] : ['How does it work?', 'What does it cost?', 'Do you guarantee meetings?', 'Is it secure?'];
}
function lowConfidence(audience: Audience): Reply {
  return rep({ answer: audience === 'public'
    ? 'I am not sure I have a reliable answer to that, and I would rather not guess. You can rephrase, pick one of these topics, or leave your email and the team will answer.'
    : 'I am not sure I have a reliable answer to that. Try rephrasing, or pick one of these topics.',
  confidence: 'low', handoff: audience === 'public', links: audience === 'public' ? [ACCESS_LINK] : [], suggestions: defaultSuggestions(audience), matched: [] });
}
// Question text stored for gap analysis: emails, phone-like and long numeric strings are masked.
export function redactQuestion(text: string) {
  return text.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]').replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]').replace(/https?:\/\/\S+/g, '[link]').replace(/\s+/g, ' ').trim().slice(0, 300);
}
export { formatLimit };
