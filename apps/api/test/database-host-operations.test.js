import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations } from '../src/local-host-operations.js';

const calls = [];
const databaseManager = {
  inspect: async () => { calls.push(['inspect']); return { engine: 'mariadb', version: '10.11', databases: [] }; },
  createDatabase: async (name) => { calls.push(['create', name]); return { engine: 'mariadb', version: '10.11', database: { name, sizeBytes: 0 }, created: true }; },
  dropDatabase: async (name) => { calls.push(['delete', name]); return { engine: 'mariadb', version: '10.11', database: { name, sizeBytes: 0 }, deleted: true }; },
};

test('local host operation map dispatches database lifecycle without transport-specific payload changes', async () => {
  calls.length = 0;
  const operations = createLocalHostOperations({ databaseManager });
  assert.equal(operations.supports(OPERATIONS.DATABASE_INSPECT), true);
  assert.equal(operations.supports(OPERATIONS.DATABASE_CREATE), true);
  assert.equal(operations.supports(OPERATIONS.DATABASE_DELETE), true);

  assert.deepEqual(await operations.executeOperation(OPERATIONS.DATABASE_INSPECT, {}), { engine: 'mariadb', version: '10.11', databases: [] });
  assert.equal((await operations.executeOperation(OPERATIONS.DATABASE_CREATE, { name: 'app_main' })).created, true);
  assert.equal((await operations.executeOperation(OPERATIONS.DATABASE_DELETE, { name: 'app_main' })).deleted, true);
  assert.deepEqual(calls, [['inspect'], ['create', 'app_main'], ['delete', 'app_main']]);
});
