import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Docker project detail renders backend-derived versioned storage backup policy without enabling backup implicitly', async () => {
  const [page, client] = await Promise.all([
    readFile(new URL('../src/workspace/DockerProjectsPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/docker-compose-client.js', import.meta.url), 'utf8'),
  ]);

  assert.match(client, /getDockerStorageBackup/);
  assert.match(client, /storage-backup/);
  assert.match(page, /getDockerStorageBackup/);
  assert.match(page, /function StoragePanel/);
  assert.match(page, /storageMounts/);
  assert.match(page, /storageResourceKey/);
  assert.match(page, /backup\?\.projectRevision === project\.revision/);
  assert.match(page, /Named volume/);
  assert.match(page, /Project bind/);
  assert.match(page, /Host bind/);
  assert.match(page, /Ephemeral/);
  assert.match(page, /Manifest'e dahil/);
  assert.match(page, /Backup dışı/);
  assert.match(page, /Varsayılan reddedilir/);
  assert.match(page, /Policy kullanılamıyor/);
  assert.match(page, /versioned backup manifest policy/);
  assert.match(page, /Genel backup executor henüz çalıştırılmaz/);
  assert.doesNotMatch(page, /Backup policy bekliyor/);
  assert.doesNotMatch(page, /backupDocker|restoreDocker|automaticBackup/i);
});
