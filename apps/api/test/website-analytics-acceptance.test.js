import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createTenantBoundaryMiddleware } from '../src/tenant-boundary.js';
import { createSiteResourceBoundary } from '../src/site-resource-boundary.js';
import { mountWebsiteAnalyticsRoutes, WebsiteAnalyticsHttpError } from '../src/website-analytics-http.js';
import { GoAccessManagerError } from '@yunpanel/host-runtime';
import { INTEGRATED_TOOL_GATEWAYS } from '../../../packages/protocol/src/tool-gateway.js';
import { requireToolGatewaySession } from '../src/tool-gateway-session-policy.js';

const serverId = '33333333-3333-4333-8333-333333333333';
const foreignServerId = '44444444-4444-4444-8444-444444444444';
const siteAId = '11111111-1111-4111-8111-111111111111';
const siteBId = '22222222-2222-4222-8222-222222222222';
const foreignSiteId = '55555555-5555-4555-8555-555555555555';

const siteA = Object.freeze({
  id: siteAId,
  name: 'site-a.com',
  serverId,
  applicationId: 'app-a',
  customerId: 'cust-a',
  resellerId: null,
  runtimeType: 'static',
});

const siteB = Object.freeze({
  id: siteBId,
  name: 'site-b.com',
  serverId,
  applicationId: 'app-b',
  customerId: 'cust-b',
  resellerId: null,
  runtimeType: 'static',
});

const foreignSite = Object.freeze({
  id: foreignSiteId,
  name: 'foreign-site.com',
  serverId: foreignServerId,
  applicationId: 'app-foreign',
  customerId: 'cust-foreign',
  resellerId: null,
  runtimeType: 'static',
});

const domainA = Object.freeze({
  id: 'domain-a',
  websiteId: siteAId,
  serverId,
  primaryDomain: 'site-a.com',
  parentDomainId: null,
});

const domainB = Object.freeze({
  id: 'domain-b',
  websiteId: siteBId,
  serverId,
  primaryDomain: 'site-b.com',
  parentDomainId: null,
});

const websitesMap = new Map([
  [siteAId, siteA],
  [siteBId, siteB],
  [foreignSiteId, foreignSite],
]);

const domainsList = [domainA, domainB];

const customersMap = new Map([
  ['cust-a', { id: 'cust-a', kind: 'customer', resellerId: null }],
  ['cust-b', { id: 'cust-b', kind: 'customer', resellerId: null }],
]);

const defaultCustomerLookup = async (id) => customersMap.get(id) ?? null;

const defaultWebsiteRegistry = {
  getWebsite: async (id) => websitesMap.get(id) ?? null,
  listWebsites: async () => Array.from(websitesMap.values()),
};

const defaultDomainRegistry = {
  getDomain: async (id) => domainsList.find((d) => d.id === id) ?? null,
  listDomains: async () => domainsList,
};

const ownerAuth = Object.freeze({
  user: { id: 'owner-id', role: 'owner', active: true },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

const siteAManagerAuth = Object.freeze({
  user: {
    id: 'site-a-user',
    role: 'site_manager',
    websiteIds: [siteAId],
    active: true,
  },
  access: { mode: 'site_management', permissions: ['sites.manage'] },
  security: { managementAllowed: true },
});

const siteBManagerAuth = Object.freeze({
  user: {
    id: 'site-b-user',
    role: 'site_manager',
    websiteIds: [siteBId],
    active: true,
  },
  access: { mode: 'site_management', permissions: ['sites.manage'] },
  security: { managementAllowed: true },
});

const customerAAuth = Object.freeze({
  user: {
    id: 'cust-a',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: null },
    websiteIds: [siteAId],
    active: true,
  },
  access: { mode: 'site_management', permissions: ['sites.manage'] },
  security: { managementAllowed: true },
});

const customerBAuth = Object.freeze({
  user: {
    id: 'cust-b',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: null },
    websiteIds: [siteBId],
    active: true,
  },
  access: { mode: 'site_management', permissions: ['sites.manage'] },
  security: { managementAllowed: true },
});

const inactiveSiteAManagerAuth = Object.freeze({
  user: {
    id: 'site-a-inactive',
    role: 'site_manager',
    websiteIds: [siteAId],
    active: false,
  },
  access: { mode: 'site_management', permissions: ['sites.manage'] },
  security: { managementAllowed: true },
});

function createMockGoAccessManager(overrides = {}) {
  const daemonStates = new Map([
    [siteAId, { running: true, pid: 1111, socketExists: true }],
    [siteBId, { running: false, pid: null, socketExists: false }],
  ]);

  return {
    inspectGoAccess: async () => ({
      satisfied: true,
      binaryPath: '/usr/bin/goaccess',
      version: '1.9.3',
    }),
    inspectDaemon: async ({ websiteId }) => {
      const state = daemonStates.get(websiteId) ?? { running: false, pid: null, socketExists: false };
      return {
        websiteId,
        running: state.running,
        pid: state.pid,
        socketExists: state.socketExists,
        socketPath: `/run/yunpanel/goaccess/${websiteId}.sock`,
        pidPath: `/run/yunpanel/goaccess/${websiteId}.pid`,
      };
    },
    generateStaticReport: async ({ websiteId, primaryDomain }) => ({
      satisfied: true,
      websiteId,
      primaryDomain,
      logPath: `/var/log/nginx/${primaryDomain}.access.log`,
      outputPath: `/var/lib/yunpanel/reports/goaccess/${websiteId}.html`,
      generatedAt: '2026-09-30T10:00:00.000Z',
    }),
    readReport: async ({ websiteId }) => ({
      websiteId,
      outputPath: `/var/lib/yunpanel/reports/goaccess/${websiteId}.html`,
      content: `<!DOCTYPE html><html><head><title>GoAccess - ${websiteId}</title></head><body><h1>Report for ${websiteId}</h1></body></html>`,
    }),
    startRealtimeDaemon: async ({ websiteId, primaryDomain }) => {
      daemonStates.set(websiteId, { running: true, pid: 7777, socketExists: true });
      return {
        running: true,
        alreadyRunning: false,
        pid: 7777,
        websiteId,
        socketPath: `/run/yunpanel/goaccess/${websiteId}.sock`,
        pidPath: `/run/yunpanel/goaccess/${websiteId}.pid`,
        wsUrl: `/tools/goaccess/${websiteId}/ws`,
      };
    },
    stopRealtimeDaemon: async ({ websiteId }) => {
      daemonStates.set(websiteId, { running: false, pid: null, socketExists: false });
      return {
        websiteId,
        running: false,
        stopped: true,
      };
    },
    restartRealtimeDaemon: async ({ websiteId, primaryDomain }) => {
      daemonStates.set(websiteId, { running: true, pid: 8888, socketExists: true });
      return {
        running: true,
        alreadyRunning: true,
        pid: 8888,
        websiteId,
        socketPath: `/run/yunpanel/goaccess/${websiteId}.sock`,
        pidPath: `/run/yunpanel/goaccess/${websiteId}.pid`,
        wsUrl: `/tools/goaccess/${websiteId}/ws`,
      };
    },
    ...overrides,
  };
}

function createAnalyticsApp(options = {}) {
  const goaccessManager = options.goaccessManager ?? createMockGoAccessManager();
  const websiteRegistry = options.websiteRegistry ?? defaultWebsiteRegistry;
  const domainRegistry = options.domainRegistry ?? defaultDomainRegistry;
  const localServerId = options.localServerId ?? serverId;
  const customerLookup = options.customerLookup ?? defaultCustomerLookup;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.use((req, res, next) => {
    const raw = req.headers['x-test-auth'];
    if (raw) {
      try {
        req.auth = JSON.parse(raw);
      } catch {
        req.auth = null;
      }
    }
    next();
  });

  app.use(createTenantBoundaryMiddleware({
    websiteRegistry,
    customerLookup,
    websiteLookup: async (id) => websiteRegistry.getWebsite(id),
  }));

  app.use(createSiteResourceBoundary({
    websiteRegistry,
    domainRegistry,
    localServerId,
    customerLookup,
  }));

  mountWebsiteAnalyticsRoutes(app, {
    websiteRegistry,
    domainRegistry,
    goaccessManager,
    localServerId,
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (
      err instanceof WebsiteAnalyticsHttpError
      || (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 && typeof err?.code === 'string')
    ) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message },
      });
    }
    return res.status(500).json({
      error: {
        code: err?.code || 'internal_error',
        message: err?.message || 'Unexpected server error',
      },
    });
  });

  return app;
}

async function withTestApp(options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  const app = createAnalyticsApp(options);
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = async (path, { method = 'GET', auth = null, body = null } = {}) => {
    const headers = {
      connection: 'close',
    };
    if (auth) {
      headers['x-test-auth'] = JSON.stringify(auth);
    }
    if (body !== null) {
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    let resBody = null;
    if (contentType.includes('application/json')) {
      resBody = await res.json();
    } else {
      resBody = await res.text();
    }
    return {
      statusCode: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: resBody,
    };
  };

  try {
    await fn({ request, baseUrl });
  } finally {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

test('AN-03 API: Site A account accesses own status without leaking PIDs, sockets, or binary paths', async () => {
  await withTestApp(async ({ request }) => {
    const res = await request(`/api/websites/${siteAId}/analytics/status`, {
      method: 'GET',
      auth: siteAManagerAuth,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.websiteId, siteAId);
    assert.equal(res.body.data.available, true);
    assert.equal(res.body.data.version, '1.9.3');
    assert.equal(res.body.data.running, true);
    assert.equal(res.body.data.socketReady, true);

    // Security assertions: internal details MUST NOT be exposed to site accounts
    assert.equal(Object.hasOwn(res.body.data, 'pid'), false);
    assert.equal(Object.hasOwn(res.body.data, 'socketPath'), false);
    assert.equal(Object.hasOwn(res.body.data, 'pidPath'), false);
    assert.equal(Object.hasOwn(res.body.data, 'outputPath'), false);
    assert.equal(Object.hasOwn(res.body.data, 'binaryPath'), false);
    assert.equal(Object.hasOwn(res.body.data, 'wsUrl'), false);
  });
});

test('AN-03 API: Site A account is forbidden from accessing Site B status and report', async () => {
  await withTestApp(async ({ request }) => {
    // Status cross-site access
    const statusRes = await request(`/api/websites/${siteBId}/analytics/status`, {
      method: 'GET',
      auth: siteAManagerAuth,
    });
    assert.equal(statusRes.statusCode, 403);
    const statusBodyStr = JSON.stringify(statusRes.body ?? {});
    assert.equal(statusBodyStr.includes(siteBId), false);

    // Static report JSON cross-site access
    const reportRes = await request(`/api/websites/${siteBId}/analytics/report`, {
      method: 'GET',
      auth: siteAManagerAuth,
    });
    assert.equal(reportRes.statusCode, 403);

    // Static report HTML cross-site access
    const htmlRes = await request(`/api/websites/${siteBId}/analytics/report?format=html`, {
      method: 'GET',
      auth: siteAManagerAuth,
    });
    assert.equal(htmlRes.statusCode, 403);
  });
});

test('AN-03 API: Site B account is forbidden from accessing Site A status and report', async () => {
  await withTestApp(async ({ request }) => {
    const statusRes = await request(`/api/websites/${siteAId}/analytics/status`, {
      method: 'GET',
      auth: siteBManagerAuth,
    });
    assert.equal(statusRes.statusCode, 403);

    const reportRes = await request(`/api/websites/${siteAId}/analytics/report`, {
      method: 'GET',
      auth: siteBManagerAuth,
    });
    assert.equal(reportRes.statusCode, 403);

    // Own Site B status is permitted
    const ownStatusRes = await request(`/api/websites/${siteBId}/analytics/status`, {
      method: 'GET',
      auth: siteBManagerAuth,
    });
    assert.equal(ownStatusRes.statusCode, 200);
    assert.equal(ownStatusRes.body.data.websiteId, siteBId);
    assert.equal(Object.hasOwn(ownStatusRes.body.data, 'pid'), false);
    assert.equal(Object.hasOwn(ownStatusRes.body.data, 'socketPath'), false);
  });
});

test('AN-03 API: Customer role enforces tenant website boundary on analytics', async () => {
  await withTestApp(async ({ request }) => {
    // Customer A accesses own site A
    const custAOwn = await request(`/api/websites/${siteAId}/analytics/status`, {
      method: 'GET',
      auth: customerAAuth,
    });
    assert.equal(custAOwn.statusCode, 200);
    assert.equal(custAOwn.body.data.websiteId, siteAId);

    // Customer A accesses foreign site B -> 403
    const custAForeign = await request(`/api/websites/${siteBId}/analytics/status`, {
      method: 'GET',
      auth: customerAAuth,
    });
    assert.equal(custAForeign.statusCode, 403);

    // Customer B accesses own site B
    const custBOwn = await request(`/api/websites/${siteBId}/analytics/status`, {
      method: 'GET',
      auth: customerBAuth,
    });
    assert.equal(custBOwn.statusCode, 200);
    assert.equal(custBOwn.body.data.websiteId, siteBId);

    // Customer B accesses foreign site A -> 403
    const custBForeign = await request(`/api/websites/${siteAId}/analytics/status`, {
      method: 'GET',
      auth: customerBAuth,
    });
    assert.equal(custBForeign.statusCode, 403);
  });
});

test('AN-03 API: Static report endpoint generates metadata and returns HTML without leaking file paths', async () => {
  await withTestApp(async ({ request }) => {
    // JSON metadata format
    const jsonRes = await request(`/api/websites/${siteAId}/analytics/report`, {
      method: 'GET',
      auth: siteAManagerAuth,
    });
    assert.equal(jsonRes.statusCode, 200);
    assert.equal(jsonRes.body.data.websiteId, siteAId);
    assert.equal(jsonRes.body.data.primaryDomain, 'site-a.com');
    assert.equal(jsonRes.body.data.generatedAt, '2026-09-30T10:00:00.000Z');
    assert.equal(Object.hasOwn(jsonRes.body.data, 'outputPath'), false);
    assert.equal(Object.hasOwn(jsonRes.body.data, 'logPath'), false);

    // HTML format
    const htmlRes = await request(`/api/websites/${siteAId}/analytics/report?format=html`, {
      method: 'GET',
      auth: siteAManagerAuth,
    });
    assert.equal(htmlRes.statusCode, 200);
    assert.equal(htmlRes.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(htmlRes.headers['cache-control'], 'no-store');
    assert.equal(htmlRes.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    assert.match(htmlRes.body, /Report for 11111111-1111-4111-8111-111111111111/);
  });
});

test('AN-03 API: Realtime daemon lifecycle is strictly Owner-only; site accounts receive 403', async () => {
  await withTestApp(async ({ request }) => {
    // Site manager attempts to start/stop/restart
    for (const action of ['start', 'stop', 'restart']) {
      const res = await request(`/api/websites/${siteAId}/analytics/realtime/${action}`, {
        method: 'POST',
        auth: siteAManagerAuth,
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'forbidden');
      assert.equal(res.body.error.message, 'Owner access is required.');
    }

    // Customer attempts to start/stop/restart
    for (const action of ['start', 'stop', 'restart']) {
      const res = await request(`/api/websites/${siteAId}/analytics/realtime/${action}`, {
        method: 'POST',
        auth: customerAAuth,
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, 'forbidden');
    }

    // Owner successfully controls realtime daemon lifecycle
    const startRes = await request(`/api/websites/${siteAId}/analytics/realtime/start`, {
      method: 'POST',
      auth: ownerAuth,
    });
    assert.equal(startRes.statusCode, 200);
    assert.equal(startRes.body.data.websiteId, siteAId);
    assert.equal(startRes.body.data.running, true);
    assert.equal(startRes.body.data.alreadyRunning, false);
    assert.equal(Object.hasOwn(startRes.body.data, 'pid'), false);
    assert.equal(Object.hasOwn(startRes.body.data, 'socketPath'), false);

    const restartRes = await request(`/api/websites/${siteAId}/analytics/realtime/restart`, {
      method: 'POST',
      auth: ownerAuth,
    });
    assert.equal(restartRes.statusCode, 200);
    assert.equal(restartRes.body.data.websiteId, siteAId);
    assert.equal(restartRes.body.data.running, true);
    assert.equal(restartRes.body.data.alreadyRunning, true);

    const stopRes = await request(`/api/websites/${siteAId}/analytics/realtime/stop`, {
      method: 'POST',
      auth: ownerAuth,
    });
    assert.equal(stopRes.statusCode, 200);
    assert.equal(stopRes.body.data.websiteId, siteAId);
    assert.equal(stopRes.body.data.running, false);
    assert.equal(stopRes.body.data.stopped, true);
  });
});

test('AN-03 API: Owner status response receives same-origin websocket url without host socket paths', async () => {
  await withTestApp(async ({ request }) => {
    const res = await request(`/api/websites/${siteAId}/analytics/status`, {
      method: 'GET',
      auth: ownerAuth,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.websiteId, siteAId);
    assert.equal(res.body.data.wsUrl, `/tools/goaccess/${siteAId}/ws`);
    assert.equal(Object.hasOwn(res.body.data, 'socketPath'), false);
    assert.equal(Object.hasOwn(res.body.data, 'pidPath'), false);
    assert.equal(Object.hasOwn(res.body.data, 'pid'), false);
  });
});

test('AN-03 Security: GoAccess integrated gateway endpoint /api/goaccess-gateway-access is Owner-only', () => {
  const goaccessGateway = INTEGRATED_TOOL_GATEWAYS.goaccess;
  assert.equal(goaccessGateway.id, 'goaccess');
  assert.equal(goaccessGateway.accessMode, 'owner');
  assert.equal(goaccessGateway.accessPath, '/api/goaccess-gateway-access');

  const mockOwnerPolicy = {
    requireManagement: (session) => {
      if (session?.user?.role !== 'owner') {
        const err = new Error('Management access required.');
        err.status = 403;
        err.code = 'forbidden';
        throw err;
      }
      return session;
    },
    requireSiteManagement: (session) => session,
  };

  // Site manager is rejected with 403
  assert.throws(
    () => requireToolGatewaySession(mockOwnerPolicy, siteAManagerAuth, goaccessGateway),
    (err) => err.status === 403 && err.code === 'forbidden',
  );

  // Customer is rejected with 403
  assert.throws(
    () => requireToolGatewaySession(mockOwnerPolicy, customerAAuth, goaccessGateway),
    (err) => err.status === 403 && err.code === 'forbidden',
  );

  // Owner is allowed
  const allowed = requireToolGatewaySession(mockOwnerPolicy, ownerAuth, goaccessGateway);
  assert.equal(allowed.user.role, 'owner');
});

test('AN-03 Security: GoAccess runtime errors and generic 500 errors suppress raw host paths', async () => {
  const failingGoAccessManager = createMockGoAccessManager({
    generateStaticReport: async () => {
      throw new GoAccessManagerError('report_generation_failed', 'Failed to generate report from /var/log/nginx/secret-leak.log');
    },
  });

  await withTestApp({ goaccessManager: failingGoAccessManager }, async ({ request }) => {
    const res = await request(`/api/websites/${siteAId}/analytics/report`, {
      method: 'GET',
      auth: siteAManagerAuth,
    });

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.code, 'report_generation_failed');
    assert.equal(res.body.error.message, 'Analytics report could not be generated');
    const bodyStr = JSON.stringify(res.body);
    assert.equal(bodyStr.includes('/var/log/nginx/secret-leak.log'), false);
  });

  // Generic unhandled error with raw path
  const crashingGoAccessManager = createMockGoAccessManager({
    inspectDaemon: async () => {
      throw new Error('ENOENT: no such file or directory, open \'/run/yunpanel/goaccess/private-token.sock\'');
    },
  });

  await withTestApp({ goaccessManager: crashingGoAccessManager }, async ({ request }) => {
    const crashRes = await request(`/api/websites/${siteAId}/analytics/status`, {
      method: 'GET',
      auth: siteAManagerAuth,
    });

    assert.equal(crashRes.statusCode, 500);
    assert.equal(crashRes.body.error.code, 'website_analytics_failed');
    assert.equal(crashRes.body.error.message, 'Website analytics operation failed');
    const crashBodyStr = JSON.stringify(crashRes.body);
    assert.equal(crashBodyStr.includes('/run/yunpanel/goaccess'), false);
    assert.equal(crashBodyStr.includes('private-token.sock'), false);
  });
});

test('AN-03 Validation: Non-local website returns 409 and non-existent website returns 404', async () => {
  await withTestApp(async ({ request }) => {
    // Foreign server website
    const foreignRes = await request(`/api/websites/${foreignSiteId}/analytics/status`, {
      method: 'GET',
      auth: ownerAuth,
    });
    assert.equal(foreignRes.statusCode, 409);
    assert.equal(foreignRes.body.error.code, 'website_not_local');

    // Non-existent website
    const notFoundRes = await request('/api/websites/99999999-9999-4999-8999-999999999999/analytics/status', {
      method: 'GET',
      auth: ownerAuth,
    });
    assert.equal(notFoundRes.statusCode, 404);
    assert.equal(notFoundRes.body.error.code, 'website_not_found');
  });
});

test('AN-03 Security: Inactive account is rejected fail-closed with 403', async () => {
  await withTestApp(async ({ request }) => {
    const res = await request(`/api/websites/${siteAId}/analytics/status`, {
      method: 'GET',
      auth: inactiveSiteAManagerAuth,
    });
    assert.equal(res.statusCode, 403);
  });
});
