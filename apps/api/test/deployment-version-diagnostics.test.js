import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import {
  API_VERSION,
  SCHEMA_VERSION,
  DEFAULT_STALE_THRESHOLD_MS,
  FRESHNESS_STATUSES,
  DEPLOYMENT_COMPARISON_STATUSES,
  sanitizeDiagnosticInfo,
  resolveDeploymentDiagnostics,
  compareDeploymentVersions,
  evaluateFreshnessState,
  evaluateDeploymentEvidence,
  requireDeploymentDiagnosticsAccess,
  createApp as createCoreApp,
} from '../src/core-app.js';
import { createApp } from '../src/app.js';

function createMockAuthApp({ userRole = 'owner', userStatus = 'active', permissions = null } = {}) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    if (userRole === 'unauthenticated') {
      req.auth = null;
    } else if (userRole === 'owner') {
      req.auth = {
        user: { id: 'usr-owner-1', username: 'admin', role: 'owner', status: userStatus },
        access: { mode: 'management', permissions: permissions ?? ['*'] },
        security: { managementAllowed: true },
      };
    } else if (userRole === 'read_only') {
      req.auth = {
        user: { id: 'usr-ro-1', username: 'auditor', role: 'read_only', status: userStatus },
        access: { mode: 'read_only', permissions: permissions ?? ['servers.read'] },
        security: { managementAllowed: false },
      };
    } else if (userRole === 'reseller') {
      req.auth = {
        user: { id: 'usr-reseller-1', username: 'partner', role: 'reseller', status: userStatus },
        access: { mode: 'site_management', permissions: permissions ?? ['sites.manage'] },
        security: { managementAllowed: true },
      };
    } else if (userRole === 'customer') {
      req.auth = {
        user: { id: 'usr-cust-1', username: 'client', role: 'customer', status: userStatus },
        access: { mode: 'site_management', permissions: permissions ?? ['sites.manage'] },
        security: { managementAllowed: true },
      };
    } else if (userRole === 'site_manager') {
      req.auth = {
        user: { id: 'usr-sm-1', username: 'sitemanager', role: 'site_manager', status: userStatus },
        access: { mode: 'site_management', permissions: permissions ?? ['sites.manage'] },
        security: { managementAllowed: true },
      };
    }
    next();
  });

  return app;
}

test('AC1: Backend build/commit ID, schema version, and sensitive data sanitization', async (t) => {
  await t.test('resolveDeploymentDiagnostics outputs version, schemaVersion, commit, buildId, and environment', () => {
    const diag = resolveDeploymentDiagnostics({
      buildId: 'build-20261001-01',
      commit: 'abc123def456',
      buildTime: '2026-10-01T00:00:00.000Z',
      assetId: 'assets-build-20261001-01',
      environment: 'production',
      now: new Date('2026-10-01T01:00:00.000Z'),
    });

    assert.equal(diag.version, API_VERSION);
    assert.equal(diag.schemaVersion, SCHEMA_VERSION);
    assert.equal(diag.buildId, 'build-20261001-01');
    assert.equal(diag.commit, 'abc123def456');
    assert.equal(diag.buildTime, '2026-10-01T00:00:00.000Z');
    assert.equal(diag.assetId, 'assets-build-20261001-01');
    assert.equal(diag.environment, 'production');
    assert.equal(diag.lastCheckedAt, '2026-10-01T01:00:00.000Z');
  });

  await t.test('sanitizeDiagnosticInfo strips secrets, tokens, credentials, and sensitive host filesystem paths', () => {
    const raw = {
      version: '0.3.0',
      rootPath: '/root/private/config.json',
      userHome: '/home/deployer/.ssh/id_rsa',
      shadowPath: '/etc/shadow',
      masterKeyPath: '/etc/yunpanel/master.key',
      geminiPath: '/var/lib/.gemini/secret-file',
      normalPath: '/var/www/site/public/index.html',
      password: 'super-secret-password-123',
      api_token: 'tok-xyz-987654',
      bearerHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz',
      nested: {
        credential: 'db-pass-nested',
        safeKey: 'normal-value',
        sshPath: '/home/admin/.ssh/authorized_keys',
      },
      list: [
        '/root/dump.sql',
        'safe-entry',
        { auth_key: 'secret-key-in-list' },
      ],
    };

    const sanitized = sanitizeDiagnosticInfo(raw);

    assert.equal(sanitized.version, '0.3.0');
    assert.equal(sanitized.rootPath, '[REDACTED_PATH]');
    assert.equal(sanitized.userHome, '[REDACTED_PATH]');
    assert.equal(sanitized.shadowPath, '[REDACTED_PATH]');
    assert.equal(sanitized.masterKeyPath, '[REDACTED_PATH]');
    assert.equal(sanitized.geminiPath, '[REDACTED_PATH]');
    assert.equal(sanitized.normalPath, '/var/www/site/public/index.html');
    assert.equal(sanitized.password, '[REDACTED]');
    assert.equal(sanitized.api_token, '[REDACTED]');
    assert.equal(sanitized.bearerHeader, 'Bearer [REDACTED]');
    assert.equal(sanitized.nested.credential, '[REDACTED]');
    assert.equal(sanitized.nested.safeKey, 'normal-value');
    assert.equal(sanitized.nested.sshPath, '[REDACTED_PATH]');
    assert.equal(sanitized.list[0], '[REDACTED_PATH]');
    assert.equal(sanitized.list[1], 'safe-entry');
    assert.equal(sanitized.list[2].auth_key, '[REDACTED]');
  });

  await t.test('requireDeploymentDiagnosticsAccess blocks unauthenticated, inactive, and site-scoped roles', () => {
    const makeReqRes = (auth) => {
      let statusCode = 200;
      let body = null;
      let nextCalled = false;
      const req = { auth };
      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        json(data) {
          body = data;
          return this;
        },
      };
      const next = () => { nextCalled = true; };
      return { req, res, next, getResult: () => ({ statusCode, body, nextCalled }) };
    };

    // Unauthenticated -> 401
    {
      const { req, res, next, getResult } = makeReqRes(null);
      requireDeploymentDiagnosticsAccess(req, res, next);
      const r = getResult();
      assert.equal(r.statusCode, 401);
      assert.equal(r.body.error.code, 'unauthorized');
      assert.equal(r.nextCalled, false);
    }

    // Inactive owner -> 403
    {
      const { req, res, next, getResult } = makeReqRes({
        user: { role: 'owner', status: 'inactive' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      });
      requireDeploymentDiagnosticsAccess(req, res, next);
      const r = getResult();
      assert.equal(r.statusCode, 403);
      assert.equal(r.body.error.code, 'forbidden');
      assert.equal(r.nextCalled, false);
    }

    // Reseller -> 403
    {
      const { req, res, next, getResult } = makeReqRes({
        user: { role: 'reseller', status: 'active' },
        access: { mode: 'site_management', permissions: ['sites.manage'] },
        security: { managementAllowed: true },
      });
      requireDeploymentDiagnosticsAccess(req, res, next);
      const r = getResult();
      assert.equal(r.statusCode, 403);
      assert.equal(r.body.error.code, 'forbidden');
      assert.equal(r.nextCalled, false);
    }

    // Customer -> 403
    {
      const { req, res, next, getResult } = makeReqRes({
        user: { role: 'customer', status: 'active' },
        access: { mode: 'site_management', permissions: ['sites.manage'] },
        security: { managementAllowed: true },
      });
      requireDeploymentDiagnosticsAccess(req, res, next);
      const r = getResult();
      assert.equal(r.statusCode, 403);
      assert.equal(r.body.error.code, 'forbidden');
      assert.equal(r.nextCalled, false);
    }

    // Site Manager -> 403
    {
      const { req, res, next, getResult } = makeReqRes({
        user: { role: 'site_manager', status: 'active' },
        access: { mode: 'site_management', permissions: ['sites.manage'] },
        security: { managementAllowed: true },
      });
      requireDeploymentDiagnosticsAccess(req, res, next);
      const r = getResult();
      assert.equal(r.statusCode, 403);
      assert.equal(r.body.error.code, 'forbidden');
      assert.equal(r.nextCalled, false);
    }

    // Active Owner in management mode -> Allowed (200 / next)
    {
      const { req, res, next, getResult } = makeReqRes({
        user: { role: 'owner', status: 'active' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      });
      requireDeploymentDiagnosticsAccess(req, res, next);
      const r = getResult();
      assert.equal(r.nextCalled, true);
    }

    // Active Read-Only with servers.read -> Allowed (200 / next)
    {
      const { req, res, next, getResult } = makeReqRes({
        user: { role: 'read_only', status: 'active' },
        access: { mode: 'read_only', permissions: ['servers.read'] },
        security: { managementAllowed: false },
      });
      requireDeploymentDiagnosticsAccess(req, res, next);
      const r = getResult();
      assert.equal(r.nextCalled, true);
    }

    // Read-Only WITHOUT servers.read -> 403
    {
      const { req, res, next, getResult } = makeReqRes({
        user: { role: 'read_only', status: 'active' },
        access: { mode: 'read_only', permissions: ['websites.read'] },
        security: { managementAllowed: false },
      });
      requireDeploymentDiagnosticsAccess(req, res, next);
      const r = getResult();
      assert.equal(r.statusCode, 403);
      assert.equal(r.nextCalled, false);
    }
  });
});

test('AC2: Frontend and backend deployment comparison and stale cache detection', async (t) => {
  const backend = {
    version: '0.3.0',
    schemaVersion: 3,
    buildId: 'build-20261001-deploy-1',
    assetId: 'assets-build-20261001-deploy-1',
  };

  await t.test('detects fully synchronized frontend and backend', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261001-deploy-1',
      assetId: 'assets-build-20261001-deploy-1',
    });

    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
    assert.equal(comparison.compatible, true);
    assert.equal(comparison.staleCache, false);
    assert.equal(comparison.requiresRefresh, false);
    assert.equal(comparison.hardRefreshRequired, false);
  });

  await t.test('detects version mismatch when frontend version differs', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.2.9',
      schemaVersion: 3,
      buildId: 'build-20261001-deploy-1',
      assetId: 'assets-build-20261001-deploy-1',
    });

    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.VERSION_MISMATCH);
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.requiresRefresh, true);
    assert.match(comparison.message, /version 0\.2\.9 differs/);
  });

  await t.test('detects stale cache when frontend version matches but assetId is outdated', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261001-deploy-1',
      assetId: 'assets-build-20260930-cached-old',
    });

    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.staleCache, true);
    assert.equal(comparison.requiresRefresh, true);
    assert.equal(comparison.hardRefreshRequired, true);
    assert.match(comparison.message, /Stale frontend asset cache detected/);
  });

  await t.test('detects stale cache when frontend version matches but buildId is outdated', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20260930-old',
      assetId: 'assets-build-20261001-deploy-1',
    });

    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.staleCache, true);
    assert.equal(comparison.hardRefreshRequired, true);
  });

  await t.test('detects schema mismatch when frontend expects older schema', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 2,
      buildId: 'build-20261001-deploy-1',
      assetId: 'assets-build-20261001-deploy-1',
    });

    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SCHEMA_MISMATCH);
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.requiresRefresh, true);
    assert.equal(comparison.hardRefreshRequired, true);
    assert.match(comparison.message, /frontend expects schema 2, but backend serves schema 3/);
  });

  await t.test('handles empty or missing frontend data gracefully as unknown', () => {
    const comparison = compareDeploymentVersions(backend, null);
    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.frontend, null);
  });
});

test('AC3: Health indicators: strict separation of last checked, stale, and unknown states', async (t) => {
  const staleThresholdMs = 30 * 1000; // 30 seconds
  const referenceNow = Date.parse('2026-10-01T12:00:00.000Z');

  await t.test('missing lastCheckedAt yields unknown status and is NEVER considered healthy', () => {
    const freshness = evaluateFreshnessState({
      lastCheckedAt: null,
      staleThresholdMs,
      now: referenceNow,
    });

    assert.equal(freshness.status, FRESHNESS_STATUSES.UNKNOWN);
    assert.equal(freshness.healthy, false);
    assert.equal(freshness.unknown, true);
    assert.equal(freshness.stale, false);
    assert.match(freshness.message, /unknown/);
  });

  await t.test('invalid timestamp yields unknown status and is NEVER considered healthy', () => {
    const freshness = evaluateFreshnessState({
      lastCheckedAt: 'invalid-date-format',
      staleThresholdMs,
      now: referenceNow,
    });

    assert.equal(freshness.status, FRESHNESS_STATUSES.UNKNOWN);
    assert.equal(freshness.healthy, false);
    assert.equal(freshness.unknown, true);
  });

  await t.test('delayed check (> threshold) yields stale status and is NEVER considered healthy', () => {
    // Checked 45 seconds ago (threshold is 30 seconds)
    const delayedTime = new Date(referenceNow - 45 * 1000).toISOString();

    const freshness = evaluateFreshnessState({
      lastCheckedAt: delayedTime,
      staleThresholdMs,
      now: referenceNow,
    });

    assert.equal(freshness.status, FRESHNESS_STATUSES.STALE);
    assert.equal(freshness.healthy, false); // Critical AC3 assertion: delayed check is never healthy
    assert.equal(freshness.stale, true);
    assert.equal(freshness.unknown, false);
    assert.equal(freshness.elapsedMs, 45000);
    assert.match(freshness.message, /stale/i);
  });

  await t.test('recent check (<= threshold) with successful status yields healthy', () => {
    // Checked 10 seconds ago (threshold is 30 seconds)
    const recentTime = new Date(referenceNow - 10 * 1000).toISOString();

    const freshness = evaluateFreshnessState({
      lastCheckedAt: recentTime,
      staleThresholdMs,
      now: referenceNow,
      checkSuccessful: true,
    });

    assert.equal(freshness.status, FRESHNESS_STATUSES.HEALTHY);
    assert.equal(freshness.healthy, true);
    assert.equal(freshness.stale, false);
    assert.equal(freshness.unknown, false);
    assert.equal(freshness.elapsedMs, 10000);
  });

  await t.test('recent check with checkSuccessful=false yields unhealthy status', () => {
    const recentTime = new Date(referenceNow - 5 * 1000).toISOString();

    const freshness = evaluateFreshnessState({
      lastCheckedAt: recentTime,
      staleThresholdMs,
      now: referenceNow,
      checkSuccessful: false,
    });

    assert.equal(freshness.healthy, false);
    assert.equal(freshness.status, 'unhealthy');
  });
});

test('AC4: Distinguishing source code modifications from deployed runtime builds', async (t) => {
  await t.test('clean repository matching deployed commit reports synchronized', () => {
    const evidence = evaluateDeploymentEvidence({
      deployedCommit: 'hash-abc-123',
      sourceCommit: 'hash-abc-123',
      isDirtyTree: false,
      buildId: 'build-production-1',
      deployedAt: '2026-10-01T02:00:00Z',
    });

    assert.equal(evidence.diverged, false);
    assert.equal(evidence.warnings.length, 0);
    assert.match(evidence.summary, /RUNTIME SYNCHRONIZED/);
    assert.equal(evidence.deployed.commit, 'hash-abc-123');
    assert.equal(evidence.source.commit, 'hash-abc-123');
    assert.equal(evidence.source.isDirtyTree, false);
  });

  await t.test('dirty working tree reports uncommitted modifications warning', () => {
    const evidence = evaluateDeploymentEvidence({
      deployedCommit: 'hash-abc-123',
      sourceCommit: 'hash-abc-123',
      isDirtyTree: true,
      buildId: 'build-production-1',
      deployedAt: '2026-10-01T02:00:00Z',
    });

    assert.equal(evidence.diverged, true);
    assert.ok(evidence.warnings.some((w) => w.includes('Uncommitted changes detected')));
    assert.match(evidence.summary, /RUNTIME DIVERGENCE/);
  });

  await t.test('source commit diverged from deployed runtime commit reports deployment pending warning', () => {
    const evidence = evaluateDeploymentEvidence({
      deployedCommit: 'hash-abc-123',
      sourceCommit: 'hash-def-456',
      isDirtyTree: false,
      buildId: 'build-production-1',
      deployedAt: '2026-10-01T02:00:00Z',
    });

    assert.equal(evidence.diverged, true);
    assert.ok(evidence.warnings.some((w) => w.includes('Local source HEAD (hash-def-456) does not match deployed runtime commit (hash-abc-123)')));
    assert.match(evidence.summary, /RUNTIME DIVERGENCE/);
  });

  await t.test('resolveDeploymentDiagnostics embeds full source vs runtime evidence', () => {
    const diag = resolveDeploymentDiagnostics({
      commit: 'hash-deployed',
      sourceCommit: 'hash-local-ahead',
      isDirtyTree: true,
    });

    assert.equal(diag.sourceInfo.sourceMatchesDeployed, false);
    assert.equal(diag.evidence.diverged, true);
    assert.equal(diag.evidence.warnings.length, 2);
    assert.ok(diag.sourceInfo.warning);
  });
});

test('AC5: End-to-end HTTP routes via createCoreApp and createApp', async (t) => {
  const origin = 'https://panel.yunpanel.internal';

  await t.test('createCoreApp exposes GET /api/system/diagnostics/version with comparison and freshness', async () => {
    const core = createCoreApp();
    const app = createMockAuthApp({ userRole: 'owner' });
    app.use(core);

    const server = http.createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

    // 1. GET with matching frontend query
    const res = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version?frontendVersion=${API_VERSION}&frontendSchemaVersion=${SCHEMA_VERSION}`, {
      headers: { origin },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.version, API_VERSION);
    assert.equal(json.data.schemaVersion, SCHEMA_VERSION);
    assert.equal(json.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
    assert.equal(json.data.freshness.status, FRESHNESS_STATUSES.HEALTHY);

    // 2. GET with stale cache frontend query (different assetId)
    const staleRes = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version?frontendVersion=${API_VERSION}&frontendAssetId=assets-old-cache`, {
      headers: { origin },
    });
    assert.equal(staleRes.status, 200);
    const staleJson = await staleRes.json();
    assert.equal(staleJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(staleJson.data.comparison.staleCache, true);

    // 3. POST /api/system/diagnostics/version/compare with JSON body
    const postRes = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        assetId: json.data.assetId,
        buildId: json.data.buildId,
      }),
    });
    assert.equal(postRes.status, 200);
    const postJson = await postRes.json();
    assert.equal(postJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);

    // 4. Aliases /api/diagnostics/deployment and /api/diagnostics/version
    const aliasRes = await fetch(`http://127.0.0.1:${port}/api/diagnostics/deployment`, {
      headers: { origin },
    });
    assert.equal(aliasRes.status, 200);
    const aliasJson = await aliasRes.json();
    assert.equal(aliasJson.data.version, API_VERSION);
  });

  await t.test('unauthorized or forbidden accounts cannot access diagnostics endpoint', async () => {
    // Unauthenticated
    {
      const core = createCoreApp();
      const app = createMockAuthApp({ userRole: 'unauthenticated' });
      app.use(core);

      const server = http.createServer(app).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

      const res = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version`);
      assert.equal(res.status, 401);
    }

    // Customer role
    {
      const core = createCoreApp();
      const app = createMockAuthApp({ userRole: 'customer' });
      app.use(core);

      const server = http.createServer(app).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

      const res = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version`);
      assert.equal(res.status, 403);
    }

    // Reseller role
    {
      const core = createCoreApp();
      const app = createMockAuthApp({ userRole: 'reseller' });
      app.use(core);

      const server = http.createServer(app).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

      const res = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version`);
      assert.equal(res.status, 403);
    }
  });

  await t.test('createApp attaches deployment diagnostics to panel settings response', async () => {
    const mockPanelSettingsService = {
      settings: {
        panel: { version: API_VERSION, hostname: 'panel.internal', executionMode: 'local' },
        websiteDefaults: { defaultRuntime: 'node' },
        dnsSsl: { acmeEmail: null },
      },
      async getSystemSettings() {
        return this.settings;
      },
      async updateSystemSettings(patch) {
        return { ...this.settings, ...patch };
      },
    };

    const mainApp = createApp({
      panelSettingsService: mockPanelSettingsService,
    });

    const app = createMockAuthApp({ userRole: 'owner' });
    app.use(mainApp);

    const server = http.createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

    const res = await fetch(`http://127.0.0.1:${port}/api/panel/settings`, {
      headers: { origin },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.data.deployment);
    assert.equal(json.data.deployment.version, API_VERSION);
    assert.equal(json.data.deployment.schemaVersion, SCHEMA_VERSION);
    assert.ok(json.data.deployment.buildId);
    assert.ok(json.data.deployment.commit);
  });
});
