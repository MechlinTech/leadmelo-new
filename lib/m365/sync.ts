import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db';
import { handleProviderEvent, suppress } from '../webhooks';
import { classifyReply } from '../replies';
import { raiseAlert } from '../alerts';
import { GraphClient, GraphError, mailboxPath } from './graph';

// Reject untrusted next links, including links for a different mailbox.
export function validateDeltaLink(link: string, mailbox: string) {
  const url = new URL(link);
  const expected = `${mailboxPath(mailbox)}/mailFolders/inbox/messages/delta`;
  if (url.origin !== 'https://graph.microsoft.com' || decodeURIComponent(url.pathname).toLowerCase() !== decodeURIComponent(expected).toLowerCase() || url.username || url.password || url.hash) throw new Error('m365_invalid_delta_link');
  return link;
}
// ---- delivery-failure (bounce) notices ----
// Exchange and other servers reply to the sender with a notice from a system address. Without this, bounces
// would never reach the health calculation and a bad list would look clean.
const SYSTEM_SENDER = /^(mailer-daemon|postmaster|mailerdaemon|mail-delivery-subsystem|microsoftexchange[0-9a-f]+)@/i;
export function isBounceNotice(from: string, subject?: string | null) {
  return SYSTEM_SENDER.test(from) && /(undeliverable|delivery status notification|delivery has failed|mail delivery failed|returned mail|failure notice|couldn't be delivered|not delivered)/i.test(subject ?? '');
}
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export function bounceRecipients(body: string, mailbox: string) {
  const text = body.replace(/<[^>]+>/g, ' ');
  return [...new Set((text.match(EMAIL_IN_TEXT) ?? []).map(x => x.toLowerCase()))].filter(x => x !== mailbox.toLowerCase() && !SYSTEM_SENDER.test(x));
}
// Suppresses a contact only when exactly one address in the notice is a contact THIS mailbox emailed in the
// last 30 days. Anything else raises an alert for a person; it never guesses.
export async function handleBounceNotice(tenantId: string, mailbox: string, eventId: string, message: { uniqueBody?: { content?: string } }) {
  const candidates = bounceRecipients(message.uniqueBody?.content ?? '', mailbox);
  const sentSince = new Date(Date.now() - 30 * 86400000);
  const contacts = candidates.length ? await db.contact.findMany({ where: { tenantId, email: { in: candidates }, outreachEvents: { some: { status: 'SENT', sentAt: { gte: sentSince }, campaign: { senderEmail: mailbox } } } }, select: { id: true, email: true, outreachEvents: { where: { status: 'SENT', campaign: { senderEmail: mailbox } }, orderBy: { sentAt: 'desc' }, take: 1, select: { campaignId: true } } } }) : [];
  if (contacts.length === 1 && contacts[0].outreachEvents[0]?.campaignId && contacts[0].email) {
    await handleProviderEvent(tenantId, { id: eventId, type: 'bounce', campaignId: contacts[0].outreachEvents[0].campaignId, email: contacts[0].email, occurredAt: new Date().toISOString() });
    return 'bounce_recorded' as const;
  }
  await db.webhookEvent.upsert({ where: { tenantId_providerEventId: { tenantId, providerEventId: eventId } }, update: {}, create: { tenantId, providerEventId: eventId, type: 'bounce.unattributed' } });
  await raiseAlert(tenantId, 'bounce_notice_unattributed', eventId);
  return 'bounce_unattributed' as const;
}

export async function pollMicrosoft(now = new Date(), suppliedClient?: GraphClient) {
  const cursor = await db.mailCursor.findFirst({where:{nextPollAt:{lte:now},OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]},orderBy:{nextPollAt:'asc'}});
  if (!cursor) return false;
  const connection = await db.m365Connection.findUnique({where:{tenantId:cursor.tenantId}});
  if (!connection?.enabled || !connection.mailboxes.includes(cursor.mailbox)) {
    await db.mailCursor.update({where:{id:cursor.id},data:{nextPollAt:new Date(now.getTime()+300000)}}); return false;
  }
  const token = randomUUID();
  const claim = await db.mailCursor.updateMany({where:{id:cursor.id,OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]},data:{leaseToken:token,leaseUntil:new Date(now.getTime()+120000)}});
  if (!claim.count) return false;
  const graph = suppliedClient ?? new GraphClient(connection);
  try {
    // 202 means accepted, not sent. Resolve the final Internet Message-ID from
    // Sent Items before advancing reply cursors, including delayed sent copies.
    const pending = await db.mailReceipt.findMany({where:{tenantId:cursor.tenantId,mailbox:cursor.mailbox,status:'ACCEPTED',sentConfirmedAt:null},orderBy:{createdAt:'asc'},take:20});
    for (const receipt of pending) {
      if (!receipt.draftId) throw new Error('m365_missing_draft');
      const message = await graph.request(`${mailboxPath(cursor.mailbox)}/messages/${encodeURIComponent(receipt.draftId)}?$select=id,isDraft,sentDateTime,internetMessageId,conversationId`);
      if (message.isDraft !== false || !message.sentDateTime || !message.internetMessageId) throw new Error('m365_sent_copy_pending');
      await db.mailReceipt.update({where:{id:receipt.id},data:{internetMessageId:message.internetMessageId,conversationId:message.conversationId,sentConfirmedAt:new Date()}});
      await db.mailCursor.updateMany({where:{id:cursor.id,leaseToken:token},data:{leaseUntil:new Date(Date.now()+120000)}});
    }
    if (await db.mailReceipt.count({where:{tenantId:cursor.tenantId,mailbox:cursor.mailbox,status:'ACCEPTED',sentConfirmedAt:null}})) throw new Error('m365_sent_copy_backlog');
    const initial = `https://graph.microsoft.com${mailboxPath(cursor.mailbox)}/mailFolders/inbox/messages/delta?$select=id,from,receivedDateTime&$filter=receivedDateTime ge ${connection.connectedAt.toISOString()}&$top=5`;
    const page = await graph.request(cursor.cursor ? validateDeltaLink(cursor.cursor,cursor.mailbox) : initial);
    if (!Array.isArray(page.value) || page.value.length>100) throw new Error('m365_invalid_page');
    for (const item of page.value) {
      const owned = await db.mailCursor.updateMany({where:{id:cursor.id,leaseToken:token},data:{leaseUntil:new Date(Date.now()+120000)}});
      if (!owned.count) return true;
      await db.workerHeartbeat.upsert({where:{id:'scheduler'},update:{updatedAt:new Date()},create:{id:'scheduler'}});
      if (item['@removed'] || !item.id) continue;
      // IDs make replay safe; even pages partially processed before a crash are replayable.
      const eventId = `m365:${createHash('sha256').update(`${cursor.mailbox}:${item.id}`).digest('hex')}`;
      if (await db.webhookEvent.findUnique({where:{tenantId_providerEventId:{tenantId:cursor.tenantId,providerEventId:eventId}}})) continue;
      const message = await graph.request(`${mailboxPath(cursor.mailbox)}/messages/${encodeURIComponent(item.id)}?$select=id,from,subject,receivedDateTime,uniqueBody,internetMessageHeaders`);
      const email = message.from?.emailAddress?.address?.toLowerCase();
      if (!email || !message.receivedDateTime || new Date(message.receivedDateTime)<connection.connectedAt) continue;
      if (isBounceNotice(email, message.subject)) { await handleBounceNotice(cursor.tenantId, cursor.mailbox, eventId, message); continue; }
      const refs: string[] = (message.internetMessageHeaders ?? []).filter((h:any)=>['in-reply-to','references'].includes(h.name.toLowerCase())).flatMap((h:any)=>h.value.match(/<[^<>\s]+>/g) ?? []);
      const receipts = await db.mailReceipt.findMany({where:{tenantId:cursor.tenantId,mailbox:cursor.mailbox,internetMessageId:{in:refs},status:{in:['ACCEPTED','SUBMITTING','AMBIGUOUS']}},take:20});
      const matches = await db.outreachEvent.findMany({where:{tenantId:cursor.tenantId,idempotencyKey:{in:receipts.map(r=>r.key)},contact:{email}},select:{campaignId:true,contactId:true}});
      const campaigns = [...new Set(matches.map(m=>m.campaignId).filter(Boolean))];
      const raw = message.uniqueBody?.contentType?.toLowerCase()==='text' ? message.uniqueBody.content : '';
      if (campaigns.length!==1) {
        // A known buyer's new thread may lack References. Stop outreach safely
        // across that buyer's campaigns; never invent a booking attribution.
        const known = await db.contact.findUnique({where:{tenantId_email:{tenantId:cursor.tenantId,email}}});
        if (known) {
          await db.$transaction(async tx => {
            await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${cursor.tenantId} FOR UPDATE`;
            await tx.enrollment.updateMany({where:{tenantId:cursor.tenantId,contactId:known.id,stoppedAt:null},data:{stoppedAt:new Date(),stopReason:'reply_attribution_review'}});
            await tx.outreachEvent.updateMany({where:{tenantId:cursor.tenantId,contactId:known.id,status:{in:['QUEUED','SENDING']}},data:{status:'CANCELED',error:'reply_attribution_review'}});
            if (classifyReply(raw) === 'NEGATIVE') await suppress(tx,cursor.tenantId,email,'negative_reply');
            await tx.webhookEvent.upsert({where:{tenantId_providerEventId:{tenantId:cursor.tenantId,providerEventId:eventId}},update:{},create:{tenantId:cursor.tenantId,providerEventId:eventId,type:'reply.unattributed'}});
            const key = `${cursor.tenantId}:reply_attribution_review:${eventId}`;
            await tx.operationalAlert.upsert({where:{key},update:{},create:{tenantId:cursor.tenantId,key,code:'reply_attribution_review',entityId:eventId}});
          });
        }
        continue;
      }
      // uniqueBody avoids classifying our own quoted pitch as the buyer's intent.
      await handleProviderEvent(cursor.tenantId,{id:eventId,type:'reply',campaignId:campaigns[0]!,email,occurredAt:message.receivedDateTime,text:raw.trim().slice(0,2000)||'[Reply body unavailable; manual review required]'});
    }
    const next = page['@odata.nextLink'] ?? page['@odata.deltaLink'];
    if (!next) throw new Error('m365_missing_delta_link');
    validateDeltaLink(next,cursor.mailbox);
    await db.mailCursor.updateMany({where:{id:cursor.id,leaseToken:token},data:{cursor:next,leaseUntil:null,error:page['@odata.nextLink']?'mail_sync_backlog':null,...(!page['@odata.nextLink']?{lastSuccessAt:now}:{}),nextPollAt:new Date(now.getTime()+(page['@odata.nextLink']?0:60000))}});
  } catch(error) {
    const expired = error instanceof GraphError && error.status===410;
    await db.mailCursor.updateMany({where:{id:cursor.id,leaseToken:token},data:{...(expired?{cursor:null}:{}),leaseUntil:null,error:expired?'delta_expired_replaying':'mail_sync_failed',nextPollAt:new Date(now.getTime()+60000)}});
    await raiseAlert(cursor.tenantId,'mail_sync_failed',cursor.id);
  }
  return true;
}
