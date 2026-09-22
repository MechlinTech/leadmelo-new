import { db } from '../lib/db';
import { tick } from '../lib/worker';
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function main() {
  while (!stopping) {
    try { await tick(); }
    catch { console.error(JSON.stringify({ event: 'worker_tick_failed', at: new Date().toISOString() })); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
main().finally(() => db.$disconnect());
