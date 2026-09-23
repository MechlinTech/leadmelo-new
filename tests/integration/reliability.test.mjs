import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { db } from '../../lib/db.ts';
import { encrypt } from '../../lib/crypto.ts';
import { GraphClient } from '../../lib/m365/graph.ts';
import { sendMicrosoft } from '../../lib/m365/send.ts';
import { pollMicrosoft } from '../../lib/m365/sync.ts';
import { collectAlerts, deliverAlert, raiseAlert } from '../../lib/alerts.ts';
import { processReverification } from '../../lib/reverification.ts';
import { handleProviderEvent } from '../../lib/webhooks.ts';
import { processOutreach } from '../../lib/worker.ts';
import { createSession,sessionCookie } from '../../lib/auth.ts';
import { GET as getAlerts, PATCH as acknowledge } from '../../app/api/alerts/route.ts';
import { GET as getM365, PUT as configureM365, DELETE as disableM365 } from '../../app/api/integrations/m365/route.ts';

if(process.env.TEST_DATABASE_CONFIRM!=='isolated') throw new Error('isolated database required');
process.env.DATA_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64');
process.env.SESSION_SECRET='synthetic-test-secret'.repeat(4);
process.env.APP_URL='http://localhost:3000';
process.env.OUTBOUND_ENABLED='true';
process.env.SENDER_HEALTH_AUTO = 'off'; // these flows post signed health events; automatic health is tested in growth.test.mjs

test('Microsoft 365 and autonomous recovery database flows',async t=>{
 const originalFetch=globalThis.fetch;
 try {
  const tenant=await db.tenant.create({data:{name:'Recovery',slug:`recovery-${randomUUID()}`,settings:{create:{automationEnabled:true,postalAddress:'123 Test Street',gatewayKey:encrypt('synthetic-gateway'),dailySendCap:25}},users:{create:{email:`admin-${randomUUID()}@example.com`,role:'TENANT_ADMIN'}}},include:{users:true}});
  const other=await db.tenant.create({data:{name:'Other',slug:`other-${randomUUID()}`,users:{create:{email:`admin-${randomUUID()}@example.com`,role:'TENANT_ADMIN'}}},include:{users:true}});
  const cookie=`${sessionCookie}=${await createSession(tenant.users[0].id)}`, otherCookie=`${sessionCookie}=${await createSession(other.users[0].id)}`;
  const req=(path,method='GET',body,auth=cookie)=>new Request(`http://localhost:3000/api/${path}`,{method,headers:{origin:'http://localhost:3000',cookie:auth,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  // Worker jobs pick one due row globally. Earlier files in this suite leave cursors, sends and alerts
  // that would be claimed first and make these assertions look at the wrong tenant.
  const parkOthers = async () => {
    const notUs = { tenantId: { not: tenant.id } };
    const later = new Date('2099-01-01');
    await db.mailCursor.updateMany({ where: notUs, data: { nextPollAt: later, lastSuccessAt: new Date(), leaseUntil: null } });
    await db.outreachEvent.updateMany({ where: { ...notUs, status: 'QUEUED' }, data: { scheduledAt: later } });
    await db.campaign.updateMany({ where: { ...notUs, status: 'ACTIVE' }, data: { status: 'PAUSED' } });
    await db.contact.updateMany({ where: notUs, data: { reverifyRequestedAt: null, verificationNextAt: later } });
    await db.operationalAlert.updateMany({ where: { ...notUs, deliveredAt: null, acknowledgedAt: null }, data: { nextAttemptAt: later } });
  };
  await parkOthers();
  let config;
  await t.test('admin setup stores encrypted secret, does not expose it, and isolates tenants',async()=>{
   const body={directoryId:randomUUID(),clientId:randomUUID(),clientSecret:'synthetic-secret-123456789',mailboxes:['sender@example.com'],mailboxScopeConfirmed:true};
   assert.equal((await configureM365(req('integrations/m365','PUT',body))).status,200);
   config=await db.m365Connection.findUnique({where:{tenantId:tenant.id}});
   assert.notEqual(config.encryptedSecret,body.clientSecret);
   const publicResponse=await(await getM365(req('integrations/m365'))).text();
   assert.ok(!publicResponse.includes(body.clientSecret));assert.ok(!publicResponse.includes(config.encryptedSecret));
   assert.equal((await(await getM365(req('integrations/m365','GET',undefined,otherCookie))).json()).connection,null);
  });
  const lead=await db.lead.create({data:{tenantId:tenant.id,company:'Synthetic Buyer',domain:'synthetic.example'}});
  const contact=await db.contact.create({data:{tenantId:tenant.id,leadId:lead.id,fullName:'Test Buyer',email:'buyer@example.com',verification:'VALID',lastVerifiedAt:new Date()}});
  const campaign=await db.campaign.create({data:{tenantId:tenant.id,name:'Recovery campaign',senderName:'Sender',senderEmail:'sender@example.com',calendlyUrl:'https://calendly.com/test',status:'ACTIVE',automationMode:'FULLY_AUTOMATIC',businessDaysOnly:false,sendStartHour:0,sendEndHour:24,sequenceSteps:{create:[{stepOrder:1,subject:'Hello',body:'Hello buyer'}]}}});
  await db.enrollment.create({data:{tenantId:tenant.id,campaignId:campaign.id,contactId:contact.id,score:90,hasBuyer:true,hasPainSignal:true,evidence:{synthetic:true}}});
  const input={tenantId:tenant.id,campaignId:campaign.id,contactId:contact.id,from:'sender@example.com',fromName:'Sender',to:contact.email,subject:'Hello',body:'Hello buyer',headers:{'List-Unsubscribe':'<https://app.example/unsubscribe?token=test>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},calendlyUrl:'https://calendly.com/test'};
  const key=`m365:${randomUUID()}`;let sends=0, drafts=0, sent=false;
  const fakeGraphFetch=async(url,options)=>{
   if(String(url).includes('login.microsoftonline.com')) return Response.json({access_token:'fake-token'});
   if(options.method==='POST' && String(url).endsWith('/messages')) {drafts++;return Response.json({id:'immutable-draft',internetMessageId:'<original@example.com>',conversationId:'conversation'});}
   if(options.method==='POST' && String(url).endsWith('/send')) {sends++;sent=true;throw new Error('timeout after provider accepted');}
   return Response.json({id:'immutable-draft',isDraft:!sent,sentDateTime:sent?new Date().toISOString():null,internetMessageId:'<original@example.com>',conversationId:'conversation'});
  };
  await t.test('accepted-but-timeout reconciles with GET without a second send',async()=>{
   await assert.rejects(sendMicrosoft(tenant.id,key,input,new GraphClient(config,fakeGraphFetch)),/m365_send_ambiguous/);
   assert.equal((await db.mailReceipt.findUnique({where:{key}})).status,'AMBIGUOUS');
   assert.equal((await sendMicrosoft(tenant.id,key,input,new GraphClient(config,fakeGraphFetch))).messageId,'immutable-draft');
   await sendMicrosoft(tenant.id,key,input,new GraphClient(config,fakeGraphFetch));
   assert.equal(sends,1);assert.equal(drafts,1);
   await assert.rejects(sendMicrosoft(tenant.id,key,{...input,body:'changed'},new GraphClient(config,fakeGraphFetch)),/idempotency_conflict/);
   await assert.rejects(sendMicrosoft(other.id,key,input,new GraphClient(config,fakeGraphFetch)),/sender_not_allowed/);
  });
  await t.test('ambiguous draft still present is never blindly resubmitted',async()=>{
   const unknownKey=`unknown:${randomUUID()}`;
   await db.mailReceipt.create({data:{tenantId:tenant.id,key:unknownKey,requestHash:(await db.mailReceipt.findUnique({where:{key}})).requestHash,mailbox:input.from,status:'SUBMITTING',draftId:'still-draft'}});
   const reader=new GraphClient(config,async(url)=>String(url).includes('login.microsoftonline.com')?Response.json({access_token:'fake'}):Response.json({isDraft:true}));
   await assert.rejects(sendMicrosoft(tenant.id,unknownKey,input,reader),/m365_send_ambiguous/);
  });
  const initial=await db.outreachEvent.create({data:{tenantId:tenant.id,campaignId:campaign.id,contactId:contact.id,leadId:lead.id,idempotencyKey:key,status:'SENT',sentAt:new Date(),stepOrder:1}});
  await t.test('mailbox delta attributes by reply headers, stops sequence, creates one booking invitation',async()=>{
   const delta='https://graph.microsoft.com/v1.0/users/sender%40example.com/mailFolders/inbox/messages/delta?$deltatoken=synthetic';
   const graph=new GraphClient(config,async(url)=>{
    const u=String(url);
    if(u.includes('login.microsoftonline.com')) return Response.json({access_token:'fake'});
    if(u.includes('/delta')) return Response.json({value:[{id:'reply-one'}],'@odata.deltaLink':delta});
    return Response.json({id:'reply-one',from:{emailAddress:{address:contact.email}},receivedDateTime:new Date().toISOString(),uniqueBody:{contentType:'text',content:'Yes please schedule a meeting'},internetMessageHeaders:[{name:'In-Reply-To',value:'<original@example.com>'}]});
   });
   await pollMicrosoft(new Date(),graph);
   assert.equal((await db.mailCursor.findUnique({where:{tenantId_mailbox:{tenantId:tenant.id,mailbox:input.from}}})).cursor,delta);
   assert.equal(await db.reply.count({where:{tenantId:tenant.id}}),1);
   assert.equal(await db.outreachEvent.count({where:{tenantId:tenant.id,purpose:'BOOKING_INVITATION'}}),1);
   await db.mailCursor.updateMany({where:{tenantId:tenant.id},data:{nextPollAt:new Date(0)}});
   await pollMicrosoft(new Date(),graph);
   assert.equal(await db.reply.count({where:{tenantId:tenant.id}}),1);
  });
  await t.test('worker selects native Microsoft sending and blocks stale reply sync',async()=>{
   await handleProviderEvent(tenant.id,{id:'health-recovery',type:'sender.health',occurredAt:new Date().toISOString(),senderEmail:input.from,status:'HEALTHY',dailyCap:25,bounceRate:0,complaintRate:0});
   await db.mailCursor.updateMany({where:{tenantId:tenant.id},data:{lastSuccessAt:new Date(0)}});
   assert.equal(await processOutreach(),false);
   await db.mailCursor.updateMany({where:{tenantId:tenant.id},data:{lastSuccessAt:new Date(),error:null}});
   await db.outreachEvent.updateMany({where:{tenantId:tenant.id,status:'QUEUED'},data:{scheduledAt:new Date(0)}});
   let nativeSends=0;
   globalThis.fetch=async(url,options)=>{
    if(String(url).includes('login.microsoftonline.com')) return Response.json({access_token:'fake'});
    if(String(url).endsWith('/send')) {nativeSends++;return new Response(null,{status:202});}
    return Response.json({id:'booking-draft',internetMessageId:'<booking@example.com>'});
   };
   await processOutreach();
   assert.equal(nativeSends,1);
   assert.equal((await db.outreachEvent.findFirst({where:{tenantId:tenant.id,purpose:'BOOKING_INVITATION'}})).status,'SENT');
   globalThis.fetch=originalFetch;
  });
  await t.test('pricing question raises review alert and cancels pending invitation',async()=>{
   await db.outreachEvent.create({data:{tenantId:tenant.id,campaignId:campaign.id,contactId:contact.id,leadId:lead.id,purpose:'BOOKING_INVITATION'}});
   await handleProviderEvent(tenant.id,{id:'question',type:'reply',campaignId:campaign.id,email:contact.email,text:'Yes please send pricing first',occurredAt:new Date().toISOString()});
   assert.equal(await db.outreachEvent.count({where:{tenantId:tenant.id,status:'QUEUED'}}),0);
   assert.equal(await db.operationalAlert.count({where:{tenantId:tenant.id,code:'reply_review'}}),1);
  });
  await t.test('delayed Sent Items copy blocks cursor advancement, then refreshes reply correlation',async()=>{
   let ready=false,deltaCalls=0;
   const graph=new GraphClient(config,async(url)=>{
    const u=String(url);
    if(u.includes('login.microsoftonline.com')) return Response.json({access_token:'fake'});
    if(u.includes('/delta')) {deltaCalls++;return Response.json({value:[],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/users/sender%40example.com/mailFolders/inbox/messages/delta?$deltatoken=confirmed'});}
    return ready?Response.json({id:'booking-draft',isDraft:false,sentDateTime:new Date().toISOString(),internetMessageId:'<final-booking@example.com>'}):new Response(null,{status:404});
   });
   await db.mailCursor.updateMany({where:{tenantId:tenant.id},data:{nextPollAt:new Date(0)}});
   await pollMicrosoft(new Date(),graph);
   assert.equal(deltaCalls,0);
   assert.equal((await db.mailCursor.findFirst({where:{tenantId:tenant.id}})).error,'mail_sync_failed');
   ready=true;
   await db.mailCursor.updateMany({where:{tenantId:tenant.id},data:{nextPollAt:new Date(0)}});
   await pollMicrosoft(new Date(),graph);
   assert.equal(deltaCalls,1);
   const receipt=await db.mailReceipt.findFirst({where:{tenantId:tenant.id,draftId:'booking-draft'}});
   assert.equal(receipt.internetMessageId,'<final-booking@example.com>');
   assert.ok(receipt.sentConfirmedAt);
  });
  await t.test('known buyer without reply headers stops outreach and alerts without guessing booking',async()=>{
   const before=await db.appointment.count({where:{tenantId:tenant.id}});
   await db.outreachEvent.create({data:{tenantId:tenant.id,campaignId:campaign.id,contactId:contact.id,status:'QUEUED',purpose:'BOOKING_INVITATION'}});
   const graph=new GraphClient(config,async(url)=>{
    const u=String(url);
    if(u.includes('login.microsoftonline.com')) return Response.json({access_token:'fake'});
    if(u.includes('/delta')) return Response.json({value:[{id:'new-thread'}],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/users/sender%40example.com/mailFolders/inbox/messages/delta?$deltatoken=new-thread'});
    return Response.json({id:'new-thread',from:{emailAddress:{address:contact.email}},receivedDateTime:new Date().toISOString(),uniqueBody:{contentType:'text',content:'Stop emailing me'},internetMessageHeaders:[]});
   });
   await db.mailCursor.updateMany({where:{tenantId:tenant.id},data:{nextPollAt:new Date(0)}});
   await pollMicrosoft(new Date(),graph);
   assert.equal(await db.outreachEvent.count({where:{tenantId:tenant.id,contactId:contact.id,status:'QUEUED'}}),0);
   assert.equal(await db.operationalAlert.count({where:{tenantId:tenant.id,code:'reply_attribution_review'}}),1);
   assert.ok(await db.suppression.findUnique({where:{tenantId_email:{tenantId:tenant.id,email:contact.email}}}));
   assert.equal(await db.appointment.count({where:{tenantId:tenant.id}}),before);
  });
  await t.test('stale contacts are reverified; invalid contacts are suppressed',async()=>{
   process.env.PROVIDER_GATEWAY_URL='https://gateway.example';
   const stale=await db.contact.create({data:{tenantId:tenant.id,leadId:lead.id,fullName:'Stale Buyer',email:'stale@example.com',verification:'VALID',lastVerifiedAt:new Date(0),reverifyRequestedAt:new Date()}});
   await db.outreachEvent.create({data:{tenantId:tenant.id,campaignId:campaign.id,contactId:stale.id,leadId:lead.id,status:'QUEUED',error:'reverification_required'}});
   globalThis.fetch=async()=>Response.json({email:stale.email,verification:'VALID',verifiedAt:new Date(Date.now()-1000).toISOString()});
   assert.equal(await processReverification(),true);
   assert.equal((await db.contact.findUnique({where:{id:stale.id}})).reverifyRequestedAt,null);
   await db.contact.update({where:{id:stale.id},data:{reverifyRequestedAt:new Date()}});
   globalThis.fetch=async()=>Response.json({email:stale.email,verification:'INVALID',verifiedAt:new Date(Date.now()-1000).toISOString()});
   await processReverification();
   assert.ok(await db.suppression.findUnique({where:{tenantId_email:{tenantId:tenant.id,email:stale.email}}}));
   assert.equal(await db.outreachEvent.count({where:{contactId:stale.id,status:'QUEUED'}}),0);
   assert.equal(await db.usageLedger.count({where:{tenantId:tenant.id,kind:'VERIFICATION'}}),2,'each verification metered once');
   globalThis.fetch=originalFetch;
  });
  await t.test('failed verification exhausts retry budget and creates one alert',async()=>{
   const c=await db.contact.create({data:{tenantId:tenant.id,fullName:'Unverifiable',email:'unverifiable@example.com',reverifyRequestedAt:new Date()}});
   await db.outreachEvent.create({data:{tenantId:tenant.id,campaignId:campaign.id,contactId:c.id,status:'QUEUED'}});
   globalThis.fetch=async()=>new Response('{}',{status:503});
   for(let i=0;i<3;i++){await processReverification();await db.contact.update({where:{id:c.id},data:{verificationNextAt:new Date(0)}});}
   assert.equal(await processReverification(),false);
   await collectAlerts();await collectAlerts();
   assert.equal(await db.operationalAlert.count({where:{entityId:c.id,code:'verification_exhausted'}}),1);
   globalThis.fetch=originalFetch;
  });
  await t.test('alerts retry, sign and deduplicate; another tenant cannot read or acknowledge',async()=>{
   await db.operationalAlert.updateMany({where:{tenantId:tenant.id},data:{acknowledgedAt:new Date()}});
   const alert=await raiseAlert(tenant.id,'test_failure','synthetic-entity');
   assert.equal((await raiseAlert(tenant.id,'test_failure','synthetic-entity')).id,alert.id);
   process.env.ALERT_WEBHOOK_URL='https://alerts.example/ingest';process.env.ALERT_WEBHOOK_SECRET='test-signing-secret';
   await deliverAlert(new Date(),async()=>new Response(null,{status:503}));
   assert.equal((await db.operationalAlert.findUnique({where:{id:alert.id}})).deliveredAt,null);
   await db.operationalAlert.update({where:{id:alert.id},data:{nextAttemptAt:new Date(0)}});
   await deliverAlert(new Date(),async(url,options)=>{
    assert.equal(options.headers['Idempotency-Key'],alert.id);
    assert.equal(options.headers['X-LeadMelo-Signature'],createHmac('sha256',process.env.ALERT_WEBHOOK_SECRET).update(`${options.headers['X-LeadMelo-Timestamp']}.${options.body}`).digest('hex'));
    return new Response(null,{status:204});
   });
   assert.ok((await db.operationalAlert.findUnique({where:{id:alert.id}})).deliveredAt);
   assert.equal((await(await getAlerts(req('alerts','GET',undefined,otherCookie))).json()).length,0);
   assert.equal((await acknowledge(req('alerts','PATCH',{id:alert.id},otherCookie))).status,404);
   assert.equal((await acknowledge(req('alerts','PATCH',{id:alert.id}))).status,200);
  });
  await t.test('disconnect pauses active campaigns and prevents further Microsoft sends',async()=>{
   assert.equal((await disableM365(req('integrations/m365','DELETE'))).status,200);
   assert.equal((await db.campaign.findUnique({where:{id:campaign.id}})).status,'PAUSED');
   await assert.rejects(sendMicrosoft(tenant.id,key,input),/sender_not_allowed/);
  });
 } finally {globalThis.fetch=originalFetch;await db.$disconnect();}
});
