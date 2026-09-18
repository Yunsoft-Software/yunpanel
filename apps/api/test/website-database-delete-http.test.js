import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  WebsiteDatabaseDeleteHttpError,
  mountWebsiteDatabaseDeleteRoutes,
} from '../src/website-database-delete-http.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const otherWebsiteId = '32345678-1234-4234-8234-123456789012';
const applicationId = '42345678-1234-4234-8234-123456789012';
const bindingId = '52345678-1234-4234-8234-123456789012';
const credentialId = '62345678-1234-4234-8234-123456789012';
const backupId = '72345678-1234-4234-8234-123456789012';
const deleteJobId = '82345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';
const dumpSha256 = 'a'.repeat(64);

function binding(overrides = {}) {
  return {
    id: bindingId,
    serverId,
    databaseName,
    websiteId,
    applicationId,
    unixUser: 'yunapp-abcdef123456',
    revision: 7,
    ...overrides,
  };
}

function backupJob(overrides = {}) {
  return {
    id: backupId,
    serverId,
    operation: OPERATIONS.DATABASE_BACKUP,
    status: 'succeeded',
    resourceType: 'database',
    resourceId: databaseName,
    payload: {
      databaseName,
      websiteId,
      databaseBindingId: bindingId,
      expectedBindingRevision: 7,
    },
    result: {
      version: 1,
      backupId,
      databaseName,
      engine: 'mariadb',
      databaseVersion: '10.11.13-MariaDB',
      dumpSha256,
      dumpBytes: 4096,
      createdAt: '2026-09-18T00:00:00.000Z',
      backedUp: true,
      sideEffects: true,
    },
    ...overrides,
  };
}

function credential() {
  return {
    id: credentialId,
    databaseBindingId: bindingId,
    serverId,
    databaseName,
    websiteId,
    applicationId,
    siteUnixUser: 'yunapp-abcdef123456',
    username: 'ydb_abcdef012345abcdef012345',
    host: 'localhost',
    revision: 3,
  };
}

function deleteJob() {
  return {
    id: deleteJobId,
    serverId,
    operation: OPERATIONS.DATABASE_DELETE,
    status: 'succeeded',
    resourceType: 'database',
    resourceId: databaseName,
    payload: {
      name: databaseName,
      websiteId,
      databaseBindingId: bindingId,
      expectedBindingRevision: 7,
      backupId,
      expectedBackupSha256: dumpSha256,
    },
    result: {
      engine: 'mariadb',
      version: '10.11.13-MariaDB',
      database: { name: databaseName, sizeBytes: 4096 },
      deleted: true,
    },
  };
}

function fixture({
  currentBinding = binding(),
  currentCredential = null,
  jobs = [backupJob()],
  inventoryDatabases = [{ name: databaseName, sizeBytes: 4096 }],
  deleteEvidence = deleteJob(),
} = {}) {
  const routes = [];
  const enqueued = [];
  const unbound = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers.at(-1)]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers.at(-1)]); },
  };
  const jobRegistry = {
    async listJobs() { return jobs; },
    async getJob(id) { return id === deleteJobId ? deleteEvidence : jobs.find((job) => job.id === id) ?? null; },
    async enqueue(input) {
      enqueued.push(structuredClone(input));
      return { id: deleteJobId, ...input, status: 'queued' };
    },
  };
  mountWebsiteDatabaseDeleteRoutes(app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    websiteRegistry: {
      async getWebsite(id) {
        if (id === websiteId) return { id, serverId, applicationId };
        if (id === otherWebsiteId) return { id, serverId, applicationId: '92345678-1234-4234-8234-123456789012' };
        return null;
      },
    },
    databaseBindingRegistry: {
      async getBinding(id) { return id === bindingId ? currentBinding : null; },
      async unbindDatabase(id, input) {
        unbound.push([id, structuredClone(input)]);
        return { id, databaseName, unbound: true };
      },
    },
    databaseCredentialRegistry: {
      async getForBinding(id) {
        assert.equal(id, bindingId);
        return currentCredential;
      },
    },
    jobRegistry,
    databaseInventoryProvider: async () => ({
      engine: 'mariadb',
      version: '10.11.13-MariaDB',
      databases: inventoryDatabases,
    }),
    ensureDatabaseIdle: async () => {},
  });

  const route = (method, suffix) => routes.find(([m, path]) => m === method && path.endsWith(suffix))?.[2];
  return {
    preview: route('GET', '/delete-preview'),
    apply: route('POST', '/delete'),
    finalize: route('POST', '/delete-finalize'),
    enqueued,
    unbound,
  };
}

async function invoke(handler, {
  body = undefined,
  params = {},
  query = {},
} = {}) {
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
      params: { serverId, websiteId, bindingId, ...params },
      body,
      query,
    },
    response,
    (value) => { error = value; },
  );
  return { status, payload, error, headers };
}

test('Website delete preview is ready only with no credential and a current binding-revision backup', async () => {
  const fx = fixture();
  const response = await invoke(fx.preview);

  assert.equal(response.error, null);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.payload.data.readyToDelete, true);
  assert.deepEqual(response.payload.data.blockers, []);
  assert.equal(response.payload.data.backup.backupId, backupId);
  assert.equal(response.payload.data.backup.dumpSha256, dumpSha256);
  assert.equal(response.payload.data.scope.databaseBindingId, bindingId);
  assert.equal(response.payload.data.scope.bindingRevision, 7);
  assert.match(response.payload.data.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(response.payload.data.confirmation,
    `delete-website-database:${bindingId}:7:${response.payload.data.previewDigest}`);
  assert.equal(response.payload.data.sideEffects, false);
});

test('Website delete preview blocks credential, stale/unscoped backup and active jobs', async () => {
  const activeJob = {
    id: '92345678-1234-4234-8234-123456789012',
    serverId,
    operation: OPERATIONS.DATABASE_RESTORE,
    status: 'running',
    resourceType: 'database',
    resourceId: databaseName,
  };
  const fx = fixture({
    currentCredential: credential(),
    jobs: [
      { ...backupJob(), payload: { databaseName } },
      activeJob,
    ],
  });
  const response = await invoke(fx.preview);

  assert.equal(response.error, null);
  assert.equal(response.payload.data.readyToDelete, false);
  assert.equal(response.payload.data.confirmation, null);
  assert.deepEqual(response.payload.data.blockers, [
    'database_credential_exists',
    'database_current_binding_backup_required',
    'database_job_active',
  ]);
  assert.deepEqual(response.payload.data.activeJobs, [{
    id: activeJob.id,
    operation: activeJob.operation,
    status: 'running',
  }]);
});

test('Website delete queues a scoped DROP while preserving binding metadata', async () => {
  const fx = fixture();
  const preview = (await invoke(fx.preview)).payload.data;
  const response = await invoke(fx.apply, {
    body: {
      expectedBindingRevision: 7,
      expectedPreviewDigest: preview.previewDigest,
      expectedBackupId: backupId,
      expectedBackupSha256: dumpSha256,
      confirmation: preview.confirmation,
    },
  });

  assert.equal(response.error, null);
  assert.equal(response.status, 202);
  assert.equal(fx.unbound.length, 0);
  assert.deepEqual(fx.enqueued, [{
    serverId,
    type: OPERATIONS.DATABASE_DELETE,
    operation: OPERATIONS.DATABASE_DELETE,
    payload: {
      name: databaseName,
      websiteId,
      databaseBindingId: bindingId,
      expectedBindingRevision: 7,
      backupId,
      expectedBackupSha256: dumpSha256,
    },
    resourceType: 'database',
    resourceId: databaseName,
  }]);
});

test('Website delete refuses stale preview, cross-Website binding and current credentials', async () => {
  {
    const fx = fixture();
    const preview = (await invoke(fx.preview)).payload.data;
    const response = await invoke(fx.apply, {
      body: {
        expectedBindingRevision: 7,
        expectedPreviewDigest: 'b'.repeat(64),
        expectedBackupId: backupId,
        expectedBackupSha256: dumpSha256,
        confirmation: preview.confirmation,
      },
    });
    assert.ok(response.error instanceof WebsiteDatabaseDeleteHttpError);
    assert.equal(response.error.code, 'website_database_delete_preview_stale');
    assert.equal(fx.enqueued.length, 0);
  }

  {
    const fx = fixture();
    const response = await invoke(fx.preview, { params: { websiteId: otherWebsiteId } });
    assert.equal(response.error?.code, 'database_binding_not_found');
  }

  {
    const fx = fixture({ currentCredential: credential() });
    const preview = (await invoke(fx.preview)).payload.data;
    const response = await invoke(fx.apply, {
      body: {
        expectedBindingRevision: 7,
        expectedPreviewDigest: preview.previewDigest,
        expectedBackupId: backupId,
        expectedBackupSha256: dumpSha256,
        confirmation: 'not-ready',
      },
    });
    assert.equal(response.error?.code, 'website_database_delete_not_ready');
    assert.equal(fx.enqueued.length, 0);
  }
});

test('Website delete finalization removes binding only after exact successful DROP evidence and schema absence', async () => {
  const fx = fixture({ inventoryDatabases: [] });
  const response = await invoke(fx.finalize, {
    body: {
      expectedBindingRevision: 7,
      deleteJobId,
      confirmation: `finalize-website-database-delete:${bindingId}:7:${deleteJobId}`,
    },
  });

  assert.equal(response.error, null);
  assert.equal(response.status, 200);
  assert.deepEqual(fx.unbound, [[bindingId, {
    expectedRevision: 7,
    confirmation: `unbind-database:${bindingId}:7`,
  }]]);
  assert.equal(response.payload.data.finalizedFromJobId, deleteJobId);
  assert.equal(response.payload.data.backupId, backupId);
  assert.equal(response.payload.data.backupSha256, dumpSha256);
});

test('Website delete finalization fails closed when schema, credential or job ownership evidence is inconsistent', async () => {
  for (const setup of [
    { inventoryDatabases: [{ name: databaseName, sizeBytes: 0 }], expectedCode: 'website_database_delete_schema_present' },
    { inventoryDatabases: [], currentCredential: credential(), expectedCode: 'website_database_delete_credential_exists' },
    {
      inventoryDatabases: [],
      deleteEvidence: {
        ...deleteJob(),
        payload: { ...deleteJob().payload, expectedBindingRevision: 6 },
      },
      expectedCode: 'website_database_delete_job_evidence_missing',
    },
  ]) {
    const fx = fixture(setup);
    const response = await invoke(fx.finalize, {
      body: {
        expectedBindingRevision: 7,
        deleteJobId,
        confirmation: `finalize-website-database-delete:${bindingId}:7:${deleteJobId}`,
      },
    });
    assert.equal(response.error?.code, setup.expectedCode);
    assert.equal(fx.unbound.length, 0);
  }
});

test('Website delete routes reject query expansion and extra caller-selected schema fields', async () => {
  const fx = fixture();
  const expanded = await invoke(fx.preview, { query: { include: 'private' } });
  assert.equal(expanded.error?.code, 'website_database_delete_query_invalid');

  const preview = (await invoke(fx.preview)).payload.data;
  const extra = await invoke(fx.apply, {
    body: {
      expectedBindingRevision: 7,
      expectedPreviewDigest: preview.previewDigest,
      expectedBackupId: backupId,
      expectedBackupSha256: dumpSha256,
      confirmation: preview.confirmation,
      databaseName: 'other_site',
    },
  });
  assert.equal(extra.error?.code, 'website_database_delete_input_invalid');
  assert.equal(fx.enqueued.length, 0);
});
