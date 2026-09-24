import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError, jsonBody } from '../../../lib/http';
import { mergeConfig, readWorkspaceConfig, workspaceConfigInput, writeWorkspaceConfig } from '../../../lib/workspaceConfig';
import { db } from '../../../lib/db';

export const GET = endpoint(async req => {
  const user = await authenticate(req);
  return Response.json(await readWorkspaceConfig(user.tenantId));
});

export const PUT = endpoint(async req => {
  const user = await authenticate(req, true);
  if (!['TENANT_ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(user.role)) throw new HttpError(403, 'role_not_allowed');
  const parsed = workspaceConfigInput.parse(await jsonBody(req));
  const next = mergeConfig(parsed);
  await writeWorkspaceConfig(user.tenantId, next);
  await db.auditEvent.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'workspace_config_updated' } });
  return Response.json(next);
});
