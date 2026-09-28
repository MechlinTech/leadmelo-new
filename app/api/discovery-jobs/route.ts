import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError } from '../../../lib/http';
export const POST = endpoint(async req => {
  await authenticate(req, true);
  throw new HttpError(410, 'use_campaigns_and_automation_runs');
});
