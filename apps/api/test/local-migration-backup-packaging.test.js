import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const buildDebUrl = new URL('../../../scripts/build-deb.sh', import.meta.url);
const scriptUrl = new URL('../../../scripts/local-migration-backup.mjs', import.meta.url);
const backupCoreUrl = new URL('../src/local-migration-backup.js', import.meta.url);
const runbookUrl = new URL('../../../docs/local-migration-backup.md', import.meta.url);

test('Debian build installs the migration backup CLI and runbook', async () => {
  const [buildScript, script, backupCore, runbook] = await Promise.all([
    readFile(buildDebUrl, 'utf8'),
    readFile(scriptUrl, 'utf8'),
    readFile(backupCoreUrl, 'utf8'),
    readFile(runbookUrl, 'utf8'),
  ]);
  assert.match(buildScript, /install -m 0755 scripts\/local-migration-backup\.mjs .*\/usr\/lib\/yunpanel\/scripts\/local-migration-backup\.mjs/);
  assert.match(buildScript, /docs\/local-migration-backup\.md/);
  assert.match(script, /^#!\/usr\/bin\/env node/m);
  assert.match(script, /localMigrationBackupInternals\.defaultRoot/);
  assert.match(backupCore, /const DEFAULT_ROOT = '\/var\/backups\/yunpanel';/);
  assert.match(runbook, /local-migration-backup\.mjs create --confirm/);
  assert.match(runbook, /local-migration-backup\.mjs verify \/var\/backups\/yunpanel\/migration-<timestamp>/);
});
