import { spawnSync } from 'node:child_process';
import process from 'node:process';

const userArgs = process.argv.slice(2);
const args = userArgs.length > 0
  ? userArgs.map((a) => (a.startsWith('apps/api/') ? a.slice('apps/api/'.length) : a))
  : ['test/**/*.test.js'];

// A hung test must fail with its name instead of blocking the whole suite forever.
// Do not add --test-force-exit: it silently drops late-registered tests (5237 -> ~5200).
// Bound file-process pressure on the 8 GiB development machine. Tests still run
// their own concurrent SQLite workers and HTTP clients without serialization.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=120000', ...args], { stdio: 'inherit' });
process.exit(result.status ?? 0);
