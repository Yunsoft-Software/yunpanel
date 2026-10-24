import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

import {
  usagePercent,
  usageThreshold,
  readableItems,
  databaseAccessView,
  filterConsoleDatabases,
  paginateConsoleItems,
} from '../src/workspace/ui/console-model.js';
import {
  SITE_TABS,
  normalizeSiteTab,
  siteHref,
  safeReturnHref,
  certificateState,
  matchingApplications,
  selectedApplication,
  siteJobs,
  jobActive,
  jobFinishedAt,
  jobFromResponse,
  externalSiteUrl,
  parentTrail,
  formatBytes,
  formatDate,
} from '../src/workspace/site-model.js';
import { siteListPage } from '../src/workspace/site-list-model.js';
import {
  createWebsiteTaskResolver,
  siteListFilterParams,
  clearSiteListFilters,
} from '../src/workspace/website-task-model.js';
import {
  siteMailDomains,
  mailSection,
  webmailMappingUrl,
} from '../src/workspace/ui/site-resource-model.js';
import {
  usageSample,
  appendUsageSample,
  usagePath,
} from '../src/workspace/ui/usage-history.js';
import {
  navigationGroups,
  navigationItemActive,
  TOOLS_SETTINGS_GROUPS,
  websiteCount,
  commandEntries,
  groupSiteTabs,
} from '../src/workspace/ui/ux-model.js';
import {
  initialCollection,
  collectionError,
  collectionReducer,
  knownCount,
} from '../src/workspace/resource-model.js';
import {
  initialScopedCollection,
  scopedCollectionReducer,
  scopedCollectionView,
} from '../src/workspace/collection-state.js';
import { workspaceResources } from '../src/workspace/workspace-resources.js';
import { resolveSiteToolEntry } from '../src/workspace/site-tool-entry-model.js';
import { filesTargets, resolveFilesEntry } from '../src/workspace/files-entry-model.js';
import {
  validDatabaseName,
  formatDatabaseBytes,
  databaseInventoryView,
  websiteDatabaseResourcesView,
  databaseBackupChoices,
} from '../src/workspace/database-model.js';
import {
  hostingCustomerQuotasInput,
  readHostingAccount,
  hostingAccountMessage,
} from '../src/workspace/hosting-account-client.js';
import { domainTreeRows } from '../src/domain-tree.js';
import {
  ownerAccess,
  panelPermission,
  enrollmentCanContinue,
} from '../src/owner-access.js';

import {
  startLocalRuntime,
  LocalRuntimeError,
  localRuntimeInternals,
} from '../../api/src/local-runtime.js';
import { createServerRegistry } from '../../api/src/server-registry.js';
import { requirePanelRouteAccess } from '../../api/src/panel-http-guard.js';
import {
  createSiteResourceBoundary,
  needsSiteResourceJson,
} from '../../api/src/site-resource-boundary.js';
import { createHostingSiteAllocationStore } from '../../api/src/hosting-site-allocation-store.js';
import { AuthError } from '../../api/src/auth-error.js';
import {
  siteFixture,
  website as fixtureWebsite,
  allocation as fixtureAllocation,
  uuid as fixtureUuid,
} from '../../api/test-support/hosting-site-fixture.js';
import {
  inspectHostInventory,
  inventoryInternals,
} from '../../../packages/host-runtime/src/inventory.js';

register(new URL('./jsx-loader.js', import.meta.url));

const {
  computeWorkspaceAlerts,
  NotificationCenterDrawer,
} = await import('../src/workspace/NotificationCenterDrawer.jsx');
const {
  UsageRing,
  ServerSummary,
  default: DashboardPage,
} = await import('../src/workspace/DashboardPage.jsx');
const { WorkspaceContext } = await import('../src/workspace/WorkspaceContext.jsx');

function createRuntimeMocks(registry, serverId) {
  return {
    registry,
    jobRegistry: {
      claimNext: async () => null,
      listJobs: async () => [],
      complete: async () => {},
      recovery: () => ({ jobs: [] }),
      getJob: async () => null,
      getReconciliationJob: async () => null,
      acknowledgeReconciliation: async () => ({ acknowledged: true }),
    },
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: {},
    websiteRegistry: { listWebsites: async () => [] },
    runtimeBindingRegistry: {
      getBinding: async () => null,
      activate: async () => {},
    },
    hostOperations: {
      operations: ['system.ping'],
      supports: () => true,
      executeOperation: async () => ({ ok: true }),
    },
    acquireLock: async () => ({ release: async () => {} }),
    executorFactory: () => ({
      start() {},
      async stop() {},
    }),
    reconcile: async () => ({ reconciled: true }),
  };
}

// ============================================================================
// SCN-MON-01 & SCN-MON-02: Live Telemetry, Inventory & Alert Threshold Engine
// ============================================================================

test('SCN-MON-01/02 [01]: local-runtime enforces 5s default snapshot interval, validates interval bounds, and updates live server telemetry', async () => {
  assert.equal(localRuntimeInternals.defaultSnapshotIntervalMs, 5_000);
  assert.equal(localRuntimeInternals.normalizeSnapshotInterval(50), 50);
  assert.equal(localRuntimeInternals.normalizeSnapshotInterval(5_000), 5_000);
  assert.equal(localRuntimeInternals.normalizeSnapshotInterval(60_000), 60_000);

  for (const invalidInterval of [0, -100, 49, 60_001, 3.5, NaN, null, '5000']) {
    assert.throws(
      () => localRuntimeInternals.normalizeSnapshotInterval(invalidInterval),
      (err) => err instanceof LocalRuntimeError && err.code === 'invalid_local_snapshot_interval',
    );
  }

  let clock = 1_700_000_000_000;
  const registry = createServerRegistry({ now: () => clock });
  const createdServer = await registry.createLocalServer({
    hostname: 'node1.yunpanel.local',
    displayName: 'Ana Node',
  });
  const mocks = createRuntimeMocks(registry, createdServer.id);

  let tick = 0;
  const samples = [
    {
      inventory: {
        cpu: { count: 4, usagePercent: 22.5 },
        memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
        filesystem: { usedBytes: 40 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
      },
      services: { nginx: { active: true } },
    },
    {
      inventory: {
        cpu: { count: 4, usagePercent: 87.2 },
        memory: { usedBytes: 14 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
        filesystem: { usedBytes: 91 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
      },
      services: { nginx: { active: true }, mariadb: { active: true } },
    },
  ];

  const runtime = await startLocalRuntime({
    ...mocks,
    serverId: createdServer.id,
    hostname: 'node1.yunpanel.local',
    runtimeVersion: '1.2.0',
    lockPath: '/tmp/yunpanel-test-runtime.lock',
    snapshotIntervalMs: 55,
    snapshotProvider: async () => {
      clock += 5_000;
      const next = samples[Math.min(tick, samples.length - 1)];
      tick += 1;
      return next;
    },
  });

  try {
    const firstSnapshot = await registry.getServer(createdServer.id);
    assert.equal(firstSnapshot.connectivity, 'online');
    assert.equal(firstSnapshot.inventory.cpu.usagePercent, 22.5);
    assert.equal(firstSnapshot.localRuntimeVersion, '1.2.0');

    await new Promise((resolve) => setTimeout(resolve, 90));
    const refreshedSnapshot = await registry.getServer(createdServer.id);
    assert.ok(tick >= 2, 'Snapshot provider should have been called on the scheduled refresh tick');
    assert.equal(refreshedSnapshot.inventory.cpu.usagePercent, 87.2);
    assert.equal(refreshedSnapshot.services.mariadb.active, true);
    assert.equal(runtime.failure(), null);
  } finally {
    await runtime.stop();
  }
});

test('SCN-MON-01/02 [02]: local-runtime validates snapshot payloads and stops cleanly on refresh faults', async () => {
  assert.deepEqual(localRuntimeInternals.normalizeSnapshotPayload(null), {});
  assert.throws(
    () => localRuntimeInternals.normalizeSnapshotPayload(['invalid']),
    (err) => err instanceof LocalRuntimeError && err.code === 'local_runtime_snapshot_invalid',
  );
  assert.throws(
    () => localRuntimeInternals.normalizeSnapshotPayload({ unsupportedKey: {} }),
    (err) => err instanceof LocalRuntimeError && err.code === 'local_runtime_snapshot_invalid',
  );
  assert.throws(
    () => localRuntimeInternals.normalizeSnapshotPayload({ inventory: null }),
    (err) => err instanceof LocalRuntimeError && err.code === 'local_runtime_snapshot_invalid',
  );

  const registry = createServerRegistry();
  const server = await registry.createLocalServer({ hostname: 'fault.yunpanel.local' });
  const mocks = createRuntimeMocks(registry, server.id);

  let calls = 0;
  const faults = [];
  const runtime = await startLocalRuntime({
    ...mocks,
    serverId: server.id,
    hostname: 'fault.yunpanel.local',
    runtimeVersion: '1.0.0',
    lockPath: '/tmp/yunpanel-fault-runtime.lock',
    snapshotIntervalMs: 50,
    onError: (err) => faults.push(err),
    snapshotProvider: async () => {
      calls += 1;
      if (calls > 1) throw new Error('Simulated disk telemetry read failure');
      return { inventory: { cpu: { count: 2, usagePercent: 12 } } };
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(faults.length, 1);
    assert.equal(faults[0].code, 'local_runtime_snapshot_refresh_failed');
    assert.deepEqual(runtime.failure(), {
      code: 'local_runtime_snapshot_refresh_failed',
      phase: 'snapshot',
      jobId: null,
    });
  } finally {
    await runtime.stop();
  }
});

test('SCN-MON-01/02 [03]: host-runtime inspectHostInventory and internals calculate CPU usage delta, memory/disk bytes, and OS release metadata', async () => {
  const ubuntuRelease = inventoryInternals.parseOsRelease(
    'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nVERSION_CODENAME=noble\n',
  );
  assert.deepEqual(ubuntuRelease, {
    id: 'ubuntu',
    name: 'Ubuntu',
    prettyName: 'Ubuntu 24.04.1 LTS',
    version: '24.04',
    codename: 'noble',
  });

  const almaRelease = inventoryInternals.parseOsRelease(
    'ID="almalinux"\nNAME="AlmaLinux"\nVERSION_ID="9.4"\nPRETTY_NAME="AlmaLinux 9.4 (Seafoam Ocelot)"\n',
  );
  assert.equal(almaRelease.id, 'almalinux');
  assert.equal(almaRelease.version, '9.4');

  const inventory = await inspectHostInventory({ mode: 'local', cpuSampleMs: 15 });
  assert.equal(inventory.mode, 'local');
  assert.ok(Number.isInteger(inventory.cpu.count) && inventory.cpu.count >= 1);
  assert.ok(
    inventory.cpu.usagePercent === null
      || (Number.isFinite(inventory.cpu.usagePercent) && inventory.cpu.usagePercent >= 0 && inventory.cpu.usagePercent <= 100),
  );
  assert.ok(Number.isFinite(inventory.memory.totalBytes) && inventory.memory.totalBytes > 0);
  assert.ok(Number.isFinite(inventory.memory.usedBytes) && inventory.memory.usedBytes >= 0);
  assert.ok(inventory.memory.usedBytes <= inventory.memory.totalBytes);
  if (inventory.filesystem !== null) {
    assert.equal(inventory.filesystem.mount, '/');
    assert.ok(inventory.filesystem.totalBytes > 0);
    assert.ok(inventory.filesystem.usedBytes >= 0 && inventory.filesystem.usedBytes <= inventory.filesystem.totalBytes);
  }
});

test('SCN-MON-01/02 [04]: console-model usagePercent and usageThreshold enforce exact 0%, 84.9%, 85%, 89.9%, 90%, 100% boundaries and reject invalid inputs', () => {
  assert.equal(usagePercent(0, 100), 0);
  assert.equal(usagePercent(84.9, 100), 84.9);
  assert.equal(usagePercent(85, 100), 85);
  assert.equal(usagePercent(89.9, 100), 89.9);
  assert.equal(usagePercent(90, 100), 90);
  assert.equal(usagePercent(100, 100), 100);

  // Invalid / out-of-bounds inputs
  assert.equal(usagePercent(-1, 100), null);
  assert.equal(usagePercent(101, 100), null);
  assert.equal(usagePercent(50, 0), null);
  assert.equal(usagePercent(50, -10), null);
  assert.equal(usagePercent(NaN, 100), null);
  assert.equal(usagePercent(50, Infinity), null);
  assert.equal(usagePercent(null, 100), null);
  assert.equal(usagePercent(undefined, 100), null);

  // Threshold classification boundaries
  assert.equal(usageThreshold(0), 'normal');
  assert.equal(usageThreshold(84), 'normal');
  assert.equal(usageThreshold(84.999), 'normal');
  assert.equal(usageThreshold(85), 'high');
  assert.equal(usageThreshold(85.001), 'high');
  assert.equal(usageThreshold(89.999), 'high');
  assert.equal(usageThreshold(90), 'critical');
  assert.equal(usageThreshold(99.9), 'critical');
  assert.equal(usageThreshold(100), 'critical');

  for (const bad of [-0.01, 100.01, NaN, Infinity, -Infinity, null, undefined, '85']) {
    assert.equal(usageThreshold(bad), 'unknown');
  }
});

test('SCN-MON-02 [05]: site-model formatBytes and formatDate handle unit boundaries and malformed values safely', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1024 ** 2), '1 MB');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(formatBytes(2.25 * 1024 ** 4), '2.3 TB');

  for (const invalid of [-1, -0.01, NaN, Infinity, -Infinity, null, undefined, '1024']) {
    assert.equal(formatBytes(invalid), '—');
  }

  assert.equal(formatDate(null), '—');
  assert.equal(formatDate(undefined), '—');
  assert.equal(formatDate('not-a-valid-date'), '—');
  assert.notEqual(formatDate('2026-10-25T10:00:00.000Z'), '—');
});

test('SCN-MON-02 [06]: usage-history usageSample, appendUsageSample, and usagePath manage live telemetry time series accurately', () => {
  const baseTime = Date.parse('2026-10-25T12:00:00.000Z');
  const s1 = usageSample({
    id: 'srv-1',
    lastSeenAt: new Date(baseTime).toISOString(),
    inventory: {
      cpu: { usagePercent: 0 },
      memory: { usedBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
      filesystem: { usedBytes: 85 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
    },
  });
  assert.deepEqual(s1, { timestamp: baseTime, cpu: 0, memory: 50, disk: 85 });

  // Malformed server records return null or null metric fields
  assert.equal(usageSample(null), null);
  assert.equal(usageSample({ id: '', lastSeenAt: '2026-10-25T12:00:00.000Z' }), null);
  assert.equal(usageSample({ id: 'srv-1', lastSeenAt: 'invalid-date' }), null);
  const partialSample = usageSample({
    id: 'srv-1',
    lastSeenAt: new Date(baseTime + 5_000).toISOString(),
    inventory: {
      cpu: { usagePercent: 105 }, // out of range -> null
      memory: { usedBytes: 200, totalBytes: 100 }, // used > total -> null
      filesystem: null,
    },
  });
  assert.deepEqual(partialSample, { timestamp: baseTime + 5_000, cpu: null, memory: null, disk: null });

  // Deduplication, out-of-order rejection, same-timestamp update, and ring-buffer bounding
  let history = [];
  history = appendUsageSample(history, s1);
  assert.equal(history.length, 1);
  assert.equal(appendUsageSample(history, s1), history, 'Identical sample at same timestamp must be a no-op');
  assert.equal(
    appendUsageSample(history, { timestamp: baseTime - 1000, cpu: 10, memory: 20, disk: 30 }),
    history,
    'Out-of-order older timestamp must be ignored',
  );

  const updatedSameTimestamp = { timestamp: baseTime, cpu: 25, memory: 50, disk: 85 };
  history = appendUsageSample(history, updatedSameTimestamp);
  assert.equal(history.length, 1);
  assert.equal(history[0].cpu, 25);

  const s2 = { timestamp: baseTime + 5_000, cpu: 50, memory: null, disk: 88 };
  const s3 = { timestamp: baseTime + 10_000, cpu: 100, memory: 75, disk: 92 };
  history = appendUsageSample(appendUsageSample(history, s2), s3);
  assert.equal(history.length, 3);

  // SVG path generation: continuous for cpu, gap over null for memory
  const cpuSvg = usagePath(history, 'cpu', { width: 600, height: 100 });
  assert.equal(cpuSvg, 'M0.00,75.00 L300.00,50.00 L600.00,0.00');
  const memSvg = usagePath(history, 'memory', { width: 600, height: 100 });
  assert.equal(memSvg, 'M0.00,50.00 M600.00,25.00');
});

test('SCN-MON-02 [07]: UsageRing and ServerSummary render real telemetry percentages, threshold classes, and error/unknown states', () => {
  const zeroHtml = renderToStaticMarkup(React.createElement(UsageRing, { label: 'CPU', value: 0, detail: '4 çekirdek' }));
  assert.match(zeroHtml, /%0/);
  assert.match(zeroHtml, /aria-valuenow="0"/);
  assert.doesNotMatch(zeroHtml, /is-high|is-critical|is-unknown/);

  const highHtml = renderToStaticMarkup(React.createElement(UsageRing, { label: 'Bellek', value: 85, detail: '13.6 GB / 16 GB' }));
  assert.match(highHtml, /is-high/);
  assert.doesNotMatch(highHtml, /is-critical/);
  assert.match(highHtml, /%85 \(Yüksek doluluk\)/);

  const criticalHtml = renderToStaticMarkup(React.createElement(UsageRing, { label: 'Disk', value: 90, detail: '90 GB / 100 GB' }));
  assert.match(criticalHtml, /is-critical is-high/);
  assert.match(criticalHtml, /%90 \(Kritik doluluk\)/);

  const unknownHtml = renderToStaticMarkup(React.createElement(UsageRing, { label: 'CPU', value: null, detail: '—' }));
  assert.match(unknownHtml, /is-unknown/);
  assert.match(unknownHtml, /CPU kullanım verisi bilinmiyor/);

  const errorServerHtml = renderToStaticMarkup(
    React.createElement(ServerSummary, {
      server: {
        id: 'srv-err',
        displayName: 'Kopuk Sunucu',
        connectivity: 'error',
        inventory: null,
      },
    }),
  );
  assert.match(errorServerHtml, /Kopuk Sunucu/);
  assert.match(errorServerHtml, /is-error is-unknown/);
  assert.match(errorServerHtml, /CPU kullanım verisinde hata/);
});

test('SCN-MON-02 [08]: DashboardPage renders live interval states (3s, 5s, 15s, paused) and disk threshold alert banners (84% none, 85% warn, 91% critical)', () => {
  const makeWorkspace = (diskUsed, telemetryIntervalMs = 5000) => ({
    domains: { status: 'ready', items: [] },
    websites: { status: 'ready', items: [] },
    applications: { status: 'ready', items: [] },
    certificates: { status: 'ready', items: [] },
    jobs: { status: 'ready', items: [] },
    servers: {
      status: 'ready',
      items: [
        {
          id: 'srv-1',
          displayName: 'Prod Sunucu',
          connectivity: 'online',
          lastSeenAt: '2026-10-25T12:00:00.000Z',
          inventory: {
            cpu: { count: 8, usagePercent: 35 },
            memory: { usedBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
            filesystem: { usedBytes: diskUsed, totalBytes: 100 },
          },
        },
      ],
      refresh: () => {},
    },
    refreshAll: () => {},
    isOwner: true,
    telemetryIntervalMs,
    setTelemetryIntervalMs: () => {},
  });

  const renderDash = (ws) => renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(WorkspaceContext.Provider, { value: ws }, React.createElement(DashboardPage)),
    ),
  );

  const html84 = renderDash(makeWorkspace(84, 3000));
  assert.match(html84, /Canlı · 3 sn/);
  assert.doesNotMatch(html84, /Disk alanı azalıyor/);
  assert.doesNotMatch(html84, /Kritik disk doluluğu/);

  const html85 = renderDash(makeWorkspace(85, 15000));
  assert.match(html85, /Canlı · 15 sn/);
  assert.match(html85, /Disk alanı azalıyor · %85/);
  assert.doesNotMatch(html85, /Kritik disk doluluğu/);

  const html91Paused = renderDash(makeWorkspace(91, 0));
  assert.match(html91Paused, /Duraklatıldı/);
  assert.match(html91Paused, /Kritik disk doluluğu · %91/);
});

test('SCN-MON-01 [09]: site-model certificateState classifies active, warning (<=30d), expired (<=0d), staging, error, pending, off, and missing validity dates', () => {
  const now = Date.parse('2026-10-25T00:00:00.000Z');
  const dayMs = 86_400_000;
  const domain = { id: 'dom-1', certificateId: 'cert-1', httpsMode: 'managed' };

  assert.equal(certificateState(domain, null, now).state, 'unknown');
  assert.equal(certificateState(domain, [], now).state, 'pending');
  assert.equal(certificateState({ ...domain, httpsMode: 'off' }, [], now).state, 'off');

  assert.equal(
    certificateState(domain, [{ id: 'cert-1', state: 'active', staging: true, validTo: new Date(now + 60 * dayMs).toISOString() }], now).state,
    'staging',
  );
  assert.equal(
    certificateState(domain, [{ id: 'cert-1', state: 'error' }], now).state,
    'error',
  );
  assert.equal(
    certificateState(domain, [{ id: 'cert-1', state: 'pending' }], now).state,
    'pending',
  );
  assert.equal(
    certificateState(domain, [{ id: 'cert-1', state: 'active', validTo: 'not-a-date' }], now).state,
    'unknown',
  );

  // Active (> 30 days)
  const active31 = certificateState(domain, [{ id: 'cert-1', state: 'active', validTo: new Date(now + 31 * dayMs).toISOString() }], now);
  assert.equal(active31.state, 'active');
  assert.equal(active31.days, 31);

  // Warning boundary (30 days and 1 day)
  const warn30 = certificateState(domain, [{ id: 'cert-1', state: 'active', validTo: new Date(now + 30 * dayMs).toISOString() }], now);
  assert.equal(warn30.state, 'warning');
  assert.equal(warn30.days, 30);

  const warn1 = certificateState(domain, [{ id: 'cert-1', state: 'active', validTo: new Date(now + 1 * dayMs).toISOString() }], now);
  assert.equal(warn1.state, 'warning');
  assert.equal(warn1.days, 1);

  // Expired boundary (0 days and negative days)
  const expired0 = certificateState(domain, [{ id: 'cert-1', state: 'active', validTo: new Date(now).toISOString() }], now);
  assert.equal(expired0.state, 'expired');
  const expiredPast = certificateState(domain, [{ id: 'cert-1', state: 'active', validTo: new Date(now - 5 * dayMs).toISOString() }], now);
  assert.equal(expiredPast.state, 'expired');
});

test('SCN-MON-01 [10]: computeWorkspaceAlerts enforces exact 84.9% (none), 85% (warning), and 90% (critical) boundaries for CPU, RAM, and Disk', () => {
  const buildServer = (pct) => ({
    id: 'srv-boundary',
    displayName: 'Boundary Node',
    connectivity: 'online',
    inventory: {
      cpu: { usagePercent: pct },
      memory: { usedBytes: pct, totalBytes: 100 },
      filesystem: { usedBytes: pct, totalBytes: 100 },
    },
  });

  // 84.9% -> 0 alerts
  const alerts84 = computeWorkspaceAlerts({ servers: [buildServer(84.9)] });
  assert.equal(alerts84.length, 0);

  // 85% -> 3 warning alerts (CPU, RAM, Disk)
  const alerts85 = computeWorkspaceAlerts({ servers: [buildServer(85)] });
  assert.equal(alerts85.length, 3);
  for (const alert of alerts85) {
    assert.equal(alert.category, 'server');
    assert.equal(alert.severity, 'warning');
    assert.equal(alert.severityLabel, 'Uyarı');
    assert.equal(alert.badgeState, 'warning');
    assert.equal(alert.href, '/servers');
  }

  // 89.9% -> still warning
  const alerts89 = computeWorkspaceAlerts({ servers: [buildServer(89.9)] });
  assert.equal(alerts89.length, 3);
  assert.ok(alerts89.every((a) => a.severity === 'warning'));

  // 90% -> 3 critical alerts (CPU, RAM, Disk)
  const alerts90 = computeWorkspaceAlerts({ servers: [buildServer(90)] });
  assert.equal(alerts90.length, 3);
  for (const alert of alerts90) {
    assert.equal(alert.category, 'server');
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.severityLabel, 'Kritik');
    assert.equal(alert.badgeState, 'failed');
    assert.equal(alert.href, '/servers');
  }
});

test('SCN-MON-01 [11]: computeWorkspaceAlerts classifies offline servers, SSL states (expired, error, warning, off, active, staging), and failed jobs', () => {
  const future90d = new Date(Date.now() + 90 * 86_400_000).toISOString();
  const future10d = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const past10d = new Date(Date.now() - 10 * 86_400_000).toISOString();

  const domains = [
    { id: 'dom-active', primaryDomain: 'active.example.com', certificateId: 'cert-active', httpsMode: 'managed' },
    { id: 'dom-staging', primaryDomain: 'staging.example.com', certificateId: 'cert-staging', httpsMode: 'managed' },
    { id: 'dom-warn', primaryDomain: 'warn.example.com', certificateId: 'cert-warn', httpsMode: 'managed' },
    { id: 'dom-expired', primaryDomain: 'expired.example.com', certificateId: 'cert-expired', httpsMode: 'managed' },
    { id: 'dom-error', primaryDomain: 'error.example.com', certificateId: 'cert-error', httpsMode: 'managed' },
    { id: 'dom-off', primaryDomain: 'off.example.com', certificateId: null, httpsMode: 'off' },
  ];
  const certificates = [
    { id: 'cert-active', state: 'active', validTo: future90d },
    { id: 'cert-staging', state: 'active', staging: true, validTo: future90d },
    { id: 'cert-warn', state: 'active', validTo: future10d },
    { id: 'cert-expired', state: 'active', validTo: past10d },
    { id: 'cert-error', state: 'error' },
  ];
  const servers = [
    { id: 'srv-offline', displayName: 'Yedek Sunucu', connectivity: 'offline', inventory: {} },
  ];
  const jobs = [
    { id: 'job-ok', operation: 'site.deploy', status: 'succeeded' },
    { id: 'job-run', operation: 'ssl.issue', status: 'running' },
    { id: 'job-fail', operation: 'database.backup', status: 'failed', error: { message: 'mysqldump çıkış kodu 2' } },
  ];

  const alerts = computeWorkspaceAlerts({ domains, certificates, servers, jobs });

  // Active and staging certificates do not trigger SSL alerts
  assert.equal(alerts.some((a) => a.id === 'ssl-dom-active'), false);
  assert.equal(alerts.some((a) => a.id === 'ssl-dom-staging'), false);

  // Warning and off SSL states trigger warning severity
  const warnSsl = alerts.find((a) => a.id === 'ssl-dom-warn');
  assert.equal(warnSsl?.severity, 'warning');
  assert.equal(warnSsl?.href, '/websites/dom-warn/ssl');

  const offSsl = alerts.find((a) => a.id === 'ssl-dom-off');
  assert.equal(offSsl?.severity, 'warning');
  assert.equal(offSsl?.href, '/websites/dom-off/ssl');

  // Expired and error SSL states trigger critical severity
  const expSsl = alerts.find((a) => a.id === 'ssl-dom-expired');
  assert.equal(expSsl?.severity, 'critical');
  assert.equal(expSsl?.href, '/websites/dom-expired/ssl');

  const errSsl = alerts.find((a) => a.id === 'ssl-dom-error');
  assert.equal(errSsl?.severity, 'critical');
  assert.equal(errSsl?.href, '/websites/dom-error/ssl');

  // Offline server triggers critical alert to /servers
  const srvAlert = alerts.find((a) => a.id === 'server-connectivity-srv-offline');
  assert.equal(srvAlert?.severity, 'critical');
  assert.equal(srvAlert?.href, '/servers');

  // Only failed job triggers job alert to /jobs?status=failed
  const jobAlerts = alerts.filter((a) => a.category === 'job');
  assert.equal(jobAlerts.length, 1);
  assert.equal(jobAlerts[0].id, 'job-failed-job-fail');
  assert.equal(jobAlerts[0].severity, 'critical');
  assert.equal(jobAlerts[0].href, '/jobs?status=failed');
  assert.equal(jobAlerts[0].detail, 'mysqldump çıkış kodu 2');
});

test('SCN-MON-01 [12]: computeWorkspaceAlerts deduplicates suspended domain and website alerts for the same domain target', () => {
  const domains = [
    { id: 'dom-shared', primaryDomain: 'shared.example.com', state: 'suspended', certificateId: 'cert-ok' },
  ];
  const websites = [
    { id: 'site-shared', primaryDomain: 'shared.example.com', primaryDomainId: 'dom-shared', state: 'suspended' },
    { id: 'site-standalone', primaryDomain: 'standalone.example.com', primaryDomainId: 'dom-standalone', state: 'suspended' },
  ];
  const certificates = [
    { id: 'cert-ok', state: 'active', validTo: new Date(Date.now() + 60 * 86_400_000).toISOString() },
  ];

  const alerts = computeWorkspaceAlerts({ domains, websites, certificates });
  const suspendedAlerts = alerts.filter((a) => a.category === 'domain');

  assert.equal(suspendedAlerts.length, 2);
  assert.ok(suspendedAlerts.some((a) => a.id === 'domain-suspended-dom-shared' && a.href === '/websites/dom-shared/settings'));
  assert.equal(suspendedAlerts.some((a) => a.id === 'website-suspended-site-shared'), false, 'Must not emit duplicate suspended alert when primaryDomainId is already alerted');
  assert.ok(suspendedAlerts.some((a) => a.id === 'website-suspended-site-standalone' && a.href === '/websites/dom-standalone/settings'));
});

test('SCN-MON-01/02 [13]: NotificationCenterDrawer renders empty states when open with zero jobs/alerts/notices and returns null when closed', () => {
  const emptyWorkspace = {
    domains: { status: 'ready', items: [] },
    websites: { status: 'ready', items: [] },
    certificates: { status: 'ready', items: [] },
    servers: { status: 'ready', items: [] },
    jobs: { status: 'ready', items: [] },
    notice: null,
    setNotice: () => {},
    observe: () => {},
  };

  const closedHtml = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(WorkspaceContext.Provider, { value: emptyWorkspace }, React.createElement(NotificationCenterDrawer, { open: false })),
    ),
  );
  assert.equal(closedHtml, '');

  for (const [tab, expectedText] of [
    ['tasks', 'Kuyrukta görev yok'],
    ['alerts', 'Sistem uyarısı yok'],
    ['notices', 'Yeni bildirim yok'],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(
          WorkspaceContext.Provider,
          { value: emptyWorkspace },
          React.createElement(NotificationCenterDrawer, { open: true, initialTab: tab }),
        ),
      ),
    );
    assert.match(html, new RegExp(expectedText));
  }
});

// ============================================================================
// SCN-RBAC-01: Owner / Reseller / Customer / Site-Manager / Read-Only RBAC
// ============================================================================

test('SCN-RBAC-01 [14]: ownerAccess and panelPermission enforce strict role, MFA enrollment, and permission boundaries', () => {
  const securityOk = { ownerMfaRequired: true, enrollmentRequired: false, managementAllowed: true };
  const securityEnroll = { ownerMfaRequired: true, enrollmentRequired: true, managementAllowed: false };

  const ownerSession = {
    user: { id: 'u-owner', role: 'owner' },
    security: securityOk,
    access: { mode: 'management', permissions: ['*'] },
  };
  assert.equal(ownerAccess(ownerSession), 'management');
  assert.equal(panelPermission(ownerSession, 'servers.read'), true);
  assert.equal(panelPermission(ownerSession, '*'), true);
  assert.equal(enrollmentCanContinue({ session: ownerSession, busy: false, sensitive: false }), true);
  assert.equal(enrollmentCanContinue({ session: ownerSession, busy: true, sensitive: false }), false);

  const enrollSession = { ...ownerSession, security: securityEnroll };
  assert.equal(ownerAccess(enrollSession), 'enrollment');
  assert.equal(panelPermission(enrollSession, 'domains.read'), false);

  for (const role of ['reseller', 'customer', 'site_manager']) {
    const scopedSession = {
      user: { id: `u-${role}`, role },
      security: securityOk,
      access: { mode: 'site_management', permissions: ['domains.read', 'websites.read'] },
    };
    assert.equal(ownerAccess(scopedSession), 'site_management');
    assert.equal(panelPermission(scopedSession, 'websites.read'), true);
    assert.equal(ownerAccess({ ...scopedSession, access: { mode: 'management', permissions: ['*'] } }), 'denied');
  }

  const readOnlySession = {
    user: { id: 'u-ro', role: 'read_only' },
    security: securityOk,
    access: { mode: 'read_only', permissions: ['domains.read', 'servers.read'] },
  };
  assert.equal(ownerAccess(readOnlySession), 'read_only');
  assert.equal(panelPermission(readOnlySession, 'domains.read'), true);
  assert.equal(panelPermission(readOnlySession, 'websites.write'), false);
  assert.equal(panelPermission(readOnlySession, '*'), false);

  // Read-only with wildcard '*' must be denied
  assert.equal(
    ownerAccess({ ...readOnlySession, access: { mode: 'read_only', permissions: ['*'] } }),
    'denied',
  );
  assert.equal(ownerAccess(null), 'unknown');
  assert.equal(ownerAccess({ user: { role: 'owner' } }), 'unknown');
});

test('SCN-RBAC-01 [15]: navigationGroups and navigationItemActive isolate Owner, Reseller, Customer, and Read-Only menus', () => {
  const ownerItems = navigationGroups(true, true, false, false)[0].items.map(([to]) => to);
  assert.deepEqual(ownerItems, [
    '/websites', '/mail', '/files', '/databases', '/statistics', '/customers', '/resellers', '/tools-settings',
  ]);

  const resellerGroup = navigationGroups(true, false, true, false)[0];
  assert.equal(resellerGroup.label, 'Bayi Menüsü');
  assert.deepEqual(resellerGroup.items.map(([to]) => to), [
    '/customers', '/websites', '/mail', '/files', '/databases', '/statistics',
  ]);
  assert.equal(resellerGroup.items[0][1], 'Müşterilerim');
  assert.equal(resellerGroup.items[1][1], 'Sitelerim');

  const customerGroup = navigationGroups(true, false, false, true)[0];
  assert.equal(customerGroup.label, 'Müşteri Menüsü');
  assert.deepEqual(customerGroup.items.map(([to]) => to), [
    '/websites', '/mail', '/files', '/databases', '/statistics',
  ]);

  const ownerReadOnlyGroup = navigationGroups(false, true, false, false)[0];
  assert.deepEqual(ownerReadOnlyGroup.items.map(([to]) => to), ['/websites', '/dashboard']);

  const customerReadOnlyGroup = navigationGroups(false, false, false, true)[0];
  assert.deepEqual(customerReadOnlyGroup.items.map(([to]) => to), ['/websites']);

  // Route highlighting rules
  assert.equal(navigationItemActive('/tools-settings', '/docker/proj-1'), true);
  assert.equal(navigationItemActive('/tools-settings', '/firewall'), true);
  assert.equal(navigationItemActive('/tools-settings', '/settings?section=dns'), true);
  assert.equal(navigationItemActive('/tools-settings', '/settings/users'), false);
  assert.equal(navigationItemActive('/settings/users', '/users/123'), true);
  assert.equal(navigationItemActive('/statistics', '/analytics/site-1'), true);
  assert.equal(navigationItemActive('/files', '/file-manager'), true);
});

test('SCN-RBAC-01 [16]: commandEntries scopes command palette results by role and supports Turkish locale domain search', () => {
  const domains = {
    status: 'ready',
    items: [
      { id: 'dom-1', primaryDomain: 'istanbul.example.com', aliases: ['www.istanbul.example.com'] },
      { id: 'dom-2', primaryDomain: 'ankara.example.com', aliases: ['portal.ankara.example.com'] },
    ],
  };

  const ownerCmds = commandEntries({ query: '', canManage: true, isOwner: true, domains });
  assert.ok(ownerCmds.some((c) => c.to === '/docker'));
  assert.ok(ownerCmds.some((c) => c.to === '/resellers'));
  assert.ok(ownerCmds.some((c) => c.to === '/firewall'));

  const resellerCmds = commandEntries({ query: '', canManage: true, isOwner: false, isReseller: true, domains });
  assert.ok(resellerCmds.some((c) => c.to === '/customers' && c.label === 'Müşterilerim'));
  assert.ok(resellerCmds.some((c) => c.to === '/websites' && c.detail === 'Sitelerim listesini aç'));
  assert.equal(resellerCmds.some((c) => c.to === '/docker' || c.to === '/resellers' || c.to === '/firewall'), false);

  const customerCmds = commandEntries({ query: '', canManage: true, isOwner: false, isCustomer: true, domains });
  assert.equal(customerCmds.some((c) => c.to === '/customers' || c.to === '/docker' || c.to === '/tools-settings'), false);

  // Turkish uppercase İ search matches 'istanbul.example.com' and 'İstatistikler'
  const trSearch = commandEntries({ query: 'İST', canManage: true, isOwner: false, isCustomer: true, domains });
  assert.ok(trSearch.some((c) => c.to === '/statistics'));
  assert.ok(trSearch.some((c) => c.id === 'domain:dom-1' && c.to === '/websites/dom-1/overview'));
  assert.ok(trSearch.some((c) => c.id === 'search-all' && c.to.startsWith('/websites?q=')));
});

test('SCN-RBAC-01 [17]: requirePanelRouteAccess enforces backend HTTP role guards for Owner, Reseller, Customer, Site-Manager, and Read-Only', () => {
  function runGuard(auth, method, url) {
    let statusCode = 200;
    let body = null;
    let passed = false;
    const req = { auth, method, url, originalUrl: url };
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; },
    };
    requirePanelRouteAccess(req, res, () => { passed = true; });
    return { passed, statusCode, body };
  }

  // Unauthenticated -> 401
  const unauth = runGuard(null, 'GET', '/api/websites');
  assert.equal(unauth.passed, false);
  assert.equal(unauth.statusCode, 401);

  // Owner -> allowed everywhere
  const ownerAuth = {
    user: { id: 'o1', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  assert.equal(runGuard(ownerAuth, 'POST', '/api/firewall').passed, true);
  assert.equal(runGuard(ownerAuth, 'DELETE', '/api/users/u2').passed, true);

  // Reseller -> allowed on /api/websites and /api/users/hosting/accounts, blocked on /api/users, /api/panel/settings, /api/firewall
  const resellerAuth = {
    user: { id: 'r1', role: 'reseller', hosting: { kind: 'reseller' } },
    access: { mode: 'site_management', permissions: [] },
    security: { managementAllowed: true },
  };
  assert.equal(runGuard(resellerAuth, 'GET', '/api/websites').passed, true);
  assert.equal(runGuard(resellerAuth, 'GET', '/api/users/hosting/accounts').passed, true);
  assert.equal(runGuard(resellerAuth, 'GET', '/api/audit').passed, true);
  for (const forbiddenUrl of ['/api/users', '/api/panel/settings', '/api/system/packages', '/api/firewall/rules']) {
    const res = runGuard(resellerAuth, 'GET', forbiddenUrl);
    assert.equal(res.passed, false, `Reseller must be blocked from ${forbiddenUrl}`);
    assert.equal(res.statusCode, 403);
  }

  // Legacy site_manager without hosting object is also blocked on /api/audit
  const legacySiteManagerAuth = {
    user: { id: 'sm1', role: 'site_manager' },
    access: { mode: 'site_management', permissions: [] },
    security: { managementAllowed: true },
  };
  assert.equal(runGuard(legacySiteManagerAuth, 'GET', '/api/audit').statusCode, 403);

  // Read-only -> allowed GET with matching permission, blocked on POST
  const readOnlyAuth = {
    user: { id: 'ro1', role: 'read_only' },
    access: { mode: 'read_only', permissions: ['domains.read'] },
    security: { managementAllowed: false },
  };
  assert.equal(runGuard(readOnlyAuth, 'GET', '/api/domains').passed, true);
  assert.equal(runGuard(readOnlyAuth, 'POST', '/api/domains').statusCode, 403);
  assert.equal(runGuard(readOnlyAuth, 'GET', '/api/servers').statusCode, 403);
});

test('SCN-RBAC-01 [18]: createSiteResourceBoundary isolates Reseller A from Reseller B and Owner websites, domains, apps, certs, and jobs', async () => {
  const serverId = 'srv-local';
  const websitesData = [
    { id: 'site-a1', serverId, applicationId: 'app-a1', customerId: 'cust-a1', resellerId: 'reseller-a' },
    { id: 'site-b1', serverId, applicationId: 'app-b1', customerId: 'cust-b1', resellerId: 'reseller-b' },
    { id: 'site-owner', serverId, applicationId: 'app-owner', customerId: null, resellerId: null },
  ];
  const domainsData = [
    { id: 'dom-a1', websiteId: 'site-a1', serverId, certificateId: 'cert-a1', primaryDomain: 'a1.example.com' },
    { id: 'dom-b1', websiteId: 'site-b1', serverId, certificateId: 'cert-b1', primaryDomain: 'b1.example.com' },
    { id: 'dom-owner', websiteId: 'site-owner', serverId, certificateId: 'cert-owner', primaryDomain: 'owner.example.com' },
  ];
  const jobsData = [
    { id: 'job-a1', serverId, resourceType: 'website', resourceId: 'site-a1' },
    { id: 'job-b1', serverId, resourceType: 'website', resourceId: 'site-b1' },
  ];

  const boundary = createSiteResourceBoundary({
    localServerId: serverId,
    websiteRegistry: {
      getWebsite: async (id) => websitesData.find((w) => w.id === id) ?? null,
      listWebsites: async () => websitesData,
    },
    domainRegistry: {
      getDomain: async (id) => domainsData.find((d) => d.id === id) ?? null,
      listDomains: async () => domainsData,
    },
    jobRegistry: {
      listJobs: async () => jobsData,
      getJob: async (id) => jobsData.find((j) => j.id === id) ?? null,
    },
    customerLookup: async (custId) => {
      if (custId === 'cust-a1') return { id: 'cust-a1', resellerId: 'reseller-a' };
      if (custId === 'cust-b1') return { id: 'cust-b1', resellerId: 'reseller-b' };
      return null;
    },
  });

  const resellerAAuth = {
    user: { id: 'reseller-a', role: 'reseller', active: true, hosting: { kind: 'reseller' }, websiteIds: ['site-a1'] },
    access: { mode: 'site_management', permissions: [] },
    security: { managementAllowed: true },
  };

  async function callBoundary(auth, method, url, routePayload = null) {
    let statusCode = 200;
    let body = null;
    const req = { auth, method, url, originalUrl: url, body: {} };
    const res = {
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; },
    };
    await boundary(req, res, () => {
      if (routePayload !== null) res.json(routePayload);
    });
    return { statusCode, body };
  }

  // Reseller A collection filtering
  const filteredWebsites = await callBoundary(resellerAAuth, 'GET', '/api/websites', { data: websitesData, total: 3 });
  assert.deepEqual(filteredWebsites.body, { data: [websitesData[0]] });

  const filteredDomains = await callBoundary(resellerAAuth, 'GET', '/api/domains', { data: domainsData });
  assert.deepEqual(filteredDomains.body, { data: [domainsData[0]] });

  const filteredJobs = await callBoundary(resellerAAuth, 'GET', '/api/jobs', { data: jobsData });
  assert.deepEqual(filteredJobs.body, { data: [jobsData[0]] });

  // Reseller A can access own website and domain
  assert.equal((await callBoundary(resellerAAuth, 'GET', '/api/websites/site-a1', { ok: true })).statusCode, 200);
  assert.equal((await callBoundary(resellerAAuth, 'GET', '/api/domains/dom-a1', { ok: true })).statusCode, 200);

  // Reseller A is blocked with 403 from Reseller B's and Owner's resources
  for (const forbiddenPath of [
    '/api/websites/site-b1',
    '/api/websites/site-owner',
    '/api/domains/dom-b1',
    '/api/domains/dom-owner',
    '/api/jobs/job-b1',
  ]) {
    const denied = await callBoundary(resellerAAuth, 'GET', forbiddenPath, { ok: true });
    assert.equal(denied.statusCode, 403, `Reseller A must be denied on ${forbiddenPath}`);
    assert.equal(denied.body?.error?.code, 'site_scope_forbidden');
  }
});

test('SCN-RBAC-01 [19]: createSiteResourceBoundary isolates Customer accounts from sibling customers, server terminal, and blocks inactive accounts', async () => {
  const serverId = 'srv-local';
  const websitesData = [
    { id: 'site-c1', serverId, applicationId: 'app-c1', customerId: 'cust-1', resellerId: 'reseller-a' },
    { id: 'site-c2', serverId, applicationId: 'app-c2', customerId: 'cust-2', resellerId: 'reseller-a' },
  ];
  const boundary = createSiteResourceBoundary({
    localServerId: serverId,
    websiteRegistry: {
      getWebsite: async (id) => websitesData.find((w) => w.id === id) ?? null,
      listWebsites: async () => websitesData,
    },
    domainRegistry: {
      getDomain: async () => null,
      listDomains: async () => [],
    },
  });

  async function invokeBoundary(auth, method, url, body = {}) {
    let statusCode = 200;
    let payload = null;
    let nextCalled = false;
    const req = { auth, method, url, originalUrl: url, body };
    const res = {
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(data) { payload = data; return this; },
    };
    await boundary(req, res, () => { nextCalled = true; });
    return { statusCode, payload, nextCalled };
  }

  const cust1Auth = {
    user: { id: 'cust-1', role: 'customer', active: true, hosting: { kind: 'customer', resellerId: 'reseller-a' }, websiteIds: ['site-c1'] },
    access: { mode: 'site_management', permissions: [] },
    security: { managementAllowed: true },
  };

  // Customer 1 allowed on own site and own site terminal
  assert.equal((await invokeBoundary(cust1Auth, 'GET', '/api/websites/site-c1')).nextCalled, true);
  assert.equal((await invokeBoundary(cust1Auth, 'POST', '/api/terminal/capabilities', { scope: 'site', websiteId: 'site-c1' })).nextCalled, true);

  // Customer 1 denied on sibling Customer 2's site and on global server terminal
  assert.equal((await invokeBoundary(cust1Auth, 'GET', '/api/websites/site-c2')).statusCode, 403);
  assert.equal((await invokeBoundary(cust1Auth, 'POST', '/api/terminal/capabilities', { scope: 'site', websiteId: 'site-c2' })).statusCode, 403);
  assert.equal((await invokeBoundary(cust1Auth, 'POST', '/api/terminal/capabilities', { scope: 'server' })).statusCode, 403);
  assert.equal((await invokeBoundary(cust1Auth, 'POST', '/api/websites/site-c1/migration')).statusCode, 403);

  // Inactive customer account is immediately blocked with 403
  const inactiveCustAuth = {
    ...cust1Auth,
    user: { ...cust1Auth.user, active: false },
  };
  const inactiveRes = await invokeBoundary(inactiveCustAuth, 'GET', '/api/websites/site-c1');
  assert.equal(inactiveRes.statusCode, 403);
  assert.equal(inactiveRes.payload?.error?.code, 'site_scope_forbidden');

  // needsSiteResourceJson helper check
  assert.equal(needsSiteResourceJson({ method: 'POST', url: '/api/domains', auth: cust1Auth }), true);
  assert.equal(needsSiteResourceJson({ method: 'GET', url: '/api/domains', auth: cust1Auth }), false);
});

test('SCN-RBAC-01 [20]: hosting-site-allocation-store and hosting-account-client enforce Reseller customer ownership and Customer website quotas on real SQLite', (t) => {
  const f = siteFixture(t, { maxWebsites: 2, maxCustomers: 5 });

  // Configure customer-a quota to maxWebsites = 1 via explicit column insert
  f.db.prepare(
    'INSERT OR REPLACE INTO auth_customer_quotas (customer_id, max_websites, max_disk_mb, max_traffic_mb, max_databases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1000, 1000)',
  ).run('customer-a', 1, 1024, null, 2);

  const resellerAStore = createHostingSiteAllocationStore({
    db: f.db,
    now: f.now,
    transaction: f.transaction,
    owner: () => ({ id: 'owner', role: 'owner', active: true }),
    existing: (id) => f.db.prepare('SELECT u.id AS user_id, u.username, u.active, h.kind, h.reseller_id, h.revision, 1 AS user_revision, 1000 AS created_at, 1000 AS updated_at FROM users u LEFT JOIN auth_hosting_accounts h ON h.user_id = u.id WHERE u.id = ?').get(id),
    projection: (row) => ({ id: row.user_id, kind: row.kind, resellerId: row.reseller_id, active: Boolean(row.active) }),
    limits: () => ({ maxCustomers: 5, maxWebsites: 2 }),
    usage: () => ({ customers: 2, websites: 0 }),
    invalidate: () => {},
    audit: () => {},
    revokeLiveUser: () => {},
    managementActor: () => ({ id: 'reseller-a', role: 'reseller', active: true }),
  });

  // Reseller A cannot preview or reserve a website for Reseller B's customer (customer-c) or Owner's direct customer
  assert.throws(
    () => resellerAStore.preview('token', () => {}, fixtureAllocation(1, 'customer-c')),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );
  assert.throws(
    () => resellerAStore.reserve('token', () => {}, fixtureAllocation(1, 'direct')),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Reseller A can reserve and complete 1st site for customer-a
  const alloc1 = fixtureAllocation(1, 'customer-a');
  const reserved1 = resellerAStore.reserve('token', () => {}, alloc1);
  assert.equal(reserved1.state, 'reserved');
  const completed1 = resellerAStore.complete('token', () => {}, alloc1, fixtureWebsite(1));
  assert.equal(completed1.state, 'attached');
  assert.equal(completed1.accessGranted, true);

  // 2nd site for customer-a exceeds customer max_websites = 1 quota -> 409 customer_quota_exceeded
  const alloc2 = fixtureAllocation(2, 'customer-a');
  assert.throws(
    () => resellerAStore.preview('token', () => {}, alloc2),
    (err) => err instanceof AuthError && err.code === 'customer_quota_exceeded' && err.status === 409,
  );
  assert.equal(
    hostingAccountMessage({ code: 'customer_quota_exceeded' }),
    'Müşteri web sitesi kotası doldu. Yeni site tahsis edilemez.',
  );

  // Validate hostingCustomerQuotasInput & readHostingAccount
  assert.deepEqual(
    hostingCustomerQuotasInput({ maxWebsites: '5', maxDiskMb: '2048', maxTrafficMb: '', maxDatabases: '3' }),
    { maxWebsites: 5, maxDiskMb: 2048, maxTrafficMb: null, maxDatabases: 3 },
  );
  const accountView = readHostingAccount({
    id: 'customer-a',
    username: 'customer-a',
    kind: 'customer',
    resellerId: 'reseller-a',
    active: true,
    revision: 1,
    userRevision: 1,
    createdAt: 1000,
    updatedAt: 1000,
    stage: 'profile_only',
    quotas: { maxWebsites: 1, maxDiskMb: 1024, maxTrafficMb: null, maxDatabases: 2 },
    usage: { websites: 1, diskMb: 120, trafficMb: 0, databases: 1 },
  });
  assert.equal(accountView.quotas.maxWebsites, 1);
  assert.equal(accountView.usage.websites, 1);
});

test('SCN-RBAC-01 [21]: collectionReducer and scopedCollectionReducer purge protected data on 401/403/404 and fence cross-scope responses', () => {
  const scopeTenantA = { path: '/websites?tenant=a', enabled: true };
  const scopeTenantB = { path: '/websites?tenant=b', enabled: true };
  const disabledScope = { path: '/websites?tenant=a', enabled: false };

  let state = initialScopedCollection();
  state = scopedCollectionReducer(state, { type: 'begin', scope: scopeTenantA, run: 1 });
  state = scopedCollectionReducer(state, {
    type: 'success',
    scope: scopeTenantA,
    run: 1,
    items: [{ id: 'site-a', name: 'Tenant A Site' }],
    now: 1000,
  });
  assert.equal(scopedCollectionView(state, scopeTenantA).status, 'ready');
  assert.equal(scopedCollectionView(state, scopeTenantA).items.length, 1);

  // Switching scope immediately masks Tenant A records on the very same render frame
  assert.deepEqual(scopedCollectionView(state, scopeTenantB).items, []);
  assert.equal(scopedCollectionView(state, scopeTenantB).status, 'loading');
  assert.equal(scopedCollectionView(state, disabledScope).status, 'disabled');
  assert.deepEqual(scopedCollectionView(state, disabledScope).items, []);

  // Begin Tenant B run 2; late reply from Tenant A run 1 is ignored
  const stateB = scopedCollectionReducer(state, { type: 'begin', scope: scopeTenantB, run: 2 });
  const afterLateReply = scopedCollectionReducer(stateB, {
    type: 'success',
    scope: scopeTenantA,
    run: 1,
    items: [{ id: 'leaked-site' }],
  });
  assert.equal(afterLateReply, stateB);

  // Access revocation (401, 403, 404) clears items, whereas network TypeError retains stale items
  const netFail = collectionReducer(state.value, { type: 'failure', error: new TypeError('Failed to fetch') });
  assert.equal(netFail.status, 'stale');
  assert.equal(netFail.items.length, 1);

  for (const status of [401, 403, 404]) {
    const revoked = collectionReducer(state.value, { type: 'failure', error: { status } });
    assert.deepEqual(revoked.items, []);
    assert.equal(readableItems(revoked).length, 0);
    assert.equal(knownCount(revoked), null);
  }
  assert.equal(
    collectionError({ status: 403, code: 'mfa_enrollment_required' }).message,
    'Yönetim için doğrulayıcı kurulumunu tamamlayın.',
  );
});

test('SCN-RBAC-01 [22]: collectionReducer prevents stale polling from rolling back domain desiredRevision, certificateId, or renewed SSL validity', () => {
  const initial = collectionReducer(initialCollection(), {
    type: 'success',
    items: [
      {
        id: 'dom-1',
        primaryDomain: 'example.com',
        desiredRevision: 5,
        certificateId: 'cert-5',
      },
      {
        id: 'cert-5',
        state: 'active',
        validFrom: '2026-10-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
        lastRenewedAt: '2026-10-01T00:00:00.000Z',
        fingerprint256: 'FP_NEW',
      },
    ],
  });

  const afterStalePoll = collectionReducer(initial, {
    type: 'success',
    items: [
      {
        id: 'dom-1',
        primaryDomain: 'example.com',
        desiredRevision: 4,
        certificateId: null,
      },
      {
        id: 'cert-5',
        state: 'renewing',
        validFrom: '2026-07-01T00:00:00.000Z',
        validTo: '2026-10-01T00:00:00.000Z',
        lastRenewedAt: '2026-07-01T00:00:00.000Z',
        fingerprint256: 'FP_OLD',
      },
    ],
  });

  const [domAfter, certAfter] = afterStalePoll.items;
  assert.equal(domAfter.desiredRevision, 5);
  assert.equal(domAfter.certificateId, 'cert-5');
  assert.equal(certAfter.state, 'active');
  assert.equal(certAfter.validTo, '2027-01-01T00:00:00.000Z');
  assert.equal(certAfter.fingerprint256, 'FP_NEW');
});

test('SCN-RBAC-01 [23]: workspaceResources enables only necessary collections per route and activates jobs when observing or running', () => {
  assert.deepEqual(workspaceResources('/dashboard'), {
    domains: true, websites: false, applications: true, certificates: true, servers: true, jobs: true,
  });
  assert.deepEqual(workspaceResources('/websites'), {
    domains: true, websites: true, applications: true, certificates: true, servers: true, jobs: false,
  });
  assert.deepEqual(workspaceResources('/files'), {
    domains: true, websites: true, applications: false, certificates: false, servers: false, jobs: false,
  });
  assert.deepEqual(workspaceResources('/files', { activeJob: true }), {
    domains: true, websites: true, applications: false, certificates: false, servers: false, jobs: true,
  });
  assert.deepEqual(workspaceResources('/docker/stack-1'), {
    domains: false, websites: false, applications: false, certificates: false, servers: true, jobs: true,
  });
  assert.deepEqual(workspaceResources('/websites/dom-1/hosting'), {
    domains: true, websites: true, applications: true, certificates: true, servers: true, jobs: true,
  });
  assert.deepEqual(workspaceResources('/websites/dom-1/files'), {
    domains: true, websites: true, applications: true, certificates: true, servers: true, jobs: false,
  });
});

// ============================================================================
// SCN-RES-01: Domain → Subdomain Hierarchy, Multi-Runtime Tools & Site Resources
// ============================================================================

test('SCN-RES-01 [24]: domainTreeRows constructs multi-level Domain → Subdomain hierarchies, preserves search ancestors, and breaks parent cycles', () => {
  const domains = [
    { id: 'd-root', primaryDomain: 'webrich.news', parentDomainId: null, aliases: ['www.webrich.news'] },
    { id: 'd-api', primaryDomain: 'api.webrich.news', parentDomainId: 'd-root', aliases: [] },
    { id: 'd-v2', primaryDomain: 'v2.api.webrich.news', parentDomainId: 'd-api', aliases: ['beta-v2.webrich.news'] },
    { id: 'd-blog', primaryDomain: 'blog.webrich.news', parentDomainId: 'd-root', aliases: [] },
    { id: 'd-orphan', primaryDomain: 'orphan.example.com', parentDomainId: 'non-existent', aliases: [] },
    { id: 'd-cycle-1', primaryDomain: 'cycle1.example.com', parentDomainId: 'd-cycle-2', aliases: [] },
    { id: 'd-cycle-2', primaryDomain: 'cycle2.example.com', parentDomainId: 'd-cycle-1', aliases: [] },
  ];

  const rows = domainTreeRows(domains);
  assert.equal(rows.length, 7);

  const rootRow = rows.find((r) => r.domain.id === 'd-root');
  const apiRow = rows.find((r) => r.domain.id === 'd-api');
  const v2Row = rows.find((r) => r.domain.id === 'd-v2');
  const orphanRow = rows.find((r) => r.domain.id === 'd-orphan');
  const cycle1Row = rows.find((r) => r.domain.id === 'd-cycle-1');

  assert.equal(rootRow.depth, 0);
  assert.equal(rootRow.childCount, 2);
  assert.equal(apiRow.depth, 1);
  assert.equal(apiRow.childCount, 1);
  assert.equal(v2Row.depth, 2);
  assert.equal(orphanRow.depth, 0);
  assert.equal(orphanRow.warning, 'Parent relationship needs review');
  assert.equal(cycle1Row.warning, 'Parent relationship needs review');

  // Collapsing d-api hides d-v2 unless searching
  const collapsedRows = domainTreeRows(domains, { collapsed: new Set(['d-api']) });
  assert.equal(collapsedRows.some((r) => r.domain.id === 'd-v2'), false);

  // Searching for alias 'beta-v2' expands and retains ancestors d-root -> d-api -> d-v2
  const searchRows = domainTreeRows(domains, { query: 'beta-v2', collapsed: new Set(['d-root', 'd-api']) });
  assert.deepEqual(searchRows.map((r) => [r.domain.id, r.depth]), [
    ['d-root', 0],
    ['d-api', 1],
    ['d-v2', 2],
  ]);
});

test('SCN-RES-01 [25]: siteListPage paginates whole domain-subdomain trees without splitting children and marks non-matching parents contextOnly', () => {
  const treeRows = [
    { domain: { id: 'root-1', primaryDomain: 'alpha.com', targetType: 'static', state: 'active' }, depth: 0 },
    { domain: { id: 'sub-1a', primaryDomain: 'api.alpha.com', targetType: 'proxy', state: 'active' }, depth: 1 },
    { domain: { id: 'sub-1b', primaryDomain: 'v2.api.alpha.com', targetType: 'proxy', state: 'suspended' }, depth: 2 },
    { domain: { id: 'root-2', primaryDomain: 'beta.com', targetType: 'static', state: 'active' }, depth: 0 },
    { domain: { id: 'sub-2a', primaryDomain: 'app.beta.com', targetType: 'proxy', state: 'active' }, depth: 1 },
  ];

  // Page 1 with perPage: 1 keeps the entire root-1 group together (3 rows)
  const page1 = siteListPage(treeRows, { perPage: 1, page: 1 });
  assert.deepEqual(page1.rows.map((r) => r.domain.id), ['root-1', 'sub-1a', 'sub-1b']);
  assert.equal(page1.totalGroups, 2);
  assert.equal(page1.pageCount, 2);

  // Filter by status: 'suspended' keeps root-1 and sub-1a as contextOnly: true for sub-1b
  const suspendedFilter = siteListPage(treeRows, { status: 'suspended' });
  assert.deepEqual(
    suspendedFilter.rows.map((r) => [r.domain.id, r.contextOnly]),
    [
      ['root-1', true],
      ['sub-1a', true],
      ['sub-1b', false],
    ],
  );
  assert.equal(suspendedFilter.totalMatches, 1);

  // Descending sort reverses top-level groups while keeping parent -> child order inside each group
  const descPage = siteListPage(treeRows, { sort: 'desc' });
  assert.deepEqual(descPage.rows.map((r) => r.domain.id), ['root-2', 'sub-2a', 'root-1', 'sub-1a', 'sub-1b']);
});

test('SCN-RES-01 [26]: createWebsiteTaskResolver resolves accurate primary and secondary tool cards across PHP, Node.js, Python, Static, and Docker runtimes', () => {
  const serverId = 'srv-1';
  const domains = {
    status: 'ready',
    items: [
      { id: 'dom-php', websiteId: 'site-php', serverId, primaryDomain: 'php.example.com' },
      { id: 'dom-node', websiteId: 'site-node', serverId, primaryDomain: 'node.example.com' },
      { id: 'dom-py', websiteId: 'site-py', serverId, primaryDomain: 'py.example.com' },
      { id: 'dom-static', websiteId: 'site-static', serverId, primaryDomain: 'static.example.com' },
      { id: 'dom-docker', websiteId: 'site-docker', serverId, primaryDomain: 'docker.example.com' },
    ],
  };
  const websites = {
    status: 'ready',
    items: [
      { id: 'site-php', serverId, runtimeType: 'php', applicationId: 'app-php' },
      { id: 'site-node', serverId, runtimeType: 'node', applicationId: 'app-node' },
      { id: 'site-py', serverId, runtimeType: 'python', applicationId: 'app-py' },
      { id: 'site-static', serverId, runtimeType: 'static', applicationId: 'app-static' },
      { id: 'site-docker', serverId, runtimeType: 'docker', applicationId: null },
    ],
  };
  const applications = {
    status: 'ready',
    items: [
      { id: 'app-php', serverId, type: 'php', name: 'WP Blog', repositoryUrl: null },
      { id: 'app-node', serverId, type: 'node', name: 'NextJS Store', repositoryUrl: 'https://github.com/org/store.git' },
      { id: 'app-py', serverId, type: 'python', name: 'FastAPI Service', repositoryUrl: 'https://github.com/org/api.git' },
      { id: 'app-static', serverId, type: 'static', name: 'Astro Docs', repositoryUrl: null },
    ],
  };

  const resolve = createWebsiteTaskResolver({ domains, websites, applications, canManage: true, isOwner: true });

  // 1. PHP runtime
  const phpCard = resolve('dom-php');
  assert.equal(phpCard.runtimeLabel, 'PHP-FPM');
  assert.equal(phpCard.applicationName, 'WP Blog');
  assert.deepEqual(phpCard.tools.map((t) => t.key), ['files', 'databases', 'ssl', 'dns', 'mail', 'logs', 'wordpress']);
  assert.ok(phpCard.secondaryTools.some((t) => t.key === 'php' && t.label === 'PHP Ayarları' && t.href === '/websites/dom-php/php'));
  assert.equal(phpCard.secondaryTools.some((t) => t.key === 'deploy'), false);

  // 2. Node.js runtime with Git repository
  const nodeCard = resolve('dom-node');
  assert.equal(nodeCard.runtimeLabel, 'Node.js');
  assert.equal(nodeCard.applicationName, 'NextJS Store');
  assert.ok(nodeCard.secondaryTools.some((t) => t.key === 'node' && t.label === 'Node.js' && t.href === '/websites/dom-node/node'));
  assert.ok(nodeCard.secondaryTools.some((t) => t.key === 'deploy' && t.href === '/websites/dom-node/deploy'));

  // 3. Python runtime with Git repository
  const pyCard = resolve('dom-py');
  assert.equal(pyCard.runtimeLabel, 'Python');
  assert.ok(pyCard.secondaryTools.some((t) => t.key === 'node' && t.label === 'Python' && t.href === '/websites/dom-py/node'));
  assert.ok(pyCard.secondaryTools.some((t) => t.key === 'deploy' && t.href === '/websites/dom-py/deploy'));

  // 4. Static runtime
  const staticCard = resolve('dom-static');
  assert.equal(staticCard.runtimeLabel, 'Statik site');
  assert.ok(staticCard.secondaryTools.some((t) => t.key === 'node' && t.label === 'Uygulama' && t.href === '/websites/dom-static/node'));

  // 5. Docker Compose bound site (applicationId: null) -> never invents a broken 'node' tool link
  const dockerCard = resolve('dom-docker');
  assert.equal(dockerCard.runtimeLabel, 'Docker');
  assert.equal(dockerCard.bindingProblem, null);
  assert.equal(dockerCard.tools.find((t) => t.key === 'files')?.href, '/websites/dom-docker/files');
  assert.equal(dockerCard.tools.find((t) => t.key === 'databases')?.href, '/websites/dom-docker/databases');
  assert.equal(dockerCard.secondaryTools.find((t) => t.key === 'hosting')?.href, '/websites/dom-docker/hosting');
  assert.equal(dockerCard.secondaryTools.find((t) => t.key === 'backup')?.href, '/websites/dom-docker/backup');
  assert.equal(dockerCard.secondaryTools.some((t) => t.key === 'node'), false);
});

test('SCN-RES-01 [27]: createWebsiteTaskResolver blocks cross-server bindings, duplicate IDs, and owner-only actions for Reseller/Customer', () => {
  const domain = { id: 'dom-1', websiteId: 'site-1', serverId: 'srv-a', primaryDomain: 'example.com' };
  const website = { id: 'site-1', applicationId: 'app-1', serverId: 'srv-a', runtimeType: 'node' };
  const app = { id: 'app-1', serverId: 'srv-a', type: 'node', name: 'App 1' };

  // Non-owner (Reseller / Customer) cannot get createSubdomainHref or removeWebsiteHref
  const customerResolved = createWebsiteTaskResolver({
    domains: { status: 'ready', items: [domain] },
    websites: { status: 'ready', items: [website] },
    applications: { status: 'ready', items: [app] },
    canManage: true,
    isOwner: false,
  })('dom-1');
  assert.equal(customerResolved.createSubdomainHref, null);
  assert.equal(customerResolved.removeHref, null);
  assert.equal(customerResolved.removeWebsiteHref, null);
  assert.equal(customerResolved.manageAliasesHref, '/websites/dom-1/domains');

  // Cross-server website or application is rejected
  const crossServerSite = createWebsiteTaskResolver({
    domains: { status: 'ready', items: [domain] },
    websites: { status: 'ready', items: [{ ...website, serverId: 'srv-b' }] },
    applications: { status: 'ready', items: [app] },
    canManage: true,
    isOwner: true,
  })('dom-1');
  assert.ok(crossServerSite.bindingProblem);
  assert.equal(crossServerSite.tools.find((t) => t.key === 'databases')?.href, null);
  assert.equal(crossServerSite.removeWebsiteHref, null);

  // Ambiguous duplicate website IDs invalidate website binding
  const duplicateSites = createWebsiteTaskResolver({
    domains: { status: 'ready', items: [domain] },
    websites: { status: 'ready', items: [website, { ...website }] },
    applications: { status: 'ready', items: [app] },
    canManage: true,
    isOwner: true,
  })('dom-1');
  assert.ok(duplicateSites.bindingProblem);
  assert.equal(duplicateSites.tools.find((t) => t.key === 'mail')?.href, null);
});

test('SCN-RES-01 [28]: site-model normalizes all tab aliases, encodes special characters in IDs, and prevents open-redirect / XSS URLs', () => {
  // Tab alias normalization
  const aliasPairs = [
    ['statistics', 'analytics'], ['stats', 'analytics'],
    ['scheduled-tasks', 'cron'], ['crons', 'cron'],
    ['backups', 'backup'], ['restore', 'backup'],
    ['git', 'deploy'], ['deployments', 'deploy'],
    ['sftp', 'access'], ['ssh', 'access'],
    ['wp', 'wordpress'],
    ['file-manager', 'files'],
    ['db', 'databases'], ['database', 'databases'],
    ['mailbox', 'mail'], ['email', 'mail'],
    ['certificates', 'ssl'], ['ssl-tls', 'ssl'],
    ['python', 'node'], ['docker', 'node'], ['application', 'node'],
    ['aliases', 'domains'],
    ['unknown-tab-xyz', 'overview'], [null, 'overview'],
  ];
  for (const [input, expected] of aliasPairs) {
    assert.equal(normalizeSiteTab(input), expected);
  }

  // Special characters in domain IDs are safely URI-encoded
  const trickyId = 'dom /?#%&=';
  assert.equal(siteHref(trickyId, 'hosting'), `/websites/${encodeURIComponent(trickyId)}/hosting`);
  assert.equal(siteHref('', 'hosting'), '/websites');

  // safeReturnHref blocks external origins, protocol-relative URLs, backslashes, and unknown routes
  assert.equal(safeReturnHref('/websites?q=test&page=2'), '/websites?q=test&page=2');
  assert.equal(safeReturnHref('/docker/stack-1'), '/docker/stack-1');
  for (const unsafe of ['//evil.example.com', 'https://evil.example.com', '/\\evil.com', 'javascript:alert(1)', '/admin-secret', null, 123]) {
    assert.equal(safeReturnHref(unsafe, '/websites'), '/websites');
  }

  // externalSiteUrl validates strict DNS hostname format
  assert.equal(externalSiteUrl({ primaryDomain: 'sub.example.com', certificateId: 'cert-1' }), 'https://sub.example.com/');
  assert.equal(externalSiteUrl({ primaryDomain: 'sub.example.com', certificateId: null }), 'http://sub.example.com/');
  for (const badHost of ['javascript:alert(1)', 'example.com/path', 'user@example.com', 'x.test#fragment', 'localhost', '']) {
    assert.equal(externalSiteUrl({ primaryDomain: badHost }), null);
  }

  // groupSiteTabs places unknown extensions under Ek Araçlar and hides legacy 'resources' duplicate
  const grouped = groupSiteTabs([...SITE_TABS, ['custom-plugin', 'Özel Araç']]);
  assert.ok(grouped.some((g) => g.id === 'extensions' && g.tabs.some((t) => t[0] === 'custom-plugin')));
});

test('SCN-RES-01 [29]: resolveSiteToolEntry resolves global tool entries across single/multiple domains, unbound websites, and mail domain strictness', () => {
  const websites = {
    status: 'ready',
    items: [
      { id: 'site-1', serverId: 'srv-1', name: 'Alpha Site' },
      { id: 'site-2', serverId: 'srv-1', name: 'Beta Site' },
      { id: 'site-unbound', serverId: 'srv-1', name: 'Unbound Site' },
    ],
  };
  const domains = {
    status: 'ready',
    items: [
      { id: 'dom-1', websiteId: 'site-1', serverId: 'srv-1', primaryDomain: 'alpha.example.com' },
      { id: 'dom-2', websiteId: 'site-2', serverId: 'srv-1', primaryDomain: 'beta.example.com' },
    ],
  };

  assert.equal(resolveSiteToolEntry({ tool: 'unknown', websites, domains, canManage: true }).state, 'unsupported');
  assert.equal(resolveSiteToolEntry({ tool: 'databases', websites, domains, canManage: false }).state, 'forbidden');
  assert.equal(resolveSiteToolEntry({ tool: 'databases', websites: { status: 'loading', items: [] }, domains, canManage: true }).state, 'unavailable');

  // Multiple sites -> 'choose' sorted alphabetically in Turkish
  const chooseRes = resolveSiteToolEntry({ tool: 'statistics', websites, domains, canManage: true });
  assert.equal(chooseRes.state, 'choose');
  assert.equal(chooseRes.targets[0].href, '/websites/dom-1/analytics');

  // Direct requestedSiteId by website ID -> 'ready'
  const readyRes = resolveSiteToolEntry({ tool: 'backups', websites, domains, canManage: true, requestedSiteId: 'site-1' });
  assert.equal(readyRes.state, 'ready');
  assert.equal(readyRes.target.href, '/websites/dom-1/backup');

  // Direct requestedSiteId by domain primaryDomain works for non-mail tools, but is rejected for 'mail'
  const byDomainSsl = resolveSiteToolEntry({ tool: 'ssl', websites, domains, canManage: true, requestedSiteId: 'alpha.example.com' });
  assert.equal(byDomainSsl.state, 'ready');
  assert.equal(byDomainSsl.target.href, '/websites/dom-1/ssl');

  const byDomainMail = resolveSiteToolEntry({ tool: 'mail', websites, domains, canManage: true, requestedSiteId: 'alpha.example.com' });
  assert.equal(byDomainMail.state, 'not_found');

  // Unbound website -> 'unbound' with href: null
  const unboundRes = resolveSiteToolEntry({ tool: 'databases', websites, domains, canManage: true, requestedSiteId: 'site-unbound' });
  assert.equal(unboundRes.state, 'unbound');
  assert.equal(unboundRes.target.href, null);
});

test('SCN-RES-01 [30]: filesTargets and resolveFilesEntry prefer root domain over subdomain for shared website file root and flag unsupported runtimes', () => {
  const websites = {
    status: 'ready',
    items: [
      { id: 'site-shared', serverId: 'srv-1', name: 'Shared Root Site', runtimeType: 'node' },
      { id: 'site-docker', serverId: 'srv-1', name: 'Docker Site', runtimeType: 'docker' },
      { id: 'site-nodomain', serverId: 'srv-1', name: 'No Domain Site', runtimeType: 'php' },
    ],
  };
  const domains = {
    status: 'ready',
    items: [
      // Subdomain appears first in array, root domain second -> filesTargets must pick root domain (!parentDomainId)
      { id: 'dom-sub', websiteId: 'site-shared', serverId: 'srv-1', primaryDomain: 'api.shared.com', parentDomainId: 'dom-root' },
      { id: 'dom-root', websiteId: 'site-shared', serverId: 'srv-1', primaryDomain: 'shared.com', parentDomainId: null },
      { id: 'dom-docker', websiteId: 'site-docker', serverId: 'srv-1', primaryDomain: 'docker.com', parentDomainId: null },
    ],
  };

  const targets = filesTargets(websites.items, domains.items);
  const sharedTarget = targets.find((t) => t.websiteId === 'site-shared');
  assert.equal(sharedTarget.domainId, 'dom-root');
  assert.equal(sharedTarget.href, '/websites/dom-root/files');
  assert.equal(sharedTarget.reason, null);

  const dockerTarget = targets.find((t) => t.websiteId === 'site-docker');
  assert.equal(dockerTarget.reason, 'unsupported');
  assert.equal(dockerTarget.href, null);

  const unboundTarget = targets.find((t) => t.websiteId === 'site-nodomain');
  assert.equal(unboundTarget.reason, 'unbound');
  assert.equal(unboundTarget.href, null);

  assert.equal(resolveFilesEntry({ websites, domains, requestedSiteId: 'site-shared', canManage: true }).state, 'ready');
  assert.equal(resolveFilesEntry({ websites, domains, requestedSiteId: 'site-docker', canManage: true }).state, 'unsupported');
  assert.equal(resolveFilesEntry({ websites, domains, requestedSiteId: 'site-nodomain', canManage: true }).state, 'unbound');
  assert.equal(resolveFilesEntry({ websites, domains, requestedSiteId: 'missing', canManage: true }).state, 'not_found');
  assert.equal(resolveFilesEntry({ websites, domains, canManage: false }).state, 'forbidden');
});

test('SCN-RES-01 [31]: site-resource-model enforces explicit webDomainId mail scoping, owner-only DNS mail section, and strict webmail URL validation', () => {
  const domains = [
    { id: 'dom-1', websiteId: 'site-1', primaryDomain: 'example.com' },
    { id: 'dom-2', websiteId: 'site-2', primaryDomain: 'sub.example.com' },
  ];
  const mailDomains = [
    { id: 'mail-1', webDomainId: 'dom-1', domainName: 'example.com' },
    { id: 'mail-2', webDomainId: 'dom-2', domainName: 'sub.example.com' },
    { id: 'mail-unlinked', webDomainId: null, domainName: 'example.com' },
  ];

  assert.deepEqual(siteMailDomains(mailDomains, domains, 'site-1'), [mailDomains[0]]);
  assert.deepEqual(siteMailDomains(mailDomains, domains, 'site-2'), [mailDomains[1]]);
  assert.deepEqual(siteMailDomains(mailDomains, domains, null), []);

  // Only owner can select 'dns' section in mail console
  assert.equal(mailSection('dns', true), 'dns');
  assert.equal(mailSection('dns', false), 'mailboxes');
  assert.equal(mailSection('aliases', false), 'aliases');
  assert.equal(mailSection('invalid-section', true), 'mailboxes');

  // Webmail mapping URL validation
  assert.equal(webmailMappingUrl({ state: 'active', hostname: 'webmail.example.com' }), 'https://webmail.example.com/');
  assert.equal(webmailMappingUrl({ state: 'pending', hostname: 'webmail.example.com' }), null);
  for (const invalidHost of ['webmail.example.com:8443', 'webmail.example.com/path', '-invalid.com', `${'a'.repeat(64)}.com`]) {
    assert.equal(webmailMappingUrl({ state: 'active', hostname: invalidHost }), null);
  }
});

test('SCN-RES-01 [32]: console-model databaseAccessView, filterConsoleDatabases, and paginateConsoleItems resolve phpMyAdmin handoff states and Turkish search', () => {
  const domains = {
    status: 'ready',
    items: [
      { id: 'dom-alpha', websiteId: 'site-alpha', primaryDomain: 'alpha.example.com' },
    ],
  };
  const dbReady = {
    name: 'alpha_prod_db',
    ownership: {
      websiteId: 'site-alpha',
      credential: { id: 'cred-1', username: 'ydb_alpha_user' },
    },
  };
  const dbNeedsUser = {
    name: 'alpha_staging_db',
    ownership: {
      websiteId: 'site-alpha',
      credential: null,
    },
  };
  const dbUnbound = {
    name: 'orphan_db',
    ownership: null,
  };

  const viewReady = databaseAccessView(dbReady, domains);
  assert.equal(viewReady.canOpen, true);
  assert.equal(viewReady.siteHref, '/websites/dom-alpha/databases');
  assert.equal(viewReady.label, 'phpMyAdmin’i aç');

  const viewNeedsUser = databaseAccessView(dbNeedsUser, domains);
  assert.equal(viewNeedsUser.canOpen, false);
  assert.equal(viewNeedsUser.siteHref, '/websites/dom-alpha/databases');
  assert.equal(viewNeedsUser.label, 'Erişimi yapılandır');

  const viewUnbound = databaseAccessView(dbUnbound, domains);
  assert.equal(viewUnbound.canOpen, false);
  assert.equal(viewUnbound.siteHref, null);
  assert.equal(viewUnbound.label, 'Siteye bağla');

  const allDbs = [dbReady, dbNeedsUser, dbUnbound];
  assert.deepEqual(filterConsoleDatabases(allDbs, { access: 'ready', domains }), [dbReady]);
  assert.deepEqual(filterConsoleDatabases(allDbs, { access: 'attention', domains }), [dbNeedsUser, dbUnbound]);
  assert.deepEqual(filterConsoleDatabases(allDbs, { query: 'YDB_ALPHA', domains }), [dbReady]);

  // Pagination clamping
  const items = Array.from({ length: 25 }, (_, idx) => ({ id: idx + 1 }));
  const page1 = paginateConsoleItems(items, -5, 10);
  assert.equal(page1.page, 1);
  assert.equal(page1.pages, 3);
  assert.equal(page1.items.length, 10);

  const pageLast = paginateConsoleItems(items, 99, 10);
  assert.equal(pageLast.page, 3);
  assert.equal(pageLast.items.length, 5);
});

test('SCN-RES-01 [33]: database-model validates schema names, rejects reserved/Roundcube schemas, projects ownership & hygiene, and filters valid backup choices', () => {
  assert.equal(validDatabaseName('app_prod_2026'), true);
  for (const invalidName of [
    'mysql', 'information_schema', 'performance_schema', 'sys',
    'roundcube', 'roundcube_mail', 'roundcubemail',
    'bad-name', 'bad;drop', '', 'a'.repeat(65), null,
  ]) {
    assert.equal(validDatabaseName(invalidName), false, `Database name "${invalidName}" must be rejected`);
  }

  assert.equal(formatDatabaseBytes(500), '500 B');
  assert.equal(formatDatabaseBytes(2048), '2 KB');
  assert.equal(formatDatabaseBytes(-1), '—');

  const serverId = fixtureUuid(100);
  const websiteId = fixtureUuid(1);
  const applicationId = fixtureUuid(2);
  const bindingId = fixtureUuid(3);
  const credId = fixtureUuid(4);
  const sha = 'a'.repeat(64);

  const inv = databaseInventoryView({
    engine: 'mariadb',
    version: '10.11.8-MariaDB',
    live: true,
    databases: [
      {
        name: 'site_db',
        sizeBytes: 1048576,
        ownership: {
          bindingId,
          websiteId,
          applicationId,
          unixUser: 'yunapp-123456abcdef',
          revision: 2,
          credential: { id: credId, username: 'ydb_1234567890abcdef12345678', host: 'localhost', revision: 1 },
        },
      },
      { name: 'mysql', sizeBytes: 4096 }, // reserved -> filtered out
    ],
  });
  assert.equal(inv.engine, 'mariadb');
  assert.equal(inv.databases.length, 1);
  assert.equal(inv.databases[0].name, 'site_db');
  assert.equal(inv.databases[0].ownership?.websiteId, websiteId);

  const siteDbView = websiteDatabaseResourcesView({
    websiteId,
    applicationId,
    databases: [
      {
        binding: { id: bindingId, databaseName: 'site_db', websiteId, applicationId, unixUser: 'yunapp-123456abcdef', revision: 2 },
        credential: {
          id: credId,
          username: 'ydb_1234567890abcdef12345678',
          host: 'localhost',
          privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
          revision: 1,
          passwordConfigured: true,
          passwordUpdatedAt: '2026-10-25T10:00:00.000Z',
        },
      },
    ],
  });
  assert.equal(siteDbView?.databases.length, 1);
  assert.equal(siteDbView?.databases[0].binding.databaseName, 'site_db');

  // Scoped backup choices filtering
  const jobs = [
    {
      id: 'backup-job-0001',
      serverId,
      operation: 'database.backup',
      status: 'succeeded',
      resourceType: 'database',
      resourceId: 'site_db',
      payload: {
        databaseName: 'site_db',
        websiteId,
        databaseBindingId: bindingId,
        expectedBindingRevision: 2,
      },
      result: {
        version: 1,
        backupId: 'backup-job-0001',
        databaseName: 'site_db',
        engine: 'mariadb',
        databaseVersion: '10.11.8',
        dumpSha256: sha,
        dumpBytes: 8192,
        createdAt: '2026-10-25T11:00:00.000Z',
        backedUp: true,
        sideEffects: true,
      },
    },
    {
      // Wrong bindingRevision -> must be excluded
      id: 'backup-job-0002',
      serverId,
      operation: 'database.backup',
      status: 'succeeded',
      resourceType: 'database',
      resourceId: 'site_db',
      payload: {
        databaseName: 'site_db',
        websiteId,
        databaseBindingId: bindingId,
        expectedBindingRevision: 1,
      },
      result: {
        version: 1,
        backupId: 'backup-job-0002',
        databaseName: 'site_db',
        engine: 'mariadb',
        databaseVersion: '10.11.8',
        dumpSha256: sha,
        dumpBytes: 4096,
        createdAt: '2026-10-25T10:00:00.000Z',
        backedUp: true,
        sideEffects: true,
      },
    },
  ];

  const choices = databaseBackupChoices(jobs, {
    serverId,
    databaseName: 'site_db',
    websiteId,
    bindingId,
    bindingRevision: 2,
  });
  assert.equal(choices.length, 1);
  assert.equal(choices[0].id, 'backup-job-0001');
});
