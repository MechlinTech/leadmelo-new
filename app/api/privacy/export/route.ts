import { z } from 'zod';
import { authenticate } from '../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../lib/http';
import { exportSubjectData } from '../../../../lib/privacy';

export const POST = endpoint(async req => {
  const user = await authenticate(req, true);
  const { email } = z.object({ email: z.string().trim().email().max(254) }).strict().parse(await jsonBody(req, 2048));
  return Response.json(await exportSubjectData(user.tenantId, user, email));
});
