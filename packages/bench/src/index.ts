/**
 * Run all three benches end-to-end. Useful for a single "show me the numbers"
 * report.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const benches = ['wire.ts', 'handoff.ts', 'live.ts'];

for (const b of benches) {
  console.log(`\n${'═'.repeat(72)}\n  ${b}\n${'═'.repeat(72)}\n`);
  const r = spawnSync('npx', ['tsx', join(here, b)], { stdio: 'inherit', shell: true });
  if (r.status !== 0 && b !== 'live.ts') process.exit(r.status ?? 1);
}
