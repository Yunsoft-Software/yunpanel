import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { MANAGED_SERVICE_IDS, OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';

const origin = 'https://services.example.test';
const csrfToken = 'services-csrf';
const servicePackages = {
  nginx: ['nginx'], mariadb: ['mariadb-server'], mysql: ['mysql-server'], docker: ['docker.io', 'docker-compose-v2'], cron: ['cron'],
  postfix: ['postfix', 'postfix-sqlite', 'sqlite3'],
  dovecot: ['dovecot-imapd', 'dovecot-lmtpd', 'dovecot-sieve', 'dovecot-sqlite', 'sqlite3'],
  rspamd: ['rspamd'],
  roundcube: ['roundcube-core', 'roundcube-sqlite3', 'php-fpm'], phpmyadmin: ['phpmyadmin', 'php-fpm', 'php-mysql'],
  elfinder: ['php-fpm', 'php-mbstring', 'php-zip', 'libjs-jquery', 'libjs-jquery-ui'],
  restic: ['restic'],
  rclone: ['rclone'],
  postsrsd: ['postsrsd'],
  redis: ['redis-server'],
  memcached: ['memcached'],
  netdata: ['netdata'],
  goaccess: ['goaccess'],
};

function fakeStore(role = 'owner') {
  const session = {
    id: '12345678-1234-4234-8234-123456789012',
    user: { id: `${role}-id`, username: role, role },
    csrfToken,
    expiresAt: Date.now() + 60_000,
    idleExpiresAt: Date.now() + 60_000,
  };
  return {
    configured: () => true,
    mfa: { enabled: () => role === 'owner' },
    audit: { record() {} },
    getSession: (token) => token === 'valid-session' ? session : null,
    listSessions: () => [],
  };
}

async function fixture(t, role = 'owner') {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'managed-services' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'services-host' });
  const jobRegistry = createJobRegistry();
  const listener = createAuthenticatedApi({
    store: fakeStore(role),
    publicOrigin: origin,
    createHandler: () => createApp({ registry, jobRegistry, environment: 'production' }),
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body } = {}) {
    const headers = { cookie: '__Host-yunpanel_session=valid-session' };
    if (method !== 'GET' && method !== 'HEAD') {
      headers.origin = origin;
      headers['sec-fetch-site'] = 'same-origin';
      headers['x-csrf-token'] = csrfToken;
      headers['content-type'] = 'application/json';
    }
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return { request, registry, jobRegistry, serverId: enrolled.server.id };
}

function healthyService(id) {
  const unitless = ['roundcube', 'phpmyadmin', 'elfinder', 'restic', 'rclone', 'goaccess'].includes(id);
  const unitName = id === 'redis' ? 'redis-server.service' : `${id}.service`;
  return {
    id,
    label: `ignored-${id}`,
    category: 'ignored',
    installed: true,
    active: !unitless,
    packages: servicePackages[id].map((packageName) => ({ packageName, installed: true, version: '1.0.0-1' })),
    units: unitless ? [] : [{
      unit: unitName,
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      unitFileState: 'enabled',
      inspectionError: false,
    }],
    health: {
      status: unitless ? 'installed' : 'ready',
      configuration: ['postfix', 'dovecot', 'rspamd', 'roundcube', 'phpmyadmin', 'elfinder', 'restic', 'rclone', 'netdata', 'goaccess'].includes(id) ? 'valid' : 'not_applicable',
    },
  };
}

test('Owner can queue a full managed service inspection', async (t) => {
  const { request, jobRegistry, serverId } = await fixture(t);
  const response = await request(`/api/servers/${serverId}/services/inspect`, { method: 'POST', body: {} });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.data.operation, OPERATIONS.SYSTEM_SERVICES_INSPECT);
  const jobs = await jobRegistry.listJobs({ serverId });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].resourceType, 'system');
  assert.equal(jobs[0].resourceId, serverId);
});

test('service installation requires exact confirmation and queues only an allowlisted id', async (t) => {
  const { request, jobRegistry, serverId } = await fixture(t);
  const denied = await request(`/api/servers/${serverId}/services/mariadb/install`, {
    method: 'POST',
    body: { confirmation: 'yes' },
  });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.code, 'managed_service_confirmation_required');
  assert.equal((await jobRegistry.listJobs()).length, 0);

  const invalid = await request(`/api/servers/${serverId}/services/ssh/install`, {
    method: 'POST',
    body: { confirmation: 'install:ssh' },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'unsupported_managed_service');

  const accepted = await request(`/api/servers/${serverId}/services/mariadb/install`, {
    method: 'POST',
    body: { confirmation: 'install:mariadb' },
  });
  assert.equal(accepted.status, 202);
  const job = (await accepted.json()).data;
  assert.equal(job.operation, OPERATIONS.SYSTEM_SERVICE_INSTALL);

  const roundcube = await fixture(t);
  const roundcubeResponse = await roundcube.request(`/api/servers/${roundcube.serverId}/services/roundcube/install`, {
    method: 'POST',
    body: { confirmation: 'install:roundcube' },
  });
  assert.equal(roundcubeResponse.status, 202);

  const phpMyAdmin = await fixture(t);
  const phpMyAdminResponse = await phpMyAdmin.request(`/api/servers/${phpMyAdmin.serverId}/services/phpmyadmin/install`, {
    method: 'POST',
    body: { confirmation: 'install:phpmyadmin' },
  });
  assert.equal(phpMyAdminResponse.status, 202);

  for (const serviceId of ['restic', 'rclone']) {
    const tool = await fixture(t);
    const response = await tool.request(`/api/servers/${tool.serverId}/services/${serviceId}/install`, {
      method: 'POST',
      body: { confirmation: `install:${serviceId}` },
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).data.operation, OPERATIONS.SYSTEM_SERVICE_INSTALL);
  }
});

test('service control validates action confirmation and serializes server system work', async (t) => {
  const { request, serverId } = await fixture(t);
  const accepted = await request(`/api/servers/${serverId}/services/nginx/control`, {
    method: 'POST',
    body: { action: 'restart', confirmation: 'control:nginx:restart' },
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).data.operation, OPERATIONS.SYSTEM_SERVICE_CONTROL);

  const conflict = await request(`/api/servers/${serverId}/services/inspect`, { method: 'POST', body: {} });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'system_job_conflict');
});

test('package-only managed applications cannot be queued as systemd control operations', async (t) => {
  for (const serviceId of ['roundcube', 'phpmyadmin', 'elfinder', 'restic', 'rclone']) {
    const { request, jobRegistry, serverId } = await fixture(t);
    const response = await request(`/api/servers/${serverId}/services/${serviceId}/control`, {
      method: 'POST',
      body: { action: 'restart', confirmation: `control:${serviceId}:restart` },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'managed_service_not_controllable');
    assert.equal((await jobRegistry.listJobs()).length, 0);
  }
});

test('latest successful full inspection is readable inside the standard data envelope', async (t) => {
  const { request, jobRegistry, serverId } = await fixture(t);
  const queued = await jobRegistry.enqueue({
    serverId,
    type: OPERATIONS.SYSTEM_SERVICES_INSPECT,
    operation: OPERATIONS.SYSTEM_SERVICES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId: serverId,
  });
  await jobRegistry.claimNext(serverId);
  await jobRegistry.complete({
    serverId,
    jobId: queued.id,
    status: 'succeeded',
    result: MANAGED_SERVICE_IDS.map(healthyService),
  });

  const response = await request(`/api/servers/${serverId}/services`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.services.length, MANAGED_SERVICE_IDS.length);
  assert.equal(body.data.snapshot.jobId, queued.id);
  assert.equal(Object.hasOwn(body.data.snapshot, 'payload'), false);
});

test('Read Only cannot enter nested service management routes', async (t) => {
  const { request, serverId } = await fixture(t, 'read_only');
  const response = await request(`/api/servers/${serverId}/services`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'forbidden');
});
