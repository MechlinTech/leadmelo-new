import { authenticate } from '../../../../../lib/auth';
import { endpoint } from '../../../../../lib/http';
import { createReset } from '../../../../../lib/identity';

// Administrator-initiated reset; the one-time link is returned for the admin to deliver.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return endpoint(async r => {
    const user = await authenticate(r, true);
    const { id } = await ctx.params;
    const { token, expiresAt } = await createReset(user, id);
    return Response.json({ resetUrl: `${process.env.APP_URL}/auth/reset?token=${token}`, expiresAt }, { status: 201 });
  })(req);
}
