import { z } from 'zod';
import { db } from './db';
import { gateway } from './providers';
import { suppress } from './webhooks';

export const verificationResult = z.object({email:z.string().email(), verification:z.enum(['VALID','INVALID','RISKY','UNKNOWN']), verifiedAt:z.string().datetime()}).strict();
export async function processReverification(now = new Date()) {
  if (process.env.OUTBOUND_ENABLED !== 'true') return false;
  const c = await db.contact.findFirst({where:{reverifyRequestedAt:{not:null},verificationAttempts:{lt:3},verificationNextAt:{lte:now},OR:[{verificationLeaseUntil:null},{verificationLeaseUntil:{lt:now}}],tenant:{settings:{automationEnabled:true}},outreachEvents:{some:{status:'QUEUED',campaign:{status:'ACTIVE',automationMode:{not:'PAUSED'}}}}},orderBy:{verificationNextAt:'asc'}});
  if (!c?.email) return false;
  const settings = await db.tenantSetting.findUnique({where:{tenantId:c.tenantId}});
  if (!settings?.gatewayKey) return false;
  const claimed = await db.contact.updateMany({where:{id:c.id,verificationAttempts:c.verificationAttempts,OR:[{verificationLeaseUntil:null},{verificationLeaseUntil:{lt:now}}]},data:{verificationAttempts:{increment:1},verificationLeaseUntil:new Date(now.getTime()+120000)}});
  if (!claimed.count) return false;
  try {
    const result = await gateway(settings.gatewayKey,'verify',`verify:${c.id}:${c.reverifyRequestedAt!.toISOString()}`,{tenantId:c.tenantId,contactId:c.id,email:c.email},verificationResult);
    const checked = new Date(result.verifiedAt);
    if (result.email.toLowerCase() !== c.email.toLowerCase() || checked > now || now.getTime()-checked.getTime()>3600000) throw new Error('invalid_verification_evidence');
    if (result.verification === 'UNKNOWN') throw new Error('verification_pending');
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${c.tenantId} FOR UPDATE`;
      await tx.contact.update({where:{id:c.id},data:{verification:result.verification,lastVerifiedAt:checked,reverifyRequestedAt:null,verificationAttempts:0,verificationLeaseUntil:null}});
      const meterKey = `verify:${c.id}:${c.reverifyRequestedAt!.toISOString()}`;
      await tx.usageLedger.upsert({ where: { tenantId_idempotencyKey: { tenantId: c.tenantId, idempotencyKey: meterKey } }, update: {}, create: { tenantId: c.tenantId, kind: 'VERIFICATION', quantity: 1, costCents: 0, idempotencyKey: meterKey } });
      if (result.verification !== 'VALID') await suppress(tx,c.tenantId,c.email!,'reverification_failed');
      else await tx.outreachEvent.updateMany({where:{tenantId:c.tenantId,contactId:c.id,status:'QUEUED',error:'reverification_required'},data:{scheduledAt:now,error:null}});
    });
  } catch {
    await db.contact.update({where:{id:c.id},data:{verificationLeaseUntil:null,verificationNextAt:new Date(now.getTime()+60000*2**c.verificationAttempts)}});
  }
  return true;
}
