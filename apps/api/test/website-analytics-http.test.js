import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import { mountWebsiteAnalyticsRoutes } from '../src/website-analytics-http.js';

function createMockApp({ websiteRegistry, domainRegistry, goaccessManager, localServerId = 'srv-1' }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      user: { id: 'u1', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteAnalyticsRoutes(app, {
    websiteRegistry,
    domainRegistry,
    goaccessManager,
    localServerId,
  });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });
  return app;
}

test('website analytics routes generate reports and manage daemons', async () => {
  const websites = new Map([
    ['site-1', { id: 'site-1', name: 'my-site', serverId: 'srv-1' }],
  ]);
  const domains = [
    { id: 'dom-1', websiteId: 'site-1', primaryDomain: 'example.com', parentId: null },
  ];

  const goaccessCalls = [];
  const mockGoAccessManager = {
    generateStaticReport: async (opts) => {
      goaccessCalls.push(['generate', opts]);
      return {
        satisfied: true,
        websiteId: opts.websiteId,
        primaryDomain: opts.primaryDomain,
        outputPath: `/var/lib/yunpanel/reports/goaccess/${opts.websiteId}.html`,
        generatedAt: '2026-09-20T12:00:00.000Z',
      };
    },
    readReport: async ({ websiteId }) => {
      goaccessCalls.push(['read', websiteId]);
      return {
        websiteId,
        content: '<html><body>GoAccess Report</body></html>',
        outputPath: `/var/lib/yunpanel/reports/goaccess/${websiteId}.html`,
        mtime: '2026-09-20T12:00:00.000Z',
      };
    },
    inspectDaemon: async ({ websiteId }) => {
      goaccessCalls.push(['inspect', websiteId]);
      return {
        websiteId,
        running: true,
        pid: 12345,
        socketExists: true,
        socketPath: `/run/yunpanel/goaccess/${websiteId}.sock`,
        pidPath: `/run/yunpanel/goaccess/${websiteId}.pid`,
      };
    },
    startRealtimeDaemon: async (opts) => {
      goaccessCalls.push(['start', opts]);
      return {
        running: true,
        alreadyRunning: false,
        pid: 12345,
        websiteId: opts.websiteId,
        socketPath: `/run/yunpanel/goaccess/${opts.websiteId}.sock`,
        outputPath: `/var/lib/yunpanel/reports/goaccess/${opts.websiteId}.html`,
        pidPath: `/run/yunpanel/goaccess/${opts.websiteId}.pid`,
        wsUrl: `/tools/goaccess/${opts.websiteId}/ws`,
      };
    },
    stopRealtimeDaemon: async ({ websiteId }) => {
      goaccessCalls.push(['stop', websiteId]);
      return { stopped: true, websiteId, pid: 12345 };
    },
    restartRealtimeDaemon: async (opts) => {
      goaccessCalls.push(['restart', opts]);
      return {
        running: true,
        alreadyRunning: false,
        pid: 12346,
        websiteId: opts.websiteId,
        socketPath: `/run/yunpanel/goaccess/${opts.websiteId}.sock`,
        outputPath: `/var/lib/yunpanel/reports/goaccess/${opts.websiteId}.html`,
        pidPath: `/run/yunpanel/goaccess/${opts.websiteId}.pid`,
        wsUrl: `/tools/goaccess/${opts.websiteId}/ws`,
      };
    },
  };

  const app = createMockApp({
    websiteRegistry: { getWebsite: async (id) => websites.get(id) ?? null },
    domainRegistry: { listDomains: async () => domains },
    goaccessManager: mockGoAccessManager,
  });

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET report metadata
    const reportRes = await fetch(`${baseUrl}/api/websites/site-1/analytics/report`);
    assert.equal(reportRes.status, 200);
    const reportJson = await reportRes.json();
    assert.equal(reportJson.data.websiteId, 'site-1');
    assert.equal(reportJson.data.primaryDomain, 'example.com');

    // 2. GET report html
    const htmlRes = await fetch(`${baseUrl}/api/websites/site-1/analytics/report?format=html`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /GoAccess Report/);

    // 3. GET daemon status
    const statusRes = await fetch(`${baseUrl}/api/websites/site-1/analytics/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.data.running, true);
    assert.equal(statusJson.data.pid, 12345);
    assert.equal(statusJson.data.wsUrl, '/tools/goaccess/site-1/ws');

    // 4. POST realtime start
    const startRes = await fetch(`${baseUrl}/api/websites/site-1/analytics/realtime/start`, { method: 'POST' });
    assert.equal(startRes.status, 200);
    const startJson = await startRes.json();
    assert.equal(startJson.data.running, true);

    // 5. POST realtime stop
    const stopRes = await fetch(`${baseUrl}/api/websites/site-1/analytics/realtime/stop`, { method: 'POST' });
    assert.equal(stopRes.status, 200);
    const stopJson = await stopRes.json();
    assert.equal(stopJson.data.stopped, true);

    // 6. POST realtime restart
    const restartRes = await fetch(`${baseUrl}/api/websites/site-1/analytics/realtime/restart`, { method: 'POST' });
    assert.equal(restartRes.status, 200);
    const restartJson = await restartRes.json();
    assert.equal(restartJson.data.running, true);
    assert.equal(restartJson.data.pid, 12346);

    // 7. Unknown website returns 404
    const notFoundRes = await fetch(`${baseUrl}/api/websites/unknown/analytics/status`);
    assert.equal(notFoundRes.status, 404);
  } finally {
    server.close();
  }
});
