import { z } from 'zod';
import { authenticate } from '../../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../../lib/http';
import { rollbackCampaign } from '../../../../../lib/campaignVersions';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return endpoint(async r => {
    const user = await authenticate(r, true);
    const { id } = await ctx.params;
    const { version } = z.object({ version: z.number().int().min(1) }).strict().parse(await jsonBody(r));
    const result = await rollbackCampaign(user.tenantId, id, version, user.id);
    return Response.json({ version: result.version, campaign: result.campaign });
  })(req);
}
