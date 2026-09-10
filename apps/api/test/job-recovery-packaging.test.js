import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootPackageUrl = new URL('../../../package.json', import.meta.url);
const buildDebUrl = new URL('../../../scripts/build-deb.sh', import.meta.url);

test('root package exposes the read-only job recovery status CLI', async () => {
  const packageJson = JSON.parse(await readFile(rootPackageUrl, 'utf8'));
  assert.equal(packageJson.scripts['job-recovery'], 'node scripts/job-recovery.mjs');
});

test('Debian package installs the job recovery entry point executable', async () => {
  const buildScript = await readFile(buildDebUrl, 'utf8');
  assert.match(buildScript, /install -m 0755 scripts\/job-recovery\.mjs .*\/usr\/lib\/yunpanel\/scripts\/job-recovery\.mjs/);
});
