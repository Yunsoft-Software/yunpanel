import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site access binds isolation audit and receipt migration controls to the persistent Website identity', async () => {
  const [site, panel, client, access] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/WebsiteIsolationPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/website-isolation-client.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/SiteAccessPanel.jsx', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(site, /<WebsiteIsolationPanel\b/);
  assert.match(access, /WebsiteIsolationPanel websiteId=\{website\.id\} onChanged=\{onChanged\}/);
  assert.doesNotMatch(access, /WebsiteIsolationPanel websiteId=\{domain\.id\}/);
  assert.match(client, /\/websites\/\$\{encodeURIComponent\(normalized\)\}\/isolation-audit/);
  assert.match(client, /\/websites\/\$\{encodeURIComponent\(normalized\)\}\/isolation-migrations/);
  assert.match(client, /\/applications\/\$\{encodeURIComponent\(normalized\)\}\/passenger-migration-preview/);
  assert.match(client, /\/applications\/\$\{encodeURIComponent\(normalized\)\}\/passenger-migration/);
  assert.match(panel, /ConfirmDialog/);
  assert.match(panel, /applyWebsiteIsolationMigration/);
  assert.match(panel, /rollbackWebsiteIsolationMigration/);
  assert.match(panel, /getPassengerMigrationPreview/);
  assert.match(panel, /applyPassengerMigration/);
  assert.match(panel, /passenger_legacy_runtime_not_operation_owned/);
  assert.match(panel, /Passenger geçişi ayrı bir işlemle yönetilir/);
  assert.match(panel, /Passenger geçişini başlat/);
  assert.doesNotMatch(panel, /adapter === 'passenger'/);
  assert.match(panel, /audit\.migration\?\.applyAvailable/);
  assert.match(panel, /create_canonical_unix_identity/);
  assert.match(panel, /create_sftp_isolation/);
  assert.match(panel, /create_php_fpm_pool/);
  assert.match(panel, /repair_php_container_metadata/);
  assert.match(panel, /repair_static_control_metadata/);
  assert.match(panel, /adapter === 'php'/);
  assert.match(panel, /adapter === 'php_container'/);
  assert.match(panel, /adapter === 'static_control'/);
  assert.match(panel, /PHP-FPM havuzu düzeltmesi/);
  assert.match(panel, /PHP konteyner izinleri düzeltmesi/);
  assert.match(panel, /Statik site izinleri düzeltmesi/);
  assert.match(panel, /alt dizinlerde toplu sahiplik, izin değişikliği veya silme yapılmaz/);
  assert.match(panel, /alt dizinlerde toplu sahiplik veya izin değişikliği yapılmaz/);
  assert.match(panel, /adapter === 'sftp'/);
  assert.match(panel, /SFTP izolasyon düzeltmesi/);
  assert.match(panel, /preservedHomeData/);
  assert.match(panel, /Sistem kullanıcısı düzeltmesi/);
  assert.match(panel, /audit\.expected\?\.unixUser/);
  assert.match(panel, /audit\.inspectedSteps/);
  assert.match(panel, /audit\.findings/);
  assert.doesNotMatch(panel, /window\.prompt|window\.confirm|window\.alert|localStorage|sessionStorage/);
});
