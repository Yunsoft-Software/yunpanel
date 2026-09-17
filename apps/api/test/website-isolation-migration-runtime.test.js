import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteIsolationMigrationRegistry } from '../src/website-isolation-migration-registry.js';
import {
  createWebsiteIsolationMigrationRuntime,
  WebsiteIsolationMigrationRuntimeError,
} from '../src/website-isolation-migration-runtime.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
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
