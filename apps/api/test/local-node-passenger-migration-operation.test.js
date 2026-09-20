import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNodePassengerMigrationExecutionContext,
  createLocalNodePassengerMigrationOperation,
} from '../src/local-node-passenger-migration-operation.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const jobId = 'd2fe443b-0fa6-4f98-a061-6f41b7f2684e';
const payload = Object.freeze({
  node: Object.freeze({ applicationId }),
  domain: Object.freeze({ primaryDomain: 'example.com' }),
});
const execution = Object.freeze({
  jobId,
  resourceType: 'application',
  resourceId: applicationId,
});
const passengerTarget = Object.freeze({
  appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  startupFile: 'server.js',
  nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
  user: 'yunapp-0123456789ab',
  group: 'yunapp-0123456789ab',
  appEnv: 'production',
  environmentInclude: `/etc/yunpanel/passenger-env/${applicationId}.conf`,
});

function migrationPreview(overrides = {}) {
  return {
    target: {
      intent: {
        appRoot: passengerTarget.appRoot,
        documentRoot: passengerTarget.documentRoot,
        startupFile: passengerTarget.startupFile,
        unixUser: passengerTarget.user,
        appEnv: passengerTarget.appEnv,
        environmentInclude: passengerTarget.environmentInclude,
      },
      inspection: {
        satisfied: true,
        nodeBinary: passengerTarget.nodeBinary,
      },
    },
    ...overrides,
  };
}

test('Passenger migration execution context is bound to the queued application and UUID job', () => {
  assert.equal(assertNodePassengerMigrationExecutionContext(payload, execution), execution);

  for (const invalid of [
    { ...execution, jobId: 'passenger-migration-job' },
    { ...execution, resourceType: 'website' },
    { ...execution, resourceId: 'ff830043-9752-4640-83b4-3a1998de78a0' },
    null,
  ]) {
    assert.throws(
      () => assertNodePassengerMigrationExecutionContext(payload, invalid),
      (error) => error?.code === 'node_passenger_migration_execution_context_invalid',
    );
  }
});

test('local Passenger migration forwards job ownership and preserves pre-cutover target evidence', async () => {
  const calls = [];
  const operation = createLocalNodePassengerMigrationOperation({
    migrationPreview: { async preview() { return migrationPreview(); } },
    migrationManager: {
      async migrate(input) {
        calls.push(input);
        return { migrated: true, operationId: input.operationId };
      },
    },
  });

  const result = await operation.execute(payload, execution);
  assert.deepEqual(result, {
    migrated: true,
    operationId: jobId,
    passengerTarget,
  });
  assert.deepEqual(calls, [{ operationId: jobId, node: payload.node, domain: payload.domain }]);
});

test('local Passenger migration rejects missing target evidence before host mutation', async () => {
  let called = false;
  const operation = createLocalNodePassengerMigrationOperation({
    migrationPreview: {
      async preview() {
        return migrationPreview({ target: { intent: null, inspection: null } });
      },
    },
    migrationManager: {
      async migrate() {
        called = true;
        return { migrated: true };
      },
    },
  });

  await assert.rejects(
    operation.execute(payload, execution),
    (error) => error?.code === 'node_passenger_migration_target_evidence_unavailable',
  );
  assert.equal(called, false);
});

test('local Passenger migration rejects mismatched execution before preview or host mutation', async () => {
  let previewed = false;
  let called = false;
  const operation = createLocalNodePassengerMigrationOperation({
    migrationPreview: {
      async preview() {
        previewed = true;
        return migrationPreview();
      },
    },
    migrationManager: {
      async migrate() {
        called = true;
        return { migrated: true };
      },
    },
  });

  await assert.rejects(
    operation.execute(payload, { ...execution, resourceId: 'ff830043-9752-4640-83b4-3a1998de78a0' }),
    (error) => error?.code === 'node_passenger_migration_execution_context_invalid',
  );
  assert.equal(previewed, false);
  assert.equal(called, false);
});
