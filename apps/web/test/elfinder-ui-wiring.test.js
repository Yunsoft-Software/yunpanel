import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const filesPanelUrl = new URL('../src/workspace/FilesPanel.jsx', import.meta.url);
const siteDetailUrl = new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url);
const apiUrl = new URL('../src/api.js', import.meta.url);

test('Files panel uses the native sandboxed file manager with multi-selection and toolbar operations', async () => {
  const [filesPanel, api] = await Promise.all([
    readFile(filesPanelUrl, 'utf8'),
    readFile(apiUrl, 'utf8'),
  ]);

  assert.match(filesPanel, /uploadSiteFile/);
  assert.match(filesPanel, /websiteId/);
  assert.match(filesPanel, /Yeni Dosya/);
  assert.match(filesPanel, /Yeni Klasör/);
  assert.match(filesPanel, /Seçilenleri Sil/);
  assert.match(filesPanel, /batch-delete:/);
  assert.match(filesPanel, /\['static', 'node', 'php', 'python'\]\.includes\(runtimeType\)/);
  assert.match(api, /uploadSiteFile/);
});

test('PHP Websites expose Owner-only Files and ttyd Terminal through the managed Website identity', async () => {
  const source = await readFile(siteDetailUrl, 'utf8');
  assert.match(source, /managedFilesWebsite = website && \['static', 'node', 'php', 'python'\]\.includes\(website\.runtimeType\)/);
  assert.match(source, /managedTerminalWebsite = website && \['static', 'node', 'php'\]\.includes\(website\.runtimeType\)/);
  assert.match(
    source,
    /<FilesPanel serverId=\{domain\.serverId\} websiteId=\{domain\.websiteId\} runtimeType=\{website\?\.runtimeType\}/,
  );
  assert.match(source, /key === 'files'\) return canManage && \(managedFilesWebsite \|\| legacyManagedTarget\)/);
  assert.match(source, /key === 'terminal'\) return canManage && \(managedTerminalWebsite \|\| legacyManagedTarget\)/);
});
