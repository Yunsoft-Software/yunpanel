import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import {
  createWebsitePhpToolsService,
  WebsitePhpToolsServiceError,
} from '../src/website-php-tools-service.js';
import { mountWebsitePhpToolsRoutes } from '../src/website-php-tools-http.js';
import { createLocalWebsitePhpToolOperation } from '../src/local-website-php-tool-operation.js';
import { websitePhpToolActionPreview } from '../src/website-php-tool-action.js';

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const APP_ID = '22222222-2222-4222-8222-222222222222';
const SERVER_ID = '33333333-3333-4333-8333-333333333333';
const UNIX_USER = 'yunapp-123456789abc';

function createMockRegistries({
  website = {
    id: WEBSITE_ID,
    applicationId: APP_ID,
    serverId: SERVER_ID,
    unixUser: UNIX_USER,
    runtimeType: 'php',
    revision: 3,
  },
  application = {
    id: APP_ID,
    serverId: SERVER_ID,
    unixUser: UNIX_USER,
    type: 'php',
  },
} = {}) {
  return {
    websiteRegistry: {
      getWebsite: async (id) => (id === WEBSITE_ID ? website : null),
    },
    applicationRegistry: {
      getApplication: async (id) => (id === APP_ID ? application : null),
    },
  };
}

test('validatePhpConfig validates supported PHP versions and resource limits', () => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: {},
    lstatFn: async () => ({ isDirectory: () => true, isFile: () => false }),
  });

  // Valid configurations
  const valid1 = service.validatePhpConfig({ phpVersion: '8.4', maxChildren: 16, memoryLimitMb: 512, maxExecutionSeconds: 120 });
  assert.deepEqual(valid1, { phpVersion: '8.4', maxChildren: 16, memoryLimitMb: 512, maxExecutionSeconds: 120 });

  const valid2 = service.validatePhpConfig({ phpVersion: '8.1' });
  assert.deepEqual(valid2, { phpVersion: '8.1' });

  // Unsupported PHP versions fail closed
  assert.throws(
    () => service.validatePhpConfig({ phpVersion: '7.4' }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_fpm_version_unsupported' && err.status === 400,
  );
  assert.throws(
    () => service.validatePhpConfig({ phpVersion: '8.5' }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_fpm_version_unsupported' && err.status === 400,
  );
  assert.throws(
    () => service.validatePhpConfig({ phpVersion: 8.3 }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_fpm_version_unsupported' && err.status === 400,
  );

  // Resource limits out of range fail closed
  assert.throws(
    () => service.validatePhpConfig({ maxChildren: 0 }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_fpm_limit_invalid' && err.status === 400,
  );
  assert.throws(
    () => service.validatePhpConfig({ maxChildren: 65 }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_fpm_limit_invalid' && err.status === 400,
  );
  assert.throws(
    () => service.validatePhpConfig({ memoryLimitMb: 32 }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_fpm_limit_invalid' && err.status === 400,
  );
  assert.throws(
    () => service.validatePhpConfig({ memoryLimitMb: 4096 }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_fpm_limit_invalid' && err.status === 400,
  );
  assert.throws(
    () => service.validatePhpConfig({ maxExecutionSeconds: 2 }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_fpm_limit_invalid' && err.status === 400,
  );
  assert.throws(
    () => service.validatePhpConfig({ maxExecutionSeconds: 1200 }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_fpm_limit_invalid' && err.status === 400,
  );

  // Unrecognized fields fail closed
  assert.throws(
    () => service.validatePhpConfig({ unknownKey: 'val' }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_config_invalid' && err.status === 400,
  );
});

test('getPhpFpmConfig returns site-scoped PHP version and FPM pool layout', async () => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: {},
    lstatFn: async () => ({ isDirectory: () => true, isFile: () => false }),
  });

  const config = await service.getPhpFpmConfig(WEBSITE_ID);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.websiteId, WEBSITE_ID);
  assert.equal(config.applicationId, APP_ID);
  assert.equal(config.unixUser, UNIX_USER);
  assert.equal(config.phpVersion, '8.3');
  assert.deepEqual(config.supportedPhpVersions, ['8.1', '8.2', '8.3', '8.4']);
  assert.equal(config.fpm.poolName, `yunpanel-${UNIX_USER}`);
  assert.equal(config.fpm.poolPath, `/etc/php/8.3/fpm/pool.d/yunpanel-${UNIX_USER}.conf`);
  assert.equal(config.fpm.socketPath, `/run/php/yunpanel-${UNIX_USER}.sock`);
  assert.equal(config.fpm.serviceUnit, 'php8.3-fpm.service');
  assert.equal(config.fpm.maxChildren, 8);
  assert.equal(config.fpm.memoryLimitMb, 256);
  assert.equal(config.fpm.maxExecutionSeconds, 60);
  assert.equal(config.phpIni.memoryLimit, '256M');
  assert.equal(config.phpIni.maxExecutionTime, 60);
});

test('previewPhpFpmConfig generates pool preview, digest and confirmation token', async () => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: {},
    lstatFn: async () => ({ isDirectory: () => true, isFile: () => false }),
  });

  // No changes throws 409
  await assert.rejects(
    async () => service.previewPhpFpmConfig(WEBSITE_ID, {}),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_config_no_changes' && err.status === 409,
  );

  const preview = await service.previewPhpFpmConfig(WEBSITE_ID, {
    phpVersion: '8.4',
    maxChildren: 16,
    memoryLimitMb: 512,
  });

  assert.equal(preview.version, 1);
  assert.equal(preview.websiteId, WEBSITE_ID);
  assert.equal(preview.websiteRevision, 3);
  assert.equal(preview.current.phpVersion, '8.3');
  assert.equal(preview.desired.phpVersion, '8.4');
  assert.equal(preview.desired.maxChildren, 16);
  assert.equal(preview.desired.memoryLimitMb, 512);
  assert.ok(/^[a-f0-9]{64}$/.test(preview.previewDigest));
  assert.equal(preview.confirmation, `php-config:${WEBSITE_ID}:8.4:${preview.previewDigest}`);
  assert.equal(preview.poolPreview.serviceUnit, 'php8.4-fpm.service');
  assert.equal(preview.poolPreview.poolName, `yunpanel-${UNIX_USER}`);
});

test('updatePhpFpmConfig enforces explicit confirmation, revision and preview digest', async () => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  let appliedIntent = null;
  const mockFpmManager = {
    apply: async (intent) => {
      appliedIntent = intent;
      return { satisfied: true };
    },
  };

  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: {},
    phpFpmSiteManager: mockFpmManager,
    lstatFn: async () => ({ isDirectory: () => true, isFile: () => false }),
  });

  const preview = await service.previewPhpFpmConfig(WEBSITE_ID, { phpVersion: '8.2' });

  // 1. Revision mismatch throws 409
  await assert.rejects(
    async () => service.updatePhpFpmConfig(WEBSITE_ID, {
      expectedRevision: 99,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
      config: { phpVersion: '8.2' },
    }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'website_revision_conflict' && err.status === 409,
  );

  // 2. Digest mismatch throws 409
  await assert.rejects(
    async () => service.updatePhpFpmConfig(WEBSITE_ID, {
      expectedRevision: 3,
      previewDigest: 'f'.repeat(64),
      confirmation: preview.confirmation,
      config: { phpVersion: '8.2' },
    }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_config_preview_stale' && err.status === 409,
  );

  // 3. Confirmation token mismatch throws 400
  await assert.rejects(
    async () => service.updatePhpFpmConfig(WEBSITE_ID, {
      expectedRevision: 3,
      previewDigest: preview.previewDigest,
      confirmation: 'wrong-confirmation',
      config: { phpVersion: '8.2' },
    }),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'php_config_confirmation_mismatch' && err.status === 400,
  );

  // 4. Valid confirmation applies configuration
  const result = await service.updatePhpFpmConfig(WEBSITE_ID, {
    expectedRevision: 3,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    config: { phpVersion: '8.2' },
  });

  assert.equal(result.success, true);
  assert.equal(result.websiteId, WEBSITE_ID);
  assert.equal(result.applied.phpVersion, '8.2');
  assert.equal(appliedIntent.phpVersion, '8.2');
  assert.equal(appliedIntent.websiteId, WEBSITE_ID);
});

function createHttpApp({
  websitePhpToolsService,
  userRole = 'owner',
  websiteIds = [WEBSITE_ID],
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (userRole === 'owner') {
      req.auth = {
        id: '11111111-1111-4111-8111-111111111111',
        user: { id: 'owner-id', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
    } else if (['site_manager', 'reseller', 'customer'].includes(userRole)) {
      req.auth = {
        id: '22222222-2222-4222-8222-222222222222',
        user: { id: `${userRole}-id`, role: userRole, websiteIds },
        access: { mode: 'site_management', permissions: ['sites.manage'] },
        security: { managementAllowed: true },
      };
    }
    next();
  });

  mountWebsitePhpToolsRoutes(app, { websitePhpToolsService });
  return app;
}

test('HTTP GET /api/websites/:websiteId/php-tools/config enforces site-scoped tenant boundary', async (t) => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: {},
    lstatFn: async () => ({ isDirectory: () => true, isFile: () => false }),
  });

  // Owner allowed
  const ownerApp = createHttpApp({ websitePhpToolsService: service, userRole: 'owner' });
  const ownerServer = http.createServer(ownerApp).listen(0, '127.0.0.1');
  await once(ownerServer, 'listening');
  t.after(() => { ownerServer.close(); ownerServer.closeAllConnections(); });

  const ownerRes = await fetch(`http://127.0.0.1:${ownerServer.address().port}/api/websites/${WEBSITE_ID}/php-tools/config`);
  assert.equal(ownerRes.status, 200);
  const ownerBody = await ownerRes.json();
  assert.equal(ownerBody.data.phpVersion, '8.3');

  // Direct alias /config also works
  const aliasRes = await fetch(`http://127.0.0.1:${ownerServer.address().port}/api/websites/${WEBSITE_ID}/config`);
  assert.equal(aliasRes.status, 200);

  // Tenant site_manager authorized for this website
  const smApp = createHttpApp({ websitePhpToolsService: service, userRole: 'site_manager', websiteIds: [WEBSITE_ID] });
  const smServer = http.createServer(smApp).listen(0, '127.0.0.1');
  await once(smServer, 'listening');
  t.after(() => { smServer.close(); smServer.closeAllConnections(); });

  const smRes = await fetch(`http://127.0.0.1:${smServer.address().port}/api/websites/${WEBSITE_ID}/php-tools/config`);
  assert.equal(smRes.status, 200);

  // Tenant site_manager denied for foreign website (site-scoped boundary)
  const foreignRes = await fetch(`http://127.0.0.1:${smServer.address().port}/api/websites/99999999-9999-4999-8999-999999999999/php-tools/config`);
  assert.equal(foreignRes.status, 403);
  const foreignBody = await foreignRes.json();
  assert.equal(foreignBody.error.code, 'forbidden');
});

test('HTTP POST /config/preview and /config endpoints execute preview and mutation flow', async (t) => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: {},
    lstatFn: async () => ({ isDirectory: () => true, isFile: () => false }),
  });

  const app = createHttpApp({ websitePhpToolsService: service, userRole: 'owner' });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });

  const port = server.address().port;

  // 1. Invalid PHP version in preview returns 400
  const invalidPreviewRes = await fetch(`http://127.0.0.1:${port}/api/websites/${WEBSITE_ID}/php-tools/config/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phpVersion: '5.6' }),
  });
  assert.equal(invalidPreviewRes.status, 400);
  const invalidBody = await invalidPreviewRes.json();
  assert.equal(invalidBody.error.code, 'php_fpm_version_unsupported');

  // 2. Valid preview returns 200 with confirmation
  const previewRes = await fetch(`http://127.0.0.1:${port}/api/websites/${WEBSITE_ID}/config/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phpVersion: '8.1' }),
  });
  assert.equal(previewRes.status, 200);
  const previewData = (await previewRes.json()).data;
  assert.equal(previewData.desired.phpVersion, '8.1');
  assert.ok(previewData.confirmation.startsWith(`php-config:${WEBSITE_ID}:8.1:`));

  // 3. Mutate with valid confirmation returns 200
  const applyRes = await fetch(`http://127.0.0.1:${port}/api/websites/${WEBSITE_ID}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: previewData.websiteRevision,
      previewDigest: previewData.previewDigest,
      confirmation: previewData.confirmation,
      config: { phpVersion: '8.1' },
    }),
  });
  assert.equal(applyRes.status, 200);
  const applyData = (await applyRes.json()).data;
  assert.equal(applyData.success, true);
  assert.equal(applyData.applied.phpVersion, '8.1');
});

test('local PHP action fails closed if session is revoked or revision changes during execution', async () => {
  let authorizationCheckCount = 0;
  const mockAuthorizeActor = async () => {
    authorizationCheckCount++;
    // Fails on post-execution check (call 2)
    return authorizationCheckCount === 1 ? { sessionId: 'sess-1', userId: 'user-1', role: 'site_manager' } : null;
  };

  const preview = websitePhpToolActionPreview({
    websiteId: WEBSITE_ID,
    serverId: SERVER_ID,
    applicationId: APP_ID,
    unixUser: UNIX_USER,
    websiteRevision: 4,
  }, 'wp.cache.flush');

  const op = createLocalWebsitePhpToolOperation({
    websitePhpToolsService: {
      getActionPreview: async () => preview,
      runWpCli: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
      runComposer: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
    },
    authorizeActor: mockAuthorizeActor,
  });

  // Post-actor revocation fails closed with 403
  await assert.rejects(
    () => op.execute({
      websiteId: WEBSITE_ID,
      applicationId: APP_ID,
      unixUser: UNIX_USER,
      expectedWebsiteRevision: 4,
      actorSessionId: 'sess-1',
      actorUserId: 'user-1',
      actorRole: 'site_manager',
      actionId: 'wp.cache.flush',
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }, {
      jobId: 'job-race-1',
      serverId: SERVER_ID,
      resourceType: 'application',
      resourceId: APP_ID,
    }),
    (err) => err.code === 'website_php_action_actor_forbidden' && err.status === 403,
  );

  // Release race condition: website revision changed during command execution
  let previewCallCount = 0;
  const opRevisionRace = createLocalWebsitePhpToolOperation({
    websitePhpToolsService: {
      getActionPreview: async () => {
        previewCallCount++;
        // Pre-execution has revision 4, post-execution has revision 5
        return { ...preview, websiteRevision: previewCallCount === 1 ? 4 : 5 };
      },
      runWpCli: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
      runComposer: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
    },
    authorizeActor: async () => ({ sessionId: 'sess-1', userId: 'user-1', role: 'site_manager' }),
  });

  await assert.rejects(
    () => opRevisionRace.execute({
      websiteId: WEBSITE_ID,
      applicationId: APP_ID,
      unixUser: UNIX_USER,
      expectedWebsiteRevision: 4,
      actorSessionId: 'sess-1',
      actorUserId: 'user-1',
      actorRole: 'site_manager',
      actionId: 'wp.cache.flush',
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }, {
      jobId: 'job-race-2',
      serverId: SERVER_ID,
      resourceType: 'application',
      resourceId: APP_ID,
    }),
    (err) => err.code === 'website_php_action_stale' && err.status === 409,
  );
});
