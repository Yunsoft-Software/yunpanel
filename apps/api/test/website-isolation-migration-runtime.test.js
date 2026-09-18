import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteIsolationMigrationRegistry } from '../src/website-isolation-migration-registry.js';
import {
  createWebsiteIsolationMigrationRuntime,
  WebsiteIsolationMigrationRuntimeError,
} from '../src/website-isolation-migration-runtime.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const sourceOperationId = '4d7d1c87-c088-4c1d-bb44-7f370d315672';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const applicationUser = 'yunapp-4dc352e64a14';
const previewDigest = 'a'.repeat(64);
const homeDirectory = `/var/lib/yunpanel/data/${applicationId}`;
const confirmation = `migrate-isolation:${websiteId}:3:${previewDigest}`;

function preview(overrides = {}) {
  return {
    version: 1,
    applicable: true,
    status: 'migration_required',
    migrationRequired: true,
    websiteId,
    applicationId,
    websiteRevision: 3,
    expected: { unixUser: applicationUser, homeDirectory },
    migration: {
      applyAvailable: true,
      previewDigest,
      confirmation,
      changes: [{
        action: 'create_workspace_directories',
        applyState: 'requires_explicit_apply',
        desired: { directories: [
          { name: 'temporary', directory: `${homeDirectory}/tmp`, mode: '0700' },
          { name: 'logs', directory: `${homeDirectory}/logs`, mode: '0750' },
        ] },
      }],
    },
    ...overrides,
  };
}

function registry() {
  return createWebsiteIsolationMigrationRegistry({
    now: () => Date.parse('2026-09-17T12:00:00.000Z'),
    idFactory: () => operationId,
  });
}

function manager({ initiallySatisfied = false, applyError = null, compensationError = null } = {}) {
  let satisfied = initiallySatisfied;
  let compensated = false;
  let receipt = initiallySatisfied ? null : false;
  const calls = [];
  return {
    calls,
    async inspectWorkspace() { return { satisfied }; },
    async inspectWorkspaceOperation(intent, options) {
      calls.push(['inspect-operation', intent, options]);
      if (!satisfied) return { satisfied: false, reason: 'website_identity_workspace_missing' };
      return receipt
        ? { satisfied: true, workspaceReceiptVersion: 1, createdWorkspaceDirectories: 2 }
        : { satisfied: true, createdWorkspaceDirectories: 0 };
    },
    async applyWorkspace(intent, options) {
      calls.push(['apply', intent, options]);
      if (applyError) throw applyError;
      satisfied = true;
      receipt = true;
      return { satisfied: true, workspaceReceiptVersion: 1, createdWorkspaceDirectories: 2 };
    },
    async inspectWorkspaceCompensation(intent, options) {
      calls.push(['inspect-compensation', intent, options]);
      return { satisfied: compensated || !receipt, removedWorkspaceDirectories: compensated ? 2 : 0 };
    },
    async compensateWorkspace(intent, options) {
      calls.push(['compensate', intent, options]);
      if (compensationError) throw compensationError;
      compensated = true;
      satisfied = false;
      return { satisfied: true, removedWorkspaceDirectories: 2 };
    },
    async inspectIdentityOperation() {
      return { satisfied: false, reason: 'website_identity_operation_receipt_missing' };
    },
    async applyIdentityMigration() {
      throw new Error('identity migration not configured in workspace test');
    },
    async inspectIdentityMigrationCompensation() {
      return { satisfied: true, removedUser: false, removedGroup: false, removedHome: false };
    },
    async compensateIdentityMigration() {
      throw new Error('identity migration not configured in workspace test');
    },
  };
}

function identityPreview(overrides = {}) {
  const desired = {
    user: applicationUser,
    homeDirectory,
    shellPolicy: 'nologin',
    privateGroup: true,
    groupMemberCount: 0,
    homeMode: '0750',
  };
  return preview({
    ...overrides,
    migration: {
      applyAvailable: true,
      previewDigest,
      confirmation,
      changes: [{
        action: 'create_canonical_unix_identity',
        applyState: 'requires_explicit_apply',
        current: {
          identityMigrationPreview: {
            version: 1,
            satisfied: false,
            safeCreateCandidate: true,
            current: { account: null, group: null, home: null },
            desired,
            differences: [
              'website_identity_user_missing',
              'website_identity_group_missing',
              'website_identity_home_missing',
            ],
          },
        },
        desired: { identity: desired },
      }],
    },
  });
}

function identityManager() {
  let created = false;
  let compensated = false;
  const calls = [];
  return {
    calls,
    async inspectWorkspace() { return { satisfied: true }; },
    async inspectWorkspaceOperation() { return { satisfied: true, createdWorkspaceDirectories: 0 }; },
    async applyWorkspace() { throw new Error('workspace migration not configured'); },
    async inspectWorkspaceCompensation() { return { satisfied: true, removedWorkspaceDirectories: 0 }; },
    async compensateWorkspace() { throw new Error('workspace migration not configured'); },
    async inspectIdentityOperation(intent, options) {
      calls.push(['inspect-identity-operation', intent, options]);
      return created
        ? { satisfied: true, identityReceiptVersion: 1, createdUnixIdentity: true }
        : { satisfied: false, reason: 'website_identity_operation_receipt_missing' };
    },
    async applyIdentityMigration(intent, options) {
      calls.push(['apply-identity', intent, options]);
      created = true;
      compensated = false;
      return { satisfied: true, identityReceiptVersion: 1, createdUnixIdentity: true };
    },
    async inspectIdentityMigrationCompensation(intent, options) {
      calls.push(['inspect-identity-compensation', intent, options]);
      return compensated
        ? { satisfied: true, removedUser: true, removedGroup: true, removedHome: false, preservedHomeData: true }
        : { satisfied: false, reason: 'website_identity_compensation_pending' };
    },
    async compensateIdentityMigration(intent, options) {
      calls.push(['compensate-identity', intent, options]);
      compensated = true;
      created = false;
      return { satisfied: true, removedUser: true, removedGroup: true, removedHome: false, preservedHomeData: true };
    },
  };
}

function sftpPreview(overrides = {}) {
  const desired = {
    websiteId,
    applicationId,
    unixUser: applicationUser,
    sourceDirectory: homeDirectory,
    chrootRoot: '/var/lib/yunpanel/sftp-chroots',
    chrootDirectory: `/var/lib/yunpanel/sftp-chroots/${applicationId}`,
    mountDirectory: `/var/lib/yunpanel/sftp-chroots/${applicationId}/site`,
    sshdConfigPath: `/etc/ssh/sshd_config.d/90-yunpanel-sftp-${applicationUser}.conf`,
    unitName: 'yunpanel-test.mount',
    sshdSha256: 'b'.repeat(64),
    mountSha256: 'c'.repeat(64),
    directoryMode: '0755',
    directoryUid: 0,
    directoryGid: 0,
  };
  return preview({
    ...overrides,
    migration: {
      applyAvailable: true,
      previewDigest,
      confirmation,
      changes: [{
        action: 'create_sftp_isolation',
        applyState: 'requires_explicit_apply',
        current: {
          sftpMigrationPreview: {
            version: 1,
            satisfied: false,
            safeCreateCandidate: true,
            current: {},
            desired,
            differences: ['sftp_receipt_missing'],
          },
        },
        desired: { sftp: desired },
      }],
    },
  });
}

function sftpMigrationHandler() {
  let active = false;
  let compensated = false;
  const calls = [];
  return {
    calls,
    async inspectMigrationOperation(context) {
      calls.push(['inspect-sftp-operation', context]);
      return active
        ? {
          satisfied: true,
          sftpReceiptVersion: 1,
          activatedSftpIsolation: true,
          authorizedKeyCount: 1,
          authorizedKeysSha256: 'd'.repeat(64),
        }
        : { satisfied: false, reason: 'sftp_site_not_active' };
    },
    async applyMigration(context) {
      calls.push(['apply-sftp', context]);
      active = true;
      compensated = false;
      return {
        satisfied: true,
        sftpReceiptVersion: 1,
        activatedSftpIsolation: true,
        authorizedKeyCount: 1,
        authorizedKeysSha256: 'd'.repeat(64),
      };
    },
    async inspectMigrationCompensation(context) {
      calls.push(['inspect-sftp-compensation', context]);
      return compensated
        ? { satisfied: true, removedSftpIsolation: true }
        : { satisfied: false, reason: 'sftp_compensation_pending' };
    },
    async compensateMigration(context) {
      calls.push(['compensate-sftp', context]);
      active = false;
      compensated = true;
      return { satisfied: true, removedSftpIsolation: true };
    },
  };
}

function phpPreview(overrides = {}) {
  const documentRoot = `/var/lib/yunpanel/apps/${applicationId}/current/public`;
  const desired = {
    websiteId,
    applicationId,
    unixUser: applicationUser,
    documentRoot,
    runtimeUmask: '0027',
  };
  return preview({
    ...overrides,
    migration: {
      applyAvailable: true,
      previewDigest,
      confirmation,
      changes: [{
        action: 'create_php_fpm_pool',
        applyState: 'requires_explicit_apply',
        current: {
          operationId: sourceOperationId,
          phpRuntimeMigrationPreview: {
            version: 1,
            adapter: 'php-runtime',
            satisfied: false,
            safeCreateCandidate: true,
            current: {},
            desired,
            differences: ['php_fpm_pool_missing'],
          },
        },
        desired: { phpRuntime: desired },
      }],
    },
  });
}

function phpContainerPreview(overrides = {}) {
  const identity = createApplicationIdentity(applicationId);
  const desired = {
    websiteId,
    applicationId,
    releaseId: sourceOperationId,
    unixUser: applicationUser,
    documentRoot: `${identity.paths.runtime.currentRelease}/public`,
    applicationRoot: identity.paths.runtime.applicationRoot,
    releasesDirectory: identity.paths.runtime.releasesDirectory,
    currentRelease: identity.paths.runtime.currentRelease,
    releaseDirectory: `${identity.paths.runtime.releasesDirectory}/${sourceOperationId}`,
    releaseDocumentRoot: `${identity.paths.runtime.releasesDirectory}/${sourceOperationId}/public`,
    controlDirectoryMode: '0755',
    releaseDirectoryMode: '0750',
  };
  return preview({
    ...overrides,
    migration: {
      applyAvailable: true,
      previewDigest,
      confirmation,
      changes: [{
        action: 'repair_php_container_metadata',
        applyState: 'requires_explicit_apply',
        current: {
          operationId: sourceOperationId,
          phpRuntimeMigrationPreview: {
            safeContainerMigrationCandidate: true,
            current: { container: { safeMigrationCandidate: true } },
          },
        },
        desired: { phpContainer: desired },
      }],
    },
  });
}

function phpContainerMigrationHandler() {
  let active = false;
  let compensated = false;
  const calls = [];
  return {
    calls,
    async inspectContainerMigrationOperation(context) {
      calls.push(['inspect-php-container-operation', context]);
      return active
        ? { satisfied: true, phpContainerReceiptVersion: 1, migratedPhpContainer: true }
        : { satisfied: false, reason: 'php_site_container_migration_receipt_missing' };
    },
    async applyContainerMigration(context) {
      calls.push(['apply-php-container', context]);
      active = true;
      compensated = false;
      return { satisfied: true, phpContainerReceiptVersion: 1, migratedPhpContainer: true };
    },
    async inspectContainerMigrationCompensation(context) {
      calls.push(['inspect-php-container-compensation', context]);
      return compensated
        ? { satisfied: true, restoredPhpContainerMetadata: true }
        : { satisfied: false, reason: 'php_site_container_migration_compensation_pending' };
    },
    async compensateContainerMigration(context) {
      calls.push(['compensate-php-container', context]);
      active = false;
      compensated = true;
      return { satisfied: true, restoredPhpContainerMetadata: true };
    },
  };
}

function phpMigrationHandler() {
  let active = false;
  let compensated = false;
  const calls = [];
  return {
    calls,
    async inspectMigrationOperation(context) {
      calls.push(['inspect-php-operation', context]);
      return active
        ? { satisfied: true, phpFpmReceiptVersion: 1, createdPhpFpmPool: true }
        : { satisfied: false, reason: 'php_fpm_receipt_missing' };
    },
    async applyMigration(context) {
      calls.push(['apply-php', context]);
      active = true;
      compensated = false;
      return { satisfied: true, phpFpmReceiptVersion: 1, createdPhpFpmPool: true };
    },
    async inspectMigrationCompensation(context) {
      calls.push(['inspect-php-compensation', context]);
      return compensated
        ? { satisfied: true, restoredPrevious: false, preservedExisting: false }
        : { satisfied: false, reason: 'php_fpm_compensation_pending' };
    },
    async compensateMigration(context) {
      calls.push(['compensate-php', context]);
      active = false;
      compensated = true;
      return { satisfied: true, restoredPrevious: false, preservedExisting: false };
    },
  };
}

test('workspace isolation migration journals before exact apply and returns receipt evidence', async () => {
  const store = registry();
  const workspace = manager();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => preview() },
    workspaceManager: workspace,
  });
  await runtime.init();

  const result = await runtime.start({ websiteId, previewDigest, confirmation });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.workspaceReceiptVersion, 1);
  assert.equal(result.result.createdWorkspaceDirectories, 2);
  assert.deepEqual(workspace.calls.map(([name]) => name), ['inspect-operation', 'apply']);
  assert.equal(workspace.calls[1][2].operationId, operationId);
});

test('workspace migration rejects stale preview before host mutation', async () => {
  const workspace = manager();
  const staleDigest = 'b'.repeat(64);
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: registry(),
    auditService: { audit: async () => {
      const current = preview();
      return {
        ...current,
        migration: {
          ...current.migration,
          previewDigest: staleDigest,
          confirmation: `migrate-isolation:${websiteId}:3:${staleDigest}`,
        },
      };
    } },
    workspaceManager: workspace,
  });
  await runtime.init();

  await assert.rejects(
    runtime.start({ websiteId, previewDigest, confirmation }),
    (error) => error instanceof WebsiteIsolationMigrationRuntimeError
      && error.code === 'website_isolation_migration_confirmation_invalid',
  );
  assert.deepEqual(workspace.calls, []);
});

test('restart inspection closes completed apply without replaying mutation', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(preview());
  await store.markApplying(created.id);
  const workspace = manager({ initiallySatisfied: true });
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => preview() },
    workspaceManager: workspace,
  });

  const recovery = await runtime.init();
  assert.deepEqual(recovery, [{ operationId, recovered: true }]);
  assert.equal((await runtime.get(operationId)).status, 'succeeded');
  assert.equal(workspace.calls.some(([name]) => name === 'apply'), false);
});

test('restart leaves incomplete apply pending without replaying mutation', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(preview());
  await store.markApplying(created.id);
  const workspace = manager();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => preview() },
    workspaceManager: workspace,
  });

  const recovery = await runtime.init();
  assert.deepEqual(recovery, [{ operationId, recovered: false, reason: 'apply_incomplete' }]);
  assert.equal((await runtime.get(operationId)).status, 'applying');
  assert.equal(workspace.calls.some(([name]) => name === 'apply'), false);
});

test('typed rollback compensates only the migration workspace receipt', async () => {
  const store = registry();
  const workspace = manager();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => preview() },
    workspaceManager: workspace,
  });
  await runtime.init();
  await runtime.start({ websiteId, previewDigest, confirmation });

  const rolledBack = await runtime.rollback({
    operationId,
    confirmation: `rollback-isolation-migration:${operationId}:${previewDigest}`,
  });
  assert.equal(rolledBack.status, 'compensated');
  assert.equal(rolledBack.compensation.removedWorkspaceDirectories, 2);
  assert.equal(workspace.calls.some(([name]) => name === 'compensate'), true);
});

test('parallel apply and rollback requests share one host mutation flight', async () => {
  const store = registry();
  const workspace = manager();
  const baseApply = workspace.applyWorkspace;
  const baseCompensate = workspace.compensateWorkspace;
  let releaseApply;
  let releaseCompensation;
  const applyGate = new Promise((resolve) => { releaseApply = resolve; });
  const compensationGate = new Promise((resolve) => { releaseCompensation = resolve; });
  let signalApply;
  let signalCompensation;
  const applyStarted = new Promise((resolve) => { signalApply = resolve; });
  const compensationStarted = new Promise((resolve) => { signalCompensation = resolve; });
  workspace.applyWorkspace = async (...args) => {
    signalApply();
    await applyGate;
    return baseApply(...args);
  };
  workspace.compensateWorkspace = async (...args) => {
    signalCompensation();
    await compensationGate;
    return baseCompensate(...args);
  };
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => preview() },
    workspaceManager: workspace,
  });
  await runtime.init();

  const firstApply = runtime.start({ websiteId, previewDigest, confirmation });
  await applyStarted;
  const secondApply = runtime.start({ websiteId, previewDigest, confirmation });
  await new Promise((resolve) => setImmediate(resolve));
  releaseApply();
  const applied = await Promise.all([firstApply, secondApply]);
  assert.deepEqual(applied.map((entry) => entry.status), ['succeeded', 'succeeded']);
  assert.equal(workspace.calls.filter(([name]) => name === 'apply').length, 1);

  const rollbackInput = {
    operationId,
    confirmation: `rollback-isolation-migration:${operationId}:${previewDigest}`,
  };
  const firstRollback = runtime.rollback(rollbackInput);
  await compensationStarted;
  await assert.rejects(
    runtime.rollback({ ...rollbackInput, confirmation: 'wrong' }),
    (error) => error instanceof WebsiteIsolationMigrationRuntimeError
      && error.code === 'website_isolation_migration_rollback_confirmation_invalid',
  );
  const secondRollback = runtime.rollback(rollbackInput);
  await new Promise((resolve) => setImmediate(resolve));
  releaseCompensation();
  const rolledBack = await Promise.all([firstRollback, secondRollback]);
  assert.deepEqual(rolledBack.map((entry) => entry.status), ['compensated', 'compensated']);
  assert.equal(workspace.calls.filter(([name]) => name === 'compensate').length, 1);
});


test('Unix identity migration journals exact safe-create target and returns durable receipt evidence', async () => {
  const store = registry();
  const manager = identityManager();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => identityPreview() },
    workspaceManager: manager,
  });
  await runtime.init();

  const result = await runtime.start({ websiteId, previewDigest, confirmation });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.result, {
    satisfied: true,
    identityReceiptVersion: 1,
    createdUnixIdentity: true,
  });
  assert.deepEqual(manager.calls.map(([name]) => name), ['inspect-identity-operation', 'apply-identity']);
});

test('Unix identity migration restart inspection closes completed receipt without replaying user creation', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(identityPreview());
  await store.markApplying(created.id);
  const manager = identityManager();
  await manager.applyIdentityMigration({
    websiteId,
    applicationId,
    user: applicationUser,
    homeDirectory,
  }, { operationId });

  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => identityPreview() },
    workspaceManager: manager,
  });
  manager.calls.length = 0;

  const recovery = await runtime.init();

  assert.deepEqual(recovery, [{ operationId, recovered: true }]);
  assert.equal((await runtime.get(operationId)).status, 'succeeded');
  assert.deepEqual(manager.calls.map(([name]) => name), ['inspect-identity-operation']);
});

test('Unix identity typed rollback preserves nonempty HOME evidence', async () => {
  const manager = identityManager();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: registry(),
    auditService: { audit: async () => identityPreview() },
    workspaceManager: manager,
  });
  await runtime.init();
  await runtime.start({ websiteId, previewDigest, confirmation });

  const result = await runtime.rollback({
    operationId,
    confirmation: `rollback-isolation-migration:${operationId}:${previewDigest}`,
  });

  assert.equal(result.status, 'compensated');
  assert.deepEqual(result.compensation, {
    satisfied: true,
    removedUser: true,
    removedGroup: true,
    removedHome: false,
    preservedHomeData: true,
  });
  assert.equal(manager.calls.some(([name]) => name === 'compensate-identity'), true);
});


test('SFTP isolation migration journals typed operation and applies through key-aware migration handler', async () => {
  const handler = sftpMigrationHandler();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: registry(),
    auditService: { audit: async () => sftpPreview() },
    workspaceManager: identityManager(),
    migrationHandlers: { sftp: handler },
  });
  await runtime.init();

  const result = await runtime.start({ websiteId, previewDigest, confirmation });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.adapter, 'sftp');
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.result, {
    satisfied: true,
    sftpReceiptVersion: 1,
    activatedSftpIsolation: true,
    authorizedKeyCount: 1,
    authorizedKeysSha256: 'd'.repeat(64),
  });
  assert.deepEqual(handler.calls.map(([name]) => name), ['inspect-sftp-operation', 'apply-sftp']);
});

test('SFTP isolation restart closes completed receipt without replaying SFTP apply', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(sftpPreview());
  await store.markApplying(created.id);
  const handler = sftpMigrationHandler();
  await handler.applyMigration({ operationId, websiteId, intent: {
    adapter: 'openssh-internal-sftp',
    websiteId,
    applicationId,
    unixUser: applicationUser,
  } });
  handler.calls.length = 0;
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => sftpPreview() },
    workspaceManager: identityManager(),
    migrationHandlers: { sftp: handler },
  });

  const recovery = await runtime.init();

  assert.deepEqual(recovery, [{ operationId, recovered: true }]);
  assert.equal((await runtime.get(operationId)).status, 'succeeded');
  assert.deepEqual(handler.calls.map(([name]) => name), ['inspect-sftp-operation']);
});

test('SFTP isolation typed rollback uses only migration compensation handler', async () => {
  const handler = sftpMigrationHandler();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: registry(),
    auditService: { audit: async () => sftpPreview() },
    workspaceManager: identityManager(),
    migrationHandlers: { sftp: handler },
  });
  await runtime.init();
  await runtime.start({ websiteId, previewDigest, confirmation });

  const result = await runtime.rollback({
    operationId,
    confirmation: `rollback-isolation-migration:${operationId}:${previewDigest}`,
  });

  assert.equal(result.status, 'compensated');
  assert.deepEqual(result.compensation, { satisfied: true, removedSftpIsolation: true });
  assert.equal(handler.calls.some(([name]) => name === 'compensate-sftp'), true);
});


test('PHP pool isolation migration applies only through the typed PHP migration handler', async () => {
  const handler = phpMigrationHandler();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: registry(),
    auditService: { audit: async () => phpPreview() },
    workspaceManager: identityManager(),
    migrationHandlers: { php_runtime: handler },
  });
  await runtime.init();

  const result = await runtime.start({ websiteId, previewDigest, confirmation });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.adapter, 'php');
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.result, {
    satisfied: true,
    phpFpmReceiptVersion: 1,
    createdPhpFpmPool: true,
  });
  assert.deepEqual(handler.calls.map(([name]) => name), ['inspect-php-operation', 'apply-php']);
  assert.equal(handler.calls[0][1].releaseOperationId, sourceOperationId);
  assert.equal(handler.calls[0][1].operationId, operationId);
  assert.equal(handler.calls[1][1].releaseOperationId, sourceOperationId);
  assert.equal(handler.calls[1][1].operationId, operationId);
});

test('PHP pool migration restart closes a completed receipt without replaying pool creation', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(phpPreview());
  await store.markApplying(created.id);
  const handler = phpMigrationHandler();
  await handler.applyMigration({
    operationId,
    releaseOperationId: sourceOperationId,
    websiteId,
    intent: {
      adapter: 'php-fpm',
      websiteId,
      applicationId,
      unixUser: applicationUser,
      documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current/public`,
    },
  });
  handler.calls.length = 0;
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => phpPreview() },
    workspaceManager: identityManager(),
    migrationHandlers: { php_runtime: handler },
  });

  const recovery = await runtime.init();

  assert.deepEqual(recovery, [{ operationId, recovered: true }]);
  assert.equal((await runtime.get(operationId)).status, 'succeeded');
  assert.deepEqual(handler.calls.map(([name]) => name), ['inspect-php-operation']);
});

test('PHP pool migration rollback uses only receipt-owned FPM compensation', async () => {
  const handler = phpMigrationHandler();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: registry(),
    auditService: { audit: async () => phpPreview() },
    workspaceManager: identityManager(),
    migrationHandlers: { php_runtime: handler },
  });
  await runtime.init();
  await runtime.start({ websiteId, previewDigest, confirmation });

  const result = await runtime.rollback({
    operationId,
    confirmation: `rollback-isolation-migration:${operationId}:${previewDigest}`,
  });

  assert.equal(result.status, 'compensated');
  assert.deepEqual(result.compensation, {
    satisfied: true,
    restoredPrevious: false,
    preservedExisting: false,
  });
  assert.equal(handler.calls.some(([name]) => name === 'compensate-php'), true);
});


test('PHP container metadata migration applies only through its typed receipt handler', async () => {
  const handler = phpContainerMigrationHandler();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: registry(),
    auditService: { audit: async () => phpContainerPreview() },
    workspaceManager: identityManager(),
    migrationHandlers: { php_runtime: handler },
  });
  await runtime.init();

  const result = await runtime.start({ websiteId, previewDigest, confirmation });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.adapter, 'php_container');
  assert.deepEqual(result.result, {
    satisfied: true,
    phpContainerReceiptVersion: 1,
    migratedPhpContainer: true,
  });
  assert.deepEqual(handler.calls.map(([name]) => name), [
    'inspect-php-container-operation',
    'apply-php-container',
  ]);
  assert.equal(handler.calls[0][1].releaseOperationId, sourceOperationId);
  assert.equal(handler.calls[0][1].operationId, operationId);
  assert.equal(handler.calls[1][1].releaseOperationId, sourceOperationId);
});

test('PHP container metadata migration restart closes receipt without replaying ownership mutation', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(phpContainerPreview());
  await store.markApplying(created.id);
  const handler = phpContainerMigrationHandler();
  await handler.applyContainerMigration({
    operationId,
    releaseOperationId: sourceOperationId,
    websiteId,
    intent: {
      adapter: 'php-fpm',
      websiteId,
      applicationId,
      unixUser: applicationUser,
      documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current/public`,
    },
  });
  handler.calls.length = 0;
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: store,
    auditService: { audit: async () => phpContainerPreview() },
    workspaceManager: identityManager(),
    migrationHandlers: { php_runtime: handler },
  });

  const recovery = await runtime.init();

  assert.deepEqual(recovery, [{ operationId, recovered: true }]);
  assert.equal((await runtime.get(operationId)).status, 'succeeded');
  assert.deepEqual(handler.calls.map(([name]) => name), ['inspect-php-container-operation']);
});

test('PHP container metadata rollback uses only its receipt-owned compensation', async () => {
  const handler = phpContainerMigrationHandler();
  const runtime = createWebsiteIsolationMigrationRuntime({
    registry: registry(),
    auditService: { audit: async () => phpContainerPreview() },
    workspaceManager: identityManager(),
    migrationHandlers: { php_runtime: handler },
  });
  await runtime.init();
  await runtime.start({ websiteId, previewDigest, confirmation });

  const result = await runtime.rollback({
    operationId,
    confirmation: `rollback-isolation-migration:${operationId}:${previewDigest}`,
  });

  assert.equal(result.status, 'compensated');
  assert.deepEqual(result.compensation, {
    satisfied: true,
    restoredPhpContainerMetadata: true,
  });
  assert.equal(handler.calls.some(([name]) => name === 'compensate-php-container'), true);
});
