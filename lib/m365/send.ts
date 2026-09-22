import { createHash } from 'node:crypto';
import { db } from '../db';
import { GraphClient, MailInput, mailboxPath, mimeMessage } from './graph';

// Every state transition is committed BEFORE a remote side effect. An uncertain send
// can be read/reconciled but never automatically submitted a second time.
export async function sendMicrosoft(tenantId: string, key: string, input: MailInput, client?: GraphClient) {
  const config = await db.m365Connection.findUnique({where:{tenantId}});
  if (!config?.enabled || input.tenantId !== tenantId || !config.mailboxes.includes(input.from)) throw new Error('m365_sender_not_allowed');
  const graph = client ?? new GraphClient(config);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  let receipt = await db.mailReceipt.upsert({where:{key}, update:{}, create:{tenantId,key,requestHash:hash,mailbox:input.from}});
  if (receipt.tenantId !== tenantId || receipt.requestHash !== hash) throw new Error('m365_idempotency_conflict');
  if (receipt.status === 'ACCEPTED') return {messageId:receipt.draftId!};
  const base = mailboxPath(input.from);
  if (['SUBMITTING','AMBIGUOUS'].includes(receipt.status) && receipt.draftId) {
    const message = await graph.request(`${base}/messages/${encodeURIComponent(receipt.draftId)}?$select=id,isDraft,sentDateTime,internetMessageId,conversationId`);
    if (message.isDraft === false && message.sentDateTime && message.internetMessageId) {
      await db.mailReceipt.update({where:{key},data:{status:'ACCEPTED',error:null,internetMessageId:message.internetMessageId,conversationId:message.conversationId,sentConfirmedAt:new Date()}});
      return {messageId:receipt.draftId};
    }
    throw new Error('m365_send_ambiguous');
  }
  if (receipt.status === 'NEW') {
    const claimed = await db.mailReceipt.updateMany({where:{key,status:'NEW'},data:{status:'CREATING'}});
    if (!claimed.count) throw new Error('m365_send_in_progress');
    try {
      const message = await graph.request(`${base}/messages`, 'POST', mimeMessage(input,key), true);
      if (!message?.id) throw new Error('m365_draft_missing_id');
      receipt = await db.mailReceipt.update({where:{key},data:{status:'DRAFT',draftId:message.id,internetMessageId:message.internetMessageId,conversationId:message.conversationId}});
    } catch {
      await db.mailReceipt.update({where:{key},data:{status:'AMBIGUOUS',error:'draft_creation_uncertain'}});
      throw new Error('m365_send_ambiguous');
    }
  }
  if (receipt.status !== 'DRAFT' || !receipt.draftId) throw new Error('m365_send_ambiguous');
  const claimed = await db.mailReceipt.updateMany({where:{key,status:'DRAFT'},data:{status:'SUBMITTING'}});
  if (!claimed.count) throw new Error('m365_send_in_progress');
  try {
    await graph.request(`${base}/messages/${encodeURIComponent(receipt.draftId)}/send`, 'POST');
    await db.mailReceipt.update({where:{key},data:{status:'ACCEPTED',error:null}});
    return {messageId:receipt.draftId};
  } catch {
    await db.mailReceipt.update({where:{key},data:{status:'AMBIGUOUS',error:'send_acceptance_uncertain'}});
    throw new Error('m365_send_ambiguous');
  }
}
