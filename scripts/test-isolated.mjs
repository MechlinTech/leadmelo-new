import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
const pg = await PGlite.create();
const port = 55439;
const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1', maxConnections: 10 });
await server.start();
const env = { ...process.env, DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?connection_limit=1`, NODE_ENV: 'test', TEST_DATABASE_CONFIRM: 'isolated', TEST_PGLITE: 'true', SENDER_HEALTH_AUTO: 'off' };
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Command exited ${code}`)));
  });
}
try {
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  // PGlite shares a session across socket clients. Prisma's statement names
  // restart in each test process, unlike separate native PostgreSQL sessions.
  for (const file of ['tests/integration/engine.test.mjs', 'tests/integration/reliability.test.mjs', 'tests/integration/calendly.test.mjs', 'tests/integration/versions_usage.test.mjs', 'tests/integration/identity.test.mjs', 'tests/integration/ops.test.mjs', 'tests/integration/privacy.test.mjs', 'tests/integration/experiments.test.mjs', 'tests/integration/growth.test.mjs', 'tests/integration/ai.test.mjs']) {
    await pg.exec('DEALLOCATE ALL');
    await run(['--import', 'tsx', '--test', file]);
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await server.stop(); await pg.close(); }
