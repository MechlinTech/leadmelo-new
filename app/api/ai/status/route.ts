import { db } from '../../../../lib/db';
import { authenticate } from '../../../../lib/auth';
import { endpoint } from '../../../../lib/http';
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  const s = await db.tenantSetting.findUnique({ where: { tenantId: user.tenantId } });
  const ready = !!s?.aiEnabled && !!s.aiBaseUrl && !!s.aiModel;
  return Response.json({ enabled: ready, features: ready ? s!.aiFeatures : [], canUse: user.role !== 'MEMBER' });
});
