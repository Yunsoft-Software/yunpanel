import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const buildDebUrl = new URL('../../../scripts/build-deb.sh', import.meta.url);
const scriptUrl = new URL('../../../scripts/local-migration-backup.mjs', import.meta.url);
const backupCoreUrl = new URL('../src/local-migration-backup.js', import.meta.url);
const previewCoreUrl = new URL('../src/local-migration-restore-preview.js', import.meta.url);
const archiveInspectionUrl = new URL('../src/local-migration-archive-inspection.js', import.meta.url);
const unixIdentityUrl = new URL('../src/local-migration-unix-identity.js', import.meta.url);
const stageCoreUrl = new URL('../src/local-migration-restore-stage.js', import.meta.url);
const runbookUrl = new URL('../../../docs/local-migration-backup.md', import.meta.url);

test('Debian build installs the migration backup CLI, restore rehearsal source and runbook', async () => {
  const [
    buildScript,
    script,
    backupCore,
    previewCore,
    archiveInspection,
    unixIdentity,
    stageCore,
    runbook,
  ] = await Promise.all([
    readFile(buildDebUrl, 'utf8'),
    readFile(scriptUrl, 'utf8'),
    readFile(backupCoreUrl, 'utf8'),
    readFile(previewCoreUrl, 'utf8'),
    readFile(archiveInspectionUrl, 'utf8'),
    readFile(unixIdentityUrl, 'utf8'),
    readFile(stageCoreUrl, 'utf8'),
    readFile(runbookUrl, 'utf8'),
  ]);

  assert.match(buildScript, /install -m 0755 scripts\/local-migration-backup\.mjs .*\/usr\/lib\/yunpanel\/scripts\/local-migration-backup\.mjs/);
  assert.match(buildScript, /docs\/local-migration-backup\.md/);
  assert.match(buildScript, /cp -a apps\/api apps\/agent apps\/web .*\/usr\/lib\/yunpanel\/apps\//);

  assert.match(script, /^#!\/usr\/bin\/env node/m);
  assert.match(script, /localMigrationBackupInternals\.defaultRoot/);
  assert.match(script, /stageLocalMigrationRestore/);
  assert.match(script, /stage <absolute-backup-directory> --confirm/);

  assert.match(backupCore, /const DEFAULT_ROOT = '\/var\/backups\/yunpanel';/);
  assert.match(previewCore, /inspectVerifiedLocalMigrationArchive/);
  assert.match(previewCore, /compareLocalMigrationUnixIdentities/);
  assert.match(archiveInspection, /migration_archive_link_escape/);
  assert.match(unixIdentity, /yunapp-\[a-f0-9\]\{12\}/);
  assert.match(stageCore, /const DEFAULT_STAGE_ROOT = '\/var\/backups\/yunpanel\/\.restore-staging';/);
  assert.match(stageCore, /--no-same-owner/);
  assert.match(stageCore, /--no-same-permissions/);

  assert.match(runbook, /local-migration-backup\.mjs create --confirm/);
  assert.match(runbook, /local-migration-backup\.mjs verify \/var\/backups\/yunpanel\/migration-<timestamp>/);
  assert.match(runbook, /local-migration-backup\.mjs preview \/var\/backups\/yunpanel\/migration-<timestamp>/);
  assert.match(runbook, /local-migration-backup\.mjs stage \/var\/backups\/yunpanel\/migration-<timestamp> --confirm/);
});
