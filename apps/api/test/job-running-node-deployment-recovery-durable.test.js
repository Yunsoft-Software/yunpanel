import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeServiceName } from '@yunpanel/config-templates';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createNodeDeploymentReceiptStore } from '../src/node-deployment-receipt.js';
import { recoverRunningNodeDeployment } from '../src/job-running-node-deployment-recovery.js';
import { createServerRegistry } from '../src/server-registry.js';

const previousReleaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-node-deployment-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'node-deployment-recovery-host' });

  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(root, 'applications.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();
  const created = await applicationRegistry.createNodeApplication({
    serverId: server.id,
    name: 'Node Deployment Recovery App',
    repositoryUrl: 'https://github.com/Yunsoft-Software/node-deployment-recovery-app',
    branch: 'main',
    runtime: { port: 34125, healthPath: '/health' },
    retention: 5,
  });
  const serviceName = nodeServiceName(created.id);
  await applicationRegistry.markDeploying(created.id, previousReleaseId);
  await applicationRegistry.markDeployed(created.id, {
    deploymentId: previousReleaseId,
    releaseId: previousReleaseId,
    commitSha: '1'.repeat(40),
    serviceName,
    port: created.runtime.port,
    healthPath: created.runtime.healthPath,
    healthy: true,
  });
  const active = await applicationRegistry.getApplication(created.id);

  const jobStore = path.join(root, 'jobs.json');
  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: 'app.node.deploy',
    operation: OPERATIONS.APP_NODE_DEPLOY,
    payload: {
      applicationId: active.id,
      repositoryUrl: active.repositoryUrl,
      branch: active.branch,
      runtime: active.runtime,
      retention: active.retention,
    },
    resourceType: 'application',
    resourceId: active.id,
  });
  await applicationRegistry.markDeploying(active.id, queued.id);
  const claimed = await first.claimNext(server.id);
  assert.equal(claimed.job.id, queued.id);
  assert.equal(claimed.envelope.payload.deploymentId, queued.id);

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);

  return {
    root,
    server,
    applicationRegistry,
    applicationId: active.id,
    runtime: active.runtime,
    jobId: queued.id,
    jobRegistry: restarted,
    contextReader: createJobRecoveryContextReader({ filePath: jobStore }),
    receiptStore: createNodeDeploymentReceiptStore({ root: path.join(root, 'receipts') }),
    serviceName,
  };
}

function deployedStatus(fx, healthy = true) {
  return {
    releaseId: fx.jobId,
    serviceName: fx.serviceName,
    port: fx.runtime.port,
    healthPath: fx.runtime.healthPath,
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    restartCount: 0,
    mainPid: 4323,
    healthy,
    inspectionError: false,
  };
}

const stoppedConsumers = async () => ({ apiActive: false, agentActive: false });

async function writeReceipt(fx) {
  return fx.receiptStore.write({
    serverId: fx.server.id,
    jobId: fx.jobId,
    applicationId: fx.applicationId,
    result: {
      deploymentId: fx.jobId,
      releaseId: fx.jobId,
      previousReleaseId,
      commitSha: '2'.repeat(40),
      serviceName: fx.serviceName,
      port: fx.runtime.port,
      healthPath: fx.runtime.healthPath,
      healthy: true,
    },
  });
}

test('verified receipt and healthy live release close the same durable Node deployment', async (t) => {
  const fx = await fixture(t);
  await writeReceipt(fx);

  const recovered = await recoverRunningNodeDeployment({
    serverId: fx.server.id,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    applicationRegistry: fx.applicationRegistry,
    serviceStatus: stoppedConsumers,
    loadJobContext: (id) => fx.contextReader.read(id),
    readDeploymentReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
    inspectNodeStatus: async () => deployedStatus(fx),
  });

  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.recoveryMethod, 'verified_node_deployment_receipt_and_status');
  assert.equal(fx.jobRegistry.recovery(), null);
  assert.deepEqual(fx.jobRegistry.recoveryRecord().jobs, []);

  const terminal = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.result.deploymentId, fx.jobId);
  assert.equal(terminal.result.releaseId, fx.jobId);
  assert.equal(terminal.result.previousReleaseId, previousReleaseId);
  assert.equal(terminal.result.commitSha, '2'.repeat(40));

  const application = await fx.applicationRegistry.getApplication(fx.applicationId);
  assert.equal(application.state, 'active');
  assert.equal(application.currentReleaseId, fx.jobId);
  assert.equal(application.previousReleaseId, previousReleaseId);
  assert.equal(application.currentCommitSha, '2'.repeat(40));
  assert.equal(application.activeDeploymentId, null);
});

test('missing deployment receipt leaves job and application deployment unresolved', async (t) => {
  const fx = await fixture(t);
  let statusInspections = 0;

  await assert.rejects(
    recoverRunningNodeDeployment({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      applicationRegistry: fx.applicationRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readDeploymentReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectNodeStatus: async () => { statusInspections += 1; return deployedStatus(fx); },
    }),
    { code: 'job_node_deployment_recovery_receipt_missing' },
  );

  assert.equal(statusInspections, 0);
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  const application = await fx.applicationRegistry.getApplication(fx.applicationId);
  assert.equal(application.state, 'deploying');
  assert.equal(application.activeDeploymentId, fx.jobId);
  assert.equal(application.currentReleaseId, previousReleaseId);
});

test('unhealthy deployed release cannot consume a valid Node deployment receipt', async (t) => {
  const fx = await fixture(t);
  await writeReceipt(fx);

  await assert.rejects(
    recoverRunningNodeDeployment({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      applicationRegistry: fx.applicationRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readDeploymentReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectNodeStatus: async () => deployedStatus(fx, false),
    }),
    { code: 'job_node_deployment_recovery_evidence_not_satisfied' },
  );

  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal((await fx.applicationRegistry.getApplication(fx.applicationId)).state, 'deploying');
});
