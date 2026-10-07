import { prospectSchema, type Prospect } from '../../lib/providers';
import { GatewayHttpError } from './errors';
import type { GatewayStore } from './store';
import type { IcpInput } from './discover';
import { looksLikeDomain, normalizeDomain, translateSignals } from './normalize';

const clip = (s: string, n = 200) => s.slice(0, n);

function displayName(local: string): string {
  const parts = local.split(/[._+-]+/).filter(Boolean).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return parts.join(' ') || 'Dummy Contact';
}

/** Build ICP-matching prospects from configured emails. Never calls Apollo or Hunter. */
export function discoverDummy(
  deps: { store: GatewayStore; emails: string[]; now?: () => Date },
  req: { tenantId: string; campaignId: string; icp: IcpInput; limit: number }
): { prospects: Prospect[] } {
  const now = deps.now ?? (() => new Date());
  if (req.limit === 0) return { prospects: [] };
  if (deps.emails.length === 0) throw new GatewayHttpError(422, 'dummy_discovery_needs_emails: set GATEWAY_DUMMY_EMAILS');
  const { icp } = req;
  if (icp.buyerTitles.length === 0) throw new GatewayHttpError(422, 'icp_needs_buyer_titles');
  const signals = translateSignals(icp.buyingSignals);
  if (signals.jobTitles.length === 0) throw new GatewayHttpError(422, 'icp_signals_not_supported: use "Hiring <role>" signals');
  if (!icp.industries[0] || !icp.companySizes[0] || !icp.geographies[0]) {
    throw new GatewayHttpError(422, 'dummy_discovery_needs_icp_dimensions');
  }

  const signal = signals.signalForJobTitle.get(signals.jobTitles[0])!;
  const title = icp.buyerTitles[0];
  const industry = icp.industries[0];
  const companySize = icp.companySizes[0];
  const geography = icp.geographies[0];
  const technologies = icp.technologies.slice(0, 5);
  const exclude = new Set(icp.exclusionRules.map(v => v.trim().toLowerCase()).filter(Boolean));
  const prospects: Prospect[] = [];

  const seenInReq = new Set<string>();
  for (const rawEmail of deps.emails) {
    if (prospects.length >= req.limit) break;
const email = String(rawEmail ?? '').trim().toLowerCase();
    if (!email || seenInReq.has(email)) continue;
    seenInReq.add(email);
    const domainRaw = email.split('@')[1] ?? '';
    const domain = normalizeDomain(domainRaw);
    if (!looksLikeDomain(domain)) continue;
    if (exclude.has(domain) || exclude.has(email)) continue;
// Always return the same canned prospects for QA: the gateway-level "seen" marker would
    // otherwise suppress them after the first run and the worker would never requeue.
    const seenKey = `seen:${req.tenantId}:${req.campaignId}:${email.toLowerCase()}`;

    const local = email.split('@')[0] ?? 'contact';
    const fullName = displayName(local);
    const company = clip(`Dummy ${domain}`);
    const evidenceUrl = `https://${domain}`;
    const parsed = prospectSchema.safeParse({
      company, domain, fullName: clip(fullName), title: clip(title), email,
      industry: clip(industry), companySize: clip(companySize), geography: clip(geography),
      technologies, signals: [signal],
      verification: 'VALID', verifiedAt: now().toISOString(), evidenceUrl,
      evidenceSummary: clip(`Dummy discovery prospect for development. ICP-aligned title "${title}" and signal "${signal}". No Apollo credit spent.`, 1000)
    });
    if (!parsed.success) continue;
    deps.store.markSeen(seenKey);
    prospects.push(parsed.data);
  }
  return { prospects };
}
