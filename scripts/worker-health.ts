import { db } from '../lib/db';
db.workerHeartbeat.findFirst({ where: { updatedAt: { gt: new Date(Date.now() - 120000) } } })
  .then(row => { if (!row) process.exitCode = 1; })
  .catch(() => { process.exitCode = 1; })
  .finally(() => db.$disconnect());
