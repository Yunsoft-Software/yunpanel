import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production bootstrap persists aggregate backup operations and enforces the derived Docker project lock', async () => {
  const source = await readFile(indexUrl, 'utf8');

  assert.match(source, /import \{ createBackupOperationRegistry \} from '\.\/backup-operation-registry\.js';/);
  assert.match(source, /import \{ createBackupProjectLockProvider \} from '\.\/backup-project-lock\.js';/);
  assert.match(source, /YUNPANEL_BACKUP_OPERATION_STORE[\s\S]*?backup-operation-registry\.json/);
  assert.match(source, /const backupOperationRegistry = createBackupOperationRegistry\(\{ filePath: backupOperationStorePath \}\);\nawait backupOperationRegistry\.init\(\);/);
  assert.match(source, /const projectBackupLocked = createBackupProjectLockProvider\(\{ backupOperationRegistry \}\);/);
  assert.match(source, /createDockerComposeRuntime\(\{[\s\S]*?projectRegistry: dockerComposeProjectBootstrap\.projectRegistry,[\s\S]*?projectBackupLocked,[\s\S]*?\}\)/);
});
