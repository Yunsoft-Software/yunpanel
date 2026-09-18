import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const filesPanelUrl = new URL('../src/workspace/FilesPanel.jsx', import.meta.url);
const siteDetailUrl = new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url);
const apiUrl = new URL('../src/api.js', import.meta.url);

test('Files panel uses the elFinder handoff as the primary action without removing legacy fallback yet', async () => {
  const [filesPanel, api] = await Promise.all([
    readFile(filesPanelUrl, 'utf8'),
    readFile(apiUrl, 'utf8'),
  ]);

  assert.match(filesPanel, /openWebsiteElFinder/);
  assert.match(filesPanel, /createElFinderHandoff/);
  assert.match(filesPanel, /serverId,/);
  assert.match(filesPanel, /websiteId,/);
  assert.match(filesPanel, /elFinder ile aç/);
  assert.match(filesPanel, /legacyAvailable = \['static', 'node'\]\.includes\(runtimeType\)/);
  assert.match(filesPanel, /Legacy görünümü yenile/);
  assert.match(filesPanel, /Bu runtime için legacy dosya API’si kullanılmaz/);
  assert.match(api, /\/elfinder-handoffs/);
  assert.match(api, /method: 'POST', body: \{\}/);
});

test('PHP Websites expose Owner-only Files and ttyd Terminal through the managed Website identity', async () => {
  const source = await readFile(siteDetailUrl, 'utf8');
  assert.match(source, /managedFilesWebsite = website && \['static', 'node', 'php'\]\.includes\(website\.runtimeType\)/);
  assert.match(source, /managedTerminalWebsite = website && \['static', 'node', 'php'\]\.includes\(website\.runtimeType\)/);
  assert.match(
    source,
    /<FilesPanel serverId=\{domain\.serverId\} websiteId=\{domain\.websiteId\} runtimeType=\{website\?\.runtimeType\}/,
  );
  assert.match(source, /key === 'files'\) return canManage && \(managedFilesWebsite \|\| legacyManagedTarget\)/);
  assert.match(source, /key === 'terminal'\) return canManage && \(managedTerminalWebsite \|\| legacyManagedTarget\)/);
});
