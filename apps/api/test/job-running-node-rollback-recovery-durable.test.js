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
import { recoverRunningNodeRollback } from '../src/job-running-node-rollback-recovery.js';
import { createNodeRollbackReceiptStore } from '../src/node-rollback-receipt.js';
import { createServerRegistry } from '../src/server-registry.js';

const targetReleaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const currentReleaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-node-rollback-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'node-rollback-recovery-host' });

  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(root, 'applications.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();
  const created = await applicationRegistry.createNodeApplication({
    serverId: server.id,
    name: 'Node Rollback Recovery App',
    repositoryUrl: 'https://github.com/Yunsoft-Software/node-rollback-recovery-app',
    branch: 'main',
    runtime: { port: 34124, healthPath: '/health' },
    retention: 5,
  });
  const serviceName = nodeServiceName(created.id);

  await applicationRegistry.markDeploying(created.id, targetReleaseId);
  await applicationRegistry.markDeployed(created.id, {
    deploymentId: targetReleaseId,
    releaseId: targetReleaseId,
    commitSha: '1'.repeat(40),
    serviceName,
    port: created.runtime.port,
    healthPath: created.runtime.healthPath,
    healthy: true,
  });
  await applicationRegistry.markDeploying(created.id, currentReleaseId);
  await applicationRegistry.markDeployed(created.id, {
    deploymentId: currentReleaseId,
    releaseId: currentReleaseId,
    commitSha: '2'.repeat(40),
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
    type: 'app.node.rollback',
    operation: OPERATIONS.APP_NODE_ROLLBACK,
    payload: {
      applicationId: active.id,
      releaseId: targetReleaseId,
      currentReleaseId,
      runtime: active.runtime,
    },
    resourceType: 'application',
    resourceId: active.id,
  });
  await applicationRegistry.markRollingBack(active.id, queued.id, targetReleaseId);
  const claimed = await first.claimNext(server.id);
  assert.equal(claimed.job.id, queued.id);

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
    receiptStore: createNodeRollbackReceiptStore({ root: path.join(root, 'receipts') }),
    serviceName,
  };
}

function targetStatus(fx, healthy = true) {
  return {
    releaseId: targetReleaseId,
    serviceName: fx.serviceName,
    port: fx.runtime.port,
    healthPath: fx.runtime.healthPath,
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    restartCount: 2,
    mainPid: 4322,
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
      releaseId: targetReleaseId,
      previousReleaseId: currentReleaseId,
      serviceName: fx.serviceName,
      port: fx.runtime.port,
      healthPath: fx.runtime.healthPath,
      healthy: true,
      active: true,
    },
  });
}

test('verified receipt and healthy target release close the same durable Node rollback', async (t) => {
  const fx = await fixture(t);
  await writeReceipt(fx);

  const recovered = await recoverRunningNodeRollback({
    serverId: fx.server.id,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    applicationRegistry: fx.applicationRegistry,
    serviceStatus: stoppedConsumers,
    loadJobContext: (id) => fx.contextReader.read(id),
    readRollbackReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
    inspectNodeStatus: async () => targetStatus(fx),
  });

  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.recoveryMethod, 'verified_node_rollback_receipt_and_status');
  assert.equal(fx.jobRegistry.recovery(), null);
  assert.deepEqual(fx.jobRegistry.recoveryRecord().jobs, []);

  const terminal = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.result.releaseId, targetReleaseId);
  assert.equal(terminal.result.previousReleaseId, currentReleaseId);
  assert.equal(terminal.result.active, true);
  assert.equal(terminal.result.healthy, true);

  const application = await fx.applicationRegistry.getApplication(fx.applicationId);
  assert.equal(application.state, 'active');
  assert.equal(application.currentReleaseId, targetReleaseId);
  assert.equal(application.previousReleaseId, currentReleaseId);
  assert.equal(application.currentCommitSha, '1'.repeat(40));
  assert.equal(application.activeDeploymentId, null);
  assert.equal(application.pendingRollbackReleaseId, null);
});

test('missing rollback receipt leaves job and application rollback unresolved', async (t) => {
  const fx = await fixture(t);
  let statusInspections = 0;

  await assert.rejects(
    recoverRunningNodeRollback({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      applicationRegistry: fx.applicationRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readRollbackReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectNodeStatus: async () => { statusInspections += 1; return targetStatus(fx); },
    }),
    { code: 'job_node_rollback_recovery_receipt_missing' },
  );

  assert.equal(statusInspections, 0);
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  const application = await fx.applicationRegistry.getApplication(fx.applicationId);
  assert.equal(application.state, 'rolling_back');
  assert.equal(application.activeDeploymentId, fx.jobId);
  assert.equal(application.pendingRollbackReleaseId, targetReleaseId);
});

test('unhealthy target release cannot consume a valid Node rollback receipt', async (t) => {
  const fx = await fixture(t);
  await writeReceipt(fx);

  await assert.rejects(
    recoverRunningNodeRollback({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      applicationRegistry: fx.applicationRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readRollbackReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectNodeStatus: async () => targetStatus(fx, false),
    }),
    { code: 'job_node_rollback_recovery_evidence_not_satisfied' },
  );

  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal((await fx.applicationRegistry.getApplication(fx.applicationId)).state, 'rolling_back');
});
