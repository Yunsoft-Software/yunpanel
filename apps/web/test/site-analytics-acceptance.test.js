import assert from 'node:assert/strict';
import test from 'node:test';
import { createSiteAnalyticsClient } from '../src/workspace/site-analytics-client.js';
import {
  analyticsReport,
  analyticsStatus,
  analyticsRealtime,
  resolveSiteAnalyticsAccess,
  siteAnalyticsErrorMessage,
  siteAnalyticsScope,
  SiteAnalyticsError,
} from '../src/workspace/site-analytics-model.js';

const serverId = '22222222-2222-4222-8222-222222222222';
const siteAScope = Object.freeze({
  websiteId: '11111111-1111-4111-8111-111111111111',
  serverId,
});
const siteBScope = Object.freeze({
  websiteId: '33333333-3333-4333-8333-333333333333',
  serverId,
});

test('AN-03 Web Client: Site A client loads status and generates static report with strict scope', async () => {
  const calls = [];
  const mockRequest = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/analytics/status')) {
      return {
        websiteId: siteAScope.websiteId,
        available: true,
        version: '1.9.3',
        running: true,
        socketReady: true,
      };
    }
    if (url.endsWith('/analytics/report')) {
      return {
        websiteId: siteAScope.websiteId,
        primaryDomain: 'site-a.com',
        generatedAt: '2026-09-30T10:00:00.000Z',
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const client = createSiteAnalyticsClient({
    scope: siteAScope,
    request: mockRequest,
    isOwner: false,
  });

  const stateUpdates = [];
  client.subscribe((s) => stateUpdates.push(s));

  // Load status
  const loadOk = await client.load();
  assert.equal(loadOk, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/websites/${siteAScope.websiteId}/analytics/status`);

  const snapshotAfterLoad = client.getSnapshot();
  assert.equal(snapshotAfterLoad.loading, false);
  assert.equal(snapshotAfterLoad.error, null);
  assert.equal(snapshotAfterLoad.denied, false);
  assert.deepEqual(snapshotAfterLoad.status, {
    websiteId: siteAScope.websiteId,
    available: true,
    version: '1.9.3',
    running: true,
    socketReady: true,
  });

  // Generate static report
  const report = await client.generateReport();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `/websites/${siteAScope.websiteId}/analytics/report`);
  assert.deepEqual(report, {
    websiteId: siteAScope.websiteId,
    primaryDomain: 'site-a.com',
    generatedAt: '2026-09-30T10:00:00.000Z',
  });

  const snapshotAfterReport = client.getSnapshot();
  assert.equal(snapshotAfterReport.busy, false);
  assert.deepEqual(snapshotAfterReport.report, report);

  client.dispose();
});

test('AN-03 Web Client: Non-owner cannot trigger realtime actions (no HTTP request made)', async () => {
  const calls = [];
  const mockRequest = async (url, options = {}) => {
    calls.push({ url, options });
    return {};
  };

  const client = createSiteAnalyticsClient({
    scope: siteAScope,
    request: mockRequest,
    isOwner: false,
  });

  for (const action of ['start', 'stop', 'restart']) {
    const res = await client.realtime(action);
    assert.equal(res, null);
  }

  // Confirm NO network requests were dispatched
  assert.equal(calls.length, 0);

  client.dispose();
});

test('AN-03 Web Client: Realtime mutation does not replay on ambiguous network responses and reconciles via GET', async () => {
  const calls = [];
  let statusCallCount = 0;

  const mockRequest = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/analytics/realtime/start')) {
      // Simulate network / server 503 timeout failure
      const error = new Error('Service Unavailable');
      error.status = 503;
      error.code = 'service_unavailable';
      throw error;
    }
    if (url.endsWith('/analytics/status')) {
      statusCallCount++;
      return {
        websiteId: siteAScope.websiteId,
        available: true,
        version: '1.9.3',
        running: true,
        socketReady: true,
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const client = createSiteAnalyticsClient({
    scope: siteAScope,
    request: mockRequest,
    isOwner: true,
  });

  const result = await client.realtime('start');
  assert.equal(result, null);

  // Critical verification:
  // 1. POST was called EXACTLY ONCE (never replayed / non-replaying)
  const postCalls = calls.filter((c) => c.options.method === 'POST');
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].url, `/websites/${siteAScope.websiteId}/analytics/realtime/start`);

  // 2. Client reconciled state via status GET
  const getCalls = calls.filter((c) => !c.options.method || c.options.method === 'GET');
  assert.equal(getCalls.length, 1);
  assert.equal(getCalls[0].url, `/websites/${siteAScope.websiteId}/analytics/status`);
  assert.equal(statusCallCount, 1);

  // 3. Client state marked unknownMutation and informative error
  const snapshot = client.getSnapshot();
  assert.equal(snapshot.unknownMutation, true);
  assert.equal(snapshot.error, 'İsteğin sonucu bilinmiyor. İşlem tekrar gönderilmedi; servis durumu yeniden okunuyor.');
  assert.deepEqual(snapshot.status, {
    websiteId: siteAScope.websiteId,
    available: true,
    version: '1.9.3',
    running: true,
    socketReady: true,
  });

  client.dispose();
});

test('AN-03 Web Client: Forbidden 403 on realtime mutation does not mark unknownMutation and does not retry', async () => {
  const calls = [];
  const mockRequest = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/analytics/realtime/start')) {
      const error = new Error('Forbidden');
      error.status = 403;
      error.code = 'forbidden';
      throw error;
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const client = createSiteAnalyticsClient({
    scope: siteAScope,
    request: mockRequest,
    isOwner: true,
  });

  const result = await client.realtime('start');
  assert.equal(result, null);
  assert.equal(calls.length, 1); // Only 1 POST, no GET reconciliation on explicit 403

  const snapshot = client.getSnapshot();
  assert.equal(snapshot.unknownMutation, false);
  assert.equal(snapshot.error, 'Bu işlem için Owner yetkisi gerekiyor.');

  client.dispose();
});

test('AN-03 Web Client: 401/403 access revocation sets denied state and stops further operations', async () => {
  const calls = [];
  const mockRequest = async (url) => {
    calls.push(url);
    const error = new Error('Forbidden');
    error.status = 403;
    error.code = 'forbidden';
    throw error;
  };

  const client = createSiteAnalyticsClient({
    scope: siteAScope,
    request: mockRequest,
    isOwner: false,
  });

  const loadOk = await client.load();
  assert.equal(loadOk, false);

  const snapshot = client.getSnapshot();
  assert.equal(snapshot.denied, true);
  assert.equal(snapshot.status, null);
  assert.equal(snapshot.error, 'Oturum veya site istatistik erişimi geçerli değil.');

  // Subsequent load and report generation are blocked without making requests
  assert.equal(await client.load(), false);
  assert.equal(await client.generateReport(), null);
  assert.equal(calls.length, 1);

  client.dispose();
});

test('AN-03 Web Model: Data model strictly validates website scoping and rejects foreign wsUrl', () => {
  // Safe status
  const safeData = {
    websiteId: siteAScope.websiteId,
    available: true,
    version: '1.9.3',
    running: false,
    socketReady: false,
  };
  assert.deepEqual(analyticsStatus(safeData, siteAScope), safeData);

  // Mismatched websiteId rejected
  assert.throws(
    () => analyticsStatus({ ...safeData, websiteId: siteBScope.websiteId }, siteAScope),
    (err) => err instanceof SiteAnalyticsError,
  );

  // Non-owner receiving wsUrl is rejected
  assert.throws(
    () => analyticsStatus({ ...safeData, wsUrl: `/tools/goaccess/${siteAScope.websiteId}/ws` }, siteAScope, { owner: false }),
    (err) => err instanceof SiteAnalyticsError,
  );

  // Owner receiving valid wsUrl is accepted
  const ownerStatus = analyticsStatus(
    { ...safeData, wsUrl: `/tools/goaccess/${siteAScope.websiteId}/ws` },
    siteAScope,
    { owner: true },
  );
  assert.equal(ownerStatus.wsUrl, `/tools/goaccess/${siteAScope.websiteId}/ws`);

  // Report validation
  const reportData = {
    websiteId: siteAScope.websiteId,
    primaryDomain: 'site-a.com',
    generatedAt: '2026-09-30T10:00:00.000Z',
  };
  assert.deepEqual(analyticsReport(reportData, siteAScope), reportData);

  // Report mismatched websiteId rejected
  assert.throws(
    () => analyticsReport({ ...reportData, websiteId: siteBScope.websiteId }, siteAScope),
    (err) => err instanceof SiteAnalyticsError,
  );

  // Realtime view validation
  const realtimeStart = analyticsRealtime(
    { websiteId: siteAScope.websiteId, running: true, alreadyRunning: false },
    siteAScope,
    'start',
  );
  assert.deepEqual(realtimeStart, { websiteId: siteAScope.websiteId, running: true, alreadyRunning: false });

  const realtimeStop = analyticsRealtime(
    { websiteId: siteAScope.websiteId, running: false, stopped: true },
    siteAScope,
    'stop',
  );
  assert.deepEqual(realtimeStop, { websiteId: siteAScope.websiteId, running: false, stopped: true });
});

test('AN-03 Web Model: resolveSiteAnalyticsAccess validates domain-website-server bindings', () => {
  const domainId = 'domain-a-uuid';
  const readyDomains = {
    status: 'ready',
    items: [{ id: domainId, websiteId: siteAScope.websiteId, serverId }],
  };
  const readyWebsites = {
    status: 'ready',
    items: [{ id: siteAScope.websiteId, serverId }],
  };

  // Ready access
  assert.deepEqual(
    resolveSiteAnalyticsAccess({ domainId, domains: readyDomains, websites: readyWebsites, canManage: true }),
    { state: 'ready', scope: siteAScope },
  );

  // canManage = false -> forbidden
  assert.deepEqual(
    resolveSiteAnalyticsAccess({ domainId, domains: readyDomains, websites: readyWebsites, canManage: false }),
    { state: 'forbidden' },
  );

  // Domains forbidden -> forbidden
  assert.deepEqual(
    resolveSiteAnalyticsAccess({
      domainId,
      domains: { status: 'forbidden', items: [] },
      websites: readyWebsites,
      canManage: true,
    }),
    { state: 'forbidden' },
  );

  // Domain not found -> not_found
  assert.deepEqual(
    resolveSiteAnalyticsAccess({
      domainId: 'non-existent-domain',
      domains: readyDomains,
      websites: readyWebsites,
      canManage: true,
    }),
    { state: 'not_found' },
  );

  // Domain unbound -> unbound
  assert.deepEqual(
    resolveSiteAnalyticsAccess({
      domainId,
      domains: { status: 'ready', items: [{ id: domainId, websiteId: null, serverId }] },
      websites: readyWebsites,
      canManage: true,
    }),
    { state: 'unbound' },
  );

  // Server mismatch -> inconsistent
  assert.deepEqual(
    resolveSiteAnalyticsAccess({
      domainId,
      domains: readyDomains,
      websites: { status: 'ready', items: [{ id: siteAScope.websiteId, serverId: 'other-server' }] },
      canManage: true,
    }),
    { state: 'inconsistent' },
  );
});

test('AN-03 Web Model: siteAnalyticsErrorMessage returns localized safe messages', () => {
  assert.equal(siteAnalyticsErrorMessage({ code: 'forbidden' }), 'Bu işlem için Owner yetkisi gerekiyor.');
  assert.equal(siteAnalyticsErrorMessage({ code: 'report_generation_failed' }), 'Statik rapor oluşturulamadı.');
  assert.equal(siteAnalyticsErrorMessage({ code: 'report_not_found' }), 'Statik rapor bulunamadı.');
  assert.equal(siteAnalyticsErrorMessage({ code: 'daemon_start_failed' }), 'Gerçek zamanlı istatistik servisi başlatılamadı.');
  assert.equal(siteAnalyticsErrorMessage({ code: 'site_analytics_response_invalid' }), 'İstatistik yanıtı bu siteyle eşleşmiyor.');
  assert.equal(siteAnalyticsErrorMessage({ code: 'unknown_code' }), 'İstatistik bilgileri alınamadı.');
  assert.equal(siteAnalyticsErrorMessage(null), 'İstatistik bilgileri alınamadı.');
});
