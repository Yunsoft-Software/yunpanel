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
  const [source, files] = await Promise.all([readFile(siteDetailUrl, 'utf8'), readFile(new URL('../src/workspace/SiteFilesPanel.jsx', import.meta.url), 'utf8')]);
  assert.match(files, /resolveSiteFilesAccess\(input\)/);
  assert.match(files, /access\.state === 'ready'/);
  assert.match(files, /access\.state === 'unbound' && legacyRepair/);
  assert.match(source, /managedTerminalWebsite = website && \['static', 'node', 'php'\]\.includes\(website\.runtimeType\)/);
  assert.match(
    files,
    /serverId=\{access\.website\.serverId\} websiteId=\{access\.website\.id\} runtimeType=\{access\.website\.runtimeType\}/,
  );
  assert.match(source, /key === 'files'\) return canManage/);
  assert.match(source, /key === 'terminal'\) return canManage && \(managedTerminalWebsite \|\| legacyManagedTarget\)/);
});
