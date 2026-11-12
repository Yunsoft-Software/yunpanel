import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const emitBuildInfoScriptPath = fileURLToPath(new URL('../../../scripts/emit-build-info.mjs', import.meta.url));
const buildDebScriptPath = fileURLToPath(new URL('../../../scripts/build-deb.sh', import.meta.url));

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

test('AC1: Backend build/commit ID, unverified defaults, precedence, schema version, and sanitization', async (t) => {
  await t.test('resolveDeploymentDiagnostics outputs verified metadata when explicit build fields are valid', () => {
    const diag = resolveDeploymentDiagnostics({
      buildId: 'build-20261112-01',
      commit: 'abc123def456',
      buildTime: '2026-11-12T00:00:00.000Z',
      assetId: 'assets-build-20261112-01',
      environment: 'production',
      now: new Date('2026-11-12T01:00:00.000Z'),
    });

    assert.equal(diag.version, API_VERSION);
    assert.equal(diag.schemaVersion, SCHEMA_VERSION);
    assert.equal(diag.buildId, 'build-20261112-01');
    assert.equal(diag.commit, 'abc123def456');
    assert.equal(diag.buildTime, '2026-11-12T00:00:00.000Z');
    assert.equal(diag.assetId, 'assets-build-20261112-01');
    assert.equal(diag.buildVerified, true);
    assert.equal(diag.environment, 'production');
    assert.equal(diag.lastCheckedAt, '2026-11-12T01:00:00.000Z');
  });

  await t.test('T901 regression: resolveDeploymentDiagnostics({ env: {} }) never uses hardcoded build/commit fallbacks or fake source synchronization', () => {
    const diag = resolveDeploymentDiagnostics({ env: {} });

    assert.equal(diag.commit, 'unknown');
    assert.equal(diag.buildId, 'unknown');
    assert.equal(diag.assetId, 'unknown');
    assert.equal(diag.buildTime, null);
    assert.equal(diag.buildVerified, false);
    assert.equal(diag.sourceInfo.sourceCommit, null);
    assert.equal(diag.sourceInfo.sourceMatchesDeployed, false);
    assert.equal(diag.evidence.verified, false);
    assert.equal(diag.evidence.diverged, false);
    assert.equal(diag.evidence.status, 'unverified');
    assert.match(diag.evidence.summary, /RUNTIME UNVERIFIED/);
    assert.doesNotMatch(diag.evidence.summary, /RUNTIME SYNCHRONIZED/);

    const serialized = JSON.stringify(diag);
    assert.equal(serialized.includes('b3f505cf14c341d58d472ea3b8916a31'), false);
    assert.equal(serialized.includes('build-20261001-0300'), false);
    assert.equal(serialized.includes('2026-10-01T03:00:00.000Z'), false);
  });

  await t.test('invalid env values and missing/corrupt manifest fail safe to unknown/unverified', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-diag-corrupt-'));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const corruptManifestPath = path.join(tempDir, 'corrupt-build-info.json');
    await writeFile(corruptManifestPath, '{not-valid-json', 'utf8');

    const diag = resolveDeploymentDiagnostics({
      manifestPath: corruptManifestPath,
      env: {
        YUNPANEL_BUILD_ID: 'unknown',
        YUNPANEL_COMMIT_HASH: 'not-a-hex-commit!!',
        YUNPANEL_ASSET_ID: '   ',
        YUNPANEL_BUILD_TIME: 'invalid-date',
        YUNPANEL_SOURCE_COMMIT: 'unknown',
      },
    });

    assert.equal(diag.buildId, 'unknown');
    assert.equal(diag.commit, 'unknown');
    assert.equal(diag.assetId, 'unknown');
    assert.equal(diag.buildTime, null);
    assert.equal(diag.buildVerified, false);
    assert.equal(diag.sourceInfo.sourceCommit, null);
    assert.equal(diag.sourceInfo.sourceMatchesDeployed, false);
  });

  await t.test('precedence follows options -> env -> manifest file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-diag-prec-'));
    t.after(() => rm(tempDir, { recursive: true, force: true }));
    const manifestPath = path.join(tempDir, 'build-info.json');
    await writeFile(manifestPath, JSON.stringify({
      version: API_VERSION,
      schemaVersion: SCHEMA_VERSION,
      buildId: 'build-from-manifest',
      assetId: 'assets-from-manifest',
      commit: '1111111111111111111111111111111111111111',
      buildTime: '2026-11-10T10:00:00.000Z',
      buildVerified: true,
    }), 'utf8');

    const fromManifest = resolveDeploymentDiagnostics({ manifestPath, env: {} });
    assert.equal(fromManifest.buildId, 'build-from-manifest');
    assert.equal(fromManifest.assetId, 'assets-from-manifest');
    assert.equal(fromManifest.commit, '1111111111111111111111111111111111111111');
    assert.equal(fromManifest.buildVerified, true);
    assert.equal(fromManifest.sourceInfo.sourceCommit, null);
    assert.equal(fromManifest.sourceInfo.sourceMatchesDeployed, false);

    const fromEnv = resolveDeploymentDiagnostics({
      manifestPath,
      env: {
        YUNPANEL_BUILD_ID: 'build-from-env',
        YUNPANEL_ASSET_ID: 'assets-from-env',
        YUNPANEL_COMMIT_HASH: '2222222222222222222222222222222222222222',
        YUNPANEL_BUILD_TIME: '2026-11-11T10:00:00.000Z',
      },
    });
    assert.equal(fromEnv.buildId, 'build-from-env');
    assert.equal(fromEnv.assetId, 'assets-from-env');
    assert.equal(fromEnv.commit, '2222222222222222222222222222222222222222');
    assert.equal(fromEnv.buildVerified, true);

    const fromOptions = resolveDeploymentDiagnostics({
      manifestPath,
      env: {
        YUNPANEL_BUILD_ID: 'build-from-env',
        YUNPANEL_COMMIT_HASH: '2222222222222222222222222222222222222222',
      },
      buildId: 'build-from-options',
      assetId: 'assets-from-options',
      commit: '3333333333333333333333333333333333333333',
      buildTime: '2026-11-12T10:00:00.000Z',
    });
    assert.equal(fromOptions.buildId, 'build-from-options');
    assert.equal(fromOptions.assetId, 'assets-from-options');
    assert.equal(fromOptions.commit, '3333333333333333333333333333333333333333');
    assert.equal(fromOptions.buildVerified, true);
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
    buildId: 'build-20261112-deploy-1',
    assetId: 'assets-build-20261112-deploy-1',
  };

  await t.test('detects fully synchronized frontend and backend when both buildId and assetId are known and match', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
    });

    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
    assert.equal(comparison.compatible, true);
    assert.equal(comparison.staleCache, false);
    assert.equal(comparison.requiresRefresh, false);
    assert.equal(comparison.hardRefreshRequired, false);
  });

  await t.test('returns UNKNOWN (never SYNCHRONIZED) when frontend or backend buildId/assetId is missing or unknown', () => {
    const missingFrontendIds = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
    });
    assert.equal(missingFrontendIds.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(missingFrontendIds.compatible, false);
    assert.equal(missingFrontendIds.staleCache, false);
    assert.equal(missingFrontendIds.requiresRefresh, false);
    assert.equal(missingFrontendIds.hardRefreshRequired, false);

    const unknownFrontendIds = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'unknown',
      assetId: 'unknown',
    });
    assert.equal(unknownFrontendIds.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(unknownFrontendIds.compatible, false);
    assert.equal(unknownFrontendIds.staleCache, false);

    const unknownBackend = {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'unknown',
      assetId: 'unknown',
    };
    const againstUnknownBackend = compareDeploymentVersions(unknownBackend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
    });
    assert.equal(againstUnknownBackend.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(againstUnknownBackend.compatible, false);
    assert.equal(againstUnknownBackend.staleCache, false);
    assert.equal(againstUnknownBackend.requiresRefresh, false);
    assert.equal(againstUnknownBackend.hardRefreshRequired, false);
  });

  await t.test('detects version mismatch when frontend version differs', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.2.9',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
    });

    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.VERSION_MISMATCH);
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.requiresRefresh, true);
    assert.match(comparison.message, /version 0\.2\.9 differs/);
  });

  await t.test('detects stale cache when frontend version matches but known assetId is outdated', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20260930-cached-old',
    });

    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.staleCache, true);
    assert.equal(comparison.requiresRefresh, true);
    assert.equal(comparison.hardRefreshRequired, true);
    assert.match(comparison.message, /Stale frontend asset cache detected/);
  });

  await t.test('detects stale cache when frontend version matches but known buildId is outdated', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20260930-old',
      assetId: 'assets-build-20261112-deploy-1',
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
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
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
  const staleThresholdMs = 30 * 1000;
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
    const delayedTime = new Date(referenceNow - 45 * 1000).toISOString();

    const freshness = evaluateFreshnessState({
      lastCheckedAt: delayedTime,
      staleThresholdMs,
      now: referenceNow,
    });

    assert.equal(freshness.status, FRESHNESS_STATUSES.STALE);
    assert.equal(freshness.healthy, false);
    assert.equal(freshness.stale, true);
    assert.equal(freshness.unknown, false);
    assert.equal(freshness.elapsedMs, 45000);
    assert.match(freshness.message, /stale/i);
  });

  await t.test('recent check (<= threshold) with successful status yields healthy', () => {
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

test('AC4: Distinguishing source code modifications and unverified metadata from deployed runtime builds', async (t) => {
  await t.test('clean repository matching known deployed commit reports synchronized and verified', () => {
    const evidence = evaluateDeploymentEvidence({
      deployedCommit: 'a1b2c3d4e5f6',
      sourceCommit: 'a1b2c3d4e5f6',
      isDirtyTree: false,
      buildId: 'build-production-1',
      deployedAt: '2026-11-12T02:00:00Z',
    });

    assert.equal(evidence.diverged, false);
    assert.equal(evidence.verified, true);
    assert.equal(evidence.status, 'synchronized');
    assert.equal(evidence.warnings.length, 0);
    assert.match(evidence.summary, /RUNTIME SYNCHRONIZED/);
    assert.equal(evidence.deployed.commit, 'a1b2c3d4e5f6');
    assert.equal(evidence.source.commit, 'a1b2c3d4e5f6');
    assert.equal(evidence.source.isDirtyTree, false);
  });

  await t.test('missing or unknown deployed/source commit reports unverified and never claims synchronized', () => {
    const missingSource = evaluateDeploymentEvidence({
      deployedCommit: 'a1b2c3d4e5f6',
      sourceCommit: null,
      isDirtyTree: false,
      buildId: 'build-production-1',
      deployedAt: '2026-11-12T02:00:00Z',
    });
    assert.equal(missingSource.diverged, false);
    assert.equal(missingSource.verified, false);
    assert.equal(missingSource.status, 'unverified');
    assert.equal(
      missingSource.summary,
      'RUNTIME UNVERIFIED: Build or source commit metadata is unavailable; source/runtime equality is not proven.',
    );

    const unknownDeployed = evaluateDeploymentEvidence({
      deployedCommit: 'unknown',
      sourceCommit: 'a1b2c3d4e5f6',
      isDirtyTree: false,
    });
    assert.equal(unknownDeployed.diverged, false);
    assert.equal(unknownDeployed.verified, false);
    assert.equal(unknownDeployed.status, 'unverified');
    assert.match(unknownDeployed.summary, /RUNTIME UNVERIFIED/);
  });

  await t.test('dirty working tree reports uncommitted modifications warning', () => {
    const evidence = evaluateDeploymentEvidence({
      deployedCommit: 'a1b2c3d4e5f6',
      sourceCommit: 'a1b2c3d4e5f6',
      isDirtyTree: true,
      buildId: 'build-production-1',
      deployedAt: '2026-11-12T02:00:00Z',
    });

    assert.equal(evidence.diverged, true);
    assert.equal(evidence.verified, false);
    assert.ok(evidence.warnings.some((w) => w.includes('Uncommitted changes detected')));
    assert.match(evidence.summary, /RUNTIME DIVERGENCE/);
  });

  await t.test('source commit diverged from deployed runtime commit reports deployment pending warning', () => {
    const evidence = evaluateDeploymentEvidence({
      deployedCommit: 'a1b2c3d4e5f6',
      sourceCommit: 'f6e5d4c3b2a1',
      isDirtyTree: false,
      buildId: 'build-production-1',
      deployedAt: '2026-11-12T02:00:00Z',
    });

    assert.equal(evidence.diverged, true);
    assert.equal(evidence.verified, false);
    assert.ok(evidence.warnings.some((w) => w.includes('Local source HEAD (f6e5d4c3b2a1) does not match deployed runtime commit (a1b2c3d4e5f6)')));
    assert.match(evidence.summary, /RUNTIME DIVERGENCE/);
  });

  await t.test('resolveDeploymentDiagnostics embeds full source vs runtime evidence', () => {
    const diag = resolveDeploymentDiagnostics({
      commit: '1111111abcdef',
      sourceCommit: '2222222abcdef',
      isDirtyTree: true,
      env: {},
    });

    assert.equal(diag.sourceInfo.sourceMatchesDeployed, false);
    assert.equal(diag.evidence.diverged, true);
    assert.equal(diag.evidence.warnings.length, 2);
    assert.ok(diag.sourceInfo.warning);
  });
});

test('AC5: Real git repository emit-build-info CLI, fail-closed package verification, and end-to-end HTTP routes', async (t) => {
  const origin = 'https://panel.yunpanel.internal';

  await t.test('emit-build-info.mjs fails closed when git HEAD is unavailable or web dist commit mismatches HEAD', async () => {
    const nonGitDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-non-git-'));
    t.after(() => rm(nonGitDir, { recursive: true, force: true }));

    // 1. Non-git directory without commit env must fail closed
    assert.throws(
      () => execFileSync(process.execPath, [
        emitBuildInfoScriptPath,
        '--repo', nonGitDir,
        '--output', path.join(nonGitDir, 'build-info.json'),
      ], {
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
      }),
      (err) => err.status !== 0,
    );

    // 2. Empty git repo without commits must fail closed
    const emptyGitDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-empty-git-'));
    t.after(() => rm(emptyGitDir, { recursive: true, force: true }));
    execFileSync('git', ['init'], { cwd: emptyGitDir, stdio: 'pipe' });

    assert.throws(
      () => execFileSync(process.execPath, [
        emitBuildInfoScriptPath,
        '--repo', emptyGitDir,
        '--output', path.join(emptyGitDir, 'build-info.json'),
      ], {
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
      }),
      (err) => err.status !== 0,
    );

    // 3. Real git repo: stale web dist commit mismatch must fail closed
    const repoDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-real-git-'));
    t.after(() => rm(repoDir, { recursive: true, force: true }));
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@yunpanel.local'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'YunPanel Test'], { cwd: repoDir, stdio: 'pipe' });

    await writeFile(path.join(repoDir, 'file.txt'), 'commit-1\n', 'utf8');
    execFileSync('git', ['add', 'file.txt'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'first commit'], { cwd: repoDir, stdio: 'pipe' });

    const webDistManifestPath = path.join(repoDir, 'dist', 'build-info.json');
    execFileSync(process.execPath, [
      emitBuildInfoScriptPath,
      '--repo', repoDir,
      '--output', webDistManifestPath,
    ], {
      env: { PATH: process.env.PATH },
      stdio: 'pipe',
    });

    // Advance HEAD to commit-2 without rebuilding web dist
    await writeFile(path.join(repoDir, 'file.txt'), 'commit-2\n', 'utf8');
    execFileSync('git', ['add', 'file.txt'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'second commit'], { cwd: repoDir, stdio: 'pipe' });

    const packageManifestPath = path.join(repoDir, 'pkg', 'build-info.json');
    assert.throws(
      () => execFileSync(process.execPath, [
        emitBuildInfoScriptPath,
        '--repo', repoDir,
        '--package-version', '0.3.0-2026111301',
        '--verify-web-dist', webDistManifestPath,
        '--output', packageManifestPath,
      ], {
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
      }),
      (err) => err.status !== 0 && /does not match|mismatch/i.test(String(err.stderr)),
    );
  });

  await t.test('real emit-build-info.mjs manifest drives createCoreApp HTTP endpoints cleanly', async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-http-git-'));
    t.after(() => rm(repoDir, { recursive: true, force: true }));

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@yunpanel.local'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'YunPanel Test'], { cwd: repoDir, stdio: 'pipe' });
    await writeFile(path.join(repoDir, 'app.js'), 'export const ok = true;\n', 'utf8');
    execFileSync('git', ['add', 'app.js'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'release commit'], { cwd: repoDir, stdio: 'pipe' });

    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    const webDistManifestPath = path.join(repoDir, 'web-dist', 'build-info.json');
    const packageManifestPath = path.join(repoDir, 'usr', 'lib', 'yunpanel', 'build-info.json');

    execFileSync(process.execPath, [
      emitBuildInfoScriptPath,
      '--repo', repoDir,
      '--output', webDistManifestPath,
    ], {
      env: {
        PATH: process.env.PATH,
        YUNPANEL_BUILD_TIME: '2026-11-12T22:00:00.000Z',
      },
      stdio: 'pipe',
    });

    execFileSync(process.execPath, [
      emitBuildInfoScriptPath,
      '--repo', repoDir,
      '--package-version', '0.3.0-2026111201',
      '--verify-web-dist', webDistManifestPath,
      '--output', packageManifestPath,
    ], {
      env: { PATH: process.env.PATH },
      stdio: 'pipe',
    });

    const manifestStat = await stat(packageManifestPath);
    assert.equal(manifestStat.mode & 0o777, 0o644);
    const webManifest = JSON.parse(await readFile(webDistManifestPath, 'utf8'));
    const pkgManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'));

    assert.equal(pkgManifest.commit, headCommit);
    assert.equal(pkgManifest.packageVersion, '0.3.0-2026111201');
    assert.equal(pkgManifest.buildId, webManifest.buildId);
    assert.equal(pkgManifest.assetId, webManifest.assetId);
    assert.equal(pkgManifest.buildTime, '2026-11-12T22:00:00.000Z');
    assert.equal(pkgManifest.buildVerified, true);

    const core = createCoreApp({
      deploymentDiagnosticsOptions: {
        manifestPath: packageManifestPath,
        env: {},
      },
    });
    const app = createMockAuthApp({ userRole: 'owner' });
    app.use(core);

    const server = http.createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

    // 1. Matching verified frontend -> SYNCHRONIZED
    const syncQuery = new URLSearchParams({
      frontendVersion: API_VERSION,
      frontendSchemaVersion: String(SCHEMA_VERSION),
      frontendBuildId: webManifest.buildId,
      frontendAssetId: webManifest.assetId,
    });
    const syncRes = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version?${syncQuery}`, {
      headers: { origin },
    });
    assert.equal(syncRes.status, 200);
    const syncJson = await syncRes.json();
    assert.equal(syncJson.data.commit, headCommit);
    assert.equal(syncJson.data.buildId, webManifest.buildId);
    assert.equal(syncJson.data.assetId, webManifest.assetId);
    assert.equal(syncJson.data.buildVerified, true);
    assert.equal(syncJson.data.sourceInfo.sourceCommit, null);
    assert.equal(syncJson.data.sourceInfo.sourceMatchesDeployed, false);
    assert.equal(syncJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
    assert.equal(syncJson.data.freshness.status, FRESHNESS_STATUSES.HEALTHY);

    // 2. Missing / unknown frontend buildId & assetId -> UNKNOWN (never SYNCHRONIZED)
    const unknownRes = await fetch(
      `http://127.0.0.1:${port}/api/system/diagnostics/version?frontendVersion=${API_VERSION}&frontendSchemaVersion=${SCHEMA_VERSION}&frontendBuildId=unknown&frontendAssetId=unknown`,
      { headers: { origin } },
    );
    assert.equal(unknownRes.status, 200);
    const unknownJson = await unknownRes.json();
    assert.equal(unknownJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(unknownJson.data.comparison.compatible, false);

    // 3. Stale frontend assetId -> STALE_CACHE
    const staleRes = await fetch(
      `http://127.0.0.1:${port}/api/system/diagnostics/version?frontendVersion=${API_VERSION}&frontendAssetId=assets-old-cache`,
      { headers: { origin } },
    );
    assert.equal(staleRes.status, 200);
    const staleJson = await staleRes.json();
    assert.equal(staleJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(staleJson.data.comparison.staleCache, true);

    // 4. POST /api/system/diagnostics/version/compare with verified vs unknown vs stale
    const postSyncRes = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        assetId: webManifest.assetId,
        buildId: webManifest.buildId,
      }),
    });
    assert.equal(postSyncRes.status, 200);
    assert.equal((await postSyncRes.json()).data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);

    const postUnknownRes = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        assetId: 'unknown',
        buildId: 'unknown',
      }),
    });
    assert.equal(postUnknownRes.status, 200);
    assert.equal((await postUnknownRes.json()).data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);

    // 5. Alias endpoint
    const aliasRes = await fetch(`http://127.0.0.1:${port}/api/diagnostics/deployment`, {
      headers: { origin },
    });
    assert.equal(aliasRes.status, 200);
    assert.equal((await aliasRes.json()).data.commit, headCommit);
  });

  await t.test('createCoreApp without build metadata returns unknown build identity and UNKNOWN comparison', async () => {
    const core = createCoreApp({
      deploymentDiagnosticsOptions: {
        manifestPath: null,
        env: {},
      },
    });
    const app = createMockAuthApp({ userRole: 'owner' });
    app.use(core);

    const server = http.createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

    const res = await fetch(
      `http://127.0.0.1:${port}/api/system/diagnostics/version?frontendVersion=${API_VERSION}&frontendSchemaVersion=${SCHEMA_VERSION}&frontendBuildId=unknown&frontendAssetId=unknown`,
      { headers: { origin } },
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.commit, 'unknown');
    assert.equal(json.data.buildId, 'unknown');
    assert.equal(json.data.assetId, 'unknown');
    assert.equal(json.data.buildVerified, false);
    assert.equal(json.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);

    const postRes = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        buildId: 'build-client-1',
        assetId: 'assets-client-1',
      }),
    });
    assert.equal(postRes.status, 200);
    assert.equal((await postRes.json()).data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
  });

  await t.test('build-deb.sh emits verified /usr/lib/yunpanel/build-info.json checked against web dist build-info.json', async () => {
    const buildScript = await readFile(buildDebScriptPath, 'utf8');
    assert.match(buildScript, /scripts\/emit-build-info\.mjs/);
    assert.match(buildScript, /--verify-web-dist "\$repository_root\/apps\/web\/dist\/build-info\.json"/);
    assert.match(buildScript, /--output "\$package_root\/usr\/lib\/yunpanel\/build-info\.json"/);
  });

  await t.test('unauthorized or forbidden accounts cannot access diagnostics endpoint', async () => {
    for (const [role, expectedStatus] of [
      ['unauthenticated', 401],
      ['customer', 403],
      ['reseller', 403],
    ]) {
      const core = createCoreApp({ deploymentDiagnosticsOptions: { env: {} } });
      const app = createMockAuthApp({ userRole: role });
      app.use(core);

      const server = http.createServer(app).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

      const res = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics/version`);
      assert.equal(res.status, expectedStatus);
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
