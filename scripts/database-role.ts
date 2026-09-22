import { db } from '../lib/db';
async function main() {
  const password = process.env.APP_DB_PASSWORD;
  if (!password || !/^[a-fA-F0-9]{64}$/.test(password)) throw new Error('APP_DB_PASSWORD must be 64 hex characters');
  const exists = await db.$queryRaw<Array<{ rolname: string }>>`SELECT rolname FROM pg_roles WHERE rolname='leadmelo_app'`;
  // Role DDL cannot bind a password parameter; only a validated 64-character hex value is interpolated.
  if (!exists.length) await db.$executeRawUnsafe(`CREATE ROLE leadmelo_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  else await db.$executeRawUnsafe(`ALTER ROLE leadmelo_app PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  const database = process.env.POSTGRES_DB || 'leadmelo';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error('POSTGRES_DB must be a lowercase SQL identifier');
  await db.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${database} TO leadmelo_app`);
  await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO leadmelo_app');
  await db.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO leadmelo_app');
  await db.$executeRawUnsafe('REVOKE ALL ON TABLE "_prisma_migrations" FROM leadmelo_app');
  await db.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  console.log('Runtime database role configured');
}
main().catch(() => { console.error('Database role provisioning failed'); process.exitCode = 1; }).finally(() => db.$disconnect());
