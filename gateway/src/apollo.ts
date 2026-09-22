import { z } from 'zod';
import { VendorError, readCapped, retryAfter } from './errors';

// Apollo, per https://docs.apollo.io :
//  People API Search  POST https://api.apollo.io/api/v1/mixed_people/api_search   (0 credits; returns NO emails)
//    parameters are sent in the QUERY STRING: person_titles[], include_similar_titles, organization_locations[],
//    organization_num_employees_ranges[] ("min,max"), currently_using_any_of_technology_uids[],
//    q_organization_job_titles[], not_organization_websites_list[], page, per_page (max 100)
//    response: { total_entries, people: [{ id, first_name, last_name_obfuscated, title, has_email, organization: { name, ... } }] }
//  People Enrichment  POST https://api.apollo.io/api/v1/people/match?id=...      (1 credit when an email is returned)
//    response person fields: id, name, title, email, email_status, country, organization { name, primary_domain, website_url,
//    linkedin_url, industry, estimated_num_employees, current_technologies[{uid,name}] }
//  Auth header x-api-key. 429 carries retry-after. Enrichment: 600 calls/hour on the documented endpoint.
// NOT VERIFIED AGAINST A LIVE ACCOUNT. Assumptions to confirm are listed in gateway/README.md
// (notably the `person` wrapper key on the enrichment response and the exact technology UID format).

const searchBody = z.object({
  total_entries: z.number().optional(),
  people: z.array(z.object({ id: z.string(), title: z.string().nullish(), organization: z.object({ name: z.string().nullish() }).passthrough().nullish() }).passthrough()).default([])
}).passthrough();
const org = z.object({
  name: z.string().nullish(), primary_domain: z.string().nullish(), website_url: z.string().nullish(), linkedin_url: z.string().nullish(),
  industry: z.string().nullish(), estimated_num_employees: z.number().nullish(),
  current_technologies: z.array(z.object({ uid: z.string().nullish(), name: z.string().nullish() }).passthrough()).nullish()
}).passthrough();
const person = z.object({ id: z.string(), name: z.string().nullish(), first_name: z.string().nullish(), last_name: z.string().nullish(), title: z.string().nullish(), email: z.string().nullish(), email_status: z.string().nullish(), country: z.string().nullish(), organization: org.nullish() }).passthrough();
const enrichBody = z.object({ person: person.nullish() }).passthrough();

export type SearchParams = {
  titles: string[]; locations: string[]; employeeRanges: string[]; technologyUids: string[]; jobTitles: string[]; excludeDomains: string[];
  page: number; perPage: number;
};
export type Candidate = { id: string; title: string | null; organizationName: string | null };
export type Enriched = { id: string; fullName: string; title: string | null; email: string | null; emailStatus: string | null; country: string | null; organization: { name: string | null; domain: string | null; website: string | null; linkedin: string | null; industry: string | null; employees: number | null; technologies: string[] } | null };

export class ApolloClient {
  constructor(private fetcher: typeof fetch, private apiKey: string, private base = 'https://api.apollo.io/api/v1') {}
  private async post(path: string, query: URLSearchParams): Promise<unknown> {
    const url = new URL(`${this.base}${path}`);
    url.search = query.toString();
    let res: Response;
    try { res = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'x-api-key': this.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' } }); }
    catch { throw new VendorError('vendor_unavailable'); }
    if (res.status === 401 || res.status === 403) throw new VendorError('vendor_auth');
    if (res.status === 429) throw new VendorError('vendor_rate_limited', retryAfter(res));
    if (res.status >= 500) throw new VendorError('vendor_unavailable', retryAfter(res));
    if (!res.ok) throw new VendorError('vendor_error');
    try { return JSON.parse(await readCapped(res)); } catch { throw new VendorError('vendor_response_invalid'); }
  }
  async searchPeople(p: SearchParams): Promise<{ candidates: Candidate[]; total: number }> {
    const q = new URLSearchParams();
    for (const t of p.titles) q.append('person_titles[]', t);
    q.set('include_similar_titles', 'false'); // LeadMelo matches titles exactly; similar titles would only waste enrichment credits
    for (const l of p.locations) q.append('organization_locations[]', l);
    for (const r of p.employeeRanges) q.append('organization_num_employees_ranges[]', r);
    for (const t of p.technologyUids) q.append('currently_using_any_of_technology_uids[]', t);
    for (const j of p.jobTitles) q.append('q_organization_job_titles[]', j);
    for (const d of p.excludeDomains) q.append('not_organization_websites_list[]', d);
    q.set('page', String(p.page)); q.set('per_page', String(p.perPage));
    let parsed;
    try { parsed = searchBody.parse(await this.post('/mixed_people/api_search', q)); } catch (e) { throw e instanceof VendorError ? e : new VendorError('vendor_response_invalid'); }
    return { total: parsed.total_entries ?? parsed.people.length, candidates: parsed.people.map(x => ({ id: x.id, title: x.title ?? null, organizationName: x.organization?.name ?? null })) };
  }
  // Spends credit when an email is returned. Never reveals personal emails or phone numbers.
  async enrich(id: string): Promise<Enriched | null> {
    const q = new URLSearchParams({ id, reveal_personal_emails: 'false' });
    let parsed;
    try { parsed = enrichBody.parse(await this.post('/people/match', q)); } catch (e) { throw e instanceof VendorError ? e : new VendorError('vendor_response_invalid'); }
    const x = parsed.person;
    if (!x) return null;
    const o = x.organization;
    return {
      id: x.id, fullName: (x.name ?? [x.first_name, x.last_name].filter(Boolean).join(' ')).trim(), title: x.title ?? null, email: x.email ?? null, emailStatus: x.email_status ?? null, country: x.country ?? null,
      organization: o ? { name: o.name ?? null, domain: o.primary_domain ?? null, website: o.website_url ?? null, linkedin: o.linkedin_url ?? null, industry: o.industry ?? null, employees: o.estimated_num_employees ?? null, technologies: (o.current_technologies ?? []).flatMap(t => [t.name, t.uid]).filter((s): s is string => !!s) } : null
    };
  }
}
