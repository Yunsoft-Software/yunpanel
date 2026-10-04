import { spawnSync } from 'node:child_process';
import process from 'node:process';

const userArgs = process.argv.slice(2);
const args = userArgs.length > 0
  ? userArgs.map((a) => (a.startsWith('apps/api/') ? a.slice('apps/api/'.length) : a))
  : ['test/**/*.test.js'];

const result = spawnSync(process.execPath, ['--test', ...args], { stdio: 'inherit' });
process.exit(result.status ?? 0);
