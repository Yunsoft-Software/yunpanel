import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createWebsiteDatabaseProvisioningHandler,
  WebsiteDatabaseProvisioningError,
} from '../src/website-database-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const serverId = '11111111-1111-4111-8111-111111111111';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const bindingId = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const databaseName = 'yp_0123456789abcdef0123456789abcdef';
const unixUser = 'yunapp-4dc352e64a14';
const privileges = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX', 'DROP',
  'REFERENCES', 'CREATE TEMPORARY TABLES', 'LOCK TABLES',
];

function intent(overrides = {}) {
  return {
    adapter: 'website-database',
    serverId,
    databaseName,
    websiteId,
    applicationId,
    unixUser,
    privileges,
    ...overrides,
  };
}

function fixture({ unmanagedDatabase = false } = {}) {
  let databaseExists = unmanagedDatabase;
  let binding = null;
  let credential = null;
  let accountApplied = false;
  let counter = 0;
  const jobs = new Map();
  const byKey = new Map();
  const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const jobRegistry = {
    async enqueue(input) {
      if (byKey.has(input.idempotencyKey)) return jobs.get(byKey.get(input.idempotencyKey));
      const id = nextId();
      let status = 'succeeded';
      let result;
      if (input.operation === OPERATIONS.DATABASE_CREATE) {
        if (databaseExists) {
          status = 'failed';
          result = null;
        } else {
          databaseExists = true;
          result = { engine: 'mariadb', version: '10.11', database: { name: databaseName, sizeBytes: 0 }, created: true };
        }
      } else if (input.operation === OPERATIONS.DATABASE_DELETE) {
        databaseExists = false;
        result = { engine: 'mariadb', version: '10.11', database: { name: databaseName, sizeBytes: 0 }, deleted: true };
      } else if (input.operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY) {
        accountApplied = true;
        result = {
          databaseCredentialId: credential.id,
          databaseBindingId: binding.id,
          credentialRevision: credential.revision,
          bindingRevision: binding.revision,
          databaseName,
          username: credential.username,
          host: 'localhost',
          desiredStateSha256: input.payload.desiredStateSha256,
          applied: true,
          sideEffects: true,
        };
      } else {
        accountApplied = false;
        result = {
          databaseCredentialId: credential.id,
          databaseBindingId: binding.id,
          credentialRevision: credential.revision,
          bindingRevision: binding.revision,
          databaseName,
          username: credential.username,
          host: 'localhost',
          desiredStateSha256: input.payload.desiredStateSha256,
          deleted: true,
          sideEffects: true,
        };
      }
      const job = {
        id,
        serverId: input.serverId,
        type: input.type,
        operation: input.operation,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        status,
        result,
      };
      jobs.set(id, job);
      byKey.set(input.idempotencyKey, id);
      return job;
    },
    async getJob(id) { return jobs.get(id) ?? null; },
  };
  const databaseBindingRegistry = {
    async getByDatabase() { return binding; },
    async bindDatabase(input) {
      binding = {
        id: bindingId,
        serverId: input.serverId,
        databaseName: input.databaseName,
        websiteId: input.websiteId,
        applicationId: input.applicationId,
        unixUser,
        revision: 1,
      };
      return binding;
    },
    async unbindDatabase() { binding = null; return { id: bindingId, unbound: true }; },
  };
  const databaseCredentialRegistry = {
    async getForBinding() { return credential; },
    async createCredential() {
      credential = {
        id: credentialId,
        databaseBindingId: bindingId,
        serverId,
        databaseName,
        websiteId,
        applicationId,
        siteUnixUser: unixUser,
        username: 'ydb_0123456789abcdef01234567',
        host: 'localhost',
        privileges,
        revision: 1,
      };
      return credential;
    },
    async deleteCredential() { credential = null; return { id: credentialId, deleted: true }; },
    async listCredentials() { return credential ? [credential] : []; },
  };
  const preview = (operation) => {
    const desiredStateSha256 = createHash('sha256').update(operation).digest('hex');
    return {
      expectedCredentialRevision: credential.revision,
      expectedBindingRevision: binding.revision,
      desiredStateSha256,
      confirmation: `${operation}:${desiredStateSha256}`,
    };
  };
  const queueCredential = async (operation, input) => ({
    desiredStateSha256: input.expectedDesiredStateSha256,
    job: await jobRegistry.enqueue({
      serverId,
      type: operation,
      operation,
      payload: { desiredStateSha256: input.expectedDesiredStateSha256 },
      resourceType: 'database',
      resourceId: databaseName,
      idempotencyKey: `${operation}:${credentialId}:${input.expectedDesiredStateSha256}`,
    }),
  });
  const databaseCredentialApplyService = {
    previewApply: async () => preview(OPERATIONS.DATABASE_CREDENTIAL_APPLY),
    queueApply: (input) => queueCredential(OPERATIONS.DATABASE_CREDENTIAL_APPLY, input),
    previewDelete: async () => preview(OPERATIONS.DATABASE_CREDENTIAL_DELETE),
    queueDelete: (input) => queueCredential(OPERATIONS.DATABASE_CREDENTIAL_DELETE, input),
  };
  const databaseCredentialMaterializer = {
    async materializePublic(payload) {
      return {
        version: 1,
        databaseCredentialId: credential.id,
        databaseBindingId: binding.id,
        credentialRevision: credential.revision,
        bindingRevision: binding.revision,
        desiredStateSha256: payload.desiredStateSha256,
        databaseName,
        username: credential.username,
        host: 'localhost',
        privileges,
      };
    },
  };
  const evidenceInspector = {
    async inspectApplied(bundle) {
      return { ...bundle, applied: accountApplied, sideEffects: false };
    },
    async inspectDeleted(bundle) {
      return { ...bundle, deleted: !accountApplied, sideEffects: false };
    },
  };
  const handler = createWebsiteDatabaseProvisioningHandler({
    jobRegistry,
    databaseBindingRegistry,
    databaseCredentialRegistry,
    databaseCredentialApplyService,
    databaseCredentialMaterializer,
    databaseInventoryProvider: async () => ({
      engine: 'mariadb',
      version: '10.11',
      databases: databaseExists ? [{ name: databaseName, sizeBytes: 0 }] : [],
    }),
    databaseHealthProvider: async () => ({
      ready: true,
      connection: { protocol: 'socket', nativeSocketAuth: true },
      hygiene: { anonymousAccountsAbsent: true, remoteRootAccountsAbsent: true, testSchemaAbsent: true },
    }),
    evidenceInspector,
    waitForTerminalJob: async (job) => job,
  });
  return {
    handler,
    context: { operationId, websiteId, intent: intent(), evidence: null },
    state: () => ({ databaseExists, binding, credential, accountApplied, jobs: [...jobs.values()] }),
  };
}

test('Website database handler creates schema, ownership and scoped grants through durable child jobs', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(f.context);

  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.databaseName, databaseName);
  assert.equal(evidence.databaseBindingId, bindingId);
  assert.equal(evidence.databaseCredentialId, credentialId);
  assert.equal('password' in evidence, false);
  assert.deepEqual(f.state().jobs.map((job) => job.operation), [
    OPERATIONS.DATABASE_CREATE,
    OPERATIONS.DATABASE_CREDENTIAL_APPLY,
  ]);
  assert.equal((await f.handler.inspect({ ...f.context, evidence })).satisfied, true);
});

test('Website database compensation revokes grants before unbinding and deleting the schema', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(f.context);
  const compensated = await f.handler.compensate({ ...f.context, evidence });

  assert.equal(compensated.satisfied, true);
  assert.deepEqual(f.state(), {
    databaseExists: false,
    binding: null,
    credential: null,
    accountApplied: false,
    jobs: f.state().jobs,
  });
  assert.deepEqual(f.state().jobs.map((job) => job.operation), [
    OPERATIONS.DATABASE_CREATE,
    OPERATIONS.DATABASE_CREDENTIAL_APPLY,
    OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    OPERATIONS.DATABASE_DELETE,
  ]);
});

test('Website database handler never claims a pre-existing unmanaged schema', async () => {
  const f = fixture({ unmanagedDatabase: true });
  await assert.rejects(
    f.handler.apply(f.context),
    (error) => error instanceof WebsiteDatabaseProvisioningError
      && error.code === 'website_database_child_job_failed',
  );
  assert.equal(f.state().binding, null);
  assert.equal(f.state().credential, null);
});

test('Website database intent rejects privilege or Website identity drift', async () => {
  const f = fixture();
  await assert.rejects(
    f.handler.apply({ ...f.context, intent: intent({ privileges: ['SELECT'] }) }),
    (error) => error instanceof WebsiteDatabaseProvisioningError
      && error.code === 'website_database_intent_invalid',
  );
  await assert.rejects(
    f.handler.apply({ ...f.context, websiteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    (error) => error instanceof WebsiteDatabaseProvisioningError
      && error.code === 'website_database_intent_invalid',
  );
});
