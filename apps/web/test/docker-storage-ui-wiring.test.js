import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Docker project detail exposes classified storage inventory without enabling backup implicitly', async () => {
  const source = await readFile(new URL('../src/workspace/DockerProjectsPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /function StoragePanel/);
  assert.match(source, /storageMounts/);
  assert.match(source, /Named volume/);
  assert.match(source, /Project bind/);
  assert.match(source, /Host bind/);
  assert.match(source, /Ephemeral/);
  assert.match(source, /Varsayılan reddedilir/);
  assert.match(source, /Backup policy bekliyor/);
  assert.match(source, /host bind yolları otomatik yedeklemeye alınmaz/);
  assert.doesNotMatch(source, /backupDocker|restoreDocker|automaticBackup/i);
});
