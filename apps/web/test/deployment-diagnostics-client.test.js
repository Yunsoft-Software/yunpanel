import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAuthStore } from '../../api/src/auth-store.js';
import { createAuthenticatedApi } from '../../api/src/auth-http.js';
import {
  API_VERSION,
  SCHEMA_VERSION,
  DEPLOYMENT_COMPARISON_STATUSES,
  createApp as createCoreApp,
  resolveDeploymentDiagnostics,
} from '../../api/src/core-app.js';
import {
  FRONTEND_VERSION,
  FRONTEND_SCHEMA_VERSION,
  FRONTEND_BUILD_ID,
  FRONTEND_ASSET_ID,
  FRONTEND_COMMIT,
  FRONTEND_BUILD_TIME,
  FRONTEND_BUILD_VERIFIED,
  resolveFrontendBuildIdentity,
  fetchDeploymentDiagnostics,
  compareDeploymentWithServer,
} from '../src/workspace/deployment-diagnostics-client.js';

const { default: SystemSettingsPanels } = await import('../src/workspace/SystemSettingsPanels.jsx');

const emitBuildInfoScriptPath = fileURLToPath(new URL('../../../scripts/emit-build-info.mjs', import.meta.url));
const PUBLIC_ORIGIN = 'https://panel.example.test';

async function startRealAuthenticatedDiagnosticsServer(t, deploymentDiagnosticsOptions) {
  const authDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-web-auth-'));
  const store = createAuthStore({
    filePath: path.join(authDir, 'auth.sqlite'),
    masterKey: 'a'.repeat(64),
  });
  t.after(async () => {
    store.close();
    await rm(authDir, { recursive: true, force: true });
  });

  const listener = createAuthenticatedApi({
    store,
    publicOrigin: PUBLIC_ORIGIN,
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
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      setupToken,
      username: 'admin',
      password: 'OwnerStrongPassword!2026',
      email: 'owner@example.test',
    }),
  });
  assert.equal(setupRes.status, 201);

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: 'admin',
      password: 'OwnerStrongPassword!2026',
    }),
  });
  assert.equal(loginRes.status, 200);
  const setCookies = loginRes.headers.getSetCookie();
  const sessionCookiePair = setCookies
    .map((entry) => entry.split(';')[0].trim())
    .find((pair) => pair.startsWith('__Host-yunpanel_session='));
  assert.ok(sessionCookiePair, 'Expected __Host-yunpanel_session cookie from /api/auth/login');

  const loginPayload = await loginRes.json();
  const csrfToken = loginPayload.data?.csrfToken;
  assert.ok(typeof csrfToken === 'string' && csrfToken.length > 10, 'Expected session csrfToken from /api/auth/login');

  return {
    baseUrl,
    cookieHeader: sessionCookiePair,
    csrfToken,
  };
}

function baseSettingsPayload(deployment) {
  return {
    panel: {
      version: API_VERSION,
      nodeVersion: process.version,
      platform: 'linux',
      arch: 'x64',
      hostname: 'panel.example.test',
      displayName: 'Test Panel',
      localServerId: 'srv-local-1',
      uptimeSeconds: 3660,
    },
    deployment,
    websiteDefaults: {
      defaultRuntime: 'node',
      defaultNodeMajor: 24,
      defaultPhpVersion: '8.3',
      defaultDocumentRootPattern: '/var/www/{domain}/public',
      defaultUmask: '0027',
      isolationUserPrefix: 'yunapp-',
    },
    dnsSsl: {
      authoritativeProvider: 'powerdns',
      acmeProvider: 'letsencrypt',
      acmeEmail: 'ssl@example.test',
      autoRenewDaysBeforeExpiry: 30,
      customCertificatesRoot: '/var/lib/yunpanel/certificates',
    },
    mail: {
      engine: 'Postfix + Dovecot',
      authStorage: 'sqlite',
      authDatabasePath: '/var/lib/yunpanel/mail/virtual.sqlite',
      maildirRoot: '/var/mail/vhosts',
      webmail: {
        engine: 'roundcube',
        deployment: 'shared',
        subdomainPattern: 'webmail.{domain}',
      },
    },
    database: {
      engine: 'mariadb',
      client: { engine: 'phpMyAdmin', deployment: 'gateway', access: 'signon' },
    },
    cache: {
      redis: {
        isolation: 'acl',
        userPattern: 'site_{id}',
        keyPrefix: 'site:{id}:*',
        dangerousCommandsRestricted: true,
      },
      memcached: {
        isolation: 'prefix',
        keyPrefix: 'site:{id}:',
      },
    },
    backup: {
      engine: 'restic',
      remoteEngine: 'rclone',
      localBackupRoot: '/var/backups/yunpanel',
      retentionDefaults: {
        retentionDaily: 7,
        retentionWeekly: 4,
        retentionMonthly: 6,
      },
    },
    security: {
      authHash: 'argon2id',
      mfa: 'totp',
      sftp: {
        engine: 'internal-sftp',
        chrootPattern: '/var/lib/yunpanel/homes/{user}',
        authorizedKeysRoot: '/etc/ssh/authorized_keys_yunpanel',
      },
      firewall: {
        engine: 'nftables',
        bouncer: 'crowdsec',
      },
    },
    observability: {
      metrics: { engine: 'Netdata', mode: 'gateway' },
      logs: { engine: 'GoAccess', mode: 'per-site' },
    },
  };
}

test('default uninjected frontend build identity is unknown and unverified (never hardcoded 20261001 fallback)', () => {
  assert.equal(FRONTEND_VERSION, '0.3.0');
  assert.equal(FRONTEND_SCHEMA_VERSION, 3);
  assert.equal(FRONTEND_BUILD_ID, 'unknown');
  assert.equal(FRONTEND_ASSET_ID, 'unknown');
  assert.equal(FRONTEND_COMMIT, 'unknown');
  assert.equal(FRONTEND_BUILD_TIME, null);
  assert.equal(FRONTEND_BUILD_VERIFIED, false);

  assert.notEqual(FRONTEND_BUILD_ID, 'build-web-20261001-0300');
  assert.notEqual(FRONTEND_ASSET_ID, 'assets-web-20261001-0300');
});

test('resolveFrontendBuildIdentity validates build-info manifests strictly', async (t) => {
  for (const invalid of [
    null,
    undefined,
    '',
    '{bad-json',
    {},
    { buildId: 'unknown', assetId: 'assets-1', commit: 'a1b2c3d4', buildTime: '2026-11-12T00:00:00Z' },
    { buildId: 'build-1', assetId: 'unknown', commit: 'a1b2c3d4', buildTime: '2026-11-12T00:00:00Z' },
    { buildId: 'build-1', assetId: 'assets-1', commit: 'not-hex!!', buildTime: '2026-11-12T00:00:00Z' },
    { buildId: 'build-1', assetId: 'assets-1', commit: 'a1b2c3d4', buildTime: 'not-a-date', buildVerified: true },
    { buildId: 'build-1', assetId: 'assets-1', commit: 'a1b2c3d4', buildTime: '2026-11-12T00:00:00Z' },
    { buildId: 'build-1', assetId: 'assets-1', commit: 'a1b2c3d4', buildTime: '2026-11-12T00:00:00Z', buildVerified: false },
    { buildId: 'build-1', assetId: 'assets-1', commit: 'a1b2c3d4', buildTime: '2026-11-12T00:00:00Z', dirty: true, buildVerified: true },
  ]) {
    const resolved = resolveFrontendBuildIdentity(invalid);
    assert.equal(resolved.buildId, 'unknown');
    assert.equal(resolved.assetId, 'unknown');
    assert.equal(resolved.commit, 'unknown');
    assert.equal(resolved.buildTime, null);
    assert.equal(resolved.buildVerified, false);
  }

  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-web-diag-'));
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-web-diag-out-'));
  t.after(() => rm(repoDir, { recursive: true, force: true }));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'web@yunpanel.local'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'YunPanel Web'], { cwd: repoDir, stdio: 'pipe' });
  await writeFile(path.join(repoDir, 'index.js'), 'console.log(1);\n', 'utf8');
  execFileSync('git', ['add', 'index.js'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'web build commit'], { cwd: repoDir, stdio: 'pipe' });
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

  const manifestPath = path.join(outDir, 'build-info.json');
  execFileSync(process.execPath, [
    emitBuildInfoScriptPath,
    '--repo', repoDir,
    '--output', manifestPath,
  ], {
    env: {
      PATH: process.env.PATH,
      YUNPANEL_BUILD_TIME: '2026-11-12T23:00:00.000Z',
    },
    stdio: 'pipe',
  });

  const rawManifest = await readFile(manifestPath, 'utf8');
  const verified = resolveFrontendBuildIdentity(rawManifest);
  assert.equal(verified.buildVerified, true);
  assert.equal(verified.dirty, false);
  assert.equal(verified.commit, headCommit);
  assert.equal(verified.buildTime, '2026-11-12T23:00:00.000Z');
  assert.notEqual(verified.buildId, 'unknown');
  assert.notEqual(verified.assetId, 'unknown');

  // Dirty tracked file modification must emit dirty: true / buildVerified: false and resolve to unknown/Doğrulanmadı
  await writeFile(path.join(repoDir, 'index.js'), 'console.log("dirty");\n', 'utf8');
  const dirtyManifestPath = path.join(outDir, 'dirty-build-info.json');
  execFileSync(process.execPath, [
    emitBuildInfoScriptPath,
    '--repo', repoDir,
    '--output', dirtyManifestPath,
  ], {
    env: { PATH: process.env.PATH },
    stdio: 'pipe',
  });
  const rawDirtyManifest = await readFile(dirtyManifestPath, 'utf8');
  const parsedDirtyManifest = JSON.parse(rawDirtyManifest);
  assert.equal(parsedDirtyManifest.dirty, true);
  assert.equal(parsedDirtyManifest.buildVerified, false);

  const resolvedDirty = resolveFrontendBuildIdentity(rawDirtyManifest);
  assert.equal(resolvedDirty.buildVerified, false);
  assert.equal(resolvedDirty.dirty, true);
  assert.equal(resolvedDirty.buildId, 'unknown');
  assert.equal(resolvedDirty.assetId, 'unknown');
  assert.equal(resolvedDirty.commit, 'unknown');

  const dirtyBackendDeployment = resolveDeploymentDiagnostics({
    manifestPath: dirtyManifestPath,
    env: {},
  });
  const dirtyUiHtml = renderToStaticMarkup(createElement(SystemSettingsPanels, {
    diagnostics: true,
    initialData: baseSettingsPayload(dirtyBackendDeployment),
    frontendIdentity: parsedDirtyManifest,
  }));
  assert.match(
    dirtyUiHtml,
    /Çalışma zamanı senkronizasyonu<\/dt><dd><span class="ws-badge ws-badge-neutral"><span aria-hidden="true"><\/span>Doğrulanmadı<\/span><\/dd>/,
  );
  assert.doesNotMatch(dirtyUiHtml, />Senkronize</);
});

test('fetchDeploymentDiagnostics and compareDeploymentWithServer work through real SQLite AuthStore session + CSRF HTTP boundary', async (t) => {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-client-http-'));
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-client-http-out-'));
  t.after(() => rm(repoDir, { recursive: true, force: true }));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'web@yunpanel.local'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'YunPanel Web'], { cwd: repoDir, stdio: 'pipe' });
  await writeFile(path.join(repoDir, 'main.jsx'), 'export default 1;\n', 'utf8');
  execFileSync('git', ['add', 'main.jsx'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'client http commit'], { cwd: repoDir, stdio: 'pipe' });

  const manifestPath = path.join(outDir, 'build-info.json');
  execFileSync(process.execPath, [
    emitBuildInfoScriptPath,
    '--repo', repoDir,
    '--output', manifestPath,
  ], {
    env: { PATH: process.env.PATH },
    stdio: 'pipe',
  });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const { baseUrl, cookieHeader, csrfToken } = await startRealAuthenticatedDiagnosticsServer(t, {
    manifestPath,
    env: {},
  });

  // 0. Unauthenticated GET and CSRF-less POST are strictly rejected by createAuthenticatedApi
  await assert.rejects(
    () => fetchDeploymentDiagnostics({
      endpoint: `${baseUrl}/api/system/diagnostics/version`,
    }),
    /status 401/,
  );

  await assert.rejects(
    () => compareDeploymentWithServer({
      version: FRONTEND_VERSION,
      schemaVersion: FRONTEND_SCHEMA_VERSION,
      buildId: manifest.buildId,
      assetId: manifest.assetId,
    }, {
      endpoint: `${baseUrl}/api/system/diagnostics/version/compare`,
      headers: {
        cookie: cookieHeader,
        origin: PUBLIC_ORIGIN,
      },
    }),
    /status 403/,
  );

  const authHeaders = {
    cookie: cookieHeader,
    origin: PUBLIC_ORIGIN,
  };

  // 1. Default uninjected client sends unknown frontend identity -> comparison must be UNKNOWN
  const uninjectedDiag = await fetchDeploymentDiagnostics({
    endpoint: `${baseUrl}/api/system/diagnostics/version`,
    headers: authHeaders,
  });
  assert.equal(uninjectedDiag.commit, manifest.commit);
  assert.equal(uninjectedDiag.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
  assert.equal(uninjectedDiag.comparison.compatible, false);

  // 2. Verified matching frontend identity -> SYNCHRONIZED
  const matchingDiag = await fetchDeploymentDiagnostics({
    endpoint: `${baseUrl}/api/system/diagnostics/version`,
    frontendIdentity: manifest,
    headers: authHeaders,
  });
  assert.equal(matchingDiag.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
  assert.equal(matchingDiag.comparison.compatible, true);

  // 3. POST compareDeploymentWithServer with real session cookie + CSRF token and stale assetId -> STALE_CACHE
  const comparedStale = await compareDeploymentWithServer({
    version: FRONTEND_VERSION,
    schemaVersion: FRONTEND_SCHEMA_VERSION,
    buildId: manifest.buildId,
    assetId: 'assets-stale-cached-bundle',
  }, {
    endpoint: `${baseUrl}/api/system/diagnostics/version/compare`,
    csrfToken,
    headers: authHeaders,
  });
  assert.equal(comparedStale.comparison.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
  assert.equal(comparedStale.comparison.staleCache, true);
});

test('SystemSettingsPanels renders Doğrulanmadı, Senkronize, and Farklılaşmış states accurately', () => {
  // 1. Unverified backend & unverified frontend -> Doğrulanmadı (never Senkronize)
  const unverifiedDeployment = resolveDeploymentDiagnostics({ env: {} });
  const unverifiedHtml = renderToStaticMarkup(createElement(SystemSettingsPanels, {
    diagnostics: true,
    initialData: baseSettingsPayload(unverifiedDeployment),
  }));

  assert.match(unverifiedHtml, /Backend derleme kimliği<\/dt><dd>Doğrulanmadı<\/dd>/);
  assert.match(unverifiedHtml, /Backend commit<\/dt><dd>Doğrulanmadı<\/dd>/);
  assert.match(unverifiedHtml, /Frontend derleme kimliği<\/dt><dd>Doğrulanmadı<\/dd>/);
  assert.match(unverifiedHtml, /Frontend varlık kimliği<\/dt><dd>Doğrulanmadı<\/dd>/);
  assert.match(
    unverifiedHtml,
    /Çalışma zamanı senkronizasyonu<\/dt><dd><span class="ws-badge ws-badge-neutral"><span aria-hidden="true"><\/span>Doğrulanmadı<\/span><\/dd>/,
  );
  assert.doesNotMatch(unverifiedHtml, />Senkronize</);
  assert.doesNotMatch(unverifiedHtml, /b3f505cf14c341d58d472ea3b8916a31|build-20261001-0300|build-web-20261001-0300/);

  // 2. Verified package build without sourceCommit -> source equality unproven -> Doğrulanmadı
  const packageOnlyDeployment = resolveDeploymentDiagnostics({
    buildId: 'build-pkg-01',
    assetId: 'assets-pkg-01',
    commit: 'abcdef1234567890',
    buildTime: '2026-11-12T20:00:00.000Z',
    env: {},
  });
  const packageOnlyHtml = renderToStaticMarkup(createElement(SystemSettingsPanels, {
    diagnostics: true,
    initialData: baseSettingsPayload(packageOnlyDeployment),
    frontendIdentity: {
      buildId: 'build-pkg-01',
      assetId: 'assets-pkg-01',
      commit: 'abcdef1234567890',
      buildTime: '2026-11-12T20:00:00.000Z',
      buildVerified: true,
    },
  }));
  assert.match(packageOnlyHtml, /Backend derleme kimliği<\/dt><dd>build-pkg-01<\/dd>/);
  assert.match(packageOnlyHtml, /Backend commit<\/dt><dd>abcdef1234567890<\/dd>/);
  assert.match(
    packageOnlyHtml,
    /Çalışma zamanı senkronizasyonu<\/dt><dd><span class="ws-badge ws-badge-neutral"><span aria-hidden="true"><\/span>Doğrulanmadı<\/span><\/dd>/,
  );

  // 3. Fully verified backend + sourceCommit + matching verified frontend -> Senkronize
  const synchronizedDeployment = resolveDeploymentDiagnostics({
    buildId: 'build-pkg-02',
    assetId: 'assets-pkg-02',
    commit: 'abcdef1234567890',
    sourceCommit: 'abcdef1234567890',
    buildTime: '2026-11-12T21:00:00.000Z',
    env: {},
  });
  const synchronizedHtml = renderToStaticMarkup(createElement(SystemSettingsPanels, {
    diagnostics: true,
    initialData: baseSettingsPayload(synchronizedDeployment),
    frontendIdentity: {
      buildId: 'build-pkg-02',
      assetId: 'assets-pkg-02',
      commit: 'abcdef1234567890',
      buildTime: '2026-11-12T21:00:00.000Z',
      buildVerified: true,
    },
  }));
  assert.match(
    synchronizedHtml,
    /Çalışma zamanı senkronizasyonu<\/dt><dd><span class="ws-badge ws-badge-good"><span aria-hidden="true"><\/span>Senkronize<\/span><\/dd>/,
  );

  // 4. Verified backend & verified frontend with mismatched assetId -> Farklılaşmış
  const mismatchedFrontendHtml = renderToStaticMarkup(createElement(SystemSettingsPanels, {
    diagnostics: true,
    initialData: baseSettingsPayload(synchronizedDeployment),
    frontendIdentity: {
      buildId: 'build-pkg-02',
      assetId: 'assets-stale-99',
      commit: 'abcdef1234567890',
      buildTime: '2026-11-12T21:00:00.000Z',
      buildVerified: true,
    },
  }));
  assert.match(
    mismatchedFrontendHtml,
    /Çalışma zamanı senkronizasyonu<\/dt><dd><span class="ws-badge ws-badge-warn"><span aria-hidden="true"><\/span>Farklılaşmış<\/span><\/dd>/,
  );

  // 5. Explicit source divergence (dirty tree or commit mismatch) -> Farklılaşmış
  const divergedDeployment = resolveDeploymentDiagnostics({
    buildId: 'build-pkg-02',
    assetId: 'assets-pkg-02',
    commit: 'abcdef1234567890',
    sourceCommit: '9999999999999999',
    buildTime: '2026-11-12T21:00:00.000Z',
    env: {},
  });
  const divergedHtml = renderToStaticMarkup(createElement(SystemSettingsPanels, {
    diagnostics: true,
    initialData: baseSettingsPayload(divergedDeployment),
  }));
  assert.match(
    divergedHtml,
    /Çalışma zamanı senkronizasyonu<\/dt><dd><span class="ws-badge ws-badge-warn"><span aria-hidden="true"><\/span>Farklılaşmış<\/span><\/dd>/,
  );
});
