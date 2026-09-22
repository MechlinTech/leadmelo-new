export type ReplyIntentName = 'POSITIVE' | 'NEUTRAL' | 'OBJECTION' | 'NEGATIVE' | 'OUT_OF_OFFICE' | 'UNSURE';
export type ReplyReason =
  | 'explicit_negative' | 'delivery_notice' | 'out_of_office' | 'injection_attempt' | 'referral'
  | 'existing_relationship' | 'question_or_objection' | 'hedged_or_conflicting' | 'long_reply'
  | 'clear_positive' | 'no_clear_intent';

// Conservative rule classifier. Order matters: anything that must stop or suppress outreach
// is decided first, and only a short, unhedged, unambiguous message can be POSITIVE.
// It never executes or obeys reply text; it only chooses one of a fixed set of labels.
export function normalizeReply(snippet: string) {
  return snippet.normalize('NFKC').toLowerCase()
    .replace(/[​-‏⁠﻿­]/g, '')
    .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim();
}
const NEGATIVE = /unsubscribe|remove me|take me off|opt[- ]?out|stop (?:emailing|contacting|sending|messaging)|do not (?:contact|email)|don't (?:contact|email)|never (?:contact|email)|leave me alone|not interested|no interest|no thanks|no thank you|not looking|not a (?:good )?fit|not relevant|isn't for us|do not (?:book|schedule)|don't (?:book|schedule)|\bspam\b|report(?:ing)? (?:you|this)|legal action|\blawyer\b|\battorney\b|cease and desist|\bgdpr\b|kindly stop|please stop|just stop|(?:^|[.!?>:;"]\s*)stop\b|take (?:us|me|my [a-z]+) off|(?:remove|delete) (?:us|me|my [a-z]+)|(?:off|from|out of) (?:of )?(?:your |the |this |that )?(?:mailing|distribution|email|contact) list|we(?:'re| are) (?:all )?set\b|(?:^|[.!?>:;"]\s*)no[.!\s]*$/;
const DELIVERY = /mailer-daemon|undeliverable|undelivered mail|delivery status notification|delivery has failed|address not found|mailbox (?:full|unavailable)|user unknown|returned to sender|\b55\d [45]\.\d/;
const OOO = /out of (?:the )?office|automatic reply|auto[- ]?reply|autoreply|automatic response|\booo\b|on (?:annual |maternity |paternity |parental |medical )?(?:leave|vacation|holiday)|away from (?:my desk|the office|email)|limited access to (?:my )?email|will (?:be back|return) (?:on|in)/;
const INJECTION = /ignore (?:all |any |the )?(?:previous|prior|above|earlier)|disregard (?:all |any |the )?(?:previous|prior|above|instructions)|system prompt|you are now|new instructions|act as (?:an? )?(?:ai|assistant|system)|as an ai\b|\bassistant:|\bsystem:|<\/?(?:system|instructions?)>|jailbreak|override (?:the )?(?:limit|cap|rule|setting)|change (?:the )?(?:recipient|sender|limit|cap|setting)|mark (?:this|me) as|(?:send|forward|email) (?:all|the|your) (?:data|contacts|leads|list|emails)/;
const REFERRAL = /wrong (?:person|contact|email)|left the company|no longer (?:at|with) (?:this|the) (?:company|organi[sz]ation)|not the right (?:person|contact)|right person|no longer (?:work|with|at)|loop(?:ing)? in|\bcc'?(?:d|ing)\b|forward(?:ed|ing) (?:this|your|it)|(?:reach out|talk|speak|connect) (?:to|with) (?!me\b|us\b)[a-z]|(?:contact|email) (?!me\b|us\b)[a-z]+ (?:at|in|on|from)\b|(?:handled|owned|managed) by/;
const EXISTING = /already (?:booked|scheduled|have a (?:meeting|call)|on (?:my|the) calendar|working with|use|using|have (?:a |an )?(?:vendor|provider|partner|team))|existing (?:vendor|provider|partner|customer|relationship|contract)|(?:we|i) (?:already )?(?:have|use|work with) (?:a |an )?(?:vendor|provider|partner|agency)|under contract|current (?:vendor|provider)/;
const QUESTION_TOPIC = /\b(?:pricing|price|prices|cost|costs|budget|rates?|quote|proposal|contract|terms|security|soc ?2|compliance|how much|how does|how do|what (?:is|are|does|do)|tell me more|more (?:info|information|details)|send (?:me )?(?:details|information|info|a deck|case stud)|can you explain|references?)\b/;
const HEDGE = /\b(?:not|never|no|don't|cannot|can't|won't|but|however|unless|maybe|perhaps|not now|later|next (?:quarter|year|month)|circle back|revisit|in the future|down the road|depends|possibly)\b/;
const POSITIVE = /\binterested\b|let's (?:talk|chat|connect|set up|schedule|do it|meet)|(?:schedule|book|set up|arrange) (?:a |an |the )?(?:call|meeting|time|chat|demo|intro)|\byes\b|\byep\b|sounds (?:good|great)|happy to (?:talk|chat|connect|meet)|send (?:me )?(?:your |a |the )?(?:calendar|link|availability)|would love to|works for me|i'd like to (?:learn|talk|chat|hear)|count me in/;
const MAX_POSITIVE_LENGTH = 400;

export function classifyReplyDetailed(snippet: string): { intent: ReplyIntentName; reason: ReplyReason } {
  const text = normalizeReply(snippet);
  if (NEGATIVE.test(text)) return { intent: 'NEGATIVE', reason: 'explicit_negative' };
  if (DELIVERY.test(text)) return { intent: 'UNSURE', reason: 'delivery_notice' };
  if (OOO.test(text)) return { intent: 'OUT_OF_OFFICE', reason: 'out_of_office' };
  if (INJECTION.test(text)) return { intent: 'UNSURE', reason: 'injection_attempt' };
  if (REFERRAL.test(text)) return { intent: 'UNSURE', reason: 'referral' };
  if (EXISTING.test(text)) return { intent: 'UNSURE', reason: 'existing_relationship' };
  if (QUESTION_TOPIC.test(text)) return { intent: 'OBJECTION', reason: 'question_or_objection' };
  if (HEDGE.test(text)) return { intent: 'UNSURE', reason: 'hedged_or_conflicting' };
  if (text.includes('?')) return { intent: 'OBJECTION', reason: 'question_or_objection' };
  if (POSITIVE.test(text)) return text.length > MAX_POSITIVE_LENGTH ? { intent: 'UNSURE', reason: 'long_reply' } : { intent: 'POSITIVE', reason: 'clear_positive' };
  return { intent: 'UNSURE', reason: 'no_clear_intent' };
}
export function classifyReply(snippet: string) {
  return classifyReplyDetailed(snippet).intent;
}
