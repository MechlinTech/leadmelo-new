import { z } from 'zod';
import { authenticate } from '../../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../../lib/http';
import { cloneCampaign } from '../../../../../lib/campaignVersions';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return endpoint(async r => {
    const user = await authenticate(r, true);
    const { id } = await ctx.params;
    const { name } = z.object({ name: z.string().trim().min(1).max(200).optional() }).strict().parse(await jsonBody(r));
    return Response.json(await cloneCampaign(user.tenantId, id, user.id, name), { status: 201 });
  })(req);
}
