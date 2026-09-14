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

test('local Passenger migration forwards the job UUID as operation ownership', async () => {
  const calls = [];
  const operation = createLocalNodePassengerMigrationOperation({
    migrationManager: {
      async migrate(input) {
        calls.push(input);
        return { migrated: true, operationId: input.operationId };
      },
    },
  });

  const result = await operation.execute(payload, execution);
  assert.deepEqual(result, { migrated: true, operationId: jobId });
  assert.deepEqual(calls, [{ operationId: jobId, node: payload.node, domain: payload.domain }]);
});

test('local Passenger migration rejects mismatched execution before host mutation', async () => {
  let called = false;
  const operation = createLocalNodePassengerMigrationOperation({
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
  assert.equal(called, false);
});
