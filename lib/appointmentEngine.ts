export type CampaignAutomationInput={
  campaignId:string;
  automationMode:'FULLY_AUTOMATIC'|'REVIEW_BEFORE_SEND'|'REVIEW_BEFORE_BOOKING'|'PAUSED';
  weeklyProspectCap:number;
  dailySendCap:number;
  minScore:number;
  minAppointmentQualityScore:number;
  weeklyAppointmentGoal:number;
  deliverabilityStatus:'HEALTHY'|'WATCHLIST'|'THROTTLED'|'BLOCKED';
};

export type AutomationDecision={
  canDiscover:boolean;
  canSend:boolean;
  canBook:boolean;
  reason:string;
};

export function decideAutomation(input:CampaignAutomationInput):AutomationDecision{
  if(input.automationMode==='PAUSED')return {canDiscover:false,canSend:false,canBook:false,reason:'campaign_paused'};
  if(input.deliverabilityStatus!=='HEALTHY')return {canDiscover:true,canSend:false,canBook:false,reason:'sender_not_healthy'};
  if(input.dailySendCap<1 || input.weeklyProspectCap<1)return {canDiscover:false,canSend:false,canBook:false,reason:'caps_not_configured'};
  return {
    canDiscover:true,
    canSend:input.automationMode==='FULLY_AUTOMATIC' || input.automationMode==='REVIEW_BEFORE_BOOKING',
    canBook:input.automationMode==='FULLY_AUTOMATIC',
    reason:'ready'
  };
}

export function isAppointmentQualified(score:number, minAppointmentQualityScore:number, hasBuyer:boolean, hasPainSignal:boolean){
  return score>=minAppointmentQualityScore && hasBuyer && hasPainSignal;
}

export const autonomousRunStages=[
  'load_campaign_icp',
  'discover_accounts',
  'enrich_buyers',
  'verify_contacts',
  'score_and_qualify',
  'queue_sequence',
  'send_with_throttles',
  'classify_replies',
  'route_to_calendar',
  'record_outcome',
  'learn_from_results'
] as const;
