import { db } from '../../../../lib/db';
import { authenticate } from '../../../../lib/auth';
import { encrypt } from '../../../../lib/crypto';
import { endpoint, HttpError, jsonBody } from '../../../../lib/http';
import { connectionInput } from '../../../../lib/m365/graph';

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  const connection = await db.m365Connection.findUnique({where:{tenantId:user.tenantId},select:{directoryId:true,clientId:true,mailboxes:true,enabled:true,connectedAt:true}});
  return Response.json({connection});
});
export const PUT = endpoint(async req => {
  const user = await authenticate(req,true);
  if (!['TENANT_ADMIN','SUPER_ADMIN'].includes(user.role)) throw new HttpError(403,'admin_required');
  const input = connectionInput.parse(await jsonBody(req));
  const existing = await db.m365Connection.findUnique({where:{tenantId:user.tenantId}});
  if (existing && (existing.directoryId !== input.directoryId || existing.clientId !== input.clientId || JSON.stringify(existing.mailboxes) !== JSON.stringify(input.mailboxes))) throw new HttpError(409,'connection_identity_change_requires_migration');
  await db.$transaction(async tx => {
    await tx.m365Connection.upsert({where:{tenantId:user.tenantId},update:{encryptedSecret:encrypt(input.clientSecret),enabled:true},create:{tenantId:user.tenantId,directoryId:input.directoryId,clientId:input.clientId,encryptedSecret:encrypt(input.clientSecret),mailboxes:input.mailboxes}});
    for (const mailbox of input.mailboxes) await tx.mailCursor.upsert({where:{tenantId_mailbox:{tenantId:user.tenantId,mailbox}},update:{},create:{tenantId:user.tenantId,mailbox}});
    await tx.auditEvent.create({data:{tenantId:user.tenantId,actorUserId:user.id,action:'m365_configured'}});
  });
  return Response.json({ok:true,liveVerified:false});
});
export const DELETE = endpoint(async req => {
  const user = await authenticate(req,true);
  if (!['TENANT_ADMIN','SUPER_ADMIN'].includes(user.role)) throw new HttpError(403,'admin_required');
  await db.$transaction(async tx => {
    await tx.m365Connection.updateMany({where:{tenantId:user.tenantId},data:{enabled:false}});
    await tx.campaign.updateMany({where:{tenantId:user.tenantId,status:'ACTIVE'},data:{status:'PAUSED'}});
    await tx.auditEvent.create({data:{tenantId:user.tenantId,actorUserId:user.id,action:'m365_disabled_campaigns_paused'}});
  });
  return Response.json({ok:true});
});
