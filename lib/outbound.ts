export const defaultCalendlyUrl='https://calendly.com/pm-mechlintech/30min';

export type ProspectCriteria={
  offer:string;
  targetTitles:string[];
  keywords:string[];
  industries:string[];
  locations:string[];
  weeklyProspectLimit:number;
  minScore:number;
};

export const mechlinQaCriteria:ProspectCriteria={
  offer:'QA Automation / Playwright Migration / SDET Support',
  targetTitles:['CTO','VP Engineering','Director of QA','QA Manager','Engineering Manager','Head of Quality'],
  keywords:['QA Automation Engineer','SDET','Playwright','Selenium','API testing','performance testing'],
  industries:['SaaS','healthcare software','insurance technology','fintech','logistics','e-commerce'],
  locations:['United States','Canada'],
  weeklyProspectLimit:50,
  minScore:70
};

export function buildDiscoveryPrompt(c:ProspectCriteria){
  return [
    `Find companies that match ${c.offer}.`,
    `Buying signals: ${c.keywords.join(', ')}.`,
    `Buyer titles: ${c.targetTitles.join(', ')}.`,
    `Industries: ${c.industries.join(', ')}.`,
    `Locations: ${c.locations.join(', ')}.`,
    `Return no more than ${c.weeklyProspectLimit} verified prospects with score >= ${c.minScore}.`
  ].join(' ');
}

export function qaAutomationEmail(firstName:string,company:string,sender='Shubham',calendlyUrl=defaultCalendlyUrl){
  return {
    subject:'QA automation support for your team',
    body:`Hi ${firstName || 'there'},

I noticed ${company} may be scaling QA or test automation work.

Mechlin Technologies helps teams with QA automation, Selenium to Playwright migration, API testing, performance testing, and SDET support.

Would you be open to a quick 30-minute call to see if we can help reduce regression time, flaky tests, or QA delivery bottlenecks?

Calendar:
${calendlyUrl}

Best,
${sender}
Mechlin Technologies`
  };
}
