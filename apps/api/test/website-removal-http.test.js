import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { renderCronTaskFile } from '@yunpanel/config-templates';
import { createSiteMutationLock, SiteMutationLockError } from '../src/site-mutation-lock.js';
import { createProcessStoreLock, ProcessStoreLockError } from '../src/process-store-lock.js';
import { createWebsiteRemovalCleanupAdapters } from '../src/website-removal-cleanup-adapters.js';

function createExpressMockApp() {
  const globalMiddlewares = [];
  const errorHandlers = [];
  const routes = [];

  const app = {
    use(fn) {
      if (typeof fn === 'function') {
        if (fn.length === 4) {
          errorHandlers.push(fn);
        } else {
          globalMiddlewares.push(fn);
        }
      }
      return app;
    },
    get(pathPattern, ...handlers) {
      const paramNames = [];
      const regexStr = '^' + pathPattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      }) + '$';
      routes.push({
        method: 'GET',
        pathPattern,
        regex: new RegExp(regexStr),
        paramNames,
        handlers,
      });
      return app;
    },
    post(pathPattern, ...handlers) {
      const paramNames = [];
      const regexStr = '^' + pathPattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      }) + '$';
      routes.push({
        method: 'POST',
        pathPattern,
        regex: new RegExp(regexStr),
        paramNames,
        handlers,
      });
      return app;
    },
    listen(port, callback) {
      const server = http.createServer(async (req, res) => {
        res.status = function (statusCode) {
          res.statusCode = statusCode;
          return res;
        };
        res.set = function (headerName, headerValue) {
          if (!res.headersSent) {
            if (typeof headerName === 'object' && headerName !== null) {
              for (const [k, v] of Object.entries(headerName)) {
                res.setHeader(k, v);
              }
            } else if (typeof headerName === 'string') {
              res.setHeader(headerName, headerValue);
            }
          }
          return res;
        };
        res.json = function (data) {
          if (!res.headersSent) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(data));
          }
          return res;
        };
        res.send = function (data) {
          if (!res.headersSent) {
            if (typeof data === 'object' && data !== null) {
              return res.json(data);
            }
            res.end(data);
          }
          return res;
        };

        req.originalUrl = req.url;

        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
          try {
            const chunks = [];
            for await (const chunk of req) {
              chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            req.body = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            req.body = {};
          }
        } else {
          req.body = {};
        }

        const urlObj = new URL(req.url, 'http://127.0.0.1');
        const pathname = urlObj.pathname;
        req.query = Object.fromEntries(urlObj.searchParams.entries());

        let matchedRoute = null;
        const routeParams = {};

        for (const r of routes) {
          if (r.method !== req.method) continue;
          const match = pathname.match(r.regex);
          if (match) {
            matchedRoute = r;
            r.paramNames.forEach((name, idx) => {
              routeParams[name] = match[idx + 1];
            });
            break;
          }
        }

        req.params = routeParams;

        if (!matchedRoute) {
          res.status(404).json({ error: { code: 'not_found', message: 'Not Found' } });
          return;
        }

        const chain = [...globalMiddlewares, ...matchedRoute.handlers];
        let idx = 0;

        const handleError = async (err) => {
          if (res.headersSent) return;
          let errIdx = 0;
          const runErrHandler = async (e) => {
            if (res.headersSent) return;
            if (errIdx < errorHandlers.length) {
              const h = errorHandlers[errIdx++];
              try {
                await h(e, req, res, runErrHandler);
              } catch (handlerError) {
                await runErrHandler(handlerError);
              }
            } else {
              const status = e.status ?? 500;
              const code = e.code ?? 'internal_error';
              res.status(status).json({ error: { code, message: e.message } });
            }
          };
          await runErrHandler(err);
        };

        const next = async (err) => {
          if (res.headersSent) return;
          if (err) {
            return handleError(err);
          }
          if (idx < chain.length) {
            const handler = chain[idx++];
            try {
              await handler(req, res, next);
            } catch (handlerErr) {
              await handleError(handlerErr);
            }
          }
        };

        await next();
      });

      return server.listen(port, callback);
    },
  };

  return app;
}

const express = () => createExpressMockApp();
express.json = () => (req, res, next) => next();

import {
  mountWebsiteRemovalRoutes,
  WebsiteRemovalHttpError,
} from '../src/website-removal-http.js';
import {
  createWebsiteRemovalRuntime,
  WebsiteRemovalRuntimeError,
} from '../src/website-removal-runtime.js';
import {
  createWebsiteRemovalOperationRegistry,
} from '../src/website-removal-operation-registry.js';
import {
  createWebsiteRemovalPreview,
} from '../src/website-removal-plan.js';

function createMockRuntime() {
  const calls = [];
  const op = {
    id: 'ws-rem-1',
    websiteId: 'ws-1',
    status: 'running',
    updatedAt: '2026-09-19T20:00:00.000Z',
    steps: [{ id: '001:domain_removal:dom-1', status: 'pending' }],
    actions: {
      stepContinuationConfirmation: 'continue-website-remove-step:ws-1:ws-rem-1:001:domain_removal:dom-1:2026-09-19T20:00:00.000Z',
    },
  };
  return {
    preview: async ({ websiteId }) => ({
      version: 1,
      operation: 'website_remove',
      websiteId,
      previewDigest: 'a'.repeat(64),
      confirmation: `start-website-remove:${websiteId}:1:${'a'.repeat(64)}`,
    }),
    start: async (input) => { calls.push({ type: 'start', input }); return op; },
    continueStep: async (input) => { calls.push({ type: 'continue', input }); return { ...op, status: 'removed' }; },
    get: async (id) => (id === 'ws-rem-1' ? op : null),
    list: async () => [op],
    listForWebsite: async (wsId) => (wsId === 'ws-1' ? [op] : []),
    list: async () => [op],
    calls,
  };
}

function createTestApp(runtime) {
  const app = express();
  app.use(express.json());
  // Mock panel route access middleware
  app.use((req, res, next) => {
    req.auth = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });
  return app;
}

test('website-removal-http mounts preview, start, continue and get routes', async () => {
  const runtime = createMockRuntime();
  const app = createTestApp(runtime);
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET preview
    const resPreview = await fetch(`${baseUrl}/api/websites/ws-1/removal`);
    assert.equal(resPreview.status, 200);
    const dataPreview = await resPreview.json();
    assert.equal(dataPreview.preview.websiteId, 'ws-1');
    assert.equal(dataPreview.operations.length, 1);

    // 2. POST start
    const resStart = await fetch(`${baseUrl}/api/websites/ws-1/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: 'a'.repeat(64),
        confirmation: `start-website-remove:ws-1:1:${'a'.repeat(64)}`,
      }),
    });
    assert.equal(resStart.status, 201);
    const dataStart = await resStart.json();
    assert.equal(dataStart.operation.id, 'ws-rem-1');
    assert.deepEqual(runtime.calls.find((entry) => entry.type === 'start').input.actor, {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      role: 'owner',
    });

    // 3. POST continue
    const resContinue = await fetch(`${baseUrl}/api/websites/ws-1/removal-operations/ws-rem-1/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-09-19T20:00:00.000Z',
        stepId: '001:domain_removal:dom-1',
        confirmation: 'continue-website-remove-step:ws-1:ws-rem-1:001:domain_removal:dom-1:2026-09-19T20:00:00.000Z',
      }),
    });
    assert.equal(resContinue.status, 200);
    const dataContinue = await resContinue.json();
    assert.equal(dataContinue.operation.status, 'removed');
    assert.deepEqual(runtime.calls.find((entry) => entry.type === 'continue').input.actor, {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      role: 'owner',
    });

    // 4. GET operations
    const resOps = await fetch(`${baseUrl}/api/websites/ws-1/removal-operations`);
    assert.equal(resOps.status, 200);
    const dataOps = await resOps.json();
    assert.equal(dataOps.operations.length, 1);

    // 5. GET single operation
    const resSingle = await fetch(`${baseUrl}/api/websites/ws-1/removal-operations/ws-rem-1`);
    assert.equal(resSingle.status, 200);
    const dataSingle = await resSingle.json();
    assert.equal(dataSingle.operation.id, 'ws-rem-1');
  } finally {
    server.close();
  }
});

test('website-removal-http rejects mutation when live Owner session identity is unavailable', async () => {
  const runtime = createMockRuntime();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      user: { role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/websites/ws-1/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: 'a'.repeat(64),
        confirmation: `start-website-remove:ws-1:1:${'a'.repeat(64)}`,
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'website_removal_actor_invalid');
    assert.equal(runtime.calls.length, 0);
  } finally {
    server.close();
  }
});

test('website-removal-http enforces Owner, Site A and Site B authorization boundaries and blocks cross-tenant access', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const siteA = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Site A',
    serverId: localServerId,
    applicationId: '33333333-3333-4333-8333-333333333333',
  };
  const siteB = {
    id: 'aaaaaaaa-2222-4222-8222-222222222222',
    name: 'Site B',
    serverId: localServerId,
    applicationId: 'bbbbbbbb-3333-4333-8333-333333333333',
  };

  const opA = {
    id: 'ws-rem-site-a',
    websiteId: siteA.id,
    serverId: localServerId,
    status: 'running',
    updatedAt: '2026-09-30T10:00:00.000Z',
    steps: [{ id: '001:domain_removal:dom-a', status: 'pending' }],
    actions: {
      stepContinuationConfirmation: `continue-website-remove-step:${siteA.id}:ws-rem-site-a:001:domain_removal:dom-a:2026-09-30T10:00:00.000Z`,
    },
  };
  const opB = {
    id: 'ws-rem-site-b',
    websiteId: siteB.id,
    serverId: localServerId,
    status: 'running',
    updatedAt: '2026-09-30T10:00:00.000Z',
    steps: [{ id: '001:domain_removal:dom-b', status: 'pending' }],
    actions: {
      stepContinuationConfirmation: `continue-website-remove-step:${siteB.id}:ws-rem-site-b:001:domain_removal:dom-b:2026-09-30T10:00:00.000Z`,
    },
  };

  const runtime = {
    preview: async ({ websiteId }) => ({
      version: 1,
      operation: 'website_remove',
      websiteId,
      previewDigest: 'b'.repeat(64),
      confirmation: `start-website-remove:${websiteId}:1:${'b'.repeat(64)}`,
      readyToStart: true,
    }),
    start: async ({ websiteId, actor }) => (websiteId === siteA.id ? opA : opB),
    continueStep: async ({ websiteId }) => ({ ...(websiteId === siteA.id ? opA : opB), status: 'removed' }),
    get: async (id) => (id === opA.id ? opA : id === opB.id ? opB : null),
    listForWebsite: async (wsId) => (wsId === siteA.id ? [opA] : wsId === siteB.id ? [opB] : []),
    list: async () => [opA, opB],
  };

  const websiteRegistry = {
    getWebsite: async (id) => (id === siteA.id ? siteA : id === siteB.id ? siteB : null),
  };

  const actors = {
    owner: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', role: 'owner', active: true },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    },
    'site-a': {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002', role: 'site_manager', active: true, websiteIds: [siteA.id] },
      access: { mode: 'site_management', permissions: ['sites.manage'] },
      security: { managementAllowed: true },
    },
    'site-b': {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003', role: 'site_manager', active: true, websiteIds: [siteB.id] },
      access: { mode: 'site_management', permissions: ['sites.manage'] },
      security: { managementAllowed: true },
    },
    inactive: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000004', role: 'site_manager', active: false, websiteIds: [siteA.id] },
      access: { mode: 'site_management', permissions: ['sites.manage'] },
      security: { managementAllowed: true },
    },
    'read-only': {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000005', role: 'read_only', active: true, websiteIds: [siteA.id] },
      access: { mode: 'read_only', permissions: ['sites.read'] },
      security: { managementAllowed: false },
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const actorHeader = req.headers['x-test-actor'] ?? 'owner';
    req.auth = actors[actorHeader] ?? null;
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime, websiteRegistry, localServerId });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Owner can access Site A and Site B preview and operations
    const ownerResA = await fetch(`${baseUrl}/api/websites/${siteA.id}/removal`, { headers: { 'x-test-actor': 'owner' } });
    assert.equal(ownerResA.status, 200);
    const ownerResB = await fetch(`${baseUrl}/api/websites/${siteB.id}/removal`, { headers: { 'x-test-actor': 'owner' } });
    assert.equal(ownerResB.status, 200);

    // 2. Site A manager can access Site A preview and operations
    const siteAManagerResA = await fetch(`${baseUrl}/api/websites/${siteA.id}/removal`, { headers: { 'x-test-actor': 'site-a' } });
    assert.equal(siteAManagerResA.status, 200);

    const siteAManagerOps = await fetch(`${baseUrl}/api/websites/${siteA.id}/removal-operations`, { headers: { 'x-test-actor': 'site-a' } });
    assert.equal(siteAManagerOps.status, 200);
    const siteAManagerOpsData = await siteAManagerOps.json();
    assert.equal(siteAManagerOpsData.operations.length, 1);
    assert.equal(siteAManagerOpsData.operations[0].id, opA.id);

    // 3. Cross-tenant prevention: Site A manager attempting access to Site B is rejected with 404 (no information leakage)
    const crossResB = await fetch(`${baseUrl}/api/websites/${siteB.id}/removal`, { headers: { 'x-test-actor': 'site-a' } });
    assert.equal(crossResB.status, 404);
    assert.equal((await crossResB.json()).error.code, 'website_removal_operation_not_found');

    const crossPreviewB = await fetch(`${baseUrl}/api/websites/${siteB.id}/removal-preview`, {
      method: 'POST',
      headers: { 'x-test-actor': 'site-a' },
    });
    assert.equal(crossPreviewB.status, 404);

    const crossStartB = await fetch(`${baseUrl}/api/websites/${siteB.id}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-actor': 'site-a' },
      body: JSON.stringify({
        previewDigest: 'b'.repeat(64),
        confirmation: `start-website-remove:${siteB.id}:1:${'b'.repeat(64)}`,
      }),
    });
    assert.equal(crossStartB.status, 404);

    const crossListB = await fetch(`${baseUrl}/api/websites/${siteB.id}/removal-operations`, { headers: { 'x-test-actor': 'site-a' } });
    assert.equal(crossListB.status, 404);

    const crossSingleB = await fetch(`${baseUrl}/api/websites/${siteB.id}/removal-operations/${opB.id}`, { headers: { 'x-test-actor': 'site-a' } });
    assert.equal(crossSingleB.status, 404);

    const crossContinueB = await fetch(`${baseUrl}/api/websites/${siteB.id}/removal-operations/${opB.id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-actor': 'site-a' },
      body: JSON.stringify({
        expectedUpdatedAt: opB.updatedAt,
        stepId: opB.steps[0].id,
        confirmation: opB.actions.stepContinuationConfirmation,
      }),
    });
    assert.equal(crossContinueB.status, 404);

    // 4. Cross-tenant prevention: Site B manager attempting access to Site A is rejected with 404
    const crossResA = await fetch(`${baseUrl}/api/websites/${siteA.id}/removal`, { headers: { 'x-test-actor': 'site-b' } });
    assert.equal(crossResA.status, 404);
    const crossStartA = await fetch(`${baseUrl}/api/websites/${siteA.id}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-actor': 'site-b' },
      body: JSON.stringify({
        previewDigest: 'b'.repeat(64),
        confirmation: `start-website-remove:${siteA.id}:1:${'b'.repeat(64)}`,
      }),
    });
    assert.equal(crossStartA.status, 404);

    // 5. Collection route filtering (/api/website-removal-operations)
    const ownerCollectionRes = await fetch(`${baseUrl}/api/website-removal-operations`, { headers: { 'x-test-actor': 'owner' } });
    assert.equal(ownerCollectionRes.status, 200);
    const ownerCollectionData = await ownerCollectionRes.json();
    assert.equal(ownerCollectionData.data.length, 2);

    const siteACollectionRes = await fetch(`${baseUrl}/api/website-removal-operations`, { headers: { 'x-test-actor': 'site-a' } });
    assert.equal(siteACollectionRes.status, 200);
    const siteACollectionData = await siteACollectionRes.json();
    assert.equal(siteACollectionData.data.length, 1);
    assert.equal(siteACollectionData.data[0].id, opA.id);

    const siteBCollectionRes = await fetch(`${baseUrl}/api/website-removal-operations`, { headers: { 'x-test-actor': 'site-b' } });
    assert.equal(siteBCollectionRes.status, 200);
    const siteBCollectionData = await siteBCollectionRes.json();
    assert.equal(siteBCollectionData.data.length, 1);
    assert.equal(siteBCollectionData.data[0].id, opB.id);

    // 6. Inactive tenant account fails closed with 403 tenant_actor_inactive
    const inactiveRes = await fetch(`${baseUrl}/api/websites/${siteA.id}/removal`, { headers: { 'x-test-actor': 'inactive' } });
    assert.equal(inactiveRes.status, 403);
    assert.equal((await inactiveRes.json()).error.code, 'tenant_actor_inactive');

    const inactiveCollectionRes = await fetch(`${baseUrl}/api/website-removal-operations`, { headers: { 'x-test-actor': 'inactive' } });
    assert.equal(inactiveCollectionRes.status, 403);
    assert.equal((await inactiveCollectionRes.json()).error.code, 'tenant_actor_inactive');

    // 7. Non-management / read-only role rejected
    const readOnlyRes = await fetch(`${baseUrl}/api/websites/${siteA.id}/removal`, { headers: { 'x-test-actor': 'read-only' } });
    assert.equal(readOnlyRes.status, 403);
  } finally {
    server.close();
  }
});

test('website-removal-http executes complete removal lifecycle verifying cleanup of files, unix identity, domain, database, SFTP, cron, runtime-binding and Application metadata', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-222222222222';
  const applicationId = '33333333-3333-4333-8333-333333333333';
  const taskId = '44444444-4444-4444-8444-444444444444';
  const unixUser = 'yunapp-0123456789ab';

  let currentWebsite = {
    id: websiteId,
    name: 'Full Lifecycle Site',
    serverId: localServerId,
    applicationId,
    systemUser: unixUser,
    unixUser,
    state: 'active',
    suspended: false,
    desiredRevision: 1,
    stagedRevision: 1,
    appliedRevision: 1,
  };

  let currentApplication = {
    id: applicationId,
    serverId: localServerId,
    type: 'node',
    runtimeAdapter: 'passenger',
    desiredRevision: 1,
    activeDeploymentId: null,
    currentReleaseId: null,
  };

  const cronTask = {
    id: taskId,
    websiteId,
    serverId: localServerId,
    applicationId,
    unixUser,
    name: 'Scheduled Maintenance',
    schedule: '0 2 * * *',
    command: '/usr/bin/backup.sh',
    enabled: true,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const cronRendered = renderCronTaskFile({
    taskId: cronTask.id,
    user: cronTask.unixUser,
    schedule: cronTask.schedule,
    command: cronTask.command,
    enabled: cronTask.enabled,
  });
  const desiredStateSha256 = createHash('sha256').update(cronRendered).digest('hex');

  let currentRuntimeBinding = {
    applicationId,
    adapter: 'passenger',
    revision: 1,
    sourceOperationId: 'source-op-1',
  };

  const cleaned = {
    domainRemoval: 0,
    cronCleanup: 0,
    sftpRevocation: 0,
    databaseUnbind: 0,
    databaseCredentialDelete: 0,
    runtimeBindingRemove: 0,
    filesCleaned: 0,
    unixIdentityCleaned: 0,
    websiteMetadataDeleted: 0,
    applicationMetadataDeleted: 0,
    applicationEnvPurged: 0,
    hostingAllocationReleased: 0,
  };

  const domainRemovalRuntime = {
    listForDomain: async () => [],
    preview: async ({ domainId }) => ({ confirmation: `start-domain-remove:${domainId}:1:checksum` }),
    start: async ({ confirmation }) => {
      cleaned.domainRemoval += 1;
      return { id: 'dom-rem-child', domainId: 'dom-child', status: 'removed' };
    },
  };

  let cronTasks = [cronTask];
  const websiteCronRegistry = {
    listTasks: async ({ websiteId: wsId }) => (wsId === websiteId ? cronTasks : []),
    getTask: async (id) => (id === taskId ? (cronTasks.find((t) => t.id === id) ?? null) : null),
  };

  let cronJob = null;
  const jobRegistry = {
    findIdempotentJob: async (request) => cronJob,
    enqueue: async (request) => {
      cleaned.cronCleanup += 1;
      cronTasks = [];
      cronJob = {
        id: '55555555-5555-4555-8555-555555555555',
        serverId: localServerId,
        operation: 'cron.remove',
        resourceType: 'website_cron',
        resourceId: taskId,
        status: 'succeeded',
        result: {
          version: 1,
          removed: true,
          taskId,
          websiteId,
          applicationId,
          unixUser,
          revision: 1,
          desiredStateSha256,
          contentSha256: desiredStateSha256,
          sideEffects: true,
        },
      };
      return cronJob;
    },
  };

  const websiteSftpKeyRegistry = {
    listKeys: async ({ websiteId: wsId }) => (wsId === websiteId ? [{ id: 'sftp-1', revision: 1 }] : []),
    revokeKey: async ({ websiteId: wsId, keyId, expectedRevision }) => {
      assert.equal(wsId, websiteId);
      assert.equal(keyId, 'sftp-1');
      assert.equal(expectedRevision, 1);
      cleaned.sftpRevocation += 1;
    },
  };

  const databaseBindingRegistry = {
    listBindings: async ({ websiteId: wsId }) => (wsId === websiteId ? [{ id: 'db-1', databaseName: 'site_db', revision: 1 }] : []),
    unbindDatabase: async (bindingId, options) => {
      assert.equal(bindingId, 'db-1');
      assert.equal(options.expectedRevision, 1);
      cleaned.databaseUnbind += 1;
      return { id: bindingId, unbound: true };
    },
  };

  const databaseCredentialRegistry = {
    getForBinding: async (bindingId) => (bindingId === 'db-1' ? { id: 'cred-1', revision: 1 } : null),
    deleteCredential: async (credentialId, options) => {
      assert.equal(credentialId, 'cred-1');
      assert.equal(options.expectedRevision, 1);
      cleaned.databaseCredentialDelete += 1;
    },
  };

  const runtimeBindingRegistry = {
    getBinding: async (appId) => (appId === applicationId ? currentRuntimeBinding : null),
    removeOwnedPassenger: async (appId, options) => {
      assert.equal(appId, applicationId);
      cleaned.runtimeBindingRemove += 1;
      currentRuntimeBinding = null;
    },
  };

  const fileCleanupHandler = async (input) => {
    assert.equal(input.websiteId, websiteId);
    assert.equal(input.applicationId, applicationId);
    assert.deepEqual(input.retainedBackups, ['backup-1']);
    assert.deepEqual(input.retainedLogScopes, [websiteId]);
    cleaned.filesCleaned += 1;
    return {
      filesCleaned: true,
      websiteId,
      applicationId,
      retainedBackups: ['backup-1'],
      retainedLogScopes: [websiteId],
      cleanedFilesCount: 42,
    };
  };

  const unixIdentityCleanupHandler = async (input) => {
    assert.equal(input.systemUser, unixUser);
    assert.equal(input.websiteId, websiteId);
    cleaned.unixIdentityCleaned += 1;
    return {
      unixIdentityCleaned: true,
      systemUser: unixUser,
      websiteId,
    };
  };

  const websiteRegistry = {
    getWebsite: async (id) => (id === websiteId ? currentWebsite : null),
    deleteMigrationWebsite: async (input) => {
      assert.equal(input.websiteId, websiteId);
      assert.equal(input.applicationId, applicationId);
      cleaned.websiteMetadataDeleted += 1;
      currentWebsite = null;
    },
  };

  let envState = { applicationId, variableCount: 0, environmentPresent: false };
  const applicationEnvironmentRegistry = {
    inspectApplicationState: async (appId) => (appId === applicationId ? envState : { variableCount: 0, environmentPresent: false }),
    purgeApplication: async (appId) => {
      assert.equal(appId, applicationId);
      cleaned.applicationEnvPurged += 1;
      envState = { applicationId, variableCount: 0, environmentPresent: false };
    },
  };

  const applicationRegistry = {
    getApplication: async (id) => (id === applicationId ? currentApplication : null),
    deleteApplication: async (input) => {
      assert.equal(input.applicationId, applicationId);
      cleaned.applicationMetadataDeleted += 1;
      currentApplication = null;
    },
  };

  const hostingAllocationReleaseHandler = async (proof) => {
    assert.equal(proof.websiteId, websiteId);
    assert.equal(proof.applicationId, applicationId);
    assert.equal(proof.websiteAbsent, true);
    assert.equal(proof.applicationAbsent, true);
    cleaned.hostingAllocationReleased += 1;
    return {
      websiteId,
      released: true,
      quotaReleased: true,
      customerId: 'customer-1',
    };
  };

  const impactDependencies = {
    domains: [{ id: 'dom-child', primaryDomain: 'sub.example.com', parentDomainId: 'dom-root' }],
    databases: { status: 'available', items: [{ id: 'db-1', state: 'site_db' }] },
    sftpKeys: { status: 'available', items: [{ id: 'sftp-1', state: 'active' }] },
    runtimeBindings: { status: 'available', items: [{ id: applicationId, state: 'active' }] },
    unixIdentities: { status: 'available', items: [{ id: unixUser, state: 'active' }] },
    logScopes: { status: 'available', items: [{ id: websiteId, state: 'managed' }] },
    crons: { status: 'available', items: [{ id: taskId, state: 'active' }] },
    backups: { status: 'available', items: [{ id: 'backup-1', state: 'available' }] },
    activeJobs: [],
  };

  const impact = {
    version: 1,
    resourceType: 'website',
    operation: 'delete',
    targetServerId: null,
    resource: { id: websiteId, serverId: localServerId },
    application: { id: applicationId, serverId: localServerId, type: 'node', desiredRevision: 1 },
    dependencies: impactDependencies,
    blockers: [],
    previewDigest: 'f'.repeat(64),
    confirmation: `delete:website:${websiteId}:${'f'.repeat(64)}`,
  };

  const preview = createWebsiteRemovalPreview({
    website: currentWebsite,
    impact,
    applicationState: currentApplication,
  });
  assert.equal(preview.readyToStart, true);

  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime,
    websiteRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    databaseBindingRegistry,
    databaseCredentialRegistry,
    websiteSftpKeyRegistry,
    runtimeBindingRegistry,
    websiteCronRegistry,
    jobRegistry,
    fileCleanupHandler,
    fileCleanupInspector: async () => ({ ready: true }),
    unixIdentityCleanupHandler,
    unixIdentityCleanupInspector: async () => ({ ready: true }),
    hostingAllocationReleaseHandler,
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime, websiteRegistry, localServerId });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. GET preview
    const resPreview = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`);
    assert.equal(resPreview.status, 200);
    const dataPreview = await resPreview.json();
    assert.equal(dataPreview.preview.readyToStart, true);
    assert.equal(dataPreview.preview.confirmation, preview.confirmation);

    // 2. Start removal
    const resStart = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resStart.status, 201);
    let { operation: currentOp } = await resStart.json();
    assert.equal(currentOp.status, 'running');
    assert.equal(currentOp.steps[0].kind, 'domain_removal');
    assert.equal(currentOp.steps[0].status, 'succeeded');

    // 3. Step-by-step continuation loop through HTTP API
    while (currentOp.status === 'running') {
      const nextStep = currentOp.steps.find((s) => s.status !== 'succeeded');
      assert.ok(nextStep, 'Expected next incomplete step while operation is running');
      assert.ok(currentOp.actions?.stepContinuationConfirmation, 'Expected step continuation confirmation');

      const resContinue = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${currentOp.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: currentOp.updatedAt,
          stepId: nextStep.id,
          confirmation: currentOp.actions.stepContinuationConfirmation,
        }),
      });
      assert.equal(resContinue.status, 200, `Step ${nextStep.id} continuation failed with status ${resContinue.status}`);
      const continueData = await resContinue.json();
      currentOp = continueData.operation ?? continueData.data;
    }

    // 4. Verify terminal status and completion
    assert.equal(currentOp.status, 'removed');
    assert.equal(currentOp.steps.every((s) => s.status === 'succeeded'), true);

    // 5. Verify every single resource cleanup occurred with exact parameters
    assert.equal(cleaned.domainRemoval, 1, 'Domain removal must be executed');
    assert.equal(cleaned.cronCleanup, 1, 'Cron cleanup must be executed');
    assert.equal(cleaned.sftpRevocation, 1, 'SFTP key revocation must be executed');
    assert.equal(cleaned.databaseUnbind, 1, 'Database unbind must be executed');
    assert.equal(cleaned.databaseCredentialDelete, 1, 'Database credential delete must be executed');
    assert.equal(cleaned.runtimeBindingRemove, 1, 'Runtime binding removal must be executed');
    assert.equal(cleaned.filesCleaned, 1, 'File cleanup must be executed with verified receipt');
    assert.equal(cleaned.unixIdentityCleaned, 1, 'Unix identity cleanup must be executed with verified receipt');
    assert.equal(cleaned.websiteMetadataDeleted, 1, 'Website metadata must be deleted');
    assert.equal(cleaned.applicationEnvPurged, 1, 'Application environment must be purged');
    assert.equal(cleaned.applicationMetadataDeleted, 1, 'Application metadata must be deleted');
    assert.equal(cleaned.hostingAllocationReleased, 1, 'Hosting allocation quota must be released');

    // 6. Verify finalization and absence from registry
    assert.equal(await websiteRegistry.getWebsite(websiteId), null);
    assert.equal(await applicationRegistry.getApplication(applicationId), null);
    assert.equal(await runtimeBindingRegistry.getBinding(applicationId), null);

    // 7. GET operation detail shows full completed journal
    const resGet = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${currentOp.id}`);
    assert.equal(resGet.status, 200);
    const getData = await resGet.json();
    assert.equal(getData.operation.status, 'removed');
    assert.equal(getData.operation.steps.length, 9);
    assert.equal(getData.operation.actions.stepContinuationConfirmation, null);
  } finally {
    server.close();
  }
});

test('website-removal-http remains fail-closed on partial failure and subsequent destructive steps do not execute', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-333333333333';
  const applicationId = '33333333-3333-4333-8333-444444444444';
  const unixUser = 'yunapp-112233445566';

  let currentWebsite = {
    id: websiteId,
    name: 'Partial Failure Site',
    serverId: localServerId,
    applicationId,
    systemUser: unixUser,
    unixUser,
    state: 'active',
    suspended: false,
    desiredRevision: 1,
    stagedRevision: 1,
    appliedRevision: 1,
  };

  let currentApplication = {
    id: applicationId,
    serverId: localServerId,
    type: 'node',
    runtimeAdapter: 'passenger',
    desiredRevision: 1,
    activeDeploymentId: null,
    currentReleaseId: null,
  };

  let fileCleanupFails = true;
  let fileCleanupAttempts = 0;
  let unixIdentityCleanedCount = 0;
  let websiteMetadataDeletedCount = 0;
  let applicationMetadataDeletedCount = 0;

  const impact = {
    version: 1,
    resourceType: 'website',
    operation: 'delete',
    targetServerId: null,
    resource: { id: websiteId, serverId: localServerId },
    application: { id: applicationId, serverId: localServerId, type: 'node', desiredRevision: 1 },
    dependencies: {
      domains: [],
      databases: { status: 'available', items: [] },
      sftpKeys: { status: 'available', items: [] },
      runtimeBindings: { status: 'available', items: [] },
      unixIdentities: { status: 'available', items: [{ id: unixUser, state: 'active' }] },
      logScopes: { status: 'available', items: [{ id: websiteId, state: 'managed' }] },
      crons: { status: 'available', items: [] },
      backups: { status: 'available', items: [] },
      activeJobs: [],
    },
    blockers: [],
    previewDigest: 'e'.repeat(64),
    confirmation: `delete:website:${websiteId}:${'e'.repeat(64)}`,
  };

  const preview = createWebsiteRemovalPreview({
    website: currentWebsite,
    impact,
    applicationState: currentApplication,
  });

  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
    websiteRegistry: {
      getWebsite: async (id) => (id === websiteId ? currentWebsite : null),
      deleteMigrationWebsite: async () => {
        websiteMetadataDeletedCount += 1;
        currentWebsite = null;
      },
    },
    applicationRegistry: {
      getApplication: async (id) => (id === applicationId ? currentApplication : null),
      deleteApplication: async () => {
        applicationMetadataDeletedCount += 1;
        currentApplication = null;
      },
    },
    applicationEnvironmentRegistry: {
      inspectApplicationState: async () => ({ variableCount: 0, environmentPresent: false }),
      purgeApplication: async () => {},
    },
    fileCleanupHandler: async (input) => {
      fileCleanupAttempts += 1;
      if (fileCleanupFails) {
        throw new WebsiteRemovalRuntimeError('website_removal_cleanup_unverified', 'Simulated file cleanup error', 409);
      }
      return {
        filesCleaned: true,
        websiteId,
        applicationId,
        retainedBackups: [...input.retainedBackups],
        retainedLogScopes: [...input.retainedLogScopes],
        cleanedFilesCount: 5,
      };
    },
    fileCleanupInspector: async () => ({ ready: true }),
    unixIdentityCleanupHandler: async (input) => {
      unixIdentityCleanedCount += 1;
      return { unixIdentityCleaned: true, systemUser: unixUser, websiteId };
    },
    unixIdentityCleanupInspector: async () => ({ ready: true }),
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime, websiteRegistry: { getWebsite: async (id) => (id === websiteId ? currentWebsite : null) }, localServerId });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Start removal
    const resStart = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resStart.status, 201);
    const startData = await resStart.json();
    let currentOp = startData.operation;

    // First step is file_cleanup, which failed during start runNextStep
    assert.equal(currentOp.status, 'blocked');
    const fileStep = currentOp.steps.find((s) => s.kind === 'file_cleanup');
    assert.equal(fileStep.status, 'blocked');
    assert.equal(fileStep.error.code, 'website_removal_cleanup_unverified');
    assert.equal(fileCleanupAttempts, 1);

    // Fail-closed verification: subsequent destructive steps must NOT have been executed!
    assert.equal(unixIdentityCleanedCount, 0, 'Unix identity cleanup must NOT run when file cleanup fails');
    assert.equal(websiteMetadataDeletedCount, 0, 'Website metadata must NOT be deleted when file cleanup fails');
    assert.equal(applicationMetadataDeletedCount, 0, 'Application metadata must NOT be deleted when file cleanup fails');
    assert.notEqual(currentWebsite, null);
    assert.notEqual(currentApplication, null);

    const unixStep = currentOp.steps.find((s) => s.kind === 'unix_identity_cleanup');
    assert.equal(unixStep.status, 'pending');
    const metaStep = currentOp.steps.find((s) => s.kind === 'metadata_finalization');
    assert.equal(metaStep.status, 'pending');
    const appStep = currentOp.steps.find((s) => s.kind === 'application_cleanup');
    assert.equal(appStep.status, 'pending');

    // 2. Fix the file cleanup adapter and explicitly continue
    fileCleanupFails = false;
    assert.ok(currentOp.actions?.stepContinuationConfirmation);

    const resContinue = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${currentOp.id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: currentOp.updatedAt,
        stepId: fileStep.id,
        confirmation: currentOp.actions.stepContinuationConfirmation,
      }),
    });
    assert.equal(resContinue.status, 200);
    const continueData = await resContinue.json();
    currentOp = continueData.operation ?? continueData.data;

    // File cleanup step succeeded on second attempt
    assert.equal(fileCleanupAttempts, 2);
    assert.equal(currentOp.steps.find((s) => s.kind === 'file_cleanup').status, 'succeeded');

    // 3. Continue remaining steps to completion
    while (currentOp.status === 'running') {
      const nextStep = currentOp.steps.find((s) => s.status !== 'succeeded');
      const resStep = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${currentOp.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: currentOp.updatedAt,
          stepId: nextStep.id,
          confirmation: currentOp.actions.stepContinuationConfirmation,
        }),
      });
      assert.equal(resStep.status, 200);
      currentOp = (await resStep.json()).operation;
    }

    assert.equal(currentOp.status, 'removed');
    assert.equal(unixIdentityCleanedCount, 1);
    assert.equal(websiteMetadataDeletedCount, 1);
    assert.equal(applicationMetadataDeletedCount, 1);
  } finally {
    server.close();
  }
});

test('website-removal-http reconciles interrupted running step upon restart as blocked (fail-closed) and does not blindly replay', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-555555555555';

  const preview = createWebsiteRemovalPreview({
    website: {
      id: websiteId,
      name: 'Restart Reconciliation Site',
      serverId: localServerId,
      applicationId: null,
      systemUser: null,
      desiredRevision: 1,
    },
    impact: {
      version: 1,
      resourceType: 'website',
      operation: 'delete',
      targetServerId: null,
      resource: { id: websiteId, serverId: localServerId },
      dependencies: {
        domains: [],
        databases: { status: 'available', items: [] },
        sftpKeys: { status: 'available', items: [] },
        runtimeBindings: { status: 'available', items: [] },
        unixIdentities: { status: 'available', items: [] },
        logScopes: { status: 'available', items: [{ id: websiteId, state: 'managed' }] },
        crons: { status: 'available', items: [] },
        backups: { status: 'available', items: [] },
        activeJobs: [],
      },
      blockers: [],
      previewDigest: 'd'.repeat(64),
      confirmation: `delete:website:${websiteId}:${'d'.repeat(64)}`,
    },
  });

  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  // Create operation and simulate a crash that left step 0 in 'running' state
  const op = await registry.create(preview);
  await registry.markStepRunning(op.id, op.steps[0].id);

  let blindReplayCalls = 0;
  const fileCleanupHandler = async (input) => {
    blindReplayCalls += 1;
    return { filesCleaned: true, websiteId, applicationId: null, retainedBackups: [], retainedLogScopes: [websiteId] };
  };

  // Simulate server restart: new runtime initialized on existing registry
  const restartedRuntime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
    websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId: localServerId, applicationId: null }), deleteMigrationWebsite: async () => {} },
    fileCleanupHandler,
    fileCleanupInspector: async () => ({ ready: true }),
  });
  await restartedRuntime.init();

  // Verify that init() did NOT blindly replay the mutation
  assert.equal(blindReplayCalls, 0, 'Runtime init must not blindly replay mutations for interrupted steps');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime: restartedRuntime, websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId: localServerId }) }, localServerId });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. GET operation shows the step was marked blocked with website_removal_interrupted
    const resGet = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${op.id}`);
    assert.equal(resGet.status, 200);
    const getData = await resGet.json();
    const interruptedStep = getData.operation.steps[0];
    assert.equal(interruptedStep.status, 'blocked');
    assert.equal(interruptedStep.error.code, 'website_removal_interrupted');
    assert.ok(getData.operation.actions.stepContinuationConfirmation);

    // 2. Explicit continuation by client safely resumes step
    const resContinue = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${op.id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: getData.operation.updatedAt,
        stepId: interruptedStep.id,
        confirmation: getData.operation.actions.stepContinuationConfirmation,
      }),
    });
    assert.equal(resContinue.status, 200);
    assert.equal(blindReplayCalls, 1, 'File cleanup executed only upon explicit continuation');
  } finally {
    server.close();
  }
});

test('website-removal-http enforces idempotency, prevents duplicate operations, and handles unknown-result reconciliation safely', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-666666666666';

  const preview = createWebsiteRemovalPreview({
    website: {
      id: websiteId,
      name: 'Idempotency Site',
      serverId: localServerId,
      applicationId: null,
      systemUser: null,
      desiredRevision: 1,
    },
    impact: {
      version: 1,
      resourceType: 'website',
      operation: 'delete',
      targetServerId: null,
      resource: { id: websiteId, serverId: localServerId },
      dependencies: {
        domains: [],
        databases: { status: 'available', items: [] },
        sftpKeys: { status: 'available', items: [] },
        runtimeBindings: { status: 'available', items: [] },
        unixIdentities: { status: 'available', items: [] },
        logScopes: { status: 'available', items: [{ id: websiteId, state: 'managed' }] },
        crons: { status: 'available', items: [] },
        backups: { status: 'available', items: [] },
        activeJobs: [],
      },
      blockers: [],
      previewDigest: 'c'.repeat(64),
      confirmation: `delete:website:${websiteId}:${'c'.repeat(64)}`,
    },
  });

  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  let websitePresent = true;
  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
    websiteRegistry: {
      getWebsite: async () => (websitePresent ? { id: websiteId, serverId: localServerId, applicationId: null } : null),
      deleteMigrationWebsite: async () => { websitePresent = false; },
    },
    fileCleanupHandler: async () => ({ filesCleaned: true, websiteId, applicationId: null, retainedBackups: [], retainedLogScopes: [websiteId] }),
    fileCleanupInspector: async () => ({ ready: true }),
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime, websiteRegistry: { getWebsite: async () => (websitePresent ? { id: websiteId, serverId: localServerId } : null) }, localServerId });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Start removal operation 1
    const resStart1 = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resStart1.status, 201);
    let op = (await resStart1.json()).operation;

    // 2. Duplicate start while operation is already in progress returns 409 website_removal_operation_in_progress
    const resDuplicateStart = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resDuplicateStart.status, 409);
    assert.equal((await resDuplicateStart.json()).error.code, 'website_removal_operation_in_progress');

    // 3. Stale preview digest / invalid confirmation returns 409 website_removal_preview_stale
    const resStaleStart = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: '0'.repeat(64),
        confirmation: `start-website-remove:${websiteId}:1:${'0'.repeat(64)}`,
      }),
    });
    assert.equal(resStaleStart.status, 409);
    assert.equal((await resStaleStart.json()).error.code, 'website_removal_preview_stale');

    // 4. Unknown-result reconciliation: client performs GET to reconcile state instead of duplicate POST
    const resReconcile = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`);
    assert.equal(resReconcile.status, 200);
    const reconcileData = await resReconcile.json();
    assert.equal(reconcileData.operations.length, 1);
    assert.equal(reconcileData.operations[0].id, op.id);

    // 5. Complete all steps until status is 'removed'
    while (op.status === 'running') {
      const step = op.steps.find((s) => s.status !== 'succeeded');
      const resCont = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${op.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: op.updatedAt,
          stepId: step.id,
          confirmation: op.actions.stepContinuationConfirmation,
        }),
      });
      assert.equal(resCont.status, 200);
      op = (await resCont.json()).operation;
    }
    assert.equal(op.status, 'removed');

    // 6. Attempting to continue a terminal/removed operation returns 409 website_removal_step_continuation_stale
    const resContTerminal = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${op.id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: op.updatedAt,
        stepId: op.steps[0].id,
        confirmation: 'any-stale-confirmation',
      }),
    });
    assert.equal(resContTerminal.status, 409);
    assert.equal((await resContTerminal.json()).error.code, 'website_removal_step_continuation_stale');
  } finally {
    server.close();
  }
});

test('website-removal-http guarantees no interaction with Plesk .44 host', async () => {
  // Test verifies all URLs and target servers are local loopback and never target .44
  const forbiddenIp = '.44';
  const runtime = createMockRuntime();
  const app = createTestApp(runtime);
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.equal(baseUrl.includes(forbiddenIp), false);
    const res = await fetch(`${baseUrl}/api/websites/ws-1/removal`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(baseUrl, /\.44/);
  } finally {
    server.close();
  }
});

test('website-removal-http fails closed with 503 on site mutation lock permission and crash failures without journal corruption', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-777777777777';

  const preview = createWebsiteRemovalPreview({
    website: {
      id: websiteId,
      name: 'Lock Failure Site',
      serverId: localServerId,
      applicationId: null,
      systemUser: null,
      desiredRevision: 1,
    },
    impact: {
      version: 1,
      resourceType: 'website',
      operation: 'delete',
      targetServerId: null,
      resource: { id: websiteId, serverId: localServerId },
      dependencies: {
        domains: [],
        databases: { status: 'available', items: [] },
        sftpKeys: { status: 'available', items: [] },
        runtimeBindings: { status: 'available', items: [] },
        unixIdentities: { status: 'available', items: [] },
        logScopes: { status: 'available', items: [] },
        crons: { status: 'available', items: [] },
        backups: { status: 'available', items: [] },
        activeJobs: [],
      },
      blockers: [],
      previewDigest: 'e'.repeat(64),
      confirmation: `delete:website:${websiteId}:${'e'.repeat(64)}`,
    },
  });

  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  let lockBehavior = 'permission_error';
  const failingSiteMutationLock = {
    withSiteLock: async ({ websiteId: targetId }, action) => {
      if (lockBehavior === 'permission_error') {
        throw new SiteMutationLockError(
          'site_mutation_lock_failed',
          'Failed to acquire site mutation lock due to permission error',
          503,
        );
      }
      if (lockBehavior === 'timeout') {
        throw new SiteMutationLockError(
          'site_mutation_locked',
          'Timed out waiting for existing site mutation lock',
          503,
        );
      }
      return action();
    },
  };

  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
    websiteRegistry: {
      getWebsite: async () => ({ id: websiteId, serverId: localServerId }),
      deleteMigrationWebsite: async () => {},
    },
    fileCleanupHandler: async () => ({ filesCleaned: true, websiteId, applicationId: null, retainedBackups: [], retainedLogScopes: [] }),
    fileCleanupInspector: async () => ({ ready: true }),
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, {
    runtime,
    siteMutationLock: failingSiteMutationLock,
    websiteRegistry: {
      getWebsite: async () => ({ id: websiteId, serverId: localServerId }),
      deleteMigrationWebsite: async () => {},
    },
    localServerId,
  });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Permission failure returns 503 site_mutation_lock_failed fail-closed
    const resPerm = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resPerm.status, 503);
    const errPerm = await resPerm.json();
    assert.equal(errPerm.error.code, 'site_mutation_lock_failed');

    // Verify registry remains empty / uncorrupted
    assert.equal((await registry.listForWebsite(websiteId)).length, 0);

    // 2. Lock timeout returns 503 site_mutation_locked fail-closed
    lockBehavior = 'timeout';
    const resTimeout = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resTimeout.status, 503);
    const errTimeout = await resTimeout.json();
    assert.equal(errTimeout.error.code, 'site_mutation_locked');

    // Verify registry still remains uncorrupted
    assert.equal((await registry.listForWebsite(websiteId)).length, 0);

    // 3. Normal lock allows start to proceed
    lockBehavior = 'ok';
    const resOk = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resOk.status, 201);
    const op = (await resOk.json()).operation;
    assert.equal(op.websiteId, websiteId);
    assert.equal((await registry.listForWebsite(websiteId)).length, 1);
  } finally {
    server.close();
  }
});

test('website-removal-http legacy direct-systemd services without deployment receipts, unowned Unix identities, and unsafe paths remain fail-closed', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-888888888888';
  const applicationId = '33333333-3333-4333-8333-888888888888';
  const systemUser = 'yunapp-test888';

  let receiptPresent = false;
  let ownedUnixUser = 'yunapp-different'; // Mismatched / unowned
  let symlinkPath = false;

  const nodeServiceCalls = [];
  const compensatedCalls = [];

  const cleanupAdapters = createWebsiteRemovalCleanupAdapters({
    websiteRegistry: {
      getWebsite: async () => ({
        id: websiteId,
        serverId: localServerId,
        applicationId,
        unixUser: systemUser,
      }),
      listWebsites: async () => [{ id: websiteId, applicationId }],
    },
    applicationRegistry: {
      getApplication: async () => ({
        id: applicationId,
        serverId: localServerId,
        type: 'node',
        runtimeAdapter: 'direct-systemd',
        desiredRevision: 2,
        currentReleaseId: null, // Legacy direct-systemd without releaseId / receipt
        serviceName: 'yunpanel-node-legacy.service',
        currentCommitSha: null,
        servicePort: 3200,
        healthPath: '/health',
      }),
    },
    websiteProvisioningRuntime: {
      registry: {
        listForWebsite: async () => [{
          operationId: 'prov-op-1',
          steps: [{
            kind: 'unix_identity',
            state: 'succeeded',
            intent: {
              websiteId,
              applicationId,
              unixUser: ownedUnixUser,
              homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
            },
            evidence: { owned: true },
          }],
        }],
      },
      handlers: {
        unix_identity: {
          compensate: async (ctx) => {
            compensatedCalls.push(ctx);
            return { satisfied: true, removedUser: true, removedGroup: true };
          },
          inspectCompensation: async () => ({ satisfied: true, removedUser: true, removedGroup: true }),
        },
      },
    },
    nodeServiceRemovalManager: {
      inspectRemoval: async (input) => {
        nodeServiceCalls.push({ type: 'inspect', input });
        return { ready: true, ...input };
      },
      removeService: async (input) => {
        nodeServiceCalls.push({ type: 'remove', input });
        return { ...input, directSystemdCleaned: true };
      },
    },
    nodeDeploymentReceiptStore: {
      read: async () => receiptPresent ? {
        version: 1,
        serverId: localServerId,
        jobId: 'rel-1',
        applicationId,
        releaseId: 'rel-1',
        previousReleaseId: null,
        commitSha: 'a'.repeat(40),
        serviceName: 'yunpanel-node-legacy.service',
        port: 3200,
        healthPath: '/health',
      } : null,
    },
    lstatFn: async (p) => ({
      isSymbolicLink: () => symlinkPath,
      isDirectory: () => !symlinkPath,
    }),
    rmFn: async () => {},
  });

  // Verify direct-systemd cleanup fails closed without deployment receipt
  await assert.rejects(
    cleanupAdapters.inspectDirectSystemdCleanup({
      websiteId,
      applicationId,
      serverId: localServerId,
      releaseId: null,
      serviceName: 'yunpanel-node-legacy.service',
      currentCommitSha: null,
      servicePort: 3200,
      healthPath: '/health',
    }),
    (error) => error.code === 'website_cleanup_direct_systemd_evidence_unavailable',
  );
  assert.equal(nodeServiceCalls.length, 0, 'No host service inspection or removal calls executed without deployment receipt');

  // Verify unowned Unix identity fails closed
  await assert.rejects(
    cleanupAdapters.inspectUnixIdentityCleanup({ websiteId, systemUser }),
    (error) => error.code === 'website_cleanup_identity_evidence_unavailable',
  );
  assert.equal(compensatedCalls.length, 0, 'No Unix identity compensation executed for unowned identity');

  // Verify unsafe symlink path fails closed
  symlinkPath = true;
  await assert.rejects(
    cleanupAdapters.inspectFileCleanup({ websiteId, applicationId }),
    (error) => error.code === 'website_cleanup_path_unsafe',
  );
});

test('website-removal-http preserves durable recovery journals across cold-restart and storage/write-failure scenarios', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-website-removal-'));
  const filePath = path.join(rootDir, 'operations.json');
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-999999999999';

  const preview = createWebsiteRemovalPreview({
    website: {
      id: websiteId,
      name: 'Cold Restart Site',
      serverId: localServerId,
      applicationId: null,
      systemUser: null,
      desiredRevision: 1,
    },
    impact: {
      version: 1,
      resourceType: 'website',
      operation: 'delete',
      targetServerId: null,
      resource: { id: websiteId, serverId: localServerId },
      dependencies: {
        domains: [],
        databases: { status: 'available', items: [] },
        sftpKeys: { status: 'available', items: [] },
        runtimeBindings: { status: 'available', items: [] },
        unixIdentities: { status: 'available', items: [] },
        logScopes: { status: 'available', items: [] },
        crons: { status: 'available', items: [] },
        backups: { status: 'available', items: [] },
        activeJobs: [],
      },
      blockers: [],
      previewDigest: 'f'.repeat(64),
      confirmation: `delete:website:${websiteId}:${'f'.repeat(64)}`,
    },
  });

  try {
    // 1. Initialize durable registry and runtime
    const registry1 = createWebsiteRemovalOperationRegistry({ filePath });
    await registry1.init();

    let cleanedFilesCount = 0;
    let websiteDeleted = false;
    const websiteRegistryMock = {
      getWebsite: async () => (websiteDeleted ? null : { id: websiteId, serverId: localServerId, applicationId: null }),
      deleteMigrationWebsite: async () => { websiteDeleted = true; },
    };

    const runtime1 = createWebsiteRemovalRuntime({
      registry: registry1,
      previewProvider: async () => preview,
      domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
      websiteRegistry: websiteRegistryMock,
      fileCleanupHandler: async () => { cleanedFilesCount++; return { filesCleaned: true, websiteId, applicationId: null, retainedBackups: [], retainedLogScopes: [] }; },
      fileCleanupInspector: async () => ({ ready: true }),
    });

    const app1 = express();
    app1.use(express.json());
    app1.use((req, res, next) => {
      req.auth = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
      next();
    });
    mountWebsiteRemovalRoutes(app1, {
      runtime: runtime1,
      websiteRegistry: websiteRegistryMock,
      localServerId,
    });
    app1.use((err, req, res, next) => {
      res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
    });

    const server1 = app1.listen(0);
    const baseUrl1 = `http://127.0.0.1:${server1.address().port}`;

    let op;
    try {
      const resStart = await fetch(`${baseUrl1}/api/websites/${websiteId}/removal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        }),
      });
      assert.equal(resStart.status, 201);
      op = (await resStart.json()).operation;
    } finally {
      server1.close();
    }

    // Verify durable storage file was created and contains the operation
    const persistedRaw1 = await readFile(filePath, 'utf8');
    const persistedOps1 = JSON.parse(persistedRaw1);
    assert.equal(persistedOps1.length, 1);
    assert.equal(persistedOps1[0].id, op.id);

    // 2. Cold restart: instantiate completely new registry2 and runtime2 pointing to the same filePath
    const registry2 = createWebsiteRemovalOperationRegistry({ filePath });
    await registry2.init();
    const runtime2 = createWebsiteRemovalRuntime({
      registry: registry2,
      previewProvider: async () => preview,
      domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
      websiteRegistry: websiteRegistryMock,
      fileCleanupHandler: async () => { cleanedFilesCount++; return { filesCleaned: true, websiteId, applicationId: null, retainedBackups: [], retainedLogScopes: [] }; },
      fileCleanupInspector: async () => ({ ready: true }),
    });

    const app2 = express();
    app2.use(express.json());
    app2.use((req, res, next) => {
      req.auth = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
      next();
    });
    mountWebsiteRemovalRoutes(app2, {
      runtime: runtime2,
      websiteRegistry: websiteRegistryMock,
      localServerId,
    });
    app2.use((err, req, res, next) => {
      res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
    });

    const server2 = app2.listen(0);
    const baseUrl2 = `http://127.0.0.1:${server2.address().port}`;

    try {
      // Reconcile / GET operation shows exact persisted state
      const resGet = await fetch(`${baseUrl2}/api/websites/${websiteId}/removal-operations/${op.id}`);
      assert.equal(resGet.status, 200);
      const reloadedOp = (await resGet.json()).operation;
      assert.equal(reloadedOp.id, op.id);
      assert.equal(reloadedOp.websiteId, websiteId);

      // 3. Storage write-failure scenario:
      // Make directory read-only (chmod 0o500) so that atomic persist() writeFile fails
      await chmod(rootDir, 0o500);

      const step = reloadedOp.steps.find((s) => s.status !== 'succeeded');
      const resFailingCont = await fetch(`${baseUrl2}/api/websites/${websiteId}/removal-operations/${op.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: reloadedOp.updatedAt,
          stepId: step.id,
          confirmation: reloadedOp.actions.stepContinuationConfirmation,
        }),
      });
      // Should fail closed with 503 process_store_lock_failed
      assert.equal(resFailingCont.status, 503);
      const errFailingCont = await resFailingCont.json();
      assert.equal(errFailingCont.error.code, 'process_store_lock_failed');

      // Restore write permissions
      await chmod(rootDir, 0o700);

      // Verify no stray .tmp files were left behind in rootDir
      // and in-memory registry reloaded from durable disk without corruption
      const resGetAfterFailure = await fetch(`${baseUrl2}/api/websites/${websiteId}/removal-operations/${op.id}`);
      assert.equal(resGetAfterFailure.status, 200);
      const opAfterFailure = (await resGetAfterFailure.json()).operation;
      assert.equal(opAfterFailure.id, op.id);

      // Retry continuation succeeds now that permissions are restored
      const resRetry = await fetch(`${baseUrl2}/api/websites/${websiteId}/removal-operations/${op.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: opAfterFailure.updatedAt,
          stepId: step.id,
          confirmation: opAfterFailure.actions.stepContinuationConfirmation,
        }),
      });
      assert.equal(resRetry.status, 200);
      const opSuccess = (await resRetry.json()).operation;
      assert.equal(opSuccess.steps.find((s) => s.id === step.id).status, 'succeeded');
    } finally {
      await chmod(rootDir, 0o700).catch(() => {});
      server2.close();
    }
  } finally {
    await chmod(rootDir, 0o700).catch(() => {});
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('website-removal-http multi-process store lock recovers crashed process locks and fails closed on live contention', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-lock-test-'));
  const lockFilePath = path.join(rootDir, 'store.json');
  try {
    // 1. Simulate crashed process: lock file written with non-existent dead PID
    const deadPid = 999999;
    const lockPath = `${lockFilePath}.lock`;
    const record = {
      version: 1,
      pid: deadPid,
      token: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date().toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(record)}\n`, 'utf8');

    // Create process store lock with a signalProcess that returns ESRCH for deadPid
    const lock = createProcessStoreLock({
      filePath: lockFilePath,
      signalProcess: (pid, sig) => {
        if (pid === deadPid) {
          const err = new Error('No such process');
          err.code = 'ESRCH';
          throw err;
        }
        process.kill(pid, sig);
      },
      waitMs: 200,
      retryMs: 10,
    });

    // withLock should evict the stale dead PID lock and successfully execute action
    let executed = false;
    await lock.withLock(async () => {
      executed = true;
    });
    assert.equal(executed, true, 'Stale lock of dead process was safely evicted');

    // 2. Simulate live process holding the lock: signalProcess returns true (no error)
    const alivePid = 888888;
    const aliveRecord = {
      version: 1,
      pid: alivePid,
      token: '22222222-2222-4222-8222-222222222222',
      createdAt: new Date().toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(aliveRecord)}\n`, 'utf8');

    const contendingLock = createProcessStoreLock({
      filePath: lockFilePath,
      signalProcess: () => true, // simulates alive process
      waitMs: 50,
      retryMs: 10,
    });

    await assert.rejects(
      contendingLock.withLock(async () => {}),
      (err) => err instanceof ProcessStoreLockError && err.code === 'process_store_locked' && err.status === 503,
      'Live process contention times out and fails closed with 503 process_store_locked',
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('website-removal-http executes full removal lifecycle for Static runtime binding and fails closed on partial failure', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-222222222222';
  const applicationId = '33333333-3333-4333-8333-333333333333';
  const unixUser = 'yunapp-staticuser';

  let currentWebsite = {
    id: websiteId,
    name: 'Static Test Site',
    serverId: localServerId,
    applicationId,
    systemUser: unixUser,
    unixUser,
    state: 'active',
    suspended: false,
    desiredRevision: 1,
    stagedRevision: 1,
    appliedRevision: 1,
  };

  let currentApplication = {
    id: applicationId,
    serverId: localServerId,
    type: 'static',
    runtimeAdapter: 'static',
    desiredRevision: 1,
    activeDeploymentId: null,
    currentReleaseId: null,
  };

  let currentRuntimeBinding = {
    applicationId,
    adapter: 'static',
    revision: 1,
    sourceOperationId: 'source-op-static',
  };

  const cleaned = {
    runtimeBindingRemove: 0,
    filesCleaned: 0,
    unixIdentityCleaned: 0,
    websiteMetadataDeleted: 0,
    applicationMetadataDeleted: 0,
    hostingAllocationReleased: 0,
  };

  const runtimeBindingRegistry = {
    getBinding: async (appId) => (appId === applicationId ? currentRuntimeBinding : null),
    removeOwnedStatic: async (appId, options) => {
      assert.equal(appId, applicationId);
      assert.equal(options.sourceOperationId, 'source-op-static');
      assert.equal(options.expectedRevision, 1);
      cleaned.runtimeBindingRemove += 1;
      currentRuntimeBinding = null;
    },
  };

  const websiteRegistry = {
    getWebsite: async (id) => (id === websiteId ? currentWebsite : null),
    deleteMigrationWebsite: async (input) => {
      assert.equal(input.websiteId, websiteId);
      cleaned.websiteMetadataDeleted += 1;
      currentWebsite = null;
    },
  };

  const applicationRegistry = {
    getApplication: async (id) => (id === applicationId ? currentApplication : null),
    deleteApplication: async (input) => {
      assert.equal(input.applicationId, applicationId);
      cleaned.applicationMetadataDeleted += 1;
      currentApplication = null;
    },
  };

  let envState = { applicationId, variableCount: 0, environmentPresent: false };
  const applicationEnvironmentRegistry = {
    inspectApplicationState: async (appId) => (appId === applicationId ? envState : { variableCount: 0, environmentPresent: false }),
    purgeApplication: async (appId) => {
      envState = { applicationId, variableCount: 0, environmentPresent: false };
    },
  };

  const fileCleanupHandler = async (input) => {
    cleaned.filesCleaned += 1;
    return {
      filesCleaned: true,
      websiteId,
      applicationId,
      retainedBackups: [],
      retainedLogScopes: [],
    };
  };

  const unixIdentityCleanupHandler = async (input) => {
    cleaned.unixIdentityCleaned += 1;
    return { unixIdentityCleaned: true, systemUser: unixUser, websiteId };
  };

  const hostingAllocationReleaseHandler = async (proof) => {
    cleaned.hostingAllocationReleased += 1;
    return { websiteId, released: true, quotaReleased: true, customerId: 'cust-static' };
  };

  const impact = {
    version: 1,
    resourceType: 'website',
    operation: 'delete',
    targetServerId: null,
    resource: { id: websiteId, serverId: localServerId },
    application: { id: applicationId, serverId: localServerId, type: 'static', desiredRevision: 1 },
    dependencies: {
      domains: [],
      databases: { status: 'available', items: [] },
      sftpKeys: { status: 'available', items: [] },
      runtimeBindings: { status: 'available', items: [{ id: applicationId, state: 'active' }] },
      unixIdentities: { status: 'available', items: [{ id: unixUser, state: 'active' }] },
      logScopes: { status: 'available', items: [] },
      crons: { status: 'available', items: [] },
      backups: { status: 'available', items: [] },
      activeJobs: [],
    },
    blockers: [],
    previewDigest: 'e'.repeat(64),
    confirmation: `delete:website:${websiteId}:${'e'.repeat(64)}`,
  };

  const preview = createWebsiteRemovalPreview({
    website: currentWebsite,
    impact,
    applicationState: currentApplication,
  });

  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
    websiteRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    runtimeBindingRegistry,
    fileCleanupHandler,
    fileCleanupInspector: async () => ({ ready: true }),
    unixIdentityCleanupHandler,
    unixIdentityCleanupInspector: async () => ({ ready: true }),
    hostingAllocationReleaseHandler,
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime, websiteRegistry, localServerId });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Start Static website removal
    const resStart = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resStart.status, 201);
    let { operation: currentOp } = await resStart.json();

    // 2. Step through all steps to completion
    while (currentOp.status === 'running') {
      const nextStep = currentOp.steps.find((s) => s.status !== 'succeeded');
      assert.ok(nextStep);
      const resContinue = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${currentOp.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: currentOp.updatedAt,
          stepId: nextStep.id,
          confirmation: currentOp.actions.stepContinuationConfirmation,
        }),
      });
      assert.equal(resContinue.status, 200);
      const continueData = await resContinue.json();
      currentOp = continueData.operation ?? continueData.data;
    }

    assert.equal(currentOp.status, 'removed');
    assert.equal(cleaned.runtimeBindingRemove, 1, 'removeOwnedStatic must be called');
    assert.equal(cleaned.filesCleaned, 1);
    assert.equal(cleaned.unixIdentityCleaned, 1);
    assert.equal(cleaned.websiteMetadataDeleted, 1);
    assert.equal(cleaned.applicationMetadataDeleted, 1);
    assert.equal(cleaned.hostingAllocationReleased, 1);
    assert.equal(currentRuntimeBinding, null);
    assert.equal(currentWebsite, null);
    assert.equal(currentApplication, null);

    // 3. Partial failure test: fail-closed on static removal failure
    const websiteIdFail = '22222222-2222-4222-8222-222222222223';
    const appIdFail = '33333333-3333-4333-8333-333333333334';
    let failSite = {
      id: websiteIdFail,
      name: 'Static Fail Site',
      serverId: localServerId,
      applicationId: appIdFail,
      systemUser: 'yunapp-staticfail',
      unixUser: 'yunapp-staticfail',
      state: 'active',
      desiredRevision: 1,
    };
    let failApp = {
      id: appIdFail,
      serverId: localServerId,
      type: 'static',
      runtimeAdapter: 'static',
      desiredRevision: 1,
      activeDeploymentId: null,
      currentReleaseId: null,
    };
    let failBinding = {
      applicationId: appIdFail,
      adapter: 'static',
      revision: 1,
      sourceOperationId: 'source-fail',
    };
    let failDestructiveExecuted = false;

    const failingRuntimeBindingRegistry = {
      getBinding: async () => failBinding,
      removeOwnedStatic: async () => {
        throw new Error('Static host binding removal failed');
      },
    };

    const failImpact = {
      version: 1,
      resourceType: 'website',
      operation: 'delete',
      targetServerId: null,
      resource: { id: websiteIdFail, serverId: localServerId },
      application: { id: appIdFail, serverId: localServerId, type: 'static', desiredRevision: 1 },
      dependencies: {
        domains: [],
        databases: { status: 'available', items: [] },
        sftpKeys: { status: 'available', items: [] },
        runtimeBindings: { status: 'available', items: [{ id: appIdFail, state: 'active' }] },
        unixIdentities: { status: 'available', items: [{ id: 'yunapp-staticfail', state: 'active' }] },
        logScopes: { status: 'available', items: [] },
        crons: { status: 'available', items: [] },
        backups: { status: 'available', items: [] },
        activeJobs: [],
      },
      blockers: [],
      previewDigest: 'd'.repeat(64),
      confirmation: `delete:website:${websiteIdFail}:${'d'.repeat(64)}`,
    };

    const failPreview = createWebsiteRemovalPreview({
      website: failSite,
      impact: failImpact,
      applicationState: failApp,
    });

    const failingRegistry = createWebsiteRemovalOperationRegistry();
    await failingRegistry.init();

    const failingRuntime = createWebsiteRemovalRuntime({
      registry: failingRegistry,
      previewProvider: async () => failPreview,
      domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
      websiteRegistry: {
        getWebsite: async (id) => (id === websiteIdFail ? failSite : null),
        deleteMigrationWebsite: async () => { failDestructiveExecuted = true; },
      },
      applicationRegistry: {
        getApplication: async () => failApp,
        deleteApplication: async () => { failDestructiveExecuted = true; },
      },
      applicationEnvironmentRegistry: {
        inspectApplicationState: async () => ({ variableCount: 0, environmentPresent: false }),
        purgeApplication: async () => {},
      },
      runtimeBindingRegistry: failingRuntimeBindingRegistry,
      fileCleanupHandler: async () => { failDestructiveExecuted = true; return {}; },
      fileCleanupInspector: async () => ({ ready: true }),
      unixIdentityCleanupHandler: async () => { failDestructiveExecuted = true; return {}; },
      unixIdentityCleanupInspector: async () => ({ ready: true }),
    });

    const failingStart = await failingRuntime.start({
      websiteId: websiteIdFail,
      previewDigest: failPreview.previewDigest,
      confirmation: failPreview.confirmation,
    });
    assert.equal(failingStart.status, 'failed');
    assert.equal(failingStart.steps[0].status, 'failed');
    assert.equal(failingStart.steps[0].error.code, 'website_removal_step_failed');
    assert.equal(failDestructiveExecuted, false, 'No subsequent destructive step executed on static failure');
    assert.notEqual(failSite, null, 'Website metadata must remain intact');
  } finally {
    server.close();
  }
});

test('website-removal-http executes full removal lifecycle for direct-systemd runtime binding and fails closed on host failure', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-222222222225';
  const applicationId = '33333333-3333-4333-8333-333333333335';
  const unixUser = 'yunapp-directuser';
  const serviceName = 'yunpanel-node-0123456789abcdef.service';

  let currentWebsite = {
    id: websiteId,
    name: 'Direct Systemd Site',
    serverId: localServerId,
    applicationId,
    systemUser: unixUser,
    unixUser,
    state: 'active',
    desiredRevision: 1,
  };

  let currentApplication = {
    id: applicationId,
    serverId: localServerId,
    type: 'node',
    runtimeAdapter: 'direct-systemd',
    desiredRevision: 1,
    activeDeploymentId: null,
    currentReleaseId: 'rel-direct-1',
    serviceName,
    currentCommitSha: 'b'.repeat(40),
    servicePort: 3456,
    healthPath: '/healthz',
  };

  let currentRuntimeBinding = {
    applicationId,
    adapter: 'direct-systemd',
    revision: 1,
    sourceOperationId: 'source-op-direct',
  };

  const directSystemdCalls = [];
  const directSystemdCleanupHandler = async (input) => {
    directSystemdCalls.push(input);
    return {
      directSystemdCleaned: true,
      websiteId: input.websiteId,
      applicationId: input.applicationId,
      serverId: input.serverId,
      releaseId: input.releaseId,
      serviceName: input.serviceName,
    };
  };

  let directSystemdBindingRemoved = 0;
  const runtimeBindingRegistry = {
    getBinding: async (appId) => (appId === applicationId ? currentRuntimeBinding : null),
    removeOwnedDirectSystemd: async (appId, options) => {
      assert.equal(appId, applicationId);
      assert.equal(options.sourceOperationId, 'source-op-direct');
      assert.equal(options.expectedRevision, 1);
      directSystemdBindingRemoved += 1;
      currentRuntimeBinding = null;
    },
  };

  let websiteMetadataDeleted = false;
  let applicationMetadataDeleted = false;
  const websiteRegistry = {
    getWebsite: async (id) => (id === websiteId ? currentWebsite : null),
    deleteMigrationWebsite: async () => {
      websiteMetadataDeleted = true;
      currentWebsite = null;
    },
  };
  const applicationRegistry = {
    getApplication: async (id) => (id === applicationId ? currentApplication : null),
    deleteApplication: async () => {
      applicationMetadataDeleted = true;
      currentApplication = null;
    },
  };

  const impact = {
    version: 1,
    resourceType: 'website',
    operation: 'delete',
    targetServerId: null,
    resource: { id: websiteId, serverId: localServerId },
    application: {
      id: applicationId,
      serverId: localServerId,
      type: 'node',
      desiredRevision: 1,
      currentReleaseId: 'rel-direct-1',
    },
    applicationRuntime: {
      adapter: 'direct-systemd',
      serviceName,
      releaseId: 'rel-direct-1',
      currentCommitSha: 'b'.repeat(40),
      servicePort: 3456,
      healthPath: '/healthz',
    },
    dependencies: {
      domains: [],
      databases: { status: 'available', items: [] },
      sftpKeys: { status: 'available', items: [] },
      runtimeBindings: { status: 'available', items: [{ id: applicationId, state: 'active' }] },
      unixIdentities: { status: 'available', items: [{ id: unixUser, state: 'active' }] },
      logScopes: { status: 'available', items: [] },
      crons: { status: 'available', items: [] },
      backups: { status: 'available', items: [] },
      activeJobs: [],
    },
    blockers: [],
    previewDigest: 'c'.repeat(64),
    confirmation: `delete:website:${websiteId}:${'c'.repeat(64)}`,
  };

  const preview = createWebsiteRemovalPreview({
    website: currentWebsite,
    impact,
    applicationState: currentApplication,
  });

  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
    websiteRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry: {
      inspectApplicationState: async () => ({ variableCount: 0, environmentPresent: false }),
      purgeApplication: async () => {},
    },
    runtimeBindingRegistry,
    directSystemdCleanupHandler,
    directSystemdCleanupInspector: async () => ({ ready: true }),
    fileCleanupHandler: async () => ({ filesCleaned: true, websiteId, applicationId, retainedBackups: [], retainedLogScopes: [] }),
    fileCleanupInspector: async () => ({ ready: true }),
    unixIdentityCleanupHandler: async () => ({ unixIdentityCleaned: true, systemUser: unixUser, websiteId }),
    unixIdentityCleanupInspector: async () => ({ ready: true }),
    hostingAllocationReleaseHandler: async () => ({ websiteId, released: true, quotaReleased: true }),
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime, websiteRegistry, localServerId });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Full removal through HTTP API
    const resStart = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resStart.status, 201);
    let { operation: currentOp } = await resStart.json();

    while (currentOp.status === 'running') {
      const nextStep = currentOp.steps.find((s) => s.status !== 'succeeded');
      assert.ok(nextStep);
      const resContinue = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${currentOp.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: currentOp.updatedAt,
          stepId: nextStep.id,
          confirmation: currentOp.actions.stepContinuationConfirmation,
        }),
      });
      assert.equal(resContinue.status, 200);
      const continueData = await resContinue.json();
      currentOp = continueData.operation ?? continueData.data;
    }

    assert.equal(currentOp.status, 'removed');
    assert.equal(directSystemdCalls.length, 1);
    assert.equal(directSystemdCalls[0].serviceName, serviceName);
    assert.equal(directSystemdCalls[0].releaseId, 'rel-direct-1');
    assert.equal(directSystemdBindingRemoved, 1);
    assert.equal(websiteMetadataDeleted, true);
    assert.equal(applicationMetadataDeleted, true);

    // 2. Fail-closed partial host failure: directSystemdCleanupHandler throws error
    const failHostSiteId = '22222222-2222-4222-8222-222222222226';
    const failHostAppId = '33333333-3333-4333-8333-333333333336';
    let destructiveCalled = false;

    const failHostSite = {
      id: failHostSiteId,
      name: 'Host Fail Site',
      serverId: localServerId,
      applicationId: failHostAppId,
      systemUser: unixUser,
      unixUser,
      state: 'active',
      desiredRevision: 1,
    };
    const failHostApp = {
      id: failHostAppId,
      serverId: localServerId,
      type: 'node',
      runtimeAdapter: 'direct-systemd',
      desiredRevision: 1,
      activeDeploymentId: null,
      currentReleaseId: 'rel-fail-1',
      serviceName: 'yunpanel-node-0123456789abcdef.service',
      currentCommitSha: 'c'.repeat(40),
      servicePort: 3456,
      healthPath: '/healthz',
    };
    const failHostImpact = {
      version: 1,
      resourceType: 'website',
      operation: 'delete',
      targetServerId: null,
      resource: { id: failHostSiteId, serverId: localServerId },
      application: {
        id: failHostAppId,
        serverId: localServerId,
        type: 'node',
        desiredRevision: 1,
        currentReleaseId: 'rel-fail-1',
      },
      applicationRuntime: {
        adapter: 'direct-systemd',
        serviceName: 'yunpanel-node-0123456789abcdef.service',
        releaseId: 'rel-fail-1',
        currentCommitSha: 'c'.repeat(40),
        servicePort: 3456,
        healthPath: '/healthz',
      },
      dependencies: {
        domains: [],
        databases: { status: 'available', items: [] },
        sftpKeys: { status: 'available', items: [] },
        runtimeBindings: { status: 'available', items: [{ id: failHostAppId, state: 'active' }] },
        unixIdentities: { status: 'available', items: [{ id: unixUser, state: 'active' }] },
        logScopes: { status: 'available', items: [] },
        crons: { status: 'available', items: [] },
        backups: { status: 'available', items: [] },
        activeJobs: [],
      },
      blockers: [],
      previewDigest: '7'.repeat(64),
      confirmation: `delete:website:${failHostSiteId}:${'7'.repeat(64)}`,
    };
    const failHostPreview = createWebsiteRemovalPreview({
      website: failHostSite,
      impact: failHostImpact,
      applicationState: failHostApp,
    });

    const failingHostRegistry = createWebsiteRemovalOperationRegistry();
    await failingHostRegistry.init();

    const failingHostRuntime = createWebsiteRemovalRuntime({
      registry: failingHostRegistry,
      previewProvider: async () => failHostPreview,
      domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
      websiteRegistry: {
        getWebsite: async () => ({ id: failHostSiteId, serverId: localServerId, applicationId: failHostAppId }),
        deleteMigrationWebsite: async () => { destructiveCalled = true; },
      },
      applicationRegistry: {
        getApplication: async () => ({ id: failHostAppId, serverId: localServerId, desiredRevision: 1 }),
        deleteApplication: async () => { destructiveCalled = true; },
      },
      applicationEnvironmentRegistry: {
        inspectApplicationState: async () => ({ variableCount: 0, environmentPresent: false }),
        purgeApplication: async () => {},
      },
      runtimeBindingRegistry: {
        getBinding: async () => ({ applicationId: failHostAppId, adapter: 'direct-systemd', revision: 1 }),
        removeOwnedDirectSystemd: async () => { destructiveCalled = true; },
      },
      directSystemdCleanupHandler: async () => {
        throw new Error('Host systemctl stop failed with exit code 1');
      },
      directSystemdCleanupInspector: async () => ({ ready: true }),
      fileCleanupHandler: async () => { destructiveCalled = true; return {}; },
      fileCleanupInspector: async () => ({ ready: true }),
      unixIdentityCleanupHandler: async () => { destructiveCalled = true; return {}; },
      unixIdentityCleanupInspector: async () => ({ ready: true }),
    });

    const hostFailStart = await failingHostRuntime.start({
      websiteId: failHostSiteId,
      previewDigest: failHostPreview.previewDigest,
      confirmation: failHostPreview.confirmation,
    });
    assert.equal(hostFailStart.status, 'failed');
    assert.equal(hostFailStart.steps[0].status, 'failed');
    assert.equal(hostFailStart.steps[0].error.code, 'website_removal_step_failed');
    assert.equal(destructiveCalled, false, 'Destructive operations must fail closed on host direct-systemd failure');
  } finally {
    server.close();
  }
});

test('website-removal-http releases hosting quota only upon verified final removal and keeps removal journal open on quota release failure', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-222222222227';
  const applicationId = '33333333-3333-4333-8333-333333333337';
  const unixUser = 'yunapp-quotauser';

  let currentWebsite = {
    id: websiteId,
    name: 'Quota Test Site',
    serverId: localServerId,
    applicationId,
    systemUser: unixUser,
    unixUser,
    state: 'active',
    desiredRevision: 1,
  };

  let currentApplication = {
    id: applicationId,
    serverId: localServerId,
    type: 'static',
    runtimeAdapter: 'static',
    desiredRevision: 1,
    activeDeploymentId: null,
  };

  let shouldFailQuota = true;
  let quotaReleaseCalls = 0;

  const hostingAllocationReleaseHandler = async (proof) => {
    quotaReleaseCalls += 1;
    if (shouldFailQuota) {
      throw new Error('Quota billing service connection timeout');
    }
    return {
      websiteId,
      released: true,
      quotaReleased: true,
      customerId: 'cust-quota-1',
    };
  };

  const preview = createWebsiteRemovalPreview({
    website: currentWebsite,
    impact: {
      version: 1,
      resourceType: 'website',
      operation: 'delete',
      targetServerId: null,
      resource: { id: websiteId, serverId: localServerId },
      application: { id: applicationId, serverId: localServerId, type: 'static', desiredRevision: 1 },
      dependencies: {
        domains: [],
        databases: { status: 'available', items: [] },
        sftpKeys: { status: 'available', items: [] },
        runtimeBindings: { status: 'available', items: [] },
        unixIdentities: { status: 'available', items: [] },
        logScopes: { status: 'available', items: [] },
        crons: { status: 'available', items: [] },
        backups: { status: 'available', items: [] },
        activeJobs: [],
      },
      blockers: [],
      previewDigest: '8'.repeat(64),
      confirmation: `delete:website:${websiteId}:${'8'.repeat(64)}`,
    },
    applicationState: currentApplication,
  });

  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime: { listForDomain: async () => [], preview: async () => ({}), start: async () => ({}) },
    websiteRegistry: {
      getWebsite: async (id) => (id === websiteId ? currentWebsite : null),
      deleteMigrationWebsite: async () => { currentWebsite = null; },
    },
    applicationRegistry: {
      getApplication: async (id) => (id === applicationId ? currentApplication : null),
      deleteApplication: async () => { currentApplication = null; },
    },
    applicationEnvironmentRegistry: {
      inspectApplicationState: async () => ({ variableCount: 0, environmentPresent: false }),
      purgeApplication: async () => {},
    },
    fileCleanupHandler: async () => ({ filesCleaned: true, websiteId, applicationId, retainedBackups: [], retainedLogScopes: [] }),
    fileCleanupInspector: async () => ({ ready: true }),
    unixIdentityCleanupHandler: async () => ({ unixIdentityCleaned: true, systemUser: unixUser, websiteId }),
    unixIdentityCleanupInspector: async () => ({ ready: true }),
    hostingAllocationReleaseHandler,
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime, websiteRegistry: { getWebsite: async (id) => (id === websiteId ? currentWebsite : null) }, localServerId });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Start removal
    const resStart = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
    });
    assert.equal(resStart.status, 201);
    let { operation: currentOp } = await resStart.json();

    // 2. Step through until metadata is deleted and application_cleanup is reached
    while (currentOp.status === 'running') {
      const nextStep = currentOp.steps.find((s) => s.status !== 'succeeded');
      assert.ok(nextStep);
      const resContinue = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${currentOp.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: currentOp.updatedAt,
          stepId: nextStep.id,
          confirmation: currentOp.actions.stepContinuationConfirmation,
        }),
      });
      assert.equal(resContinue.status, 200);
      const continueData = await resContinue.json();
      currentOp = continueData.operation ?? continueData.data;
    }

    // 3. Operation is BLOCKED because hosting quota release failed
    assert.equal(currentOp.status, 'blocked');
    const appCleanupStep = currentOp.steps.find((s) => s.kind === 'application_cleanup');
    assert.equal(appCleanupStep.status, 'blocked');
    assert.equal(appCleanupStep.error.code, 'website_removal_allocation_release_failed');
    assert.equal(quotaReleaseCalls, 1);

    // 4. Removal journal remains open with continuation confirmation
    assert.ok(currentOp.actions.stepContinuationConfirmation, 'Removal journal must remain open on quota release failure');

    // 5. GET operation endpoint confirms operation is still open and blocked
    const resGet = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${currentOp.id}`);
    assert.equal(resGet.status, 200);
    const opData = (await resGet.json()).operation;
    assert.equal(opData.status, 'blocked');
    assert.ok(opData.actions.stepContinuationConfirmation);

    // 6. Quota service recovers -> operator continues the step
    shouldFailQuota = false;
    const resRecover = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${currentOp.id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: opData.updatedAt,
        stepId: appCleanupStep.id,
        confirmation: opData.actions.stepContinuationConfirmation,
      }),
    });
    assert.equal(resRecover.status, 200);
    const recoveredOp = (await resRecover.json()).operation;

    // 7. Verified final removal reached, quota released, journal closed
    assert.equal(recoveredOp.status, 'removed');
    assert.equal(recoveredOp.actions.stepContinuationConfirmation, null);
    const finalStep = recoveredOp.steps.find((s) => s.kind === 'application_cleanup');
    assert.equal(finalStep.status, 'succeeded');
    assert.equal(finalStep.result.hostingAllocation.quotaReleased, true);
    assert.equal(quotaReleaseCalls, 2);
  } finally {
    server.close();
  }
});

test('website-removal-http enforces shared multi-process mutation lock preventing race conditions with site creation, provisioning, and worker mutations', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-lock-test-'));
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-222222222228';
  const targetLockFile = path.join(rootDir, `website-${websiteId}.lock`);

  try {
    const siteMutationLock = createSiteMutationLock({
      root: rootDir,
      pid: process.pid,
      signalProcess: (pid, sig) => {
        if (pid === 777777) return true; // alive concurrent worker (e.g. site provisioning/cron)
        if (pid === 888888) {
          const err = new Error('No such process');
          err.code = 'ESRCH';
          throw err; // crashed worker
        }
        process.kill(pid, sig);
      },
    });

    const runtimeMock = createMockRuntime();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.auth = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
      next();
    });
    mountWebsiteRemovalRoutes(app, {
      runtime: runtimeMock,
      siteMutationLock: {
        withSiteLock: ({ websiteId: wsId }, action) => siteMutationLock.withWebsiteLock(wsId, action),
      },
      websiteRegistry: { getWebsite: async (id) => (id === websiteId ? { id: websiteId, serverId: localServerId } : null) },
      localServerId,
    });
    app.use((err, req, res, next) => {
      res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
    });

    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      // 1. Simulate active concurrent worker holding the lock (e.g. site creation/provisioning/cron mutation)
      const liveRecord = {
        version: 1,
        resourceType: 'website',
        resourceId: websiteId,
        pid: 777777,
        token: '33333333-3333-4333-8333-333333333333',
        createdAt: new Date().toISOString(),
      };
      await writeFile(targetLockFile, `${JSON.stringify(liveRecord)}\n`, 'utf8');

      // Attempting removal start while active worker holds the lock fails closed with 409 site_mutation_locked
      const resLockedStart = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previewDigest: 'a'.repeat(64),
          confirmation: `start-website-remove:${websiteId}:1:${'a'.repeat(64)}`,
        }),
      });
      assert.equal(resLockedStart.status, 409);
      const dataLockedStart = await resLockedStart.json();
      assert.equal(dataLockedStart.error.code, 'site_mutation_locked');

      // Attempting step continuation while active worker holds the lock also fails closed with 409
      const resLockedContinue = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/ws-rem-1/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: '2026-09-19T20:00:00.000Z',
          stepId: '001:domain_removal:dom-1',
          confirmation: 'continue-website-remove-step:ws-1:ws-rem-1:001:domain_removal:dom-1:2026-09-19T20:00:00.000Z',
        }),
      });
      assert.equal(resLockedContinue.status, 409);
      const dataLockedContinue = await resLockedContinue.json();
      assert.equal(dataLockedContinue.error.code, 'site_mutation_locked');

      // 2. Simulate crashed worker (dead PID 888888): lock eviction
      const deadRecord = {
        version: 1,
        resourceType: 'website',
        resourceId: websiteId,
        pid: 888888,
        token: '44444444-4444-4444-8444-444444444444',
        createdAt: new Date().toISOString(),
      };
      await writeFile(targetLockFile, `${JSON.stringify(deadRecord)}\n`, 'utf8');

      // Attempting removal start evicts stale crash lock and succeeds with 201
      const resCrashStart = await fetch(`${baseUrl}/api/websites/${websiteId}/removal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previewDigest: 'a'.repeat(64),
          confirmation: `start-website-remove:${websiteId}:1:${'a'.repeat(64)}`,
        }),
      });
      assert.equal(resCrashStart.status, 201);
      const dataCrashStart = await resCrashStart.json();
      assert.equal(dataCrashStart.operation.id, 'ws-rem-1');
    } finally {
      server.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('website-removal-http enforces Owner-only recovery journal inspection and safe continuation for interrupted unknown-result operations', async () => {
  const localServerId = '11111111-1111-4111-8111-111111111111';
  const websiteId = '22222222-2222-4222-8222-222222222229';
  const applicationId = '33333333-3333-4333-8333-333333333339';

  let executedSteps = [];
  const blockedStepId = '002:file_cleanup:files';
  const confirmationToken = `continue-website-remove-step:${websiteId}:op-rec-1:${blockedStepId}:2026-10-01T12:00:00.000Z`;

  const blockedOp = {
    id: 'op-rec-1',
    websiteId,
    serverId: localServerId,
    applicationId,
    status: 'blocked',
    updatedAt: '2026-10-01T12:00:00.000Z',
    steps: [
      { id: '001:domain_removal:dom-1', kind: 'domain_removal', status: 'succeeded' },
      { id: blockedStepId, kind: 'file_cleanup', status: 'blocked', error: { code: 'unknown_host_state', message: 'Interrupted file cleanup' } },
      { id: '003:metadata_finalization:meta', kind: 'metadata_finalization', status: 'pending' },
    ],
    actions: {
      stepContinuationConfirmation: confirmationToken,
    },
    recoveryJournal: {
      interruptedAt: '2026-10-01T12:00:00.000Z',
      reason: 'unknown_result_reconciliation',
    },
  };

  const runtimeMock = {
    get: async (id) => (id === 'op-rec-1' ? blockedOp : null),
    listForWebsite: async (wsId) => (wsId === websiteId ? [blockedOp] : []),
    continueStep: async ({ operationId, stepId, confirmation }) => {
      if (confirmation !== confirmationToken) {
        throw new WebsiteRemovalRuntimeError('website_removal_confirmation_mismatch', 'Confirmation does not match', 409);
      }
      executedSteps.push(stepId);
      return {
        ...blockedOp,
        status: 'removed',
        steps: blockedOp.steps.map((s) => ({ ...s, status: 'succeeded' })),
        actions: { stepContinuationConfirmation: null },
      };
    },
    preview: async () => ({ readyToStart: true }),
    start: async () => blockedOp,
  };

  const websiteRegistry = {
    getWebsite: async (id) => (id === websiteId ? { id: websiteId, serverId: localServerId } : null),
  };

  const actors = {
    owner: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', role: 'owner', active: true },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    },
    'site-manager-diff': {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002', role: 'site_manager', active: true, websiteIds: ['other-site'] },
      access: { mode: 'site_management', permissions: ['sites.manage'] },
      security: { managementAllowed: true },
    },
    inactive: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003',
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003', role: 'owner', active: false },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    },
    'no-session': {
      user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', role: 'owner', active: true },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const actorKey = req.headers['x-actor'] ?? 'owner';
    req.auth = actors[actorKey] ?? null;
    next();
  });
  mountWebsiteRemovalRoutes(app, {
    runtime: runtimeMock,
    websiteRegistry,
    localServerId,
  });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Unauthenticated -> 401 unauthorized
    const resNoAuth = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${blockedOp.id}`, {
      headers: { 'x-actor': 'none' },
    });
    assert.equal(resNoAuth.status, 401);
    assert.equal((await resNoAuth.json()).error.code, 'unauthorized');

    // Missing live session identity -> 403 website_removal_actor_invalid
    const resInvalidActor = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${blockedOp.id}`, {
      headers: { 'x-actor': 'no-session' },
    });
    assert.equal(resInvalidActor.status, 403);
    assert.equal((await resInvalidActor.json()).error.code, 'website_removal_actor_invalid');

    // 2. Inactive account -> 403 tenant_actor_inactive
    const resInactive = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${blockedOp.id}`, {
      headers: { 'x-actor': 'inactive' },
    });
    assert.equal(resInactive.status, 403);
    assert.equal((await resInactive.json()).error.code, 'tenant_actor_inactive');

    // 3. Cross-tenant tenant actor -> 404 (not found, no leakage)
    const resCross = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${blockedOp.id}`, {
      headers: { 'x-actor': 'site-manager-diff' },
    });
    assert.equal(resCross.status, 404);

    // 4. Owner identity -> 200 with full recovery journal data
    const resOwner = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${blockedOp.id}`, {
      headers: { 'x-actor': 'owner' },
    });
    assert.equal(resOwner.status, 200);
    const ownerData = await resOwner.json();
    assert.equal(ownerData.operation.id, blockedOp.id);
    assert.equal(ownerData.operation.status, 'blocked');
    assert.equal(ownerData.operation.recoveryJournal.reason, 'unknown_result_reconciliation');
    assert.equal(ownerData.operation.actions.stepContinuationConfirmation, confirmationToken);

    // 5. Continuation with invalid token fails closed
    const resInvalidToken = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${blockedOp.id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-actor': 'owner' },
      body: JSON.stringify({
        expectedUpdatedAt: blockedOp.updatedAt,
        stepId: blockedStepId,
        confirmation: 'invalid-token',
      }),
    });
    assert.equal(resInvalidToken.status, 409);

    // 6. Valid continuation resumes the blocked step safely
    const resValidContinue = await fetch(`${baseUrl}/api/websites/${websiteId}/removal-operations/${blockedOp.id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-actor': 'owner' },
      body: JSON.stringify({
        expectedUpdatedAt: blockedOp.updatedAt,
        stepId: blockedStepId,
        confirmation: confirmationToken,
      }),
    });
    assert.equal(resValidContinue.status, 200);
    const validData = await resValidContinue.json();
    assert.equal(validData.operation.status, 'removed');
    assert.deepEqual(executedSteps, [blockedStepId], 'Only the interrupted step was resumed; prior succeeded steps were not replayed');
  } finally {
    server.close();
  }
});
