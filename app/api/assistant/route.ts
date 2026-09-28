import { z } from 'zod';
import { db } from '../../../lib/db';
import { sessionCookie, sessionUser } from '../../../lib/auth';
import { endpoint, jsonBody } from '../../../lib/http';
import { publicGuard } from '../../../lib/public';
import { answer, redactQuestion } from '../../../lib/assistant/engine';

// Public, unauthenticated, rate-limited. Signed-in help is only available when a valid session cookie is present.
export const POST = endpoint(async req => {
  await publicGuard(req, 'assistant', 30, 10, 3000);
  const { message } = z.object({ message: z.string().max(500), audience: z.enum(['public', 'app']).optional() }).strict().parse(await jsonBody(req, 4096));
  const cookie = req.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${sessionCookie}=`));
  const signedIn = !!(await sessionUser(cookie?.slice(sessionCookie.length + 1)))?.tenantId;
  const audience = signedIn ? 'app' : 'public';
  const reply = answer(message, audience);
  if (reply.confidence === 'low' && message.trim().length > 3) await db.assistantQuestion.create({ data: { question: redactQuestion(message), audience } });
  return Response.json({ ...reply, audience });
});
