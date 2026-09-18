import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteProvisioningHandlers,
  websiteProvisioningIsolationInternals,
} from '../src/website-provisioning-handlers-isolation.js';

function baseRuntime({ satisfied = true } = {}) {
  const calls = [];
  return {
    calls,
    handler: {
      async apply(context) { calls.push(['apply', context]); return { satisfied, adapter: 'passenger', unixUser: 'yunapp-test' }; },
      async inspect(context) { calls.push(['inspect', context]); return { satisfied, adapter: 'passenger', unixUser: 'yunapp-test' }; },
      async previewMigration(context) {
        calls.push(['preview-migration', context]);
        return {
          version: 1,
          adapter: 'passenger',
          satisfied,
          current: {},
          desired: {},
          differences: satisfied ? [] : ['passenger_runtime_unavailable'],
        };
      },
    },
  };
}

function umask({ satisfied = true } = {}) {
  const calls = [];
  return {
    calls,
    manager: {
      async apply(runtime) { calls.push(['apply', runtime]); return satisfied ? { satisfied: true, umask: '0027' } : { satisfied: false }; },
      async inspect(runtime) { calls.push(['inspect', runtime]); return satisfied ? { satisfied: true, umask: '0027' } : { satisfied: false, reason: 'service_umask_not_effective' }; },
    },
  };
}

test('Passenger runtime readiness includes shared Nginx UMask=0027 policy', async () => {
  const base = baseRuntime();
  const policy = umask();
  const handler = websiteProvisioningIsolationInternals.passengerRuntimeHandler(base.handler, policy.manager);
  const context = { operationId: 'operation-1', intent: { adapter: 'passenger' } };

  const applied = await handler.apply(context);
  const inspected = await handler.inspect(context);

  assert.equal(applied.satisfied, true);
  assert.equal(applied.runtimeUmask, '0027');
  assert.equal(inspected.runtimeUmask, '0027');
  assert.deepEqual(policy.calls, [['apply', 'passenger'], ['inspect', 'passenger']]);
});

test('Passenger inspect fails closed when Nginx runtime umask is not effective', async () => {
  const base = baseRuntime();
  const policy = umask({ satisfied: false });
  const handler = websiteProvisioningIsolationInternals.passengerRuntimeHandler(base.handler, policy.manager);

  const result = await handler.inspect({ intent: { adapter: 'passenger' } });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'passenger_runtime_umask_not_ready');
  assert.equal(result.umaskReason, 'service_umask_not_effective');
});

test('Passenger wrapper does not mutate shared service policy if base runtime is not ready', async () => {
  const base = baseRuntime({ satisfied: false });
  const policy = umask();
  const handler = websiteProvisioningIsolationInternals.passengerRuntimeHandler(base.handler, policy.manager);

  const result = await handler.apply({ intent: { adapter: 'passenger' } });
  assert.equal(result.satisfied, false);
  assert.deepEqual(policy.calls, []);
});


test('Passenger migration preview survives the isolation wrapper and pins shared UMask drift', async () => {
  const base = baseRuntime();
  const policy = umask({ satisfied: false });
  const handler = websiteProvisioningIsolationInternals.passengerRuntimeHandler(base.handler, policy.manager);

  const preview = await handler.previewMigration({ intent: { adapter: 'passenger' } });

  assert.equal(preview.adapter, 'passenger');
  assert.equal(preview.satisfied, false);
  assert.deepEqual(preview.runtimeUmask, {
    satisfied: false,
    reason: 'service_umask_not_effective',
  });
  assert.deepEqual(preview.differences, ['passenger_runtime_umask_not_ready']);
  assert.deepEqual(base.calls.map(([name]) => name), ['preview-migration']);
  assert.deepEqual(policy.calls, [['inspect', 'passenger']]);
});

test('Static runtime isolates retained publish releases before Nginx routing can proceed', async () => {
  const calls = [];
  const base = {
    async apply(context) { calls.push(['runtime-apply', context]); return { satisfied: true, adapter: 'static', releaseId: 'release-1' }; },
    async inspect(context) { calls.push(['runtime-inspect', context]); return { satisfied: true, adapter: 'static', releaseId: 'release-1' }; },
    async compensate(context) { calls.push(['runtime-compensate', context]); return { satisfied: true }; },
    async inspectCompensation(context) { calls.push(['runtime-compensation-inspect', context]); return { satisfied: true }; },
  };
  const isolation = {
    async apply(value) { calls.push(['isolation-apply', value]); return { satisfied: true, adapter: 'static-publish-isolation', releaseCount: 3, currentRelease: '/var/www/yunpanel/apps/app/releases/release-1' }; },
    async inspect(value) { calls.push(['isolation-inspect', value]); return { satisfied: true, adapter: 'static-publish-isolation', releaseCount: 3, currentRelease: '/var/www/yunpanel/apps/app/releases/release-1' }; },
  };
  const handler = websiteProvisioningIsolationInternals.staticRuntimeHandler(base, isolation);
  const context = { intent: { websiteId: 'website-1', applicationId: 'application-1' } };

  const applied = await handler.apply(context);
  const inspected = await handler.inspect(context);

  assert.deepEqual(calls.slice(0, 4).map(([name]) => name), [
    'runtime-apply', 'isolation-apply', 'runtime-inspect', 'isolation-inspect',
  ]);
  assert.deepEqual(calls[1][1], { websiteId: 'website-1', applicationId: 'application-1' });
  assert.equal(applied.publishIsolated, true);
  assert.equal(applied.isolatedReleaseCount, 3);
  assert.equal(inspected.publishIsolated, true);
});

test('Static migration preview combines current deployment state with exact publish isolation evidence', async () => {
  const calls = [];
  const base = {
    async apply() { throw new Error('unused'); },
    async inspect(context) {
      calls.push(['runtime-inspect', context]);
      return {
        satisfied: false,
        reason: 'website_static_release_not_current',
        adapter: 'static',
        applicationId: 'application-1',
        releaseId: 'release-old',
        deploymentId: 'release-new',
      };
    },
    async compensate() { return { satisfied: true }; },
    async inspectCompensation() { return { satisfied: true }; },
  };
  const isolation = {
    async apply() { throw new Error('unused'); },
    async inspect() { throw new Error('unused'); },
    async previewMigration(value) {
      calls.push(['isolation-preview', value]);
      return {
        version: 1,
        adapter: 'static-publish-isolation',
        satisfied: false,
        safeMigrationCandidate: false,
        current: {},
        desired: {},
        differences: ['static_publish_acl_drift'],
      };
    },
  };
  const handler = websiteProvisioningIsolationInternals.staticRuntimeHandler(base, isolation);
  const context = {
    intent: {
      websiteId: 'website-1',
      applicationId: 'application-1',
      mode: 'deploy',
      deploymentId: 'release-new',
    },
  };

  const preview = await handler.previewMigration(context);

  assert.equal(preview.version, 1);
  assert.equal(preview.adapter, 'static-runtime');
  assert.equal(preview.satisfied, false);
  assert.equal(preview.safeControlMigrationCandidate, false);
  assert.equal(preview.current.runtime.reason, 'website_static_release_not_current');
  assert.equal(preview.current.isolation.adapter, 'static-publish-isolation');
  assert.deepEqual(preview.desired, {
    websiteId: 'website-1',
    applicationId: 'application-1',
    mode: 'deploy',
    deploymentId: 'release-new',
  });
  assert.deepEqual(preview.differences, [
    'website_static_release_not_current',
    'static_publish_acl_drift',
  ]);
  assert.deepEqual(calls.map(([name]) => name), ['runtime-inspect', 'isolation-preview']);
});

test('Static control migration delegates only to receipt-backed publish metadata lifecycle', async () => {
  const calls = [];
  const base = {
    async apply() { throw new Error('normal static apply must not run'); },
    async inspect(context) {
      calls.push(['runtime-inspect', context]);
      return { satisfied: true, adapter: 'static', applicationId: 'application-1' };
    },
    async compensate() { throw new Error('normal static compensation must not run'); },
    async inspectCompensation() { throw new Error('normal static compensation inspect must not run'); },
  };
  const isolation = {
    async apply() { throw new Error('normal isolation apply must not run'); },
    async inspect() { throw new Error('normal isolation inspect must not run'); },
    async previewMigration(value) {
      calls.push(['migration-preview', value]);
      return {
        version: 1,
        adapter: 'static-publish-isolation',
        satisfied: false,
        safeMigrationCandidate: true,
        current: {},
        desired: {},
        differences: ['static_publish_container_drift'],
      };
    },
    async inspectMigrationOperation(value, options) {
      calls.push(['migration-inspect', value, options]);
      return { satisfied: true, staticControlReceiptVersion: 1, migratedStaticControlMetadata: true };
    },
    async applyMigration(value, options) {
      calls.push(['migration-apply', value, options]);
      return { satisfied: true, staticControlReceiptVersion: 1, migratedStaticControlMetadata: true };
    },
    async inspectMigrationCompensation(value, options) {
      calls.push(['migration-compensation-inspect', value, options]);
      return { satisfied: true, restoredStaticControlMetadata: true, receiptState: 'active' };
    },
    async compensateMigration(value, options) {
      calls.push(['migration-compensate', value, options]);
      return { satisfied: true, restoredStaticControlMetadata: true, receiptState: 'compensated' };
    },
  };
  const handler = websiteProvisioningIsolationInternals.staticRuntimeHandler(base, isolation);
  const context = {
    operationId: '12345678-1234-4234-8234-123456789012',
    intent: { websiteId: 'website-1', applicationId: 'application-1' },
  };

  const applied = await handler.applyControlMigration(context);
  assert.equal(applied.staticControlReceiptVersion, 1);
  assert.equal(applied.staticRuntimeMigration, true);
  assert.deepEqual(calls.map(([name]) => name), ['migration-preview', 'migration-apply', 'migration-inspect']);
  assert.equal(calls.some(([name]) => name === 'runtime-inspect'), false);

  const pending = await handler.inspectControlMigrationCompensation(context);
  assert.deepEqual(pending, {
    satisfied: false,
    reason: 'static_publish_migration_compensation_receipt_pending',
  });
  const rolledBack = await handler.compensateControlMigration(context);
  assert.equal(rolledBack.restoredStaticControlMetadata, true);
  assert.equal(calls.some(([name]) => name === 'migration-compensate'), true);
});

test('Static runtime inspect fails closed when publish ACL or ownership drifted', async () => {
  const base = {
    async apply() { return { satisfied: true, adapter: 'static' }; },
    async inspect() { return { satisfied: true, adapter: 'static' }; },
    async compensate() { return { satisfied: true }; },
    async inspectCompensation() { return { satisfied: true }; },
  };
  const isolation = {
    async apply() { return { satisfied: false, reason: 'static_publish_acl_drift' }; },
    async inspect() { return { satisfied: false, reason: 'static_publish_acl_drift' }; },
  };
  const handler = websiteProvisioningIsolationInternals.staticRuntimeHandler(base, isolation);

  const result = await handler.inspect({ intent: { websiteId: 'website-1', applicationId: 'application-1' } });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'static_publish_isolation_not_ready');
  assert.equal(result.isolationReason, 'static_publish_acl_drift');
});

test('Static compensation remains owned by the existing release rollback lifecycle', async () => {
  const calls = [];
  const base = {
    async apply() { return { satisfied: true }; },
    async inspect() { return { satisfied: true }; },
    async compensate(context) { calls.push(['compensate', context]); return { satisfied: true }; },
    async inspectCompensation(context) { calls.push(['inspect', context]); return { satisfied: true }; },
  };
  const isolation = {
    async apply() { throw new Error('unused'); },
    async inspect() { throw new Error('unused'); },
  };
  const handler = websiteProvisioningIsolationInternals.staticRuntimeHandler(base, isolation);
  const context = { operationId: 'operation-1', intent: { websiteId: 'website-1', applicationId: 'application-1' } };

  await handler.compensate(context);
  await handler.inspectCompensation(context);
  assert.deepEqual(calls.map(([name]) => name), ['compensate', 'inspect']);
});


test('isolated provisioning handler set exposes elFinder with the injected per-Website FPM manager', async () => {
  const calls = [];
  const fpmManager = {
    async apply(input, options) {
      calls.push(['apply', input, options]);
      return { satisfied: true, adapter: 'elfinder-fpm', socketPath: '/run/php/elfinder.sock' };
    },
    async inspect(input) {
      calls.push(['inspect', input]);
      return { satisfied: true, adapter: 'elfinder-fpm', socketPath: '/run/php/elfinder.sock' };
    },
    async compensate(input, options) {
      calls.push(['compensate', input, options]);
      return { satisfied: true };
    },
    async inspectCompensation(input, options) {
      calls.push(['inspect-compensation', input, options]);
      return { satisfied: true };
    },
  };
  const policy = umask();
  const sharedCalls = [];
  const gatewayCalls = [];
  const handlers = createWebsiteProvisioningHandlers({
    elFinderFpmSiteManager: fpmManager,
    elFinderSharedApplicationManager: {
      async install(id) {
        sharedCalls.push(['install', id]);
        return {
          id,
          installed: true,
          units: [],
          health: { status: 'installed', configuration: 'valid' },
        };
      },
      async inspect(id) {
        sharedCalls.push(['inspect', id]);
        return {
          id,
          installed: true,
          units: [],
          health: { status: 'installed', configuration: 'valid' },
        };
      },
    },
    elFinderGatewayManager: {
      async apply() {
        gatewayCalls.push('apply');
        return {
          satisfied: true,
          adapter: 'elfinder-nginx-gateway',
          gatewaySocketPath: '/run/yunpanel/elfinder-http.sock',
          configSha256: 'a'.repeat(64),
        };
      },
      async inspect() {
        gatewayCalls.push('inspect');
        return {
          satisfied: true,
          adapter: 'elfinder-nginx-gateway',
          gatewaySocketPath: '/run/yunpanel/elfinder-http.sock',
          configSha256: 'a'.repeat(64),
        };
      },
    },
    serviceUmaskManager: policy.manager,
  });
  const context = {
    operationId: '12345678-1234-4234-8234-123456789012',
    intent: {
      adapter: 'elfinder-fpm',
      websiteId: '22345678-1234-4234-8234-123456789012',
      applicationId: '32345678-1234-4234-8234-123456789012',
      unixUser: 'yunapp-abcdef123456',
    },
  };

  const result = await handlers.elfinder.apply(context);
  assert.equal(result.satisfied, true);
  assert.equal(result.runtimeUmask, '0027');
  assert.deepEqual(calls.map(([name]) => name), ['apply', 'inspect']);
  assert.deepEqual(sharedCalls, [['install', 'elfinder']]);
  assert.deepEqual(gatewayCalls, ['apply']);
  assert.deepEqual(policy.calls, [['apply', 'php']]);
});
