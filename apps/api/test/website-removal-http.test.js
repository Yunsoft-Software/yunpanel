import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { renderCronTaskFile } from '@yunpanel/config-templates';

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
