import { createHash } from 'node:crypto';
import { db } from '../db';
import { nonBlankEnv } from '../security';
import { GraphClient, GraphError, MailInput, emailBodyContentType, mailInput, mailboxPath, mimeMessage } from './graph';

// Logs identify a recipient without disclosing the address.
const hashRecipient = (email: string) => createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12);

// Every state transition is committed BEFORE a remote side effect. An uncertain send
// can be read/reconciled but never automatically submitted a second time.
// One workspace notice from the first connected mailbox. Returns false when Microsoft is not connected.
export async function sendWorkspaceNotice(tenantId: string, to: string, subject: string, text: string) {
  const config = await db.m365Connection.findUnique({ where: { tenantId } });
  const from = config?.enabled ? config.mailboxes[0] : undefined;
  if (!from || /[\r\n]/.test(to) || /[\r\n]/.test(subject)) return false;
  const graph = new GraphClient(config!);
  await graph.request(`${mailboxPath(from)}/sendMail`, 'POST', JSON.stringify({
    message: {
      subject,
      body: { contentType: 'Text', content: text },
      toRecipients: [{ emailAddress: { address: to } }]
    },
    saveToSentItems: true
  }));
  return true;
}

// Platform notices (access-request confirmations, account-ready mail, password-reset links)
// are delivered from the first connected Microsoft 365 mailbox on this installation, or
// PLATFORM_MAIL_TENANT_ID's. `send` is injectable so tests can stub the remote side effect.
export async function sendPlatformNotice(to: string, subject: string, text: string, send: typeof sendWorkspaceNotice = sendWorkspaceNotice) {
  // nonBlankEnv, not ??: an empty PLATFORM_MAIL_TENANT_ID must fall back to the connected
  // mailbox, not disable every notice and look like "no mailbox configured".
  const tenantId = nonBlankEnv(process.env.PLATFORM_MAIL_TENANT_ID)
    || (await db.m365Connection.findFirst({ where: { enabled: true }, select: { tenantId: true } }))?.tenantId;
  if (!tenantId) return false;
  return send(tenantId, to, subject, text);
}

export async function sendMicrosoft(tenantId: string, key: string, input: MailInput, client?: GraphClient) {
  mailInput.parse(input);
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
  // A receipt parked in SUBMITTING/AMBIGUOUS with no draftId has nothing to reconcile: the
  // send step only runs once a draftId is known, so this message cannot have reached anyone.
  // Leaving it here made it permanently unsendable (the DRAFT check below could never pass).
  // Recovering it to NEW is safe: at worst an orphaned, unsent draft is left in the sender's
  // own mailbox, which is not a duplicate delivery to the recipient.
  if (['SUBMITTING','AMBIGUOUS'].includes(receipt.status) && !receipt.draftId) {
    console.error(JSON.stringify({ event: 'm365_send_recovered', key, previousStatus: receipt.status, previousError: receipt.error }));
    receipt = await db.mailReceipt.update({where:{key},data:{status:'NEW',error:'recovered_without_draft'}});
  }
  if (receipt.status === 'NEW') {
    const claimed = await db.mailReceipt.updateMany({where:{key,status:'NEW'},data:{status:'CREATING'}});
    if (!claimed.count) throw new Error('m365_send_in_progress');
    try {
      // Diagnostics only: message key, subject/body lengths, content type and provider status.
      // Never logs the body text, recipient address, credentials or tokens.
      console.log(JSON.stringify({ event: 'm365_send_attempt', messageId: key, subjectLength: input.subject.length, bodyLength: input.body.length, contentType: emailBodyContentType(input.body), recipientHash: hashRecipient(input.to) }));
      const message = await graph.request(`${base}/messages`, 'POST', mimeMessage(input,key), true);
      if (!message?.id) throw new Error('m365_draft_missing_id');
      console.log(JSON.stringify({ event: 'm365_draft_created', key, draftId: message.id, providerStatus: 'ok' }));
      receipt = await db.mailReceipt.update({where:{key},data:{status:'DRAFT',draftId:message.id,internetMessageId:message.internetMessageId,conversationId:message.conversationId}});
    } catch (error) {
      // A definitive HTTP rejection means Microsoft answered and refused the request,
      // so no draft exists and the recipient cannot have been sent anything. Recording
      // this as AMBIGUOUS left a row with no draftId, which could never advance past
      // the DRAFT check below: one transient 503 or one bad request bricked the message
      // permanently. Resetting to NEW lets the next attempt create a fresh draft. Even
      // if a 5xx did leave a draft behind on the server, only the draftId recorded here
      // is ever sent, so the recipient still receives exactly one message.
      // 408 is the one case that is genuinely unknown — the request may or may not have
      // been processed — so it must be reconciled rather than resubmitted.
      if (error instanceof GraphError && error.status !== 408) {
        await db.mailReceipt.update({where:{key},data:{status:'NEW',error:`draft_rejected_${error.status}`}});
        throw new Error(`m365_draft_rejected_${error.status}`);
      }
      // Only a timeout, a dropped connection or an unparseable response leaves it
      // genuinely unknown whether a draft was created. Those must be reconciled,
      // never blindly resubmitted.
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
    console.log(JSON.stringify({ event: 'm365_send_accepted', messageId: receipt.draftId, bodyLength: input.body.length, contentType: emailBodyContentType(input.body) }));
    return {messageId:receipt.draftId};
  } catch (error) {
    console.error(JSON.stringify({ event: 'm365_send_uncertain', key, draftId: receipt.draftId, error: error instanceof Error ? error.message : 'unknown' }));
    await db.mailReceipt.update({where:{key},data:{status:'AMBIGUOUS',error:'send_acceptance_uncertain'}});
    throw new Error('m365_send_ambiguous');
  }
}
