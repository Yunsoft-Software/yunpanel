import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('management UI has one implicit local server and no server chooser', async () => {
  const sources = await Promise.all([
    '../src/workspace/NewWebsitePage.jsx',
    '../src/workspace/ApplicationsPage.jsx',
    '../src/workspace/DatabasesPage.jsx',
    '../src/workspace/OperationsPages.jsx',
    '../src/DomainManager.jsx',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const combined = sources.join('\n');
  assert.doesNotMatch(combined, /Sunucu seç|Tüm sunucular|Select server|serverId: ''/);
  assert.match(sources[2], /servers\.items\.length === 1 \? servers\.items\[0\] : null/);
  assert.match(sources[3], /YunPanel yalnızca kurulu olduğu yerel sunucuyu yönetir/);
  assert.doesNotMatch(sources[3], /ServerManager|enrollment/);
  assert.match(sources[0], /\/sites\/create-preview/);
  assert.match(sources[0], /previewDigest: preview\.previewDigest/);
});

test('primary navigation exposes working modules instead of placeholder destinations', async () => {
  const [layout, model] = await Promise.all([
    readFile(new URL('../src/workspace/WorkspaceLayout.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/site-model.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(layout, /\['\/(?:docker|mail|backups)'/);
  assert.match(layout, /\['\/audit', 'Denetim', 'shield'\]/);
  assert.doesNotMatch(model, /\['(?:mail|databases|cron|backups)'/);
  assert.match(model, /\['files', 'Dosyalar'\]/);
});

test('audit route uses the real owner-only history client instead of a placeholder', async () => {
  const [app, page, client, operations] = await Promise.all([
    readFile(new URL('../src/workspace/WorkspaceApp.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/AuditPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/audit-client.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/OperationsPages.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /path: 'audit', element: manage\(<AuditPage \/>\)/);
  assert.match(page, /createAuditClient/);
  assert.match(page, /type="datetime-local"/);
  assert.match(client, /`\/audit\?\$\{query\}`/);
  assert.doesNotMatch(operations, /audit: \['Denetim kayıtları'/);
});

test('legacy Domain repair and real site file manager replace terminal and file placeholders', async () => {
  const [detail, files, logs] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/FilesPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/LogsPanel.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(detail, /websites\/migration\/create-website/);
  assert.match(detail, /websites\/migration\/bind/);
  assert.match(detail, /websites\.items\.find/);
  assert.match(detail, /\['files', 'terminal'\]\.includes\(key\)/);
  assert.match(detail, /<FilesPanel websiteId=\{domain\.websiteId\}/);
  assert.doesNotMatch(detail, /Site dosyalarını listeleme, yükleme ve düzenleme API’leri henüz uygulanmadı/);
  assert.match(files, /\/files\/text/);
  assert.match(files, /method: 'DELETE'/);
  assert.doesNotMatch(files, /window\.prompt|window\.alert|innerHTML/);
  assert.match(detail, /<LogsPanel application=\{application\} domain=\{domain\} server=\{server\}/);
  assert.match(logs, /nginx-access/);
  assert.match(logs, /\/logs\/node/);
});
