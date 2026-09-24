import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = (name) => readFile(new URL('../src/workspace/' + name, import.meta.url), 'utf8');

test('backup is a Plesk-style site tool and old file/cron routes remain', async () => {
  const detail = await source('SiteDetailPage.jsx');
  assert.match(detail, /tab === 'backup' && <SiteBackupPanel/);
  assert.match(detail, /tab === 'files' && <SiteFilesPanel/);
  assert.match(detail, /tab === 'cron' && <SiteCronPanel/);
});
test('backup client uses only Website-scoped browser endpoint', async () => {
  const client = await source('site-backup-client.js');
  assert.match(client, /\/websites\/.*\/backups/);
  assert.doesNotMatch(client, /\/backups\/repositories|\/backups\/remotes/);
});
test('backup panel does not expose raw repository target or execute sync mutation', async () => {
  const panel = await source('SiteBackupPanel.jsx');
  assert.doesNotMatch(panel, /repository\.target|targetPaths/);
  assert.match(panel, /durable işlem hattına taşınmadan buradan çalıştırılmaz/);
});
