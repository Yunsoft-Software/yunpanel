import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);
const appUrl = new URL('../src/app.js', import.meta.url);

test('production bootstrap persists aggregate backup operations and enforces the derived Docker project lock', async () => {
  const source = await readFile(indexUrl, 'utf8');

  assert.match(source, /import \{ createBackupOperationRegistry \} from '\.\/backup-operation-registry\.js';/);
  assert.match(source, /import \{ createBackupProjectLockProvider \} from '\.\/backup-project-lock\.js';/);
  assert.match(source, /YUNPANEL_BACKUP_OPERATION_STORE[\s\S]*?backup-operation-registry\.json/);
  assert.match(source, /const backupOperationRegistry = createBackupOperationRegistry\(\{ filePath: backupOperationStorePath \}\);\nawait backupOperationRegistry\.init\(\);/);
  assert.match(source, /const projectBackupLocked = createBackupProjectLockProvider\(\{ backupOperationRegistry \}\);/);
  assert.match(source, /createDockerComposeRuntime\(\{[\s\S]*?projectRegistry: dockerComposeProjectBootstrap\.projectRegistry,[\s\S]*?projectBackupLocked,[\s\S]*?\}\)/);
});

test('production app receives the durable stores and Compose runtime needed for aggregate execution', async () => {
  const [indexSource, appSource] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
  ]);

  assert.match(indexSource, /createApp\(\{[\s\S]*?backupOperationRegistry,[\s\S]*?backupJobStorePath: jobStorePath,[\s\S]*?projectBackupLocked,[\s\S]*?dockerComposeProjectRegistry: dockerComposeRuntime\.projectRegistry,[\s\S]*?dockerComposeObserver: dockerComposeRuntime\.observer,/);
  assert.match(appSource, /import \{ createBackupProductionRuntime \} from '\.\/backup-production-runtime\.js';/);
  assert.match(appSource, /const backupRuntime = backupOperationRegistry && backupJobStorePath && projectBackupLocked[\s\S]*?createBackupProductionRuntime\(\{/);
  assert.match(appSource, /mountBackupRoutes\(app, \{[\s\S]*?backupOperationRegistry,[\s\S]*?backupOrchestratorForRequest:/);
});
