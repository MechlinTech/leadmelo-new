import { z } from 'zod';
import { authenticate } from '../../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../../lib/http';
import { decideRecommendation } from '../../../../../lib/experiments';

// `id` is the recommendation id; the caller must belong to the recommendation's tenant.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return endpoint(async r => {
    const user = await authenticate(r, true);
    const { id } = await ctx.params;
    const { decision } = z.object({ decision: z.enum(['accept', 'reject']) }).strict().parse(await jsonBody(r, 1024));
    return Response.json(await decideRecommendation(user.tenantId, user, id, decision));
  })(req);
}
