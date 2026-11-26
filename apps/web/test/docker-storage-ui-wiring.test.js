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
  assert.match(page, /Adlandırılmış volume/);
  assert.match(page, /Proje dizini/);
  assert.match(page, /Sunucu dizini/);
  assert.match(page, /Geçici/);
  assert.match(page, /Yedeğe dahil/);
  assert.match(page, /Yedek dışı/);
  assert.match(page, /Varsayılan reddedilir/);
  assert.match(page, /Yedek kuralı okunamadı/);
  assert.match(page, /Konteyner servislerinin kalıcı disk \(volume\) ve dizin bağlantıları\./);
  assert.doesNotMatch(page, /Backup policy bekliyor/);
  assert.doesNotMatch(page, /backupDocker|restoreDocker|automaticBackup/i);
});
