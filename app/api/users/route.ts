import { db } from '../../../lib/db';
import { authenticate } from '../../../lib/auth';
import { endpoint, HttpError } from '../../../lib/http';

// Team list for administrators (used by the Team table and password-reset issuance). Tenant-scoped; no hashes or secrets.
export const GET = endpoint(async req => {
  const user = await authenticate(req);
  if (!['TENANT_ADMIN', 'SUPER_ADMIN'].includes(user.role)) throw new HttpError(403, 'admin_required');
  const rows = await db.user.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'asc' }, take: 200, select: { id: true, email: true, name: true, role: true, disabled: true, mfaEnabledAt: true, createdAt: true } });
  return Response.json(rows.map(r => ({ id: r.id, email: r.email, name: r.name, role: r.role, disabled: r.disabled, mfaEnabled: !!r.mfaEnabledAt, you: r.id === user.id })));
});
