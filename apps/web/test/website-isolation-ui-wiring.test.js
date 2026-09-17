import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site overview binds read-only isolation audit to the persistent Website identity', async () => {
  const [site, panel, client] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/WebsiteIsolationPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/website-isolation-client.js', import.meta.url), 'utf8'),
  ]);

  assert.match(site, /WebsiteIsolationPanel websiteId=\{website\.id\}/);
  assert.doesNotMatch(site, /WebsiteIsolationPanel websiteId=\{domain\.id\}/);
  assert.match(client, /\/websites\/\$\{encodeURIComponent\(normalized\)\}\/isolation-audit/);
  assert.match(panel, /Migration apply henüz kapalı/);
  assert.match(panel, /audit\.expected\?\.unixUser/);
  assert.match(panel, /audit\.inspectedSteps/);
  assert.match(panel, /audit\.findings/);
  assert.doesNotMatch(panel, /method:\s*'POST'|method:\s*'PUT'|method:\s*'DELETE'/);
  assert.doesNotMatch(panel, /window\.prompt|window\.confirm|window\.alert|localStorage|sessionStorage/);
});
