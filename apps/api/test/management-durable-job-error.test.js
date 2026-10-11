import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createAuthStore } from '../src/auth-store.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { DurableJobRegistryError } from '../src/durable-job-registry.js';

test('global management routes expose a durable mutation guard as actionable 503', async t => {
  const store = createAuthStore({ filePath: ':memory:' });
  t.after(() => store.close());
  const password = randomBytes(32).toString('base64url');
  await store.completeSetup({ setupToken: store.issueSetupToken().token, username: 'guard-owner', password });
  const session = await store.login({ username: 'guard-owner', password });
  const registry = createServerRegistry(); await registry.init();
  const local = await registry.createLocalServer({ hostname: 'guard-host' });
  const jobs = { ...createJobRegistry(), enqueue: async () => {
    throw new DurableJobRegistryError('durable_job_reconciliation_required', 'Persisted running jobs require reconciliation');
  } };
  const origin = 'http://127.0.0.1:5173';
  const server = http.createServer(createAuthenticatedApi({ store, publicOrigin: origin, development: true,
    createHandler: () => createApp({ registry, jobRegistry: jobs, environment: 'development' }),
  })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/servers/${local.id}/system/packages/inspect`, {
    method: 'POST', headers: { cookie: `yunpanel_session=${session.token}`, origin, 'x-csrf-token': session.session.csrfToken },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'durable_job_reconciliation_required', message: 'Persisted running jobs require reconciliation' } });
  assert.equal((await jobs.listJobs()).length, 0);
});
