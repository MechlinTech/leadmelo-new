import { db } from '../lib/db';
import { hashPassword } from '../lib/crypto';

async function main() {
  const password = process.env.SEED_PASSWORD ?? '';
  if (password.length < 16) throw new Error('Set SEED_PASSWORD to at least 16 characters');

  const accounts = [
    { email: 'admin@mechlintech.com', name: 'Tenant Admin', role: 'TENANT_ADMIN' as const },
    { email: 'manager@mechlintech.com', name: 'Manager', role: 'MANAGER' as const },
    { email: 'member@mechlintech.com', name: 'Member', role: 'MEMBER' as const },
    { email: 'operator@mechlintech.com', name: 'Super Admin', role: 'SUPER_ADMIN' as const }
  ];

  const hash = hashPassword(password);

  const tenant = await db.tenant.upsert({
    where: { slug: 'mechlin' },
    update: { name: 'Mechlin', plan: 'GROWTH' },
    create: { name: 'Mechlin', slug: 'mechlin', plan: 'GROWTH', settings: { create: {} } }
  });

  for (const account of accounts) {
    await db.user.upsert({
      where: { email: account.email },
      update: { passwordHash: hash, role: account.role, disabled: false, tenantId: tenant.id, name: account.name },
      create: { email: account.email, name: account.name, role: account.role, passwordHash: hash, tenantId: tenant.id }
    });
  }

  console.log(`Seeded ${accounts.length} users on tenant ${tenant.slug}`);
}

main().catch(e => { console.error(e.message || e); process.exitCode = 1; }).finally(() => db.$disconnect());
