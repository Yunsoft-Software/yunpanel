import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const buildDebUrl = new URL('../../../scripts/build-deb.sh', import.meta.url);
const scriptUrl = new URL('../../../scripts/local-migration-backup.mjs', import.meta.url);

test('Debian build installs the migration backup CLI as an executable packaged script', async () => {
  const [buildScript, script] = await Promise.all([
    readFile(buildDebUrl, 'utf8'),
    readFile(scriptUrl, 'utf8'),
  ]);
  assert.match(buildScript, /install -m 0755 scripts\/local-migration-backup\.mjs .*\/usr\/lib\/yunpanel\/scripts\/local-migration-backup\.mjs/);
  assert.match(script, /^#!\/usr\/bin\/env node/m);
  assert.match(script, /\/var\/backups\/yunpanel/);
});
