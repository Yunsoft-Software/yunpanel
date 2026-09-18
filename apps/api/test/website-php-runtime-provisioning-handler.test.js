import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePhpRuntimeProvisioningHandler } from '../src/website-php-runtime-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const releaseOperationId = '4d7d1c87-c088-4c1d-bb44-7f370d315672';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const unixUser = 'yunapp-4dc352e64a14';
const documentRoot = `/var/lib/yunpanel/apps/${applicationId}/current/public`;

function intent() {
  return { adapter: 'php-fpm', websiteId, applicationId, unixUser, documentRoot };
}

function umaskManager(calls = null, { satisfied = true } = {}) {
  return {
    async apply(runtime) {
      calls?.push(['umask', runtime]);
      return satisfied ? { satisfied: true, adapter: 'systemd-umask', runtime, umask: '0027' } : { satisfied: false, reason: 'service_umask_not_effective' };
    },
    async inspect(runtime) {
      calls?.push(['umask-inspect', runtime]);
      return satisfied ? { satisfied: true, adapter: 'systemd-umask', runtime, umask: '0027' } : { satisfied: false, reason: 'service_umask_not_effective' };
    },
  };
}

test('PHP runtime locks containers, activates FPM, enforces UMask=0027 and rechecks the pool', async () => {
  const calls = [];
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply(value, options) {
        calls.push(['container', value, options]);
        return { satisfied: true, adapter: 'php-container', containerOwner: 'root:root', releaseUid: 1201, releaseGid: 1201 };
      },
      async inspect() { return { satisfied: true, adapter: 'php-container', containerOwner: 'root:root', releaseUid: 1201, releaseGid: 1201 }; },
    },
    fpmManager: {
      async apply(value, options) {
        calls.push(['fpm', value, options]);
        return { satisfied: true, adapter: 'php-fpm', applicationId, unixUser, documentRoot, socketPath: `/run/php/yunpanel-${unixUser}.sock` };
      },
      async inspect() {
        calls.push(['fpm-inspect']);
        return { satisfied: true, adapter: 'php-fpm', applicationId, unixUser, documentRoot, socketPath: `/run/php/yunpanel-${unixUser}.sock` };
      },
      async compensate() { return { satisfied: true }; },
      async inspectCompensation() { return { satisfied: true }; },
    },
    umaskManager: umaskManager(calls),
  });

  const result = await handler.apply({ intent: intent(), operationId });

  assert.deepEqual(calls.map(([name]) => name), ['container', 'fpm', 'umask', 'fpm-inspect']);
  assert.equal(calls[0][1].adapter, undefined);
  assert.equal(calls[0][2].operationId, operationId);
  assert.equal(calls[1][2].operationId, operationId);
  assert.equal(calls[2][1], 'php');
  assert.equal(result.adapter, 'php-fpm');
  assert.equal(result.containerLocked, true);
  assert.equal(result.containerOwner, 'root:root');
  assert.equal(result.releaseUid, 1201);
  assert.equal(result.runtimeUmask, '0027');
});

test('PHP runtime inspect does not claim readiness when container lockdown drifted', async () => {
  let fpmInspected = false;
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { throw new Error('unused'); },
      async inspect() { return { satisfied: false, reason: 'php_site_container_control_plane_drift' }; },
    },
    fpmManager: {
      async apply() { throw new Error('unused'); },
      async inspect() { fpmInspected = true; return { satisfied: true }; },
      async compensate() { return { satisfied: true }; },
      async inspectCompensation() { return { satisfied: true }; },
    },
    umaskManager: umaskManager(),
  });

  const result = await handler.inspect({ intent: intent(), operationId });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'php_container_not_ready');
  assert.equal(fpmInspected, false);
});

test('PHP runtime inspect fails closed when the shared FPM service umask drifted', async () => {
  let fpmInspected = false;
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { return { satisfied: true, adapter: 'php-container' }; },
      async inspect() { return { satisfied: true, adapter: 'php-container', containerOwner: 'root:root' }; },
    },
    fpmManager: {
      async apply() { return { satisfied: true, adapter: 'php-fpm' }; },
      async inspect() { fpmInspected = true; return { satisfied: true }; },
      async compensate() { return { satisfied: true }; },
      async inspectCompensation() { return { satisfied: true }; },
    },
    umaskManager: umaskManager(null, { satisfied: false }),
  });

  const result = await handler.inspect({ intent: intent(), operationId });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'php_runtime_umask_not_ready');
  assert.equal(fpmInspected, false);
});

test('PHP runtime compensation removes only FPM state and preserves shared service policy', async () => {
  const calls = [];
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { return { satisfied: true, adapter: 'php-container' }; },
      async inspect() { return { satisfied: true, adapter: 'php-container' }; },
    },
    fpmManager: {
      async apply() { return { satisfied: true, adapter: 'php-fpm' }; },
      async inspect() { return { satisfied: true, adapter: 'php-fpm' }; },
      async compensate(value, options) { calls.push(['compensate', value, options]); return { satisfied: true }; },
      async inspectCompensation(value, options) { calls.push(['inspect', value, options]); return { satisfied: true }; },
    },
    umaskManager: umaskManager(calls),
  });

  await handler.compensate({ intent: intent(), operationId });
  await handler.inspectCompensation({ intent: intent(), operationId });
  assert.deepEqual(calls.map(([name]) => name), ['compensate', 'inspect']);
});


test('PHP runtime migration preview combines container, FPM and UMask evidence without apply calls', async () => {
  const calls = [];
  const containerPreview = {
    version: 1,
    adapter: 'php-container',
    satisfied: false,
    current: { applicationRoot: { present: true, uid: 1201, gid: 1201, mode: '0750' } },
    desired: { websiteId, applicationId, unixUser, documentRoot },
    differences: ['php_site_container_control_plane_drift'],
  };
  const fpmPreview = {
    version: 1,
    adapter: 'php-fpm',
    satisfied: false,
    safeCreateCandidate: false,
    current: { pool: { present: false, sha256: null } },
    desired: { websiteId, applicationId, unixUser, documentRoot },
    differences: ['php_fpm_pool_missing'],
  };
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { calls.push('unexpected-container-apply'); return {}; },
      async inspect() { return { satisfied: false }; },
      async previewMigration(value, options) {
        calls.push(['container-preview', value, options]);
        return containerPreview;
      },
    },
    fpmManager: {
      async apply() { calls.push('unexpected-fpm-apply'); return {}; },
      async inspect() { return { satisfied: false }; },
      async previewMigration(value, options) {
        calls.push(['fpm-preview', value, options]);
        return fpmPreview;
      },
      async compensate() { return { satisfied: true }; },
      async inspectCompensation() { return { satisfied: true }; },
    },
    umaskManager: {
      async apply() { calls.push('unexpected-umask-apply'); return {}; },
      async inspect(runtime) {
        calls.push(['umask-preview', runtime]);
        return { satisfied: false, reason: 'service_umask_not_effective' };
      },
    },
  });

  const preview = await handler.previewMigration({ intent: intent(), operationId });

  assert.equal(preview.version, 1);
  assert.equal(preview.adapter, 'php-runtime');
  assert.equal(preview.satisfied, false);
  assert.equal(preview.current.container, containerPreview);
  assert.equal(preview.current.fpm, fpmPreview);
  assert.deepEqual(preview.current.fpmRuntime, {
    satisfied: false,
    reason: 'php_fpm_runtime_not_ready',
  });
  assert.deepEqual(preview.current.umask, {
    satisfied: false,
    reason: 'service_umask_not_effective',
  });
  assert.equal(preview.desired.runtimeUmask, '0027');
  assert.deepEqual(preview.differences, [
    'php_site_container_control_plane_drift',
    'php_fpm_pool_missing',
    'php_fpm_runtime_not_ready',
    'php_runtime_umask_not_ready',
  ]);
  assert.deepEqual(calls.map((entry) => Array.isArray(entry) ? entry[0] : entry), [
    'container-preview',
    'fpm-preview',
    'umask-preview',
  ]);
});


test('PHP runtime migration opens only when container and UMask are already canonical and FPM pool is safe-create', async () => {
  const calls = [];
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { throw new Error('unexpected container apply'); },
      async inspect(value, options) {
        calls.push(['container-inspect', value, options]);
        return { satisfied: true, adapter: 'php-container', containerOwner: 'root:root', releaseUid: 1201, releaseGid: 1201 };
      },
      async previewMigration(value, options) {
        calls.push(['container-preview', value, options]);
        return { version: 1, adapter: 'php-container', satisfied: true, current: {}, desired: {}, differences: [] };
      },
    },
    fpmManager: {
      async apply() { throw new Error('unexpected normal FPM apply'); },
      async inspect() { return { satisfied: false }; },
      async previewMigration(value, options) {
        calls.push(['fpm-preview', value, options]);
        return {
          version: 1,
          adapter: 'php-fpm',
          satisfied: false,
          safeCreateCandidate: true,
          current: { pool: { present: false } },
          desired: { websiteId, applicationId, unixUser, documentRoot },
          differences: ['php_fpm_pool_missing'],
        };
      },
      async inspectMigrationOperation(value, options) {
        calls.push(['fpm-migration-inspect', value, options]);
        return {
          satisfied: true,
          adapter: 'php-fpm',
          phpFpmReceiptVersion: 1,
          createdPhpFpmPool: true,
        };
      },
      async applyMigration(value, options) {
        calls.push(['fpm-migration-apply', value, options]);
        return {
          satisfied: true,
          adapter: 'php-fpm',
          phpFpmReceiptVersion: 1,
          createdPhpFpmPool: true,
        };
      },
      async compensate() { return { satisfied: true, restoredPrevious: false, preservedExisting: false }; },
      async inspectCompensation() { return { satisfied: true, restoredPrevious: false, preservedExisting: false }; },
    },
    umaskManager: {
      async apply() { throw new Error('unexpected UMask apply'); },
      async inspect(runtime) {
        calls.push(['umask-inspect', runtime]);
        return { satisfied: true, adapter: 'systemd-umask', runtime, umask: '0027' };
      },
    },
  });

  const preview = await handler.previewMigration({ intent: intent(), operationId, releaseOperationId });
  assert.equal(preview.safeCreateCandidate, true);

  const applied = await handler.applyMigration({ intent: intent(), operationId, releaseOperationId });

  assert.equal(applied.satisfied, true);
  assert.equal(applied.phpRuntimeMigration, true);
  assert.equal(applied.phpFpmReceiptVersion, 1);
  assert.equal(applied.createdPhpFpmPool, true);
  const containerPreviewCall = calls.find(([name]) => name === 'container-preview');
  const containerInspectCall = calls.find(([name]) => name === 'container-inspect');
  const fpmPreviewCall = calls.find(([name]) => name === 'fpm-preview');
  const fpmApplyCall = calls.find(([name]) => name === 'fpm-migration-apply');
  assert.equal(containerPreviewCall[2].operationId, releaseOperationId);
  assert.equal(containerInspectCall[2].operationId, releaseOperationId);
  assert.equal(fpmPreviewCall[2].operationId, operationId);
  assert.equal(fpmApplyCall[2].operationId, operationId);
  assert.equal(calls.some(([name]) => name === 'fpm-migration-apply'), true);
  assert.equal(calls.some(([name]) => name === 'unexpected container apply'), false);
  assert.equal(calls.some(([name]) => name === 'unexpected UMask apply'), false);
});

test('PHP runtime migration refuses container or shared UMask drift without mutation', async () => {
  for (const state of [
    { containerSatisfied: false, umaskSatisfied: true },
    { containerSatisfied: true, umaskSatisfied: false },
  ]) {
    let migrationApplyCalls = 0;
    const handler = createWebsitePhpRuntimeProvisioningHandler({
      containerManager: {
        async apply() { throw new Error('unused'); },
        async inspect() { return { satisfied: state.containerSatisfied }; },
        async previewMigration() {
          return {
            version: 1,
            adapter: 'php-container',
            satisfied: state.containerSatisfied,
            current: {},
            desired: {},
            differences: state.containerSatisfied ? [] : ['php_site_container_control_plane_drift'],
          };
        },
      },
      fpmManager: {
        async apply() { throw new Error('unused'); },
        async inspect() { return { satisfied: false }; },
        async previewMigration() {
          return {
            version: 1,
            adapter: 'php-fpm',
            satisfied: false,
            safeCreateCandidate: true,
            current: {},
            desired: {},
            differences: ['php_fpm_pool_missing'],
          };
        },
        async inspectMigrationOperation() { return { satisfied: false }; },
        async applyMigration() { migrationApplyCalls += 1; return {}; },
        async compensate() { return { satisfied: true }; },
        async inspectCompensation() { return { satisfied: true }; },
      },
      umaskManager: {
        async apply() { throw new Error('unused'); },
        async inspect() {
          return state.umaskSatisfied
            ? { satisfied: true, umask: '0027' }
            : { satisfied: false, reason: 'service_umask_not_effective' };
        },
      },
    });

    await assert.rejects(
      handler.applyMigration({ intent: intent(), operationId }),
      (error) => error.code === 'website_php_runtime_migration_not_safe_create',
    );
    assert.equal(migrationApplyCalls, 0);
  }
});

test('PHP runtime migration compensation delegates only receipt-owned FPM pool rollback', async () => {
  const calls = [];
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { return { satisfied: true, adapter: 'php-container' }; },
      async inspect() { return { satisfied: true, adapter: 'php-container' }; },
      async previewMigration() { return { version: 1, adapter: 'php-container', satisfied: true, current: {}, desired: {}, differences: [] }; },
    },
    fpmManager: {
      async apply() { return { satisfied: true, adapter: 'php-fpm' }; },
      async inspect() { return { satisfied: true, adapter: 'php-fpm' }; },
      async previewMigration() { return { version: 1, adapter: 'php-fpm', satisfied: true, safeCreateCandidate: false, current: {}, desired: {}, differences: [] }; },
      async inspectMigrationOperation() { return { satisfied: true, phpFpmReceiptVersion: 1, createdPhpFpmPool: true }; },
      async applyMigration() { return { satisfied: true, phpFpmReceiptVersion: 1, createdPhpFpmPool: true }; },
      async compensate(value, options) {
        calls.push(['fpm-compensate', value, options]);
        return { satisfied: true, restoredPrevious: false, preservedExisting: false };
      },
      async inspectCompensation(value, options) {
        calls.push(['fpm-compensation-inspect', value, options]);
        return { satisfied: true, restoredPrevious: false, preservedExisting: false };
      },
    },
    umaskManager: umaskManager(),
  });

  await handler.inspectMigrationCompensation({ intent: intent(), operationId });
  await handler.compensateMigration({ intent: intent(), operationId });

  assert.deepEqual(calls.map(([name]) => name), ['fpm-compensation-inspect', 'fpm-compensate']);
});


test('PHP container metadata migration uses source release identity and isolated receipt lifecycle only', async () => {
  const calls = [];
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { throw new Error('unexpected normal container apply'); },
      async inspect() { return { satisfied: false }; },
      async previewMigration(value, options) {
        calls.push(['container-preview', value, options]);
        return {
          version: 1,
          adapter: 'php-container',
          satisfied: false,
          safeMigrationCandidate: true,
          current: {},
          desired: {},
          differences: ['php_site_container_control_plane_drift'],
        };
      },
      async inspectMigrationOperation(value, options) {
        calls.push(['container-migration-inspect', value, options]);
        return { satisfied: true, phpContainerReceiptVersion: 1, migratedPhpContainer: true };
      },
      async applyMigration(value, options) {
        calls.push(['container-migration-apply', value, options]);
        return { satisfied: true, phpContainerReceiptVersion: 1, migratedPhpContainer: true };
      },
      async inspectMigrationCompensation(value, options) {
        calls.push(['container-migration-compensation-inspect', value, options]);
        return { satisfied: true, restoredPhpContainerMetadata: true };
      },
      async compensateMigration(value, options) {
        calls.push(['container-migration-compensate', value, options]);
        return { satisfied: true, restoredPhpContainerMetadata: true };
      },
    },
    fpmManager: {
      async apply() { throw new Error('unexpected FPM apply'); },
      async inspect() { return { satisfied: true, adapter: 'php-fpm' }; },
      async previewMigration() {
        return { version: 1, adapter: 'php-fpm', satisfied: false, safeCreateCandidate: false, current: {}, desired: {}, differences: ['php_fpm_receipt_missing'] };
      },
      async compensate() { throw new Error('unexpected FPM compensation'); },
      async inspectCompensation() { throw new Error('unexpected FPM compensation inspection'); },
    },
    umaskManager: umaskManager(),
  });

  const preview = await handler.previewMigration({ intent: intent(), operationId, releaseOperationId });
  assert.equal(preview.safeContainerMigrationCandidate, true);
  const applied = await handler.applyContainerMigration({ intent: intent(), operationId, releaseOperationId });
  assert.equal(applied.phpContainerReceiptVersion, 1);
  assert.equal(applied.migratedPhpContainer, true);
  const applyCall = calls.find(([name]) => name === 'container-migration-apply');
  assert.equal(applyCall[2].operationId, releaseOperationId);
  assert.equal(applyCall[2].migrationOperationId, operationId);

  const inspectedRollback = await handler.inspectContainerMigrationCompensation({ intent: intent(), operationId, releaseOperationId });
  assert.equal(inspectedRollback.restoredPhpContainerMetadata, true);
  await handler.compensateContainerMigration({ intent: intent(), operationId, releaseOperationId });
  assert.equal(calls.some(([name]) => name === 'container-migration-compensate'), true);
});
