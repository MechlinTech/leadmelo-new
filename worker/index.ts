import { db } from '../lib/db';
import { tick } from '../lib/worker';
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function main() {
  while (!stopping) {
    try { await tick(); }
    // A tick that throws is the only trace of a scheduler-wide fault; log the cause, or the
    // operator sees "worker_tick_failed" with nothing to act on.
    catch (error) { console.error(JSON.stringify({ event: 'worker_tick_failed', at: new Date().toISOString(), error: error instanceof Error ? (error.stack ?? error.message) : String(error) })); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
main().finally(() => db.$disconnect());
