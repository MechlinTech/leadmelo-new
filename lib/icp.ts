export type ICPDefinition={
  name:string;
  offer:string;
  industries:string[];
  companySizes:string[];
  geographies:string[];
  technologies:string[];
  buyingSignals:string[];
  buyerTitles:string[];
  exclusionRules:string[];
  minScore:number;
  weeklyAppointmentGoal:number;
};

export const mechlinQaICP:ICPDefinition={
  name:'Mechlin QA Automation ICP',
  offer:'QA Automation / Playwright Migration / SDET Support',
  industries:['SaaS','healthcare software','insurance technology','fintech','logistics','e-commerce'],
  companySizes:['50-1000 employees'],
  geographies:['United States','Canada'],
  technologies:['Selenium','Playwright','Cypress','REST APIs','CI/CD'],
  buyingSignals:['hiring QA Automation Engineer','hiring SDET','Selenium mentioned','Playwright mentioned','performance testing mentioned','release-quality pain'],
  buyerTitles:['CTO','VP Engineering','Director of QA','QA Manager','Engineering Manager','Head of Quality'],
  exclusionRules:['staffing agencies','students/training companies','competitors','invalid or unverifiable email','existing suppression'],
  minScore:75,
  weeklyAppointmentGoal:5
};

export function validateICP(icp:ICPDefinition){
  const missing:string[]=[];
  if(!icp.offer)missing.push('offer');
  if(!icp.buyerTitles.length)missing.push('buyerTitles');
  if(!icp.buyingSignals.length)missing.push('buyingSignals');
  if(!icp.geographies.length)missing.push('geographies');
  if(icp.minScore<50)missing.push('minScore >= 50');
  return {valid:missing.length===0,missing};
}
