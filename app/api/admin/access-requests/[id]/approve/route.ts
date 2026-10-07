import { authenticate } from '../../../../../../lib/auth';
import { endpoint } from '../../../../../../lib/http';
import { approveAccessRequest } from '../../../../../../lib/onboarding';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return endpoint(async r => {
    const user = await authenticate(r, true);
    const { id } = await ctx.params;
    return Response.json(await approveAccessRequest(id, user), { status: 201 });
  })(req);
}
