// Local development only: an in-memory PostgreSQL (PGlite) on 127.0.0.1:55440 with all migrations
// applied. Data is lost when this process exits. Never use for staging or production.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';

const port = 55440;
const pg = await PGlite.create();
const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1', maxConnections: 10 });
await server.start();
const env = { ...process.env, DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?connection_limit=1` };
// Must be async: the database runs in this process, so blocking the event loop would deadlock it.
const status = await new Promise(resolve => spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, stdio: 'inherit' }).on('exit', resolve));
if (status !== 0) { await server.stop(); process.exit(1); }
console.log(`DEV_DATABASE_READY ${env.DATABASE_URL}`);
const stop = async () => { await server.stop(); await pg.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
