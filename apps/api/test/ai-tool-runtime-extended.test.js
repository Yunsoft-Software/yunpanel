import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiToolRuntime } from '../src/ai-tool-runtime.js';
import { OPERATIONS } from '@yunpanel/protocol';

function makeFixture() {
  const localServerId = 'srv-local';
  const server = { id: localServerId, hostname: 'test', executionMode: 'local' };
  const website = { id: 'web-1', serverId: localServerId, applicationId: 'app-node-1', domain: 'example.com' };
  const application = {
    id: 'app-node-1',
    serverId: localServerId,
    type: 'node',
    currentReleaseId: 'rel-2',
    previousReleaseId: 'rel-1',
    releases: [{ releaseId: 'rel-1' }, { releaseId: 'rel-2' }],
    activeDeploymentId: null,
  };
  const domain = { id: 'dom-1', domainName: 'example.com', websiteId: 'web-1', serverId: localServerId };
  const cert = { id: 'cert-1', certName: 'example.com', serverId: localServerId };
  const dnsZone = { id: 'zone-1', zoneName: 'example.com', serverId: localServerId };

  const enqueuedJobs = [];
  const jobRegistry = {
    async listJobs() { return []; },
    async getJob(id) { return enqueuedJobs.find((j) => j.id === id) ?? null; },
    async enqueue(spec) {
      const job = { id: `job-${enqueuedJobs.length + 1}`, status: 'queued', createdAt: new Date().toISOString(), ...spec };
      enqueuedJobs.push(job);
      return job;
    },
  };

  const serverRegistry = {
    async getServer(id) { return id === localServerId ? server : null; },
    async listServers() { return [server]; },
  };

  const websiteRegistry = {
    async getWebsite(id) { return id === website.id ? website : null; },
    async listWebsites() { return [website]; },
  };

  const domainRegistry = {
    async getDomain(id) { return id === domain.id ? domain : null; },
    async listDomains() { return [domain]; },
  };

  const applicationRegistry = {
    async getApplication(id) { return id === application.id ? application : null; },
    async markRollingBack(id, jobId, releaseId) {
      return { ...application, activeDeploymentId: jobId, currentReleaseId: releaseId };
    },
  };

  const applicationEnvironmentRegistry = {
    async environmentStatus() { return { savedRevision: 1 }; },
  };

  const certificateRegistry = {
    async getCertificate(id) { return id === cert.id ? cert : null; },
    async getForDomain(id) { return id === domain.id ? cert : null; },
  };

  const dnsHostingRegistry = {
    async getZone(id) { return id === dnsZone.id ? dnsZone : null; },
    async listZones() { return [dnsZone]; },
  };

  const journalLogReader = {
    async query({ unit, limit }) {
      return {
        entries: Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
          timestamp: '2026-09-21T00:00:00.000Z',
          level: 'info',
          unit,
          message: `Log line ${i + 1}`,
        })),
      };
    },
  };

  const websiteBackupSetProvider = {
    async getWebsiteBackupSet({ websiteId }) {
      return { websiteId, repositories: [{ id: 'repo-1' }], snapshots: [{ id: 'snap-1' }] };
    },
  };

  const websiteBackupService = {
    async executeBackup({ websiteId }) {
      return { backupId: 'bk-1', websiteId, status: 'succeeded' };
    },
  };

  const websiteRestoreService = {
    async executeRestore({ websiteId, snapshotId }) {
      return { restoreId: 'rst-1', websiteId, snapshotId, status: 'succeeded' };
    },
  };

  const applicationDeployQueue = async ({ applicationId, gitTarget }) => ({
    application,
    job: { id: 'deploy-job-1', status: 'queued', createdAt: new Date().toISOString() },
    replayed: false,
  });

  return {
    localServerId,
    serverRegistry,
    websiteRegistry,
    domainRegistry,
    applicationRegistry,
    jobRegistry,
    applicationEnvironmentRegistry,
    certificateRegistry,
    dnsHostingRegistry,
    journalLogReader,
    websiteBackupSetProvider,
    websiteBackupService,
    websiteRestoreService,
    applicationDeployQueue,
    enqueuedJobs,
  };
}

test('AI tool runtime binds and executes application.deploy', async () => {
  const fixture = makeFixture();
  const runtime = createAiToolRuntime(fixture);

  const tool = runtime.get('application.deploy');
  assert.equal(tool.available, true);

  const result = await runtime.execute({
    name: 'application.deploy',
    input: { applicationId: 'app-node-1', gitTarget: 'main' },
    context: { actorId: 'owner-1' },
  });

  assert.equal(result.job.id, 'deploy-job-1');
  assert.equal(result.replayed, false);
});

test('AI tool runtime binds and executes application.rollback', async () => {
  const fixture = makeFixture();
  const runtime = createAiToolRuntime(fixture);

  const tool = runtime.get('application.rollback');
  assert.equal(tool.available, true);

  const result = await runtime.execute({
    name: 'application.rollback',
    input: { applicationId: 'app-node-1', releaseId: 'rel-1' },
    context: { actorId: 'owner-1' },
  });

  assert.equal(result.job.operation, OPERATIONS.APP_NODE_ROLLBACK);
  assert.equal(result.application.currentReleaseId, 'rel-1');
});

test('AI tool runtime binds and executes logs.query bounded to max limit', async () => {
  const fixture = makeFixture();
  const runtime = createAiToolRuntime(fixture);

  const tool = runtime.get('logs.query');
  assert.equal(tool.available, true);

  const result = await runtime.execute({
    name: 'logs.query',
    input: { applicationId: 'app-node-1', limit: 50 },
    context: { actorId: 'owner-1' },
  });

  assert.equal(result.source, 'journal');
  assert.equal(result.count, 3);
  assert.equal(result.entries.length, 3);
  assert.ok(result.entries[0].message.includes('Log line 1'));
});

test('AI tool runtime binds and executes dns.update', async () => {
  const fixture = makeFixture();
  const runtime = createAiToolRuntime(fixture);

  const tool = runtime.get('dns.update');
  assert.equal(tool.available, true);

  const result = await runtime.execute({
    name: 'dns.update',
    input: { dnsZoneId: 'zone-1', change: { action: 'upsert', record: { name: 'api', type: 'A', value: '1.2.3.4' } } },
    context: { actorId: 'owner-1' },
  });

  assert.equal(result.job.operation, OPERATIONS.DNS_RECORD_APPLY);
});

test('AI tool runtime binds and executes certificate.issue and certificate.renew', async () => {
  const fixture = makeFixture();
  const runtime = createAiToolRuntime(fixture);

  const issueTool = runtime.get('certificate.issue');
  assert.equal(issueTool.available, true);

  const issueResult = await runtime.execute({
    name: 'certificate.issue',
    input: { domainId: 'dom-1' },
    context: { actorId: 'owner-1' },
  });
  assert.equal(issueResult.job.operation, OPERATIONS.SSL_ISSUE);

  const renewTool = runtime.get('certificate.renew');
  assert.equal(renewTool.available, true);

  const renewResult = await runtime.execute({
    name: 'certificate.renew',
    input: { certificateId: 'cert-1' },
    context: { actorId: 'owner-1' },
  });
  assert.equal(renewResult.job.operation, OPERATIONS.SSL_RENEW);
});

test('AI tool runtime binds and executes backup tools (inspect, create, restore)', async () => {
  const fixture = makeFixture();
  const runtime = createAiToolRuntime(fixture);

  assert.equal(runtime.get('backup.inspect').available, true);
  assert.equal(runtime.get('backup.create').available, true);
  assert.equal(runtime.get('backup.restore').available, true);

  const inspectResult = await runtime.execute({
    name: 'backup.inspect',
    input: { websiteId: 'web-1' },
    context: { actorId: 'owner-1' },
  });
  assert.equal(inspectResult.backupSet.snapshots.length, 1);

  const createResult = await runtime.execute({
    name: 'backup.create',
    input: { websiteId: 'web-1' },
    context: { actorId: 'owner-1' },
  });
  assert.equal(createResult.result.status, 'succeeded');

  const restoreResult = await runtime.execute({
    name: 'backup.restore',
    input: { websiteId: 'web-1', snapshotId: 'snap-1' },
    context: { actorId: 'owner-1' },
  });
  assert.equal(restoreResult.result.status, 'succeeded');
});
