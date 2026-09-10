import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createAuditedJobRegistry } from '../src/audited-job-registry.js';
import { createAuthStore } from '../src/auth-store.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';

const publicOrigin = 'http://127.0.0.1:5173';
const password = randomBytes(32).toString('base64url');

async function ownerSession(store) {
  const { token: setupToken } = store.issueSetupToken();
  await store.completeSetup({ setupToken, username: 'audit-owner', password });
  return store.login({ username: 'audit-owner', password });
}

async function fixture(t) {
  const store = createAuthStore({ filePath: ':memory:' });
  t.after(() => store.close());
  const session = await ownerSession(store);
  const registry = createServerRegistry();
  await registry.init();
  const managedServer = await registry.createLocalServer({ hostname: 'audit-host' });
  const jobs = createAuditedJobRegistry({ registry: createJobRegistry(), audit: store.audit });
  const listener = createAuthenticatedApi({
    store,
    publicOrigin,
    development: true,
    createHandler: () => createApp({ registry, jobRegistry: jobs, environment: 'development' }),
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const headers = {
    cookie: `yunpanel_session=${session.token}`,
    origin: publicOrigin,
    'x-csrf-token': session.session.csrfToken,
  };
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, jobs, managedServer, headers, base };
}

test('authenticated management job records accepted and terminal audit against the Owner actor', async (t) => {
  const f = await fixture(t);
  const accepted = await fetch(`${f.base}/api/servers/${f.managedServer.id}/system/packages/inspect`, {
    method: 'POST',
    headers: f.headers,
  });
  assert.equal(accepted.status, 202);
  const { data: queued } = await accepted.json();
  assert.equal('actorId' in queued, false);

  const claimed = await f.jobs.claimNext(f.managedServer.id);
  assert.equal(claimed.job.id, queued.id);
  await f.jobs.complete({
    serverId: f.managedServer.id,
    jobId: queued.id,
    status: 'succeeded',
    result: {
      packageName: 'yunpanel',
      installed: true,
      installedVersion: '0.3.0',
      candidateVersion: '0.3.0',
      updateAvailable: false,
    },
  });

  const auditResponse = await fetch(`${f.base}/api/audit?actorId=${encodeURIComponent(claimed.job ? f.store.getSession(f.headers.cookie.slice('yunpanel_session='.length)).user.id : '')}`, {
    headers: { cookie: f.headers.cookie },
  });
  assert.equal(auditResponse.status, 200);
  const audit = (await auditResponse.json()).data.events;
  const requestEvent = audit.find((event) => event.action === 'system.packages.inspect' && event.outcome === 'accepted');
  const terminalEvent = audit.find((event) => event.action === 'job.system.packages.inspect' && event.outcome === 'succeeded');
  assert.ok(requestEvent);
  assert.ok(terminalEvent);
  assert.equal(requestEvent.actorId, terminalEvent.actorId);
  assert.equal(requestEvent.resourceType, 'server');
  assert.equal(requestEvent.resourceId, f.managedServer.id);
  assert.equal(terminalEvent.resourceType, 'system');
  assert.equal(terminalEvent.resourceId, f.managedServer.id);

  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(password), false);
  assert.equal(serialized.includes(f.headers['x-csrf-token']), false);
  assert.equal(serialized.includes('installedVersion'), false);
});

test('system-created async jobs are auditable without pretending to have a human actor', async (t) => {
  const f = await fixture(t);
  const queued = await f.jobs.enqueue({
    serverId: f.managedServer.id,
    type: 'system.packages.inspect',
    operation: 'system.packages.inspect',
    payload: {},
    resourceType: 'system',
    resourceId: f.managedServer.id,
  });
  await f.jobs.claimNext(f.managedServer.id);
  await f.jobs.complete({
    serverId: f.managedServer.id,
    jobId: queued.id,
    status: 'failed',
    error: { code: 'apt_inspection_failed', message: 'SECRET=/root/private/apt' },
  });
  const event = f.store.audit.list({ actorId: 'system' }).events.find((candidate) => candidate.action === 'job.system.packages.inspect');
  assert.ok(event);
  assert.equal(event.actorId, 'system');
  assert.equal(event.outcome, 'failed');
  assert.equal(event.code, 'apt_inspection_failed');
  assert.equal(JSON.stringify(event).includes('SECRET'), false);
});
