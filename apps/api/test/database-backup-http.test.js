import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  DatabaseHttpError,
  mountDatabaseRoutes,
} from '../src/database-http.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';

function mounted({ jobs = [] } = {}) {
  const routes = [];
  const enqueued = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers]); },
    delete(path, ...handlers) { routes.push(['DELETE', path, handlers]); },
  };
  const jobRegistry = {
    async listJobs() { return jobs; },
    async enqueue(input) {
      enqueued.push(structuredClone(input));
      return { id: '22345678-1234-4234-8234-123456789012', ...input, status: 'queued' };
    },
  };
  mountDatabaseRoutes(app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    jobRegistry,
  });
  const route = routes.find(([method, path]) => method === 'POST'
    && path === '/api/servers/:serverId/databases/:name/backup');
  assert.ok(route);
  return { handler: route[2].at(-1), enqueued };
}

async function invoke(handler, body) {
  let status = 200;
  let payload = null;
  let error = null;
  const response = {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  };
  await handler(
    { params: { serverId, name: databaseName }, body, query: {} },
    response,
    (value) => { error = value; },
  );
  return { status, payload, error };
}

test('database backup route queues only safe database identity after exact confirmation', async () => {
  const fx = mounted();
  const response = await invoke(fx.handler, { confirmation: `backup:${databaseName}` });
  assert.equal(response.error, null);
  assert.equal(response.status, 202);
  assert.equal(fx.enqueued.length, 1);
  assert.deepEqual(fx.enqueued[0], {
    serverId,
    type: OPERATIONS.DATABASE_BACKUP,
    operation: OPERATIONS.DATABASE_BACKUP,
    payload: { databaseName },
    resourceType: 'database',
    resourceId: databaseName,
  });
  assert.equal(JSON.stringify(response.payload).includes('dumpPath'), false);
  assert.equal(JSON.stringify(response.payload).includes('sql'), false);
});

test('database backup route rejects stale, extra or missing confirmation without enqueueing', async () => {
  for (const body of [
    {},
    { confirmation: 'backup:other_db' },
    { confirmation: `backup:${databaseName}`, dumpPath: '/private/dump.sql' },
  ]) {
    const fx = mounted();
    const response = await invoke(fx.handler, body);
    assert.ok(response.error instanceof DatabaseHttpError);
    assert.equal(fx.enqueued.length, 0);
  }
});

test('database backup serializes with every other queued or running database mutation', async () => {
  for (const operation of [OPERATIONS.DATABASE_CREDENTIAL_APPLY, OPERATIONS.DATABASE_RESTORE]) {
    const fx = mounted({ jobs: [{ operation, status: 'running' }] });
    const response = await invoke(fx.handler, { confirmation: `backup:${databaseName}` });
    assert.equal(response.error?.code, 'database_job_conflict');
    assert.equal(fx.enqueued.length, 0);
  }
});
