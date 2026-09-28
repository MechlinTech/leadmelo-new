import { db } from '../lib/db';
import { hashPassword } from '../lib/crypto';

async function main() {
  const { BOOTSTRAP_EMAIL: email, BOOTSTRAP_PASSWORD: password, BOOTSTRAP_TENANT: name, BOOTSTRAP_ROLE: requestedRole } = process.env;
  // TENANT_ADMIN by default. SUPER_ADMIN (platform operator: plans, suspension, access requests) must be asked for explicitly.
  const role = requestedRole === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'TENANT_ADMIN';
  if (requestedRole && requestedRole !== 'TENANT_ADMIN' && requestedRole !== 'SUPER_ADMIN') throw new Error('BOOTSTRAP_ROLE must be TENANT_ADMIN or SUPER_ADMIN');
  if (!email || !email.includes('@') || !password || password.length < 16 || !name) {
    throw new Error('Set BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD (16+ chars), BOOTSTRAP_TENANT');
  }
  if (await db.user.findUnique({ where: { email: email.toLowerCase() } })) throw new Error('User already exists; no changes made');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('Invalid tenant name');
  await db.tenant.create({ data: {
    name, slug, settings: { create: {} },
    users: { create: { email: email.toLowerCase(), role, passwordHash: hashPassword(password) } }
  } });
  console.log('Tenant and administrator created. Remove bootstrap password from the environment.');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
