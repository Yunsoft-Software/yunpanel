import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  WebsiteDatabaseDataHttpError,
  mountWebsiteDatabaseDataRoutes,
} from '../src/website-database-data-http.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const otherWebsiteId = '32345678-1234-4234-8234-123456789012';
const applicationId = '42345678-1234-4234-8234-123456789012';
const otherApplicationId = '52345678-1234-4234-8234-123456789012';
const bindingId = '62345678-1234-4234-8234-123456789012';
const backupId = '72345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';
const previewDigest = 'a'.repeat(64);
const backupSha256 = 'b'.repeat(64);

function binding(overrides = {}) {
  return {
    id: bindingId,
    serverId,
    websiteId,
    applicationId,
    databaseName,
    unixUser: 'yunapp-abcdef123456',
    revision: 7,
    ...overrides,
  };
}

function mounted({ currentBinding = binding() } = {}) {
  const routes = [];
  const enqueued = [];
  const operationCalls = [];
  const idleCalls = [];
  const app = {
    post(path, ...handlers) { routes.push([path, handlers]); },
  };
  const jobRegistry = {
    async listJobs() { return []; },
    async enqueue(input) {
      enqueued.push(structuredClone(input));
      return { id: '82345678-1234-4234-8234-123456789012', ...input, status: 'queued' };
    },
  };
  const databaseBackupOperationsService = {
    async previewRestore(input) {
      operationCalls.push(['preview', structuredClone(input)]);
      return {
        version: 1,
        operation: 'database_restore',
        serverId,
        databaseName,
        backupId,
        backupSha256,
        backupBytes: 4096,
        engine: 'mariadb',
        databaseVersion: '10.11.13-MariaDB',
        websiteId,
        databaseBindingId: bindingId,
        expectedBindingRevision: 7,
        previewDigest,
        confirmation: `restore-database:${databaseName}:${previewDigest}`,
        sideEffects: false,
      };
    },
    async queueRestore(input) {
      operationCalls.push(['queue', structuredClone(input)]);
      return {
        previewDigest,
        backupSha256,
        job: { id: '92345678-1234-4234-8234-123456789012', status: 'queued' },
      };
    },
  };
  mountWebsiteDatabaseDataRoutes(app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    websiteRegistry: {
      async getWebsite(id) {
        if (id === websiteId) return { id, serverId, applicationId };
        if (id === otherWebsiteId) return { id, serverId, applicationId: otherApplicationId };
        return null;
      },
    },
    databaseBindingRegistry: {
      async getBinding(id) { return id === bindingId ? currentBinding : null; },
    },
    jobRegistry,
    ensureDatabaseIdle: async (_registry, id) => { idleCalls.push(id); },
    databaseBackupOperationsService,
  });
  const route = (suffix) => routes.find(([path]) => path.endsWith(suffix))?.[1].at(-1);
  return {
    backup: route('/backup'),
    preview: route('/restore-preview'),
    restore: route('/restore'),
    enqueued,
    operationCalls,
    idleCalls,
  };
}

async function invoke(handler, body, params = {}) {
  let status = 200;
  let payload = null;
  let error = null;
  const headers = {};
  const response = {
    status(value) { status = value; return this; },
    set(name, value) { headers[name.toLowerCase()] = value; return this; },
    json(value) { payload = value; return this; },
  };
  await handler(
    {
      params: {
        serverId,
        websiteId,
        bindingId,
        ...params,
      },
      body,
      query: {},
    },
    response,
    (value) => { error = value; },
  );
  return { status, payload, error, headers };
}

test('Website backup derives schema only from the verified binding and persists ownership evidence', async () => {
  const fx = mounted();
  const response = await invoke(fx.backup, {
    expectedBindingRevision: 7,
    confirmation: `backup-website-database:${bindingId}:7`,
  });

  assert.equal(response.error, null);
  assert.equal(response.status, 202);
  assert.deepEqual(fx.idleCalls, [serverId]);
  assert.deepEqual(fx.enqueued, [{
    serverId,
    type: OPERATIONS.DATABASE_BACKUP,
    operation: OPERATIONS.DATABASE_BACKUP,
    payload: {
      databaseName,
      websiteId,
      databaseBindingId: bindingId,
      expectedBindingRevision: 7,
    },
    resourceType: 'database',
    resourceId: databaseName,
  }]);
  assert.deepEqual(response.payload.data.scope, {
    serverId,
    websiteId,
    applicationId,
    databaseBindingId: bindingId,
    bindingRevision: 7,
    databaseName,
  });
});

test('Website backup rejects stale binding revision and cross-Website binding selection', async () => {
  for (const [params, revision, code] of [
    [{}, 6, 'website_database_binding_revision_conflict'],
    [{ websiteId: otherWebsiteId }, 7, 'database_binding_not_found'],
  ]) {
    const fx = mounted();
    const response = await invoke(fx.backup, {
      expectedBindingRevision: revision,
      confirmation: `backup-website-database:${bindingId}:${revision}`,
    }, params);
    assert.ok(response.error instanceof WebsiteDatabaseDataHttpError);
    assert.equal(response.error.code, code);
    assert.equal(fx.enqueued.length, 0);
  }
});

test('Website restore preview pins current binding ownership into restore evidence', async () => {
  const fx = mounted();
  const response = await invoke(fx.preview, {
    backupId,
    expectedBindingRevision: 7,
  });

  assert.equal(response.error, null);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(fx.operationCalls, [['preview', {
    serverId,
    databaseName,
    backupId,
    ownership: {
      websiteId,
      databaseBindingId: bindingId,
      expectedBindingRevision: 7,
    },
  }]]);
  assert.equal(response.payload.data.scope.databaseBindingId, bindingId);
  assert.equal(response.payload.data.scope.bindingRevision, 7);
});

test('Website restore apply cannot choose a schema and forwards only pinned ownership evidence', async () => {
  const fx = mounted();
  const confirmation = `restore-database:${databaseName}:${previewDigest}`;
  const response = await invoke(fx.restore, {
    backupId,
    expectedBindingRevision: 7,
    expectedPreviewDigest: previewDigest,
    expectedBackupSha256: backupSha256,
    confirmation,
  });

  assert.equal(response.error, null);
  assert.equal(response.status, 202);
  assert.deepEqual(fx.operationCalls, [['queue', {
    serverId,
    databaseName,
    backupId,
    expectedPreviewDigest: previewDigest,
    expectedBackupSha256: backupSha256,
    confirmation,
    ownership: {
      websiteId,
      databaseBindingId: bindingId,
      expectedBindingRevision: 7,
    },
  }]]);
  assert.equal(response.payload.data.scope.databaseName, databaseName);
});

test('Website data routes reject caller-selected database names and extra fields before side effects', async () => {
  for (const [handler, body] of [
    ['backup', {
      expectedBindingRevision: 7,
      confirmation: `backup-website-database:${bindingId}:7`,
      databaseName: 'other_site',
    }],
    ['preview', { backupId, expectedBindingRevision: 7, databaseName: 'other_site' }],
    ['restore', {
      backupId,
      expectedBindingRevision: 7,
      expectedPreviewDigest: previewDigest,
      expectedBackupSha256: backupSha256,
      confirmation: `restore-database:${databaseName}:${previewDigest}`,
      databaseName: 'other_site',
    }],
  ]) {
    const fx = mounted();
    const response = await invoke(fx[handler], body);
    assert.ok(response.error instanceof WebsiteDatabaseDataHttpError);
    assert.equal(fx.enqueued.length, 0);
    assert.equal(fx.operationCalls.length, 0);
  }
});
