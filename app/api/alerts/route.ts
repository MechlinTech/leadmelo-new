import { z } from 'zod';
import { authenticate } from '../../../lib/auth';
import { db } from '../../../lib/db';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await db.operationalAlert.findMany({where:{tenantId:user.tenantId,acknowledgedAt:null},orderBy:{createdAt:'desc'},take:100}));
});
export const PATCH = endpoint(async req => {
  const user = await authenticate(req,true);
  const {id} = z.object({id:z.string()}).strict().parse(await jsonBody(req));
  const result = await db.operationalAlert.updateMany({where:{id,tenantId:user.tenantId},data:{acknowledgedAt:new Date()}});
  if (!result.count) throw new HttpError(404,'alert_not_found');
  return Response.json({ok:true});
});
