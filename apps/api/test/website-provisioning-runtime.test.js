import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';

function plan({ operation = operationId, website = websiteId } = {}) {
  return {
    operationId: operation,
    websiteId: website,
    steps: [{
      id: 'unix_identity',
      kind: 'unix_identity',
      state: 'pending',
      intent: {
        unixUser: 'yunapp-0123456789ab',
        homeDirectory: '/var/lib/yunpanel/data/6dcb8908-3f3e-43da-9452-15fd6b51ac76',
      },
      compensation: { state: 'pending' },
    }],
  };
}

function sftpPlan() {
  return {
    operationId,
    websiteId,
    steps: [{
      id: 'sftp',
      kind: 'sftp',
      state: 'pending',
      intent: {
        adapter: 'openssh-internal-sftp',
        websiteId,
        applicationId,
        unixUser: 'yunapp-4dc352e64a14',
      },
      compensation: { state: 'pending' },
    }],
  };
}

function identityManager(overrides = {}) {
  return {
    inspect: async () => ({ satisfied: false, reason: 'unused' }),
    apply: async () => ({ satisfied: false, reason: 'unused' }),
    compensate: async () => ({ satisfied: false, reason: 'unused' }),
    inspectCompensation: async () => ({ satisfied: false, reason: 'unused' }),
    ...overrides,
  };
}

function passengerSiteManager() {
  return {
    inspect: async () => ({ satisfied: false, reason: 'unused' }),
    apply: async () => ({ satisfied: false, reason: 'unused' }),
  };
}

function nginxManager() {
  return {
    stageDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64) }),
    inspectStagedDomain: async () => ({ satisfied: false, result: null }),
    inspectActiveDomain: async () => ({ satisfied: false, result: null }),
    activateDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64), active: true }),
    compensateDomain: async () => ({ satisfied: true, configName: 'unused', checksum: 'a'.repeat(64) }),
    inspectDomainCompensation: async () => ({ satisfied: true, configName: 'unused', checksum: 'a'.repeat(64) }),
  };
}

async function persistedFile(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'operations.json');
}

function runtime({ filePath = null, manager = identityManager() } = {}) {
  return createWebsiteProvisioningRuntime({
    filePath,
    identityManager: manager,
    passengerSiteManager: passengerSiteManager(),
    nginxManager: nginxManager(),
  });
}

test('runtime composes registry, injected managers and orchestrator', async () => {
  const calls = [];
  const provisioning = runtime({
    manager: identityManager({
      inspect: async (intent) => ({ satisfied: true, ...intent, uid: 1201, gid: 1201 }),
      apply: async (intent) => {
        calls.push(intent);
        return { satisfied: true, ...intent, uid: 1201, gid: 1201 };
      },
    }),
  });

  assert.deepEqual(await provisioning.init(), []);
  await provisioning.create(plan());
  const result = await provisioning.runNext(operationId);

  assert.equal(result.outcome, 'ready');
  assert.equal(result.operation.ready, true);
  assert.equal(typeof provisioning.compensateStep, 'function');
  assert.deepEqual(calls, [{
    user: 'yunapp-0123456789ab',
    homeDirectory: '/var/lib/yunpanel/data/6dcb8908-3f3e-43da-9452-15fd6b51ac76',
  }]);
  assert.deepEqual(await provisioning.get(operationId), result.operation);
  assert.deepEqual(await provisioning.listInterrupted(), []);
});

test('runtime installs the Website database handler before restart reconciliation', () => {
  const provisioning = runtime();
  const jobRegistry = { async enqueue() {}, async getJob() {} };
  const databaseBindingRegistry = {
    async getByDatabase() {}, async bindDatabase() {}, async unbindDatabase() {},
  };
  const databaseCredentialRegistry = {
    async getForBinding() {}, async createCredential() {}, async deleteCredential() {}, async listCredentials() {},
  };
  const databaseCredentialApplyService = {
    async previewApply() {}, async queueApply() {}, async previewDelete() {}, async queueDelete() {},
  };
  const databaseCredentialMaterializer = { async materializePublic() {} };
  const databaseInventoryProvider = async () => ({ databases: [] });
  const databaseHealthProvider = async () => ({ ready: false });
  const evidenceInspector = { async inspectApplied() {}, async inspectDeleted() {} };
  const waitForTerminalJob = async (job) => job;
  const dependencies = {
    jobRegistry,
    databaseBindingRegistry,
    databaseCredentialRegistry,
    databaseCredentialApplyService,
    databaseCredentialMaterializer,
    databaseInventoryProvider,
    databaseHealthProvider,
    evidenceInspector,
    waitForTerminalJob,
  };

  assert.deepEqual(provisioning.configureDatabaseControlPlane(dependencies), { configured: true });
  assert.equal(typeof provisioning.handlers.website_database.apply, 'function');
  assert.equal(typeof provisioning.handlers.website_database.inspectCompensation, 'function');
  assert.deepEqual(provisioning.configureDatabaseControlPlane(dependencies), { configured: true });
  assert.throws(
    () => provisioning.configureDatabaseControlPlane({ ...dependencies, jobRegistry: { ...jobRegistry } }),
    /cannot be replaced/,
  );
});

test('runtime startup reconciles an interrupted apply by inspection without applying again', async (t) => {
  const filePath = await persistedFile(t, 'yunpanel-provisioning-restart-');
  const beforeRestart = runtime({ filePath });
  await beforeRestart.init();
  await beforeRestart.create(plan());
  await beforeRestart.registry.beginStep({ operationId, stepId: 'unix_identity' });

  let inspectCalls = 0;
  let applyCalls = 0;
  const afterRestart = runtime({
    filePath,
    manager: identityManager({
      inspect: async (intent) => {
        inspectCalls += 1;
        return { satisfied: true, ...intent, uid: 1201, gid: 1201 };
      },
      apply: async () => {
        applyCalls += 1;
        throw new Error('startup reconcile must not reapply');
      },
    }),
  });

  const startup = await afterRestart.init();
  const restored = await afterRestart.get(operationId);

  assert.equal(startup.length, 1);
  assert.equal(startup[0].outcome, 'ready');
  assert.equal(inspectCalls, 1);
  assert.equal(applyCalls, 0);
  assert.equal(restored.ready, true);
  assert.equal(restored.steps[0].state, 'succeeded');
  assert.deepEqual(await afterRestart.listInterrupted(), []);
});

test('runtime startup leaves uncertain interrupted apply untouched instead of mutating the host', async (t) => {
  const filePath = await persistedFile(t, 'yunpanel-provisioning-uncertain-');
  const beforeRestart = runtime({ filePath });
  await beforeRestart.init();
  await beforeRestart.create(plan());
  await beforeRestart.registry.beginStep({ operationId, stepId: 'unix_identity' });

  let applyCalls = 0;
  const afterRestart = runtime({
    filePath,
    manager: identityManager({
      inspect: async () => ({ satisfied: false, reason: 'website_identity_partial_state' }),
      apply: async () => {
        applyCalls += 1;
        throw new Error('startup reconcile must not apply uncertain state');
      },
    }),
  });

  const startup = await afterRestart.init();
  const restored = await afterRestart.get(operationId);

  assert.equal(startup.length, 1);
  assert.equal(startup[0].outcome, 'interrupted');
  assert.equal(startup[0].actionRequired, 'inspect_or_remediate');
  assert.equal(applyCalls, 0);
  assert.equal(restored.steps[0].state, 'applying');
  assert.equal((await afterRestart.listInterrupted()).length, 1);
});

test('runtime startup reconciles interrupted compensation by inspection without compensating again', async (t) => {
  const filePath = await persistedFile(t, 'yunpanel-provisioning-compensation-');
  const beforeRestart = runtime({
    filePath,
    manager: identityManager({
      apply: async (intent) => ({ satisfied: true, ...intent, uid: 1201, gid: 1201 }),
    }),
  });
  await beforeRestart.init();
  await beforeRestart.create(plan());
  await beforeRestart.runNext(operationId);
  await beforeRestart.registry.beginCompensation({ operationId, stepId: 'unix_identity' });

  let inspectCalls = 0;
  let compensateCalls = 0;
  const afterRestart = runtime({
    filePath,
    manager: identityManager({
      inspectCompensation: async () => {
        inspectCalls += 1;
        return { satisfied: true, removedUser: true, removedGroup: true, removedHome: true };
      },
      compensate: async () => {
        compensateCalls += 1;
        throw new Error('startup reconcile must not repeat compensation');
      },
    }),
  });

  const startup = await afterRestart.init();
  const restored = await afterRestart.get(operationId);

  assert.equal(startup.length, 1);
  assert.equal(startup[0].outcome, 'compensated');
  assert.equal(inspectCalls, 1);
  assert.equal(compensateCalls, 0);
  assert.equal(restored.steps[0].state, 'compensated');
  assert.equal(restored.steps[0].compensation.state, 'succeeded');
  assert.deepEqual(await afterRestart.listInterrupted(), []);
});

test('runtime restart keeps interrupted SFTP applying until authorized-key desired state is explicitly reconciled', async (t) => {
  const filePath = await persistedFile(t, 'yunpanel-provisioning-sftp-restart-');
  const baseManager = {
    async apply() { return { satisfied: true, adapter: 'openssh-internal-sftp' }; },
    async inspect() { return { satisfied: true, adapter: 'openssh-internal-sftp' }; },
    async compensate() { return { satisfied: true }; },
    async inspectCompensation() { return { satisfied: true }; },
  };
  let materialized = false;
  let baseApplyCalls = 0;
  let reconcileCalls = 0;
  const keyService = {
    async reconcile(id) {
      assert.equal(id, websiteId);
      reconcileCalls += 1;
      materialized = true;
      return { satisfied: true, adapter: 'openssh-authorized-keys', keyCount: 0, sha256: 'a'.repeat(64) };
    },
    async inspectMaterialization(id) {
      assert.equal(id, websiteId);
      return materialized
        ? { satisfied: true, adapter: 'openssh-authorized-keys', keyCount: 0, sha256: 'a'.repeat(64) }
        : { satisfied: false, reason: 'sftp_authorized_keys_file_missing' };
    },
  };
  const beforeRestart = createWebsiteProvisioningRuntime({
    filePath,
    sftpSiteManager: baseManager,
    sftpKeyService: keyService,
  });
  await beforeRestart.init();
  await beforeRestart.create(sftpPlan());
  await beforeRestart.registry.beginStep({ operationId, stepId: 'sftp' });

  const afterRestart = createWebsiteProvisioningRuntime({
    filePath,
    sftpSiteManager: {
      ...baseManager,
      async apply() {
        baseApplyCalls += 1;
        throw new Error('startup must not replay SFTP apply');
      },
    },
    sftpKeyService: keyService,
  });
  const startup = await afterRestart.init();
  assert.equal(startup[0].outcome, 'interrupted');
  assert.equal(startup[0].actionRequired, 'inspect_or_remediate');
  assert.equal((await afterRestart.get(operationId)).steps[0].state, 'applying');
  assert.equal(baseApplyCalls, 0);
  assert.equal(reconcileCalls, 0);

  await keyService.reconcile(websiteId);
  const recovered = await afterRestart.runNext(operationId);
  assert.equal(recovered.outcome, 'ready');
  assert.equal(recovered.operation.steps[0].evidence.authorizedKeyCount, 0);
  assert.equal(baseApplyCalls, 0);
  assert.equal(reconcileCalls, 1);
});


test('runtime enables durable Unix identity isolation migration only with the complete lifecycle manager', () => {
  const lifecycleManager = {
    async inspectWorkspace() { return { satisfied: true }; },
    async inspectWorkspaceOperation() { return { satisfied: true, createdWorkspaceDirectories: 0 }; },
    async applyWorkspace() { return { satisfied: true, workspaceReceiptVersion: 1, createdWorkspaceDirectories: 0 }; },
    async inspectWorkspaceCompensation() { return { satisfied: true, removedWorkspaceDirectories: 0 }; },
    async compensateWorkspace() { return { satisfied: true, removedWorkspaceDirectories: 0 }; },
    async inspectIdentityOperation() {
      return { satisfied: false, reason: 'website_identity_operation_receipt_missing' };
    },
    async applyIdentityMigration() {
      return { satisfied: true, identityReceiptVersion: 1, createdUnixIdentity: true };
    },
    async inspectIdentityMigrationCompensation() {
      return { satisfied: true, removedUser: true, removedGroup: true, removedHome: true };
    },
    async compensateIdentityMigration() {
      return { satisfied: true, removedUser: true, removedGroup: true, removedHome: true };
    },
  };
  const provisioning = createWebsiteProvisioningRuntime({
    isolationWorkspaceManager: lifecycleManager,
  });
  const websiteRegistry = {
    async getWebsite(id) {
      return id === websiteId ? {
        id: websiteId,
        serverId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
        applicationId,
        runtimeType: 'php',
        unixUser: 'yunapp-4dc352e64a14',
        documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current/public`,
        revision: 1,
      } : null;
    },
  };
  const applicationRegistry = {
    async getApplication(id) {
      return id === applicationId ? {
        id: applicationId,
        serverId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
        type: 'php',
      } : null;
    },
  };

  assert.deepEqual(
    provisioning.configureIsolationAudit({ websiteRegistry, applicationRegistry }),
    { configured: true },
  );
  assert.equal(typeof provisioning.isolationMigration?.start, 'function');
  assert.equal(typeof provisioning.isolationMigration?.rollback, 'function');
});
