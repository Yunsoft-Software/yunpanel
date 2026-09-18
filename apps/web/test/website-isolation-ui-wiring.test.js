import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site overview binds isolation audit and receipt migration controls to the persistent Website identity', async () => {
  const [site, panel, client] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/WebsiteIsolationPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/website-isolation-client.js', import.meta.url), 'utf8'),
  ]);

  assert.match(site, /WebsiteIsolationPanel websiteId=\{website\.id\}/);
  assert.doesNotMatch(site, /WebsiteIsolationPanel websiteId=\{domain\.id\}/);
  assert.match(client, /\/websites\/\$\{encodeURIComponent\(normalized\)\}\/isolation-audit/);
  assert.match(client, /\/websites\/\$\{encodeURIComponent\(normalized\)\}\/isolation-migrations/);
  assert.match(panel, /ConfirmDialog/);
  assert.match(panel, /applyWebsiteIsolationMigration/);
  assert.match(panel, /rollbackWebsiteIsolationMigration/);
  assert.match(panel, /audit\.migration\?\.applyAvailable/);
  assert.match(panel, /create_canonical_unix_identity/);
  assert.match(panel, /create_sftp_isolation/);
  assert.match(panel, /create_php_fpm_pool/);
  assert.match(panel, /adapter === 'php'/);
  assert.match(panel, /PHP-FPM pool migration/);
  assert.match(panel, /adapter === 'sftp'/);
  assert.match(panel, /SFTP migration/);
  assert.match(panel, /preservedHomeData/);
  assert.match(panel, /Unix identity migration/);
  assert.match(panel, /audit\.expected\?\.unixUser/);
  assert.match(panel, /audit\.inspectedSteps/);
  assert.match(panel, /audit\.findings/);
  assert.doesNotMatch(panel, /window\.prompt|window\.confirm|window\.alert|localStorage|sessionStorage/);
});
