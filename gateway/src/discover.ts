import { createHash } from 'node:crypto';
import { prospectSchema, type Prospect } from '../../lib/providers';
import { ApolloClient } from './apollo';
import { HunterClient } from './hunter';
import { GatewayHttpError, VendorError } from './errors';
import { GatewayStore } from './store';
import type { GatewayConfig } from './config';
import { apolloEmployeeRanges, apolloLocation, geographyFor, industryFor, looksLikeDomain, normalizeDomain, sizeBandFor, technologyUid, titleFor, translateSignals } from './normalize';

export type IcpInput = { industries: string[]; companySizes: string[]; geographies: string[]; technologies: string[]; buyingSignals: string[]; buyerTitles: string[]; exclusionRules: string[] };
const clip = (s: string, n = 200) => s.slice(0, n);
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// Search (free) -> pre-filter on title (free) -> enrich (spends a credit) -> independent verification.
// Only prospects with a Hunter-verified VALID mailbox, a provable "hiring" evidence link and an
// ICP-equivalent title are returned. Claims are limited to what a vendor filter or field supports:
//  * a "Hiring X" signal is claimed only for candidates returned by a search filtered on job title X;
//  * a technology is claimed only if Apollo lists it in the organization's current technologies.
export async function discover(
  deps: { apollo: ApolloClient; hunter: HunterClient; store: GatewayStore; config: GatewayConfig; now?: () => Date },
  req: { tenantId: string; campaignId: string; icp: IcpInput; limit: number }
): Promise<{ prospects: Prospect[] }> {
  const { apollo, hunter, store, config } = deps, now = deps.now ?? (() => new Date());
  if (req.limit === 0) return { prospects: [] };
  const { icp } = req;
  if (icp.buyerTitles.length === 0) throw new GatewayHttpError(422, 'icp_needs_buyer_titles');
  const signals = translateSignals(icp.buyingSignals);
  // Fail before spending anything: LeadMelo requires a matching buying signal, and only job-posting signals can be evidenced.
  if (signals.jobTitles.length === 0) throw new GatewayHttpError(422, 'icp_signals_not_supported: use "Hiring <role>" signals');
  const budget = Math.min(req.limit * 4, config.maxEnrichPerRequest), deadline = Date.now() + config.discoveryDeadlineMs;
  const base = {
    titles: icp.buyerTitles, locations: [...new Set(icp.geographies.map(apolloLocation))], employeeRanges: apolloEmployeeRanges(icp.companySizes),
    technologyUids: icp.technologies.map(technologyUid).filter(Boolean), excludeDomains: icp.exclusionRules.filter(looksLikeDomain)
  };
  const prospects: Prospect[] = [], emails = new Set<string>();
  let enriched = 0, stoppedByVendor: VendorError | null = null;
  const done = () => prospects.length >= req.limit || enriched >= budget || Date.now() > deadline || !!stoppedByVendor;

  try {
    for (const jobTitle of signals.jobTitles) {
      const signal = signals.signalForJobTitle.get(jobTitle)!;
      const cursorKey = `cursor:${req.tenantId}:${req.campaignId}:${hash(JSON.stringify({ ...base, jobTitle }))}`;
      let page = store.cursor(cursorKey) + 1;
      for (let pages = 0; pages < config.maxPages && !done(); pages++, page++) {
        const { candidates } = await apollo.searchPeople({ ...base, jobTitles: [jobTitle], page, perPage: Math.min(100, Math.max(10, (budget - enriched) * 2)) });
        if (candidates.length === 0) { store.setCursor(cursorKey, 0); break; } // ran out of results: start over next time
        let consumed = true;
        for (const c of candidates) {
          if (done()) { consumed = false; break; }
          const seenKey = `seen:${req.tenantId}:${req.campaignId}:${c.id}`;
          if (store.hasSeen(seenKey) || !titleFor(c.title, icp.buyerTitles, config.taxonomy.titles).matched) continue; // free checks first
          const e = await apollo.enrich(c.id);
          enriched++; store.markSeen(seenKey); // recorded only after the vendor answered, so a failed call is retried, not lost
          const org = e?.organization;
          if (!e || !e.email || !org) continue;
          const domain = normalizeDomain(org.domain ?? org.website);
          const evidenceUrl = [org.website, org.linkedin].find(u => u && /^https?:\/\//i.test(u) && URL.canParse(u));
          const title = titleFor(e.title, icp.buyerTitles, config.taxonomy.titles);
          if (!looksLikeDomain(domain) || !evidenceUrl || !title.matched || !e.fullName || emails.has(e.email.toLowerCase())) continue;
          const check = await hunter.verify(e.email);
          if (check.verification !== 'VALID') continue;
          const techSet = new Set(org.technologies.map(t => t.toLowerCase()));
          const technologies = icp.technologies.filter(t => techSet.has(t.toLowerCase()) || techSet.has(technologyUid(t)));
          const parsed = prospectSchema.safeParse({
            company: clip(org.name ?? domain), domain, fullName: clip(e.fullName), title: clip(title.title), email: e.email.toLowerCase(),
            industry: clip(industryFor(org.industry, icp.industries, config.taxonomy.industries)), companySize: clip(sizeBandFor(org.employees, icp.companySizes)),
            geography: clip(geographyFor(e.country, icp.geographies)), technologies, signals: [signal],
            verification: 'VALID', verifiedAt: now().toISOString(), evidenceUrl,
            evidenceSummary: clip(`Apollo lists ${clip(org.name ?? domain, 80)} as having an open job posting matching "${jobTitle}" (Apollo search filter q_organization_job_titles; not independently confirmed). Mailbox verified by Hunter (${check.vendorStatus}).`, 1000)
          });
          if (parsed.success) { prospects.push(parsed.data); emails.add(parsed.data.email); }
        }
        if (consumed) store.setCursor(cursorKey, page);
      }
    }
  } catch (error) {
    // Keep what was already bought and verified; a vendor failure only ends the run early.
    if (!(error instanceof VendorError) || prospects.length === 0) throw error;
    stoppedByVendor = error;
  }
  return { prospects: prospects.slice(0, req.limit) };
}
