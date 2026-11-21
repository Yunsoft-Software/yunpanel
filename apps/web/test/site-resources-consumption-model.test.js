import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const {
  formatDiskSharedRootNote,
  formatEnforcedScopeNote,
  formatMeasuredDisplay,
  formatTrafficGuardWarning,
  formatTrafficMeta,
  formatTrafficMeterStart,
  resolveConsumptionBadge,
} = await import('../src/workspace/SiteResourcesPanel.jsx');
const { CustomerQuotaDialog } = await import('../src/workspace/CustomerQuotaDialog.jsx');

test('formatMeasuredDisplay formats measured trafficMb and diskSpaceMb with MB and human bytes', () => {
  assert.equal(
    formatMeasuredDisplay('trafficMb', { measured: 0, bytes: 0, unknown: false, unit: 'MB' }),
    '0 B',
  );
  assert.equal(
    formatMeasuredDisplay('trafficMb', { measured: 1.5, bytes: 1572864, unknown: false, unit: 'MB' }),
    '1,5 MB (1.536 KB)',
  );
  assert.equal(
    formatMeasuredDisplay('trafficMb', { measured: 1536, bytes: 1610612736, unknown: false, unit: 'MB' }),
    '1.536 MB (1,5 GB)',
  );
  assert.equal(
    formatMeasuredDisplay('diskSpaceMb', { measured: 512, bytes: 536870912, unknown: false, unit: 'MB' }),
    '512 MB (524.288 KB)',
  );
  assert.equal(
    formatMeasuredDisplay('trafficMb', { measured: null, bytes: null, unknown: true, unit: 'MB' }),
    null,
  );
});

test('formatTrafficMeta and formatTrafficMeterStart translate scopes into Turkish and show non-retroactive meter start', () => {
  const completeMeta = formatTrafficMeta({
    measured: 25,
    unknown: false,
    period: '2026-11',
    scope: 'nginx_outbound_body_bytes',
    completeness: 'complete',
  });
  assert.equal(completeMeta, '2026-11 · Nginx çıkış gövdesi baytı');
  assert.doesNotMatch(completeMeta, /nginx_outbound_body_bytes/);

  const legacyMeta = formatTrafficMeta({
    measured: 12.5,
    unknown: false,
    period: '2026-11',
    scope: 'nginx_legacy_applied_access_log',
    completeness: 'complete',
  });
  assert.equal(legacyMeta, '2026-11 · Mevcut vhost erişim günlüğü (statik dosyalar hariç)');
  assert.doesNotMatch(legacyMeta, /nginx_legacy_applied_access_log/);

  const partialMeta = formatTrafficMeta({
    measured: 25,
    unknown: false,
    period: '2026-11',
    scope: 'nginx_outbound_body_bytes',
    completeness: 'partial_rotation_gap',
    rotationGapCount: 1,
  });
  assert.equal(partialMeta, '2026-11 · Nginx çıkış gövdesi baytı · Günlük döngüsü nedeniyle kısmi ölçüm');

  assert.equal(
    formatTrafficMeta({ measured: null, unknown: true, period: '2026-11', scope: 'nginx_outbound_body_bytes' }),
    null,
  );

  const meterStart = formatTrafficMeterStart({
    measured: 25,
    unknown: false,
    meterStartedAt: '2026-11-21T10:30:00.000Z',
  });
  assert.match(meterStart, /^Sayaç başlangıcı: /);
  assert.equal(formatTrafficMeterStart({ measured: 25, unknown: false, meterStartedAt: null }), null);
  assert.equal(formatTrafficMeterStart({ measured: null, unknown: true, meterStartedAt: '2026-11-21T10:30:00.000Z' }), null);
});

test('formatEnforcedScopeNote, formatTrafficGuardWarning, and formatDiskSharedRootNote surface honest scope and guard hints', () => {
  assert.equal(formatEnforcedScopeNote('databases', { enforcedLimit: null }), null);
  assert.equal(
    formatEnforcedScopeNote('databases', { enforcedLimit: 2 }),
    'Hesap geneli veritabanı sınırı',
  );
  assert.equal(
    formatEnforcedScopeNote('diskSpaceMb', { enforcedLimit: 500, enforcementMode: 'managed_write_guard' }),
    'Dosya Yöneticisi yazmaları',
  );
  assert.equal(
    formatEnforcedScopeNote('diskSpaceMb', { enforcedLimit: 500 }),
    'Dosya Yöneticisi yazmaları',
  );
  assert.equal(
    formatEnforcedScopeNote('diskSpaceMb', { enforcedLimit: 500, enforcementMode: 'native_quota_available' }),
    'Dosya Yöneticisi yazmaları',
  );
  assert.equal(
    formatEnforcedScopeNote('diskSpaceMb', { enforcedLimit: 500, enforcementScope: 'native_filesystem_quota' }),
    'Sunucu disk kotası',
  );
  assert.equal(
    formatEnforcedScopeNote('trafficMb', { enforcedLimit: 10240 }),
    'Aylık trafik sınırı · ay başında açılır',
  );

  assert.equal(
    formatTrafficGuardWarning('trafficMb', { enforcedLimit: 10240, trafficGuardReady: false }),
    'Trafik sınırının etkinleşmesi için site ayarlarını yeniden uygulayın',
  );
  assert.equal(
    formatTrafficGuardWarning('trafficMb', { enforcedLimit: null, trafficEnforcementRequested: true, trafficGuardReady: false }),
    'Trafik sınırının etkinleşmesi için site ayarlarını yeniden uygulayın',
  );
  assert.equal(formatTrafficGuardWarning('trafficMb', { enforcedLimit: 10240, trafficGuardReady: true }), null);
  assert.equal(formatTrafficGuardWarning('trafficMb', { enforcedLimit: null, trafficEnforcementRequested: false, trafficGuardReady: false }), null);
  assert.equal(formatTrafficGuardWarning('trafficMb', { enforcedLimit: null, trafficGuardReady: false }), null);

  assert.equal(
    formatDiskSharedRootNote('diskSpaceMb', { reasonCode: 'shared_root_overlap' }),
    'Paylaşımlı klasörlerde dosya yazılamaz. Dosyaları silebilirsiniz.',
  );
  assert.equal(formatDiskSharedRootNote('diskSpaceMb', { reasonCode: 'root_missing' }), null);
});

test('resolveConsumptionBadge renders valid PanelKit states and error Sınırlandı when trafficMb is blocked', () => {
  assert.deepEqual(
    resolveConsumptionBadge('trafficMb', { status: 'exceeded', enforcedLimit: 1024, blocked: true }),
    { state: 'error', label: 'Sınırlandı' },
  );
  assert.deepEqual(
    resolveConsumptionBadge('diskSpaceMb', { status: 'exceeded', enforcedLimit: 500 }),
    { state: 'error', label: 'Aşıldı' },
  );
  assert.deepEqual(
    resolveConsumptionBadge('diskSpaceMb', { status: 'exceeded', enforcedLimit: null }),
    { state: 'warning', label: 'Limit üstü' },
  );
  assert.deepEqual(
    resolveConsumptionBadge('databases', { status: 'warning', enforcedLimit: 2 }),
    { state: 'warning', label: 'Uyarı' },
  );
  assert.deepEqual(
    resolveConsumptionBadge('databases', { status: 'ok', enforcedLimit: 2 }),
    { state: 'healthy', label: 'Normal' },
  );
  assert.deepEqual(
    resolveConsumptionBadge('trafficMb', { status: 'unknown', enforcedLimit: null }, 'Ölçülemiyor'),
    { state: 'neutral', label: 'Ölçülemiyor' },
  );
});

test('CustomerQuotaDialog renders disabled opt-in toggles when disk/traffic limits are empty and enabled checked toggles when active', () => {
  const emptyAccount = {
    id: 'cust-empty',
    username: 'custempty',
    kind: 'customer',
    revision: 1,
    quotas: { maxWebsites: 2, maxDiskMb: null, maxTrafficMb: null, maxDatabases: 1 },
    quotaEnforcement: { websites: true, databases: true, disk: false, traffic: false },
  };
  const emptyHtml = renderToStaticMarkup(
    createElement(CustomerQuotaDialog, {
      account: emptyAccount,
      client: { current: null },
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  assert.match(emptyHtml, /Disk yazma kotasını uygula/);
  assert.match(emptyHtml, /Aylık trafik sınırını uygula/);
  assert.match(emptyHtml, /Dosya kotası, Dosya Yöneticisi’ndeki yazma işlemlerini kapsar\. Paylaşımlı klasörlerde dosya yazılamaz\. Dosyaları silebilirsiniz\./);
  assert.match(emptyHtml, /Aylık limite ulaşıldığında sitenin yeni isteklerini sınırlar; ay başında otomatik açılır veya kapatılarak geri alınır\./);
  // Both checkboxes must be disabled when limits are empty
  const disabledCheckboxes = emptyHtml.match(/<input type="checkbox" disabled=""/g) ?? [];
  assert.equal(disabledCheckboxes.length, 2);

  const activeAccount = {
    id: 'cust-active',
    username: 'custactive',
    kind: 'customer',
    revision: 2,
    quotas: { maxWebsites: 2, maxDiskMb: 500, maxTrafficMb: 2048, maxDatabases: 2 },
    quotaEnforcement: { websites: true, databases: true, disk: true, traffic: true },
  };
  const activeHtml = renderToStaticMarkup(
    createElement(CustomerQuotaDialog, {
      account: activeAccount,
      client: { current: null },
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  const checkedCheckboxes = activeHtml.match(/<input type="checkbox" checked=""/g) ?? [];
  assert.equal(checkedCheckboxes.length, 2);
});
