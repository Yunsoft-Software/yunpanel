import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Website database password rotation uses exact durable apply flow without exposing the secret', async () => {
  const panel = await readFile(new URL('../src/workspace/SiteResourcesPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /rotateDatabaseCredential/);
  assert.match(panel, /previewDatabaseCredentialApply/);
  assert.match(panel, /applyDatabaseCredential/);
  assert.match(panel, /observe\(queued\.job\)/);
  assert.match(panel, /waitForJob\(queued\.job\.id\)/);
  assert.match(panel, /credential: rotatedCredential, rotatedCredential/);
  assert.match(panel, /rotatedCredential: null/);
  assert.match(panel, /confirmation=\{rotateTarget\.credential\.username\}/);
  assert.match(panel, /resourceBusy\('database', binding\.databaseName\)/);
  assert.doesNotMatch(panel, /window\.(?:prompt|confirm|alert)|type="password"|setPassword/);
});

test('Website database credential revoke requires a successful durable delete job before finalization', async () => {
  const panel = await readFile(new URL('../src/workspace/SiteResourcesPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /previewDatabaseCredentialDelete/);
  assert.match(panel, /queueDatabaseCredentialDelete/);
  assert.match(panel, /waitForJob\(deleteJob\.id\)/);
  assert.match(panel, /finalizeDatabaseCredentialDelete/);
  assert.match(panel, /deleteJob\.status === 'succeeded'/);
  assert.match(panel, /Kör replay yapılmadı/);
  assert.match(panel, /Schema ve Website binding silinmez/);
});

test('Website database backup waits for checksum-validated durable vendor dump completion', async () => {
  const panel = await readFile(new URL('../src/workspace/SiteResourcesPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /createWebsiteDatabaseBackup/);
  assert.match(panel, /backupTarget\.binding\.id/);
  assert.match(panel, /backupTarget\.binding\.revision/);
  assert.match(panel, /website\.id/);
  assert.match(panel, /waitForJob\(backupJob\.id\)/);
  assert.match(panel, /resourceBusy\('database', binding\.databaseName\)/);
  assert.match(panel, /checksum kanıtı oluşmadan başarılı sayılmaz/);
  assert.match(panel, /backupJob\.status === 'succeeded'/);
  assert.match(panel, /Kör replay yapılmadı/);
});

test('Website database restore selects scoped backup evidence and applies an exact verified preview', async () => {
  const panel = await readFile(new URL('../src/workspace/SiteResourcesPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /databaseBackupChoices\(jobs\.items/);
  assert.match(panel, /websiteId: website\?\.id/);
  assert.match(panel, /bindingId: binding\.id/);
  assert.match(panel, /bindingRevision: binding\.revision/);
  assert.match(panel, /previewWebsiteDatabaseRestore/);
  assert.match(panel, /databaseRestorePreviewView/);
  assert.match(panel, /restoreWebsiteDatabase/);
  assert.match(panel, /waitForJob\(restoreJob\.id\)/);
  assert.match(panel, /pre-restore snapshot/);
  assert.match(panel, /checksum ve post-restore doğrulaması/);
  assert.match(panel, /confirmation=\{restoreTarget\.binding\.databaseName\}/);
  assert.doesNotMatch(panel, /createDatabaseBackup\(|previewDatabaseRestore\(|restoreDatabase\(/);
});

test('Website database delete uses scoped preview, durable DROP and evidence-gated binding finalization', async () => {
  const panel = await readFile(new URL('../src/workspace/SiteResourcesPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /getWebsiteDatabaseDeletePreview/);
  assert.match(panel, /websiteDatabaseDeletePreviewView/);
  assert.match(panel, /deleteWebsiteDatabase/);
  assert.match(panel, /finalizeWebsiteDatabaseDelete/);
  assert.match(panel, /waitForJob\(deleteJob\.id\)/);
  assert.match(panel, /deleteJob\.status === 'succeeded'/);
  assert.match(panel, /Kör replay yapılmadı/);
  assert.match(panel, /Silme önizleme/);
  assert.match(panel, /Silme onayına geç/);
  assert.match(panel, /confirmation=\{deleteTarget\.databaseName\}/);
  assert.match(panel, /current binding revizyonuna ait doğrulanmış/);
  assert.match(panel, /Binding finalization’ı yeniden dene/);
  assert.doesNotMatch(panel, /getDatabaseDropPreview|databaseDropPreviewView|database_delete_safety_chain_pending/);
  assert.doesNotMatch(panel, /window\.(?:prompt|confirm|alert)/);
});


test('Website phpMyAdmin action uses an ephemeral same-origin POST handoff without persisting the capability', async () => {
  const [panel, client] = await Promise.all([
    readFile(new URL('../src/workspace/SiteResourcesPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/phpmyadmin-client.js', import.meta.url), 'utf8'),
  ]);
  assert.match(panel, /createPhpMyAdminHandoff/);
  assert.match(panel, /openWebsitePhpMyAdmin/);
  assert.match(panel, /phpMyAdminOpeningCredentialId/);
  assert.match(panel, /phpMyAdmin açılıyor/);
  assert.match(panel, /disabled=\{busy \|\| !canManage \|\| resourceBusy\('database', binding\.databaseName\)\}/);
  assert.doesNotMatch(panel, /useState\([^\n]*capability|localStorage|sessionStorage|window\.open/);

  assert.match(client, /\/tools\/phpmyadmin\/__yunpanel\/signon/);
  assert.match(client, /method: 'POST'/);
  assert.match(client, /credentials: 'same-origin'/);
  assert.match(client, /redirect: 'follow'/);
  assert.match(client, /referrerPolicy: 'no-referrer'/);
  assert.match(client, /form\.set\('capability', handoff\.capability\)/);
  assert.match(client, /form\.delete\('capability'\)/);
  assert.doesNotMatch(client, /localStorage|sessionStorage|\?capability|console\.|window\.open/);
});
