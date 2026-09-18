import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DomainSuspensionHttpError,
  mountDomainSuspensionRoutes,
} from '../src/domain-suspension-http.js';
import { DomainSuspensionRuntimeError } from '../src/domain-suspension-runtime.js';

const domainId = '12345678-1234-4234-8234-123456789012';
const operationId = '22345678-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);
const previewDigest = 'b'.repeat(64);

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, ...handlers) { routes.set('GET ' + route, handlers); },
    post(route, ...handlers) { routes.set('POST ' + route, handlers); },
  };
}

async function invoke(app, key, {
  params = {},
  body = undefined,
  query = {},
} = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, 'route ' + key + ' should be mounted');
  let status = 200;
  let payload = null;
  let forwarded = null;
  const headers = {};
  const response = {
    status(value) { status = value; return this; },
    set(name, value) { headers[name.toLowerCase()] = value; return this; },
    json(value) { payload = value; return this; },
  };
  await handlers.at(-1)(
    { params: { domainId, operationId, ...params }, body, query },
    response,
    (error) => { forwarded = error ?? null; },
  );
  if (forwarded) throw forwarded;
  return { status, payload, headers };
}

function operation(status = 'suspended') {
  return {
    id: operationId,
    domainId,
    checksum,
    status,
    updatedAt: '2026-09-18T16:00:00.000Z',
    actions: {
      suspendRetryConfirmation: status === 'failed' ? 'retry-suspend' : null,
      resumeConfirmation: status === 'suspended' ? 'resume-confirm' : null,
      resumeRetryConfirmation: status === 'resume_failed' ? 'retry-resume' : null,
    },
  };
}

test('Domain suspension HTTP exposes preview, suspend, operation visibility, resume and retries', async () => {
  const calls = [];
  const preview = {
    version: 1,
    operation: 'domain_suspend',
    domain: {
      id: domainId,
      desiredRevision: 4,
      stagedChecksum: checksum,
    },
    blockers: [],
    readyToSuspend: true,
    previewDigest,
    confirmation: 'suspend-confirm',
    sideEffects: false,
  };
  const runtime = {
    preview: async (input) => { calls.push(['preview', input]); return preview; },
    start: async (input) => { calls.push(['start', input]); return operation('suspended'); },
    listForDomain: async (id) => { calls.push(['list', id]); return [operation('suspended')]; },
    get: async (id) => { calls.push(['get', id]); return operation('suspended'); },
    retrySuspend: async (input) => { calls.push(['retrySuspend', input]); return operation('suspended'); },
    resume: async (input) => { calls.push(['resume', input]); return operation('resumed'); },
    retryResume: async (input) => { calls.push(['retryResume', input]); return operation('resumed'); },
  };
  const app = fakeApp();
  mountDomainSuspensionRoutes(app, { runtime });

  const previewResponse = await invoke(app, 'POST /api/domains/:domainId/suspend-preview', {
    body: {},
  });
  assert.equal(previewResponse.status, 200);
  assert.deepEqual(previewResponse.payload, { data: preview });
  assert.equal(previewResponse.headers['cache-control'], 'no-store');

  const suspendResponse = await invoke(app, 'POST /api/domains/:domainId/suspend', {
    body: { previewDigest, confirmation: 'suspend-confirm' },
  });
  assert.equal(suspendResponse.status, 202);
  assert.equal(suspendResponse.payload.data.status, 'suspended');

  const listResponse = await invoke(app, 'GET /api/domains/:domainId/suspension-operations');
  assert.equal(listResponse.headers['cache-control'], 'no-store');
  assert.equal(listResponse.payload.data.length, 1);

  const detailResponse = await invoke(
    app,
    'GET /api/domains/:domainId/suspension-operations/:operationId',
  );
  assert.equal(detailResponse.payload.data.id, operationId);
  assert.equal(detailResponse.headers['cache-control'], 'no-store');

  const commonBody = {
    expectedUpdatedAt: '2026-09-18T16:00:00.000Z',
    checksum,
    confirmation: 'typed-confirmation',
  };
  assert.equal((await invoke(
    app,
    'POST /api/domains/:domainId/suspension-operations/:operationId/suspend-retry',
    { body: commonBody },
  )).status, 202);
  assert.equal((await invoke(
    app,
    'POST /api/domains/:domainId/suspension-operations/:operationId/resume',
    { body: commonBody },
  )).status, 202);
  assert.equal((await invoke(
    app,
    'POST /api/domains/:domainId/suspension-operations/:operationId/resume-retry',
    { body: commonBody },
  )).status, 202);

  assert.deepEqual(calls, [
    ['preview', { domainId }],
    ['start', { domainId, previewDigest, confirmation: 'suspend-confirm' }],
    ['list', domainId],
    ['get', operationId],
    ['retrySuspend', {
      domainId,
      operationId,
      expectedUpdatedAt: commonBody.expectedUpdatedAt,
      checksum,
      confirmation: commonBody.confirmation,
    }],
    ['resume', {
      domainId,
      operationId,
      expectedUpdatedAt: commonBody.expectedUpdatedAt,
      checksum,
      confirmation: commonBody.confirmation,
    }],
    ['retryResume', {
      domainId,
      operationId,
      expectedUpdatedAt: commonBody.expectedUpdatedAt,
      checksum,
      confirmation: commonBody.confirmation,
    }],
  ]);
});

test('Domain suspension HTTP rejects extra fields, query expansion and malformed operation fences', async () => {
  let calls = 0;
  const runtime = {
    preview: async () => { calls += 1; return {}; },
    start: async () => { calls += 1; return {}; },
    listForDomain: async () => { calls += 1; return []; },
    get: async () => { calls += 1; return null; },
    retrySuspend: async () => { calls += 1; return {}; },
    resume: async () => { calls += 1; return {}; },
    retryResume: async () => { calls += 1; return {}; },
  };
  const app = fakeApp();
  mountDomainSuspensionRoutes(app, { runtime });

  for (const [key, request, code] of [
    [
      'POST /api/domains/:domainId/suspend-preview',
      { body: { force: true } },
      'domain_suspension_preview_input_invalid',
    ],
    [
      'POST /api/domains/:domainId/suspend',
      { body: { previewDigest, confirmation: '', force: true } },
      'domain_suspension_input_invalid',
    ],
    [
      'GET /api/domains/:domainId/suspension-operations',
      { query: { include: 'private' } },
      'domain_suspension_query_invalid',
    ],
    [
      'POST /api/domains/:domainId/suspension-operations/:operationId/resume',
      {
        body: {
          expectedUpdatedAt: 'not-a-date',
          checksum,
          confirmation: 'resume',
        },
      },
      'domain_resume_input_invalid',
    ],
  ]) {
    await assert.rejects(
      invoke(app, key, request),
      (error) => error instanceof DomainSuspensionHttpError && error.code === code,
    );
  }
  assert.equal(calls, 0);
});

test('operation detail is scoped to Domain path', async () => {
  const otherDomainId = '42345678-1234-4234-8234-123456789012';
  const runtime = {
    preview: async () => ({}),
    start: async () => ({}),
    listForDomain: async () => [],
    get: async () => operation('suspended'),
    retrySuspend: async () => ({}),
    resume: async () => ({}),
    retryResume: async () => ({}),
  };
  const app = fakeApp();
  mountDomainSuspensionRoutes(app, { runtime });

  await assert.rejects(
    invoke(app, 'GET /api/domains/:domainId/suspension-operations/:operationId', {
      params: { domainId: otherDomainId },
    }),
    (error) => error instanceof DomainSuspensionHttpError
      && error.code === 'domain_suspension_operation_not_found',
  );
});

test('runtime errors are mapped to bounded Domain suspension HTTP errors', async () => {
  const runtime = {
    preview: async () => {
      throw new DomainSuspensionRuntimeError(
        'domain_suspension_job_inventory_unavailable',
        'Active Domain jobs could not be inspected',
        503,
      );
    },
    start: async () => ({}),
    listForDomain: async () => [],
    get: async () => null,
    retrySuspend: async () => ({}),
    resume: async () => ({}),
    retryResume: async () => ({}),
  };
  const app = fakeApp();
  mountDomainSuspensionRoutes(app, { runtime });

  await assert.rejects(
    invoke(app, 'POST /api/domains/:domainId/suspend-preview', { body: {} }),
    (error) => error instanceof DomainSuspensionHttpError
      && error.code === 'domain_suspension_job_inventory_unavailable'
      && error.status === 503,
  );
});

test('route mounting rejects incomplete suspension runtimes', () => {
  const app = fakeApp();
  assert.throws(
    () => mountDomainSuspensionRoutes(app, { runtime: { preview: async () => ({}) } }),
    /Domain suspension runtime is required/,
  );
});
