import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../src/core-app.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

async function fixture(t) {
  const localServerId = 'local-server';
  const remoteServerId = 'remote-server';
  let heartbeatCalls = 0;
  let cancelCalls = 0;
  const servers = [
    { id: localServerId, serverId: localServerId, hostname: 'current-host', executionMode: 'local' },
    { id: remoteServerId, serverId: remoteServerId, hostname: 'old-host', executionMode: 'agent' },
  ];
  const applications = [
    { id: 'local-app', serverId: localServerId, type: 'static', name: 'Local' },
    { id: 'remote-app', serverId: remoteServerId, type: 'static', name: 'Remote' },
  ];
  const domains = [
    { id: 'local-domain', serverId: localServerId, primaryDomain: 'local.example' },
    { id: 'remote-domain', serverId: remoteServerId, primaryDomain: 'remote.example' },
  ];
  const certificates = [
    { id: 'local-certificate', serverId: localServerId, domains: ['local.example'] },
    { id: 'remote-certificate', serverId: remoteServerId, domains: ['remote.example'] },
  ];
  const jobs = [
    { id: 'local-job', serverId: localServerId, type: 'inspect', status: 'succeeded' },
    { id: 'remote-job', serverId: remoteServerId, type: 'inspect', status: 'queued' },
  ];
  const registry = {
    async listServers() { return servers; },
    async getServer(id) { return servers.find((item) => item.id === id) ?? null; },
    async heartbeat() { heartbeatCalls += 1; return servers[1]; },
  };
  const applicationRegistry = {
    async listApplications() { return applications; },
    async getApplication(id) { return applications.find((item) => item.id === id) ?? null; },
  };
  const domainRegistry = {
    async listDomains() { return domains; },
    async getDomain(id) { return domains.find((item) => item.id === id) ?? null; },
  };
  const certificateRegistry = {
    async listCertificates() { return certificates; },
    async getCertificate(id) { return certificates.find((item) => item.id === id) ?? null; },
  };
  const jobRegistry = {
    async listJobs(filter = {}) {
      return jobs.filter((job) => !filter.serverId || job.serverId === filter.serverId);
    },
    async getJob(id) { return jobs.find((item) => item.id === id) ?? null; },
    async cancel(id) { cancelCalls += 1; return jobs.find((item) => item.id === id); },
  };
  const listener = withPanelContext(createApp({
    environment: 'production', localServerId, registry, applicationRegistry, domainRegistry, certificateRegistry, jobRegistry,
  }));
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    heartbeatCalls: () => heartbeatCalls,
    cancelCalls: () => cancelCalls,
  };
}

test('configured local panel exposes only resources belonging to its own host', async (t) => {
  const state = await fixture(t);
  for (const [path, expectedId] of [
    ['/api/servers', 'local-server'],
    ['/api/applications', 'local-app'],
    ['/api/domains', 'local-domain'],
    ['/api/certificates', 'local-certificate'],
    ['/api/jobs', 'local-job'],
  ]) {
    const response = await fetch(`${state.baseUrl}${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((item) => item.id), [expectedId]);
  }
});

test('remote resource identities and retained agent transport cannot cross the local host boundary', async (t) => {
  const state = await fixture(t);
  for (const path of [
    '/api/servers/remote-server',
    '/api/applications/remote-app',
    '/api/domains/remote-domain',
    '/api/certificates/remote-certificate',
    '/api/jobs/remote-job',
    '/api/jobs?serverId=remote-server',
  ]) assert.equal((await fetch(`${state.baseUrl}${path}`)).status, 404, path);

  const cancelled = await fetch(`${state.baseUrl}/api/jobs/remote-job/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 404);
  assert.equal(state.cancelCalls(), 0);

  const heartbeat = await fetch(`${state.baseUrl}/api/servers/remote-server/heartbeat`, { method: 'POST' });
  assert.equal(heartbeat.status, 404);
  assert.equal((await heartbeat.json()).error.code, 'agent_transport_removed');
  assert.equal(state.heartbeatCalls(), 0);
});
