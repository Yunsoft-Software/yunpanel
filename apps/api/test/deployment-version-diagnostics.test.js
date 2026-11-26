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
import { createAuthStore } from '../src/auth/auth-store.js';
import { createAuthenticatedApi } from '../src/auth/auth-http.js';
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
} from '../src/http/core-app.js';
import { createApp } from '../src/http/app.js';

const emitBuildInfoScriptPath = fileURLToPath(new URL('../../../scripts/emit-build-info.mjs', import.meta.url));
const buildDebScriptPath = fileURLToPath(new URL('../../../scripts/build-deb.sh', import.meta.url));

async function startRealAuthenticatedCoreServer(t, {
  deploymentDiagnosticsOptions,
  publicOrigin = 'https://panel.yunpanel.internal',
} = {}) {
  const authDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-diag-auth-'));
  const store = createAuthStore({
    filePath: path.join(authDir, 'auth.sqlite'),
    masterKey: 'b'.repeat(64),
  });
  t.after(async () => {
    store.close();
    await rm(authDir, { recursive: true, force: true });
  });

  const listener = createAuthenticatedApi({
    store,
    publicOrigin,
    ownerMfaRequired: false,
    createHandler: () => createCoreApp({ deploymentDiagnosticsOptions }),
  });

  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { token: setupToken } = store.issueSetupToken();

  const setupRes = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: {
      origin: publicOrigin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      setupToken,
      username: 'admin',
      password: 'OwnerStrongPassword!2026',
      email: 'owner@yunpanel.internal',
    }),
  });
  assert.equal(setupRes.status, 201);

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: publicOrigin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: 'admin',
      password: 'OwnerStrongPassword!2026',
    }),
  });
  assert.equal(loginRes.status, 200);

  const cookieHeader = loginRes.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0].trim())
    .find((pair) => pair.startsWith('__Host-yunpanel_session='));
  assert.ok(cookieHeader, 'Expected __Host-yunpanel_session cookie from /api/auth/login');

  const loginJson = await loginRes.json();
  const csrfToken = loginJson.data?.csrfToken;
  assert.ok(typeof csrfToken === 'string' && csrfToken.length > 10, 'Expected session csrfToken');

  return {
    baseUrl,
    publicOrigin,
    cookieHeader,
    csrfToken,
  };
}

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

  await t.test('invalid env values and corrupt/dirty/unverified manifests fail safe and block env fallback', async () => {
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
    assert.equal(diag.manifestInvalid, true);
    assert.equal(diag.buildVerified, false);
    assert.equal(diag.sourceInfo.sourceCommit, null);
    assert.equal(diag.sourceInfo.sourceMatchesDeployed, false);

    // Corrupt, dirty, or unverified manifest on disk MUST block valid env fallback
    const validEnv = {
      YUNPANEL_BUILD_ID: 'build-env-valid',
      YUNPANEL_ASSET_ID: 'assets-env-valid',
      YUNPANEL_COMMIT_HASH: '4444444444444444444444444444444444444444',
      YUNPANEL_BUILD_TIME: '2026-11-12T10:00:00.000Z',
      YUNPANEL_SOURCE_COMMIT: '4444444444444444444444444444444444444444',
    };

    const dirtyManifestPath = path.join(tempDir, 'dirty-build-info.json');
    await writeFile(dirtyManifestPath, JSON.stringify({
      version: API_VERSION,
      schemaVersion: SCHEMA_VERSION,
      buildId: 'build-dirty-manifest',
      assetId: 'assets-dirty-manifest',
      commit: '4444444444444444444444444444444444444444',
      buildTime: '2026-11-12T10:00:00.000Z',
      dirty: true,
      buildVerified: false,
    }), 'utf8');

    const unverifiedManifestPath = path.join(tempDir, 'unverified-build-info.json');
    await writeFile(unverifiedManifestPath, JSON.stringify({
      version: API_VERSION,
      schemaVersion: SCHEMA_VERSION,
      buildId: 'build-unverified-manifest',
      assetId: 'assets-unverified-manifest',
      commit: '4444444444444444444444444444444444444444',
      buildTime: '2026-11-12T10:00:00.000Z',
      dirty: false,
      buildVerified: false,
    }), 'utf8');

    for (const invalidPath of [corruptManifestPath, dirtyManifestPath, unverifiedManifestPath]) {
      const blocked = resolveDeploymentDiagnostics({
        manifestPath: invalidPath,
        env: validEnv,
      });
      assert.equal(blocked.manifestInvalid, true);
      assert.equal(blocked.buildVerified, false);
      assert.equal(blocked.buildId, 'unknown');
      assert.equal(blocked.commit, 'unknown');
      assert.equal(blocked.evidence.verified, false);
      assert.notEqual(blocked.evidence.status, 'synchronized');
      assert.equal(blocked.sourceInfo.sourceMatchesDeployed, false);
      assert.doesNotMatch(blocked.evidence.summary, /RUNTIME SYNCHRONIZED/);
    }
  });

  await t.test('authoritative manifest precedence: options -> manifest (env never overwrites manifest; env applies only when manifest is absent)', async () => {
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
      dirty: false,
      buildVerified: true,
    }), 'utf8');

    // 1. Verified manifest without env
    const fromManifest = resolveDeploymentDiagnostics({ manifestPath, env: {} });
    assert.equal(fromManifest.buildId, 'build-from-manifest');
    assert.equal(fromManifest.assetId, 'assets-from-manifest');
    assert.equal(fromManifest.commit, '1111111111111111111111111111111111111111');
    assert.equal(fromManifest.metadataConflict, false);
    assert.equal(fromManifest.buildVerified, true);
    assert.equal(fromManifest.sourceInfo.sourceCommit, null);
    assert.equal(fromManifest.sourceInfo.sourceMatchesDeployed, false);

    // 2. When manifest is absent, explicit env is used
    const fromEnvWithoutManifest = resolveDeploymentDiagnostics({
      manifestPath: path.join(tempDir, 'missing-build-info.json'),
      env: {
        YUNPANEL_BUILD_ID: 'build-from-env',
        YUNPANEL_ASSET_ID: 'assets-from-env',
        YUNPANEL_COMMIT_HASH: '2222222222222222222222222222222222222222',
        YUNPANEL_BUILD_TIME: '2026-11-11T10:00:00.000Z',
      },
    });
    assert.equal(fromEnvWithoutManifest.buildId, 'build-from-env');
    assert.equal(fromEnvWithoutManifest.assetId, 'assets-from-env');
    assert.equal(fromEnvWithoutManifest.commit, '2222222222222222222222222222222222222222');
    assert.equal(fromEnvWithoutManifest.buildVerified, true);

    // 3. When verified manifest exists, conflicting env NEVER overwrites manifest and triggers metadataConflict
    const conflictingEnv = resolveDeploymentDiagnostics({
      manifestPath,
      env: {
        YUNPANEL_BUILD_ID: 'build-from-env',
        YUNPANEL_ASSET_ID: 'assets-from-env',
        YUNPANEL_COMMIT_HASH: '2222222222222222222222222222222222222222',
        YUNPANEL_BUILD_TIME: '2026-11-11T10:00:00.000Z',
        YUNPANEL_SOURCE_COMMIT: '1111111111111111111111111111111111111111',
      },
    });
    assert.equal(conflictingEnv.buildId, 'build-from-manifest');
    assert.equal(conflictingEnv.assetId, 'assets-from-manifest');
    assert.equal(conflictingEnv.commit, '1111111111111111111111111111111111111111');
    assert.equal(conflictingEnv.buildTime, '2026-11-10T10:00:00.000Z');
    assert.equal(conflictingEnv.metadataConflict, true);
    assert.equal(conflictingEnv.buildVerified, false);
    assert.equal(conflictingEnv.evidence.verified, false);
    assert.equal(conflictingEnv.evidence.status, 'unverified');
    assert.equal(conflictingEnv.sourceInfo.sourceMatchesDeployed, false);
    assert.ok(conflictingEnv.evidence.warnings.some((w) => w.includes('conflicts with immutable package build-info.json')));

    // 4. Direct function options still take explicit programmatic precedence
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
    assert.equal(fromOptions.metadataConflict, false);
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
    commit: 'abcdef1234567890',
    buildTime: '2026-11-12T00:00:00.000Z',
    dirty: false,
    buildVerified: true,
  };

  await t.test('detects fully synchronized frontend and backend only when both sides are verified and buildId, assetId, commit, and buildTime all match', () => {
    const comparison = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
      commit: 'abcdef1234567890',
      buildTime: '2026-11-12T00:00:00.000Z',
      dirty: false,
      buildVerified: true,
    });

    assert.equal(comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
    assert.equal(comparison.compatible, true);
    assert.equal(comparison.staleCache, false);
    assert.equal(comparison.requiresRefresh, false);
    assert.equal(comparison.hardRefreshRequired, false);
    assert.equal(comparison.backend.commit, 'abcdef1234567890');
    assert.equal(comparison.backend.buildTime, '2026-11-12T00:00:00.000Z');
    assert.equal(comparison.frontend.commit, 'abcdef1234567890');
    assert.equal(comparison.frontend.buildTime, '2026-11-12T00:00:00.000Z');
  });

  await t.test('returns UNKNOWN (never SYNCHRONIZED) when frontend or backend buildId/assetId/commit/buildTime/buildVerified is missing or unverified', () => {
    const missingFrontendIds = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
    });
    assert.equal(missingFrontendIds.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(missingFrontendIds.compatible, false);

    // Matching buildId & assetId WITHOUT commit/buildTime/buildVerified MUST return UNKNOWN
    const idOnlyFrontend = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
    });
    assert.equal(idOnlyFrontend.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(idOnlyFrontend.compatible, false);

    for (const incompleteFrontend of [
      {
        version: '0.3.0',
        schemaVersion: 3,
        buildId: 'build-20261112-deploy-1',
        assetId: 'assets-build-20261112-deploy-1',
        buildTime: '2026-11-12T00:00:00.000Z',
        buildVerified: true,
      },
      {
        version: '0.3.0',
        schemaVersion: 3,
        buildId: 'build-20261112-deploy-1',
        assetId: 'assets-build-20261112-deploy-1',
        commit: 'abcdef1234567890',
        buildVerified: true,
      },
      {
        version: '0.3.0',
        schemaVersion: 3,
        buildId: 'build-20261112-deploy-1',
        assetId: 'assets-build-20261112-deploy-1',
        commit: 'abcdef1234567890',
        buildTime: '2026-11-12T00:00:00.000Z',
        buildVerified: false,
      },
    ]) {
      const result = compareDeploymentVersions(backend, incompleteFrontend);
      assert.equal(result.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
      assert.equal(result.compatible, false);
    }

    // Partial backend (e.g. buildTime: null -> buildVerified: false) MUST return UNKNOWN even when IDs and commit match
    const partialBackend = resolveDeploymentDiagnostics({
      manifestPath: null,
      env: {
        YUNPANEL_BUILD_ID: 'build-20261112-deploy-1',
        YUNPANEL_ASSET_ID: 'assets-build-20261112-deploy-1',
        YUNPANEL_COMMIT_HASH: 'abcdef1234567890',
      },
    });
    assert.equal(partialBackend.buildVerified, false);
    assert.equal(partialBackend.buildTime, null);
    const againstPartialBackend = compareDeploymentVersions(partialBackend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
      commit: 'abcdef1234567890',
      buildTime: '2026-11-12T00:00:00.000Z',
      dirty: false,
      buildVerified: true,
    });
    assert.equal(againstPartialBackend.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(againstPartialBackend.compatible, false);

    const unknownBackend = {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'unknown',
      assetId: 'unknown',
      commit: 'unknown',
      buildTime: null,
      buildVerified: false,
    };
    const againstUnknownBackend = compareDeploymentVersions(unknownBackend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
      commit: 'abcdef1234567890',
      buildTime: '2026-11-12T00:00:00.000Z',
      buildVerified: true,
    });
    assert.equal(againstUnknownBackend.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(againstUnknownBackend.compatible, false);
  });

  await t.test('detects stale cache when reused buildId/assetId hide a commit or buildTime mismatch', () => {
    const commitMismatch = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
      commit: '1111111111111111',
      buildTime: '2026-11-12T00:00:00.000Z',
      dirty: false,
      buildVerified: true,
    });
    assert.equal(commitMismatch.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(commitMismatch.compatible, false);
    assert.equal(commitMismatch.staleCache, true);
    assert.equal(commitMismatch.requiresRefresh, true);
    assert.equal(commitMismatch.hardRefreshRequired, true);

    const buildTimeMismatch = compareDeploymentVersions(backend, {
      version: '0.3.0',
      schemaVersion: 3,
      buildId: 'build-20261112-deploy-1',
      assetId: 'assets-build-20261112-deploy-1',
      commit: 'abcdef1234567890',
      buildTime: '2026-11-11T23:00:00.000Z',
      dirty: false,
      buildVerified: true,
    });
    assert.equal(buildTimeMismatch.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(buildTimeMismatch.compatible, false);
    assert.equal(buildTimeMismatch.staleCache, true);
    assert.equal(buildTimeMismatch.requiresRefresh, true);
    assert.equal(buildTimeMismatch.hardRefreshRequired, true);
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

    await writeFile(path.join(repoDir, '.gitignore'), 'dist/\npkg/\n', 'utf8');
    await writeFile(path.join(repoDir, 'file.txt'), 'commit-1\n', 'utf8');
    execFileSync('git', ['add', '.gitignore', 'file.txt'], { cwd: repoDir, stdio: 'pipe' });
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

  await t.test('T901 review regressions: dirty git tree marks buildVerified:false/dirty:true, release mode rejects dirty state, and --verify-web-dist rejects env overrides', async (subT) => {
    const workRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t901-probe-'));
    subT.after(() => rm(workRoot, { recursive: true, force: true }));

    const repoDir = path.join(workRoot, 'repo');
    const outDir = path.join(workRoot, 'out');
    execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'probe@yunpanel.local'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'YunPanel Probe'], { cwd: repoDir, stdio: 'pipe' });

    const trackedFile = path.join(repoDir, 'app.js');
    await writeFile(trackedFile, 'export const version = "A";\n', 'utf8');
    execFileSync('git', ['add', 'app.js'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'commit A'], { cwd: repoDir, stdio: 'pipe' });
    const commitA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // 1. Clean web manifest generation with explicit build identity
    const cleanWebManifestPath = path.join(outDir, 'clean-web-build-info.json');
    execFileSync(process.execPath, [
      emitBuildInfoScriptPath,
      '--repo', repoDir,
      '--output', cleanWebManifestPath,
    ], {
      env: {
        PATH: process.env.PATH,
        YUNPANEL_BUILD_ID: 'build-web-A',
        YUNPANEL_ASSET_ID: 'assets-web-A',
        YUNPANEL_BUILD_TIME: '2026-11-13T00:00:00.000Z',
      },
      stdio: 'pipe',
    });
    const cleanWebManifest = JSON.parse(await readFile(cleanWebManifestPath, 'utf8'));
    assert.equal(cleanWebManifest.commit, commitA);
    assert.equal(cleanWebManifest.version, API_VERSION);
    assert.equal(cleanWebManifest.buildId, 'build-web-A');
    assert.equal(cleanWebManifest.assetId, 'assets-web-A');
    assert.equal(cleanWebManifest.buildTime, '2026-11-13T00:00:00.000Z');
    assert.equal(cleanWebManifest.dirty, false);
    assert.equal(cleanWebManifest.buildVerified, true);

    // 2. --verify-web-dist WITHOUT env overrides preserves exact web manifest identity
    const exactPkgManifestPath = path.join(outDir, 'exact-pkg-build-info.json');
    execFileSync(process.execPath, [
      emitBuildInfoScriptPath,
      '--repo', repoDir,
      '--package-version', '0.3.0-2026111301',
      '--verify-web-dist', cleanWebManifestPath,
      '--output', exactPkgManifestPath,
    ], {
      env: { PATH: process.env.PATH },
      stdio: 'pipe',
    });
    const exactPkgManifest = JSON.parse(await readFile(exactPkgManifestPath, 'utf8'));
    assert.equal(exactPkgManifest.version, cleanWebManifest.version);
    assert.equal(exactPkgManifest.commit, cleanWebManifest.commit);
    assert.equal(exactPkgManifest.buildId, cleanWebManifest.buildId);
    assert.equal(exactPkgManifest.assetId, cleanWebManifest.assetId);
    assert.equal(exactPkgManifest.buildTime, cleanWebManifest.buildTime);
    assert.equal(exactPkgManifest.dirty, false);
    assert.equal(exactPkgManifest.buildVerified, true);
    assert.equal(exactPkgManifest.packageVersion, '0.3.0-2026111301');

    // 3. --verify-web-dist WITH mismatched env overrides fails closed (exit !== 0)
    for (const mismatchedEnv of [
      { YUNPANEL_BUILD_ID: 'build-package-B' },
      { YUNPANEL_ASSET_ID: 'assets-package-B' },
      { YUNPANEL_BUILD_TIME: '2026-11-13T01:00:00.000Z' },
      { YUNPANEL_VERSION: '0.3.1' },
      { YUNPANEL_COMMIT_HASH: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
      { YUNPANEL_BUILD_COMMIT: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    ]) {
      assert.throws(
        () => execFileSync(process.execPath, [
          emitBuildInfoScriptPath,
          '--repo', repoDir,
          '--verify-web-dist', cleanWebManifestPath,
          '--output', path.join(outDir, 'rejected-override.json'),
        ], {
          env: { PATH: process.env.PATH, ...mismatchedEnv },
          stdio: 'pipe',
        }),
        (err) => err.status !== 0,
        `Expected --verify-web-dist to reject mismatched env ${JSON.stringify(mismatchedEnv)}`,
      );
    }

    // 4. Modify tracked app.js -> git status --porcelain reports " M app.js"
    await writeFile(trackedFile, 'export const version = "B-dirty";\n', 'utf8');
    const porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    assert.match(porcelain, /^M\s+app\.js$/m);

    // 4a. Default WIP mode succeeds (does not break local vite build) but sets dirty: true & buildVerified: false
    const dirtyWipManifestPath = path.join(outDir, 'dirty-wip-build-info.json');
    execFileSync(process.execPath, [
      emitBuildInfoScriptPath,
      '--repo', repoDir,
      '--output', dirtyWipManifestPath,
    ], {
      env: { PATH: process.env.PATH },
      stdio: 'pipe',
    });
    const dirtyWipManifest = JSON.parse(await readFile(dirtyWipManifestPath, 'utf8'));
    assert.equal(dirtyWipManifest.commit, commitA);
    assert.equal(dirtyWipManifest.dirty, true);
    assert.equal(dirtyWipManifest.buildVerified, false);

    // 4b. Release mode (--require-clean and --verify-web-dist) rejects dirty repo and dirty manifest fail-closed
    assert.throws(
      () => execFileSync(process.execPath, [
        emitBuildInfoScriptPath,
        '--repo', repoDir,
        '--require-clean',
        '--output', path.join(outDir, 'rejected-dirty-release.json'),
      ], {
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
      }),
      (err) => err.status !== 0,
    );

    assert.throws(
      () => execFileSync(process.execPath, [
        emitBuildInfoScriptPath,
        '--repo', repoDir,
        '--verify-web-dist', cleanWebManifestPath,
        '--output', path.join(outDir, 'rejected-dirty-tree-pkg.json'),
      ], {
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
      }),
      (err) => err.status !== 0,
    );

    // Restore clean working tree, then verify --verify-web-dist STILL rejects the dirty web manifest
    execFileSync('git', ['checkout', '--', 'app.js'], { cwd: repoDir, stdio: 'pipe' });
    assert.throws(
      () => execFileSync(process.execPath, [
        emitBuildInfoScriptPath,
        '--repo', repoDir,
        '--verify-web-dist', dirtyWipManifestPath,
        '--output', path.join(outDir, 'rejected-dirty-web-manifest-pkg.json'),
      ], {
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
      }),
      (err) => err.status !== 0,
    );

    // 4c. Backend resolver & real AuthStore HTTP server treat dirty/unverified manifest as unverified / UNKNOWN (never SYNCHRONIZED)
    const dirtyDiag = resolveDeploymentDiagnostics({
      manifestPath: dirtyWipManifestPath,
      env: {},
    });
    assert.equal(dirtyDiag.dirty, true);
    assert.equal(dirtyDiag.buildVerified, false);
    assert.equal(dirtyDiag.buildId, 'unknown');
    assert.equal(dirtyDiag.assetId, 'unknown');
    assert.equal(dirtyDiag.commit, 'unknown');
    assert.equal(dirtyDiag.sourceInfo.dirty, true);
    assert.equal(dirtyDiag.sourceInfo.sourceMatchesDeployed, false);

    const dirtyAuth = await startRealAuthenticatedCoreServer(subT, {
      deploymentDiagnosticsOptions: {
        manifestPath: dirtyWipManifestPath,
        env: {},
      },
      publicOrigin: origin,
    });

    const dirtyHttpRes = await fetch(
      `${dirtyAuth.baseUrl}/api/system/diagnostics/version?frontendVersion=${API_VERSION}&frontendSchemaVersion=${SCHEMA_VERSION}&frontendBuildId=${dirtyWipManifest.buildId}&frontendAssetId=${dirtyWipManifest.assetId}`,
      {
        headers: {
          origin,
          cookie: dirtyAuth.cookieHeader,
        },
      },
    );
    assert.equal(dirtyHttpRes.status, 200);
    const dirtyHttpJson = await dirtyHttpRes.json();
    assert.equal(dirtyHttpJson.data.buildVerified, false);
    assert.equal(dirtyHttpJson.data.dirty, true);
    assert.equal(dirtyHttpJson.data.sourceInfo.dirty, true);
    assert.equal(dirtyHttpJson.data.sourceInfo.sourceMatchesDeployed, false);
    assert.equal(dirtyHttpJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(dirtyHttpJson.data.comparison.compatible, false);
  });

  await t.test('T901 runtime env conflict regression: stale runtime env never overwrites immutable package build-info.json or faked SYNCHRONIZED state', async (subT) => {
    const workRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t901-env-probe-'));
    subT.after(() => rm(workRoot, { recursive: true, force: true }));

    const repoDir = path.join(workRoot, 'repo');
    const outDir = path.join(workRoot, 'out');
    execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'envprobe@yunpanel.local'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'YunPanel Env Probe'], { cwd: repoDir, stdio: 'pipe' });

    await writeFile(path.join(repoDir, 'server.js'), 'export const release = 1;\n', 'utf8');
    execFileSync('git', ['add', 'server.js'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'verified package commit'], { cwd: repoDir, stdio: 'pipe' });
    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    const packageManifestPath = path.join(outDir, 'build-info.json');
    execFileSync(process.execPath, [
      emitBuildInfoScriptPath,
      '--repo', repoDir,
      '--require-clean',
      '--package-version', '0.3.0-2026111302',
      '--output', packageManifestPath,
    ], {
      env: { PATH: process.env.PATH },
      stdio: 'pipe',
    });
    const pkgManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'));
    assert.equal(pkgManifest.commit, headCommit);
    assert.equal(pkgManifest.buildVerified, true);
    assert.equal(pkgManifest.dirty, false);

    // Exact t901-runtime-env-probe-01 scenario: stale env + matching stale YUNPANEL_SOURCE_COMMIT
    const staleCommit = '1111111111111111111111111111111111111111';
    const staleEnv = {
      YUNPANEL_BUILD_ID: 'build-stale-20261001',
      YUNPANEL_ASSET_ID: 'assets-stale-20261001',
      YUNPANEL_COMMIT_HASH: staleCommit,
      YUNPANEL_BUILD_TIME: '2026-10-01T03:00:00.000Z',
      YUNPANEL_SOURCE_COMMIT: staleCommit,
    };

    const diag = resolveDeploymentDiagnostics({
      manifestPath: packageManifestPath,
      env: staleEnv,
    });

    // Authoritative package manifest fields MUST be retained (never overwritten by stale env)
    assert.equal(diag.commit, headCommit);
    assert.equal(diag.buildId, pkgManifest.buildId);
    assert.equal(diag.assetId, pkgManifest.assetId);
    assert.equal(diag.buildTime, pkgManifest.buildTime);

    // Conflict MUST mark provenance unverified and block synchronization
    assert.equal(diag.metadataConflict, true);
    assert.equal(diag.buildVerified, false);
    assert.equal(diag.evidence.verified, false);
    assert.equal(diag.evidence.diverged, true);
    assert.equal(diag.evidence.status, 'diverged');
    assert.equal(diag.sourceInfo.sourceMatchesDeployed, false);
    assert.ok(diag.evidence.warnings.some((w) => w.includes('conflicts with immutable package build-info.json')));
    assert.ok(diag.sourceInfo.warning && diag.sourceInfo.warning.includes('conflicts with immutable package build-info.json'));
    assert.doesNotMatch(diag.evidence.summary, /RUNTIME SYNCHRONIZED/);

    // Same-commit YUNPANEL_SOURCE_COMMIT with conflicting stale YUNPANEL_BUILD_ID -> status: 'unverified' (never 'synchronized')
    const sameSourceStaleBuildDiag = resolveDeploymentDiagnostics({
      manifestPath: packageManifestPath,
      env: {
        YUNPANEL_BUILD_ID: 'build-stale-20261001',
        YUNPANEL_SOURCE_COMMIT: headCommit,
      },
    });
    assert.equal(sameSourceStaleBuildDiag.commit, headCommit);
    assert.equal(sameSourceStaleBuildDiag.buildId, pkgManifest.buildId);
    assert.equal(sameSourceStaleBuildDiag.metadataConflict, true);
    assert.equal(sameSourceStaleBuildDiag.buildVerified, false);
    assert.equal(sameSourceStaleBuildDiag.evidence.verified, false);
    assert.equal(sameSourceStaleBuildDiag.evidence.status, 'unverified');
    assert.equal(sameSourceStaleBuildDiag.sourceInfo.sourceMatchesDeployed, false);
    assert.doesNotMatch(sameSourceStaleBuildDiag.evidence.summary, /RUNTIME SYNCHRONIZED/);

    // Real SQLite AuthStore + session cookie + CSRF HTTP verification under stale env conflict
    const authServer = await startRealAuthenticatedCoreServer(subT, {
      deploymentDiagnosticsOptions: {
        manifestPath: packageManifestPath,
        env: staleEnv,
      },
      publicOrigin: origin,
    });

    const query = new URLSearchParams({
      frontendVersion: API_VERSION,
      frontendSchemaVersion: String(SCHEMA_VERSION),
      frontendBuildId: pkgManifest.buildId,
      frontendAssetId: pkgManifest.assetId,
    });
    const getRes = await fetch(`${authServer.baseUrl}/api/system/diagnostics/version?${query}`, {
      headers: {
        origin,
        cookie: authServer.cookieHeader,
      },
    });
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.equal(getJson.data.commit, headCommit);
    assert.equal(getJson.data.buildId, pkgManifest.buildId);
    assert.equal(getJson.data.metadataConflict, true);
    assert.equal(getJson.data.buildVerified, false);
    assert.equal(getJson.data.sourceInfo.sourceMatchesDeployed, false);
    assert.equal(getJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(getJson.data.comparison.compatible, false);

    // POST without CSRF token is rejected 403
    const noCsrfRes = await fetch(`${authServer.baseUrl}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: {
        origin,
        cookie: authServer.cookieHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        buildId: pkgManifest.buildId,
        assetId: pkgManifest.assetId,
      }),
    });
    assert.equal(noCsrfRes.status, 403);

    // POST with valid CSRF token returns UNKNOWN due to backend metadataConflict
    const compareRes = await fetch(`${authServer.baseUrl}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: {
        origin,
        cookie: authServer.cookieHeader,
        'x-csrf-token': authServer.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        buildId: pkgManifest.buildId,
        assetId: pkgManifest.assetId,
      }),
    });
    assert.equal(compareRes.status, 200);
    const compareJson = await compareRes.json();
    assert.equal(compareJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(compareJson.data.comparison.compatible, false);
  });

  await t.test('real emit-build-info.mjs manifest drives createAuthenticatedApi + createCoreApp HTTP endpoints cleanly', async (subT) => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-http-git-'));
    subT.after(() => rm(repoDir, { recursive: true, force: true }));

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@yunpanel.local'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'YunPanel Test'], { cwd: repoDir, stdio: 'pipe' });
    await writeFile(path.join(repoDir, 'app.js'), 'export const ok = true;\n', 'utf8');
    execFileSync('git', ['add', 'app.js'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'release commit'], { cwd: repoDir, stdio: 'pipe' });

    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-http-artifacts-'));
    subT.after(() => rm(artifactsDir, { recursive: true, force: true }));
    const webDistManifestPath = path.join(artifactsDir, 'web-dist', 'build-info.json');
    const packageManifestPath = path.join(artifactsDir, 'usr', 'lib', 'yunpanel', 'build-info.json');

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
      '--require-clean',
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

    const authServer = await startRealAuthenticatedCoreServer(subT, {
      deploymentDiagnosticsOptions: {
        manifestPath: packageManifestPath,
        env: {},
      },
      publicOrigin: origin,
    });
    const authGetHeaders = {
      origin,
      cookie: authServer.cookieHeader,
    };
    const authPostHeaders = {
      origin,
      cookie: authServer.cookieHeader,
      'x-csrf-token': authServer.csrfToken,
      'content-type': 'application/json',
    };

    // 1. Matching verified frontend (with commit, buildTime, dirty=false, buildVerified=true) -> SYNCHRONIZED
    const syncQuery = new URLSearchParams({
      frontendVersion: API_VERSION,
      frontendSchemaVersion: String(SCHEMA_VERSION),
      frontendBuildId: webManifest.buildId,
      frontendAssetId: webManifest.assetId,
      frontendCommit: webManifest.commit,
      frontendBuildTime: webManifest.buildTime,
      frontendDirty: 'false',
      frontendBuildVerified: 'true',
    });
    const syncRes = await fetch(`${authServer.baseUrl}/api/system/diagnostics/version?${syncQuery}`, {
      headers: authGetHeaders,
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

    // 1b. Matching buildId/assetId WITHOUT commit/buildTime/buildVerified -> UNKNOWN (never SYNCHRONIZED)
    const idOnlyQuery = new URLSearchParams({
      frontendVersion: API_VERSION,
      frontendSchemaVersion: String(SCHEMA_VERSION),
      frontendBuildId: webManifest.buildId,
      frontendAssetId: webManifest.assetId,
    });
    const idOnlyRes = await fetch(`${authServer.baseUrl}/api/system/diagnostics/version?${idOnlyQuery}`, {
      headers: authGetHeaders,
    });
    assert.equal(idOnlyRes.status, 200);
    const idOnlyJson = await idOnlyRes.json();
    assert.equal(idOnlyJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(idOnlyJson.data.comparison.compatible, false);

    // 2. Missing / unknown frontend buildId & assetId -> UNKNOWN (never SYNCHRONIZED)
    const unknownRes = await fetch(
      `${authServer.baseUrl}/api/system/diagnostics/version?frontendVersion=${API_VERSION}&frontendSchemaVersion=${SCHEMA_VERSION}&frontendBuildId=unknown&frontendAssetId=unknown`,
      { headers: authGetHeaders },
    );
    assert.equal(unknownRes.status, 200);
    const unknownJson = await unknownRes.json();
    assert.equal(unknownJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(unknownJson.data.comparison.compatible, false);

    // 3. Stale frontend assetId -> STALE_CACHE
    const staleRes = await fetch(
      `${authServer.baseUrl}/api/system/diagnostics/version?frontendVersion=${API_VERSION}&frontendAssetId=assets-old-cache`,
      { headers: authGetHeaders },
    );
    assert.equal(staleRes.status, 200);
    const staleJson = await staleRes.json();
    assert.equal(staleJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(staleJson.data.comparison.staleCache, true);

    // 4. POST /api/system/diagnostics/version/compare with verified vs unknown vs stale
    const postSyncRes = await fetch(`${authServer.baseUrl}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: authPostHeaders,
      body: JSON.stringify({
        version: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        assetId: webManifest.assetId,
        buildId: webManifest.buildId,
        commit: webManifest.commit,
        buildTime: webManifest.buildTime,
        dirty: false,
        buildVerified: true,
      }),
    });
    assert.equal(postSyncRes.status, 200);
    assert.equal((await postSyncRes.json()).data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);

    const postUnknownRes = await fetch(`${authServer.baseUrl}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: authPostHeaders,
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
    const aliasRes = await fetch(`${authServer.baseUrl}/api/diagnostics/deployment`, {
      headers: authGetHeaders,
    });
    assert.equal(aliasRes.status, 200);
    assert.equal((await aliasRes.json()).data.commit, headCommit);
  });

  await t.test('T901 probe-03 regressions: partial unverified backend returns UNKNOWN and reused buildId/assetId across distinct commits returns STALE_CACHE over real AuthStore HTTP', async (subT) => {
    const workRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t901-probe03-'));
    subT.after(() => rm(workRoot, { recursive: true, force: true }));

    const repoDir = path.join(workRoot, 'repo');
    const outDir = path.join(workRoot, 'out');
    execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'probe03@yunpanel.local'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'YunPanel Probe 03'], { cwd: repoDir, stdio: 'pipe' });

    const sourceFile = path.join(repoDir, 'module.js');
    await writeFile(sourceFile, 'export const rev = "A";\n', 'utf8');
    execFileSync('git', ['add', 'module.js'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'clean commit A'], { cwd: repoDir, stdio: 'pipe' });
    const commitA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    const manifestAPath = path.join(outDir, 'manifest-a.json');
    execFileSync(process.execPath, [
      emitBuildInfoScriptPath,
      '--repo', repoDir,
      '--require-clean',
      '--output', manifestAPath,
    ], {
      env: {
        PATH: process.env.PATH,
        YUNPANEL_BUILD_ID: 'build-reused-operator-id',
        YUNPANEL_ASSET_ID: 'assets-reused-operator-id',
        YUNPANEL_BUILD_TIME: '2026-11-13T00:00:00.000Z',
      },
      stdio: 'pipe',
    });
    const manifestA = JSON.parse(await readFile(manifestAPath, 'utf8'));

    await writeFile(sourceFile, 'export const rev = "B";\n', 'utf8');
    execFileSync('git', ['add', 'module.js'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'clean commit B'], { cwd: repoDir, stdio: 'pipe' });
    const commitB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    assert.notEqual(commitA, commitB);

    const manifestBPath = path.join(outDir, 'manifest-b.json');
    execFileSync(process.execPath, [
      emitBuildInfoScriptPath,
      '--repo', repoDir,
      '--require-clean',
      '--output', manifestBPath,
    ], {
      env: {
        PATH: process.env.PATH,
        YUNPANEL_BUILD_ID: 'build-reused-operator-id',
        YUNPANEL_ASSET_ID: 'assets-reused-operator-id',
        YUNPANEL_BUILD_TIME: '2026-11-13T01:00:00.000Z',
      },
      stdio: 'pipe',
    });
    const manifestB = JSON.parse(await readFile(manifestBPath, 'utf8'));
    assert.equal(manifestA.buildId, manifestB.buildId);
    assert.equal(manifestA.assetId, manifestB.assetId);
    assert.equal(manifestA.commit, commitA);
    assert.equal(manifestB.commit, commitB);

    // 1. Açık 1: Partial backend (manifestPath: null, valid buildId/assetId/commitB, missing buildTime -> buildVerified: false)
    const partialServer = await startRealAuthenticatedCoreServer(subT, {
      deploymentDiagnosticsOptions: {
        manifestPath: null,
        env: {
          YUNPANEL_BUILD_ID: 'build-reused-operator-id',
          YUNPANEL_ASSET_ID: 'assets-reused-operator-id',
          YUNPANEL_COMMIT_HASH: commitB,
        },
      },
      publicOrigin: origin,
    });

    const partialQuery = new URLSearchParams({
      frontendVersion: API_VERSION,
      frontendSchemaVersion: String(SCHEMA_VERSION),
      frontendBuildId: manifestB.buildId,
      frontendAssetId: manifestB.assetId,
      frontendCommit: manifestB.commit,
      frontendBuildTime: manifestB.buildTime,
      frontendDirty: 'false',
      frontendBuildVerified: 'true',
    });
    const partialGetRes = await fetch(`${partialServer.baseUrl}/api/system/diagnostics/version?${partialQuery}`, {
      headers: {
        origin,
        cookie: partialServer.cookieHeader,
      },
    });
    assert.equal(partialGetRes.status, 200);
    const partialGetJson = await partialGetRes.json();
    assert.equal(partialGetJson.data.buildVerified, false);
    assert.equal(partialGetJson.data.buildTime, null);
    assert.equal(partialGetJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(partialGetJson.data.comparison.compatible, false);

    const partialPostRes = await fetch(`${partialServer.baseUrl}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: {
        origin,
        cookie: partialServer.cookieHeader,
        'x-csrf-token': partialServer.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(manifestB),
    });
    assert.equal(partialPostRes.status, 200);
    const partialPostJson = await partialPostRes.json();
    assert.equal(partialPostJson.data.buildVerified, false);
    assert.equal(partialPostJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
    assert.equal(partialPostJson.data.comparison.compatible, false);

    // 2. Açık 2: Verified backendB (commitB, 01:00Z) vs verified frontendA (commitA, 00:00Z) with identical reused buildId/assetId
    const backendBServer = await startRealAuthenticatedCoreServer(subT, {
      deploymentDiagnosticsOptions: {
        manifestPath: manifestBPath,
        env: {
          YUNPANEL_SOURCE_COMMIT: commitB,
        },
      },
      publicOrigin: origin,
    });

    const reusedQueryA = new URLSearchParams({
      frontendVersion: manifestA.version,
      frontendSchemaVersion: String(manifestA.schemaVersion),
      frontendBuildId: manifestA.buildId,
      frontendAssetId: manifestA.assetId,
      frontendCommit: manifestA.commit,
      frontendBuildTime: manifestA.buildTime,
      frontendDirty: 'false',
      frontendBuildVerified: 'true',
    });
    const reusedGetRes = await fetch(`${backendBServer.baseUrl}/api/system/diagnostics/version?${reusedQueryA}`, {
      headers: {
        origin,
        cookie: backendBServer.cookieHeader,
      },
    });
    assert.equal(reusedGetRes.status, 200);
    const reusedGetJson = await reusedGetRes.json();
    assert.equal(reusedGetJson.data.buildVerified, true);
    assert.equal(reusedGetJson.data.sourceInfo.sourceMatchesDeployed, true);
    assert.equal(reusedGetJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(reusedGetJson.data.comparison.compatible, false);
    assert.equal(reusedGetJson.data.comparison.staleCache, true);

    const reusedPostRes = await fetch(`${backendBServer.baseUrl}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: {
        origin,
        cookie: backendBServer.cookieHeader,
        'x-csrf-token': backendBServer.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(manifestA),
    });
    assert.equal(reusedPostRes.status, 200);
    const reusedPostJson = await reusedPostRes.json();
    assert.equal(reusedPostJson.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
    assert.equal(reusedPostJson.data.comparison.compatible, false);
    assert.equal(reusedPostJson.data.comparison.staleCache, true);
  });

  await t.test('createCoreApp without build metadata returns unknown build identity and UNKNOWN comparison through real AuthStore', async (subT) => {
    const authServer = await startRealAuthenticatedCoreServer(subT, {
      deploymentDiagnosticsOptions: {
        manifestPath: null,
        env: {},
      },
      publicOrigin: origin,
    });

    const res = await fetch(
      `${authServer.baseUrl}/api/system/diagnostics/version?frontendVersion=${API_VERSION}&frontendSchemaVersion=${SCHEMA_VERSION}&frontendBuildId=unknown&frontendAssetId=unknown`,
      {
        headers: {
          origin,
          cookie: authServer.cookieHeader,
        },
      },
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.commit, 'unknown');
    assert.equal(json.data.buildId, 'unknown');
    assert.equal(json.data.assetId, 'unknown');
    assert.equal(json.data.buildVerified, false);
    assert.equal(json.data.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);

    const postRes = await fetch(`${authServer.baseUrl}/api/system/diagnostics/version/compare`, {
      method: 'POST',
      headers: {
        origin,
        cookie: authServer.cookieHeader,
        'x-csrf-token': authServer.csrfToken,
        'content-type': 'application/json',
      },
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

  await t.test('build-deb.sh emits verified /usr/lib/yunpanel/build-info.json checked against clean tree and web dist build-info.json', async () => {
    const buildScript = await readFile(buildDebScriptPath, 'utf8');
    assert.match(buildScript, /scripts\/emit-build-info\.mjs/);
    assert.match(buildScript, /--require-clean/);
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
