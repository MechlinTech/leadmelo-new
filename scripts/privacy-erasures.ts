import { readFileSync } from 'node:fs';
import { db } from '../lib/db';
import { exportErasureLedger, reapplyErasures } from '../lib/privacy';

// export                 -> prints the erasure ledger as JSON (encrypt it and store it apart from DB backups)
// reapply <ledger.json>  -> re-erases and re-suppresses everyone in the ledger; run after EVERY restore
//                           ("-" reads the ledger from standard input)
async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === 'export') console.log(JSON.stringify(await exportErasureLedger()));
  else if (command === 'reapply' && file) console.log(JSON.stringify(await reapplyErasures(JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')))));
  else { console.error('usage: privacy-erasures.ts export | reapply <ledger.json | ->'); process.exitCode = 2; }
}
main().catch(() => { console.error('privacy erasure command failed'); process.exitCode = 1; }).finally(() => db.$disconnect());
