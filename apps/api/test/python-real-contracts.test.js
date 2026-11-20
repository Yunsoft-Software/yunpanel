import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pythonApplicationUser, pythonServiceName } from '@yunpanel/config-templates';
import { AGENT_PROTOCOL_VERSION, OPERATIONS, validateOperationEnvelope } from '@yunpanel/protocol';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';
import { createWebsitePythonApplicationReleaseProvisioningHandler } from '../src/website-python-application-release-provisioning-handler.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { createWebsiteRemovalCleanupAdapters } from '../src/website-removal-cleanup-adapters.js';

async function createRealRegistries(t, prefix) {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });

  const serverRegistry = createServerRegistry({ filePath: path.join(base, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'py-contract.example.test' });

  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(base, 'applications.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();

  const websiteRegistry = createWebsiteRegistry({
    filePath: path.join(base, 'websites.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getApplication: (id) => applicationRegistry.getApplication(id),
  });
  await websiteRegistry.init();

  const jobRegistry = createJobRegistry({ filePath: path.join(base, 'jobs.json') });
  await jobRegistry.init();

  const provisioning = createWebsiteProvisioningRuntime({
    filePath: path.join(base, 'provisioning.json'),
  });
  await provisioning.registry.init();

  return { base, server, serverRegistry, applicationRegistry, websiteRegistry, jobRegistry, provisioning };
}

test('APP_PYTHON_DEPLOY with environmentRevision passes protocol validation and real JobRegistry + ApplicationRegistry lifecycle', async (t) => {
  const { server, applicationRegistry, jobRegistry } = await createRealRegistries(t, 'yp-py-real-reg-');

  const app = await applicationRegistry.createPythonApplication({
    serverId: server.id,
    name: 'py-contract-app',
    repositoryUrl: 'https://github.com/example/python-app',
    branch: 'main',
    runtime: { appServer: 'gunicorn', entryPoint: 'app:app', workers: 1, healthPath: '/' },
  });

  const deployPayload = {
    applicationId: app.id,
    repositoryUrl: app.repositoryUrl,
    branch: app.branch,
    gitTarget: { kind: 'branch', value: 'main' },
    runtime: app.runtime,
    retention: app.retention,
    environmentRevision: 2,
  };

  const envelopeCheck = validateOperationEnvelope({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    id: 'job-python-env-rev-1',
    operation: OPERATIONS.APP_PYTHON_DEPLOY,
    payload: deployPayload,
  });
  assert.equal(envelopeCheck.ok, true, `unexpected envelope errors: ${envelopeCheck.errors.join(', ')}`);

  const job1 = await jobRegistry.enqueue({
    serverId: server.id,
    type: 'app.python.deploy',
    operation: OPERATIONS.APP_PYTHON_DEPLOY,
    payload: deployPayload,
    resourceType: 'application',
    resourceId: app.id,
  });
  await applicationRegistry.markDeploying(app.id, job1.id);
  await jobRegistry.claimNext(server.id);
  const commit1 = 'a'.repeat(40);
  const done1 = await jobRegistry.complete({
    serverId: server.id,
    jobId: job1.id,
    status: 'succeeded',
    result: {
      deploymentId: job1.id,
      releaseId: job1.id,
      previousReleaseId: null,
      commitSha: commit1,
      gitTarget: { kind: 'branch', value: 'main' },
      serviceName: pythonServiceName(app.id),
      socketPath: `/run/yunpanel/python-${app.id}.sock`,
      port: null,
      healthPath: '/',
      healthy: true,
    },
  });
  assert.equal(done1.status, 'succeeded');
  await applicationRegistry.markDeployed(app.id, {
    deploymentId: job1.id,
    releaseId: job1.id,
    previousReleaseId: null,
    commitSha: commit1,
    gitTarget: { kind: 'branch', value: 'main' },
    runtime: app.runtime,
  });

  const job2 = await jobRegistry.enqueue({
    serverId: server.id,
    type: 'app.python.deploy',
    operation: OPERATIONS.APP_PYTHON_DEPLOY,
    payload: deployPayload,
    resourceType: 'application',
    resourceId: app.id,
  });
  await applicationRegistry.markDeploying(app.id, job2.id);
  await jobRegistry.claimNext(server.id);
  const commit2 = 'b'.repeat(40);
  await jobRegistry.complete({
    serverId: server.id,
    jobId: job2.id,
    status: 'succeeded',
    result: {
      deploymentId: job2.id,
      releaseId: job2.id,
      previousReleaseId: job1.id,
      commitSha: commit2,
      gitTarget: { kind: 'branch', value: 'main' },
      serviceName: pythonServiceName(app.id),
      socketPath: `/run/yunpanel/python-${app.id}.sock`,
      port: null,
      healthPath: '/',
      healthy: true,
    },
  });
  await applicationRegistry.markDeployed(app.id, {
    deploymentId: job2.id,
    releaseId: job2.id,
    previousReleaseId: job1.id,
    commitSha: commit2,
    gitTarget: { kind: 'branch', value: 'main' },
    runtime: app.runtime,
  });

  const rbJob = await jobRegistry.enqueue({
    serverId: server.id,
    type: 'app.python.rollback',
    operation: OPERATIONS.APP_PYTHON_ROLLBACK,
    payload: {
      applicationId: app.id,
      releaseId: job1.id,
      currentReleaseId: job2.id,
      runtime: app.runtime,
      environmentRevision: 2,
    },
    resourceType: 'application',
    resourceId: app.id,
  });
  await jobRegistry.claimNext(server.id);
  const rbDone = await jobRegistry.complete({
    serverId: server.id,
    jobId: rbJob.id,
    status: 'succeeded',
    result: {
      releaseId: job1.id,
      previousReleaseId: job2.id,
      serviceName: pythonServiceName(app.id),
      socketPath: `/run/yunpanel/python-${app.id}.sock`,
      port: null,
      healthPath: '/',
      active: true,
      healthy: true,
      rolledBack: true,
    },
  });
  assert.equal(rbDone.status, 'succeeded');

  const restartJob = await jobRegistry.enqueue({
    serverId: server.id,
    type: 'app.python.restart',
    operation: OPERATIONS.APP_PYTHON_RESTART,
    payload: {
      applicationId: app.id,
      releaseId: job1.id,
      runtime: app.runtime,
      environmentRevision: 2,
    },
    resourceType: 'application',
    resourceId: app.id,
  });
  await jobRegistry.claimNext(server.id);
  const restartDone = await jobRegistry.complete({
    serverId: server.id,
    jobId: restartJob.id,
    status: 'succeeded',
    result: {
      releaseId: job1.id,
      serviceName: pythonServiceName(app.id),
      socketPath: `/run/yunpanel/python-${app.id}.sock`,
      healthy: true,
      restarted: true,
    },
  });
  assert.equal(restartDone.status, 'succeeded');
});

test('WebsitePythonApplicationReleaseProvisioningHandler activates release shape against real ApplicationRegistry', async (t) => {
  const { server, applicationRegistry } = await createRealRegistries(t, 'yp-py-real-act-');
  const app = await applicationRegistry.createPythonApplication({
    serverId: server.id,
    name: 'py-act-app',
    repositoryUrl: 'https://github.com/example/python-app',
    branch: 'main',
    runtime: { appServer: 'gunicorn', entryPoint: 'app:app', workers: 1, healthPath: '/' },
  });

  const operationId = randomUUID();
  const commitSha = 'c'.repeat(40);
  const handler = createWebsitePythonApplicationReleaseProvisioningHandler({ applicationRegistry });
  const result = await handler.apply({
    operationId,
    intent: {
      adapter: 'python-application-release',
      applicationId: app.id,
      releaseId: operationId,
    },
    operation: {
      operationId,
      resources: { application: app },
      steps: [{
        id: 'python_release',
        state: 'succeeded',
        evidence: {
          satisfied: true,
          adapter: 'python-release',
          applicationId: app.id,
          deploymentId: operationId,
          releaseId: operationId,
          previousReleaseId: null,
          commit: commitSha,
          commitSha,
        },
      }],
    },
  });

  assert.equal(result.satisfied, true);
  assert.equal(result.commitSha, commitSha);
  const stored = await applicationRegistry.getApplication(app.id);
  assert.equal(stored.currentReleaseId, operationId);
  assert.equal(stored.currentCommitSha, commitSha);
});

test('real WebsiteRemovalCleanupAdapters with real registries rejects Python Website lacking python_runtime journal before file deletion', async (t) => {
  const { server, applicationRegistry, websiteRegistry, provisioning } = await createRealRegistries(t, 'yp-py-real-rem-');

  const app = await applicationRegistry.createPythonApplication({
    serverId: server.id,
    name: 'py-no-journal',
    repositoryUrl: 'https://github.com/example/python-app',
    branch: 'main',
    runtime: { appServer: 'gunicorn', entryPoint: 'app:app', workers: 1, healthPath: '/' },
  });
  const unixUser = pythonApplicationUser(app.id);
  const website = await websiteRegistry.createWebsite({
    serverId: server.id,
    name: 'py-no-journal.example.test',
    applicationId: app.id,
    runtimeType: 'python',
  });

  const opId = randomUUID();
  await provisioning.registry.create({
    operationId: opId,
    websiteId: website.id,
    resources: { website, application: app },
    steps: [
      {
        id: 'unix_identity',
        kind: 'unix_identity',
        state: 'pending',
        intent: {
          websiteId: website.id,
          applicationId: app.id,
          unixUser,
          homeDirectory: `/var/lib/yunpanel/data/${app.id}`,
        },
      },
      {
        id: 'elfinder',
        kind: 'elfinder',
        state: 'pending',
        intent: {
          adapter: 'elfinder-fpm',
          websiteId: website.id,
          applicationId: app.id,
          unixUser,
        },
      },
    ],
  });
  await provisioning.registry.beginStep({ operationId: opId, stepId: 'unix_identity' });
  await provisioning.registry.completeStep({ operationId: opId, stepId: 'unix_identity', evidence: { owned: true } });

  const adapters = createWebsiteRemovalCleanupAdapters({
    websiteRegistry,
    applicationRegistry,
    websiteProvisioningRuntime: {
      registry: provisioning.registry,
      handlers: {
        sftp: {
          retire: async () => {},
          inspectRetirement: async () => ({
            satisfied: true, sshdConfigRemoved: true, mountUnitRemoved: true, chrootRemoved: true,
            websiteId: website.id, applicationId: app.id, unixUser,
          }),
        },
        elfinder: {
          retire: async () => {},
          inspectRetirement: async () => ({
            satisfied: true, poolRemoved: true, socketRemoved: true,
            websiteId: website.id, applicationId: app.id, unixUser,
          }),
        },
        unix_identity: {
          compensate: async () => ({ satisfied: true, removedUser: true, removedGroup: true }),
          inspectCompensation: async () => ({ satisfied: true, removedUser: true, removedGroup: true }),
        },
      },
    },
  });

  await assert.rejects(
    () => adapters.fileCleanupHandler({ websiteId: website.id, applicationId: app.id }),
    (error) => error?.code === 'website_cleanup_python_evidence_invalid',
  );
  await assert.rejects(
    () => adapters.unixIdentityCleanupHandler({ websiteId: website.id, systemUser: unixUser }),
    (error) => error?.code === 'website_cleanup_python_evidence_invalid',
  );
});
