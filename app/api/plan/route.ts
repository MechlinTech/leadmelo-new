import { authenticate } from '../../../lib/auth';
import { endpoint } from '../../../lib/http';
import { planState, usageNow } from '../../../lib/entitlements';
import { PLANS } from '../../../lib/plans';

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  const [state, usage] = await Promise.all([planState(user.tenantId), usageNow(user.tenantId)]);
  return Response.json({ plan: state.plan, name: PLANS[state.plan].name, enforced: state.enforced, trialDaysLeft: state.trialDaysLeft, trialExpired: state.trialExpired, limits: state.planLimits, usage });
});
