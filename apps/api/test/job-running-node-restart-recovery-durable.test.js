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
import { recoverRunningNodeRestart } from '../src/job-running-node-restart-recovery.js';
import { createNodeRestartReceiptStore } from '../src/node-restart-receipt.js';
import { createServerRegistry } from '../src/server-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-node-restart-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'node-restart-recovery-host' });

  const applicationStore = path.join(root, 'applications.json');
  const applicationRegistry = createApplicationRegistry({
    filePath: applicationStore,
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();
  const created = await applicationRegistry.createNodeApplication({
    serverId: server.id,
    name: 'Node Recovery App',
    repositoryUrl: 'https://github.com/Yunsoft-Software/node-recovery-app',
    branch: 'main',
    runtime: { port: 34123, healthPath: '/health' },
  });
  const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  const serviceName = nodeServiceName(created.id);
  await applicationRegistry.markDeploying(created.id, releaseId);
  await applicationRegistry.markDeployed(created.id, {
    deploymentId: releaseId,
    releaseId,
    commitSha: '2'.repeat(40),
    serviceName,
    port: created.runtime.port,
    healthPath: created.runtime.healthPath,
    healthy: true,
  });
  const application = await applicationRegistry.getApplication(created.id);

  const jobStore = path.join(root, 'jobs.json');
  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: 'app.node.restart',
    operation: OPERATIONS.APP_NODE_RESTART,
    payload: {
      applicationId: application.id,
      releaseId: application.currentReleaseId,
      runtime: application.runtime,
    },
    resourceType: 'application',
    resourceId: application.id,
  });
  const claimed = await first.claimNext(server.id);
  assert.equal(claimed.job.id, queued.id);

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);

  return {
    root,
    server,
    applicationRegistry,
    application,
    jobId: queued.id,
    jobRegistry: restarted,
    contextReader: createJobRecoveryContextReader({ filePath: jobStore }),
    receiptStore: createNodeRestartReceiptStore({ root: path.join(root, 'receipts') }),
    releaseId,
    serviceName,
  };
}

function healthyStatus(fx) {
  return {
    releaseId: fx.releaseId,
    serviceName: fx.serviceName,
    port: fx.application.runtime.port,
    healthPath: fx.application.runtime.healthPath,
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    restartCount: 1,
    mainPid: 4321,
    healthy: true,
    inspectionError: false,
  };
}

const stoppedConsumers = async () => ({ apiActive: false, agentActive: false });

test('verified receipt and healthy live status close the same durable Node restart', async (t) => {
  const fx = await fixture(t);
  await fx.receiptStore.write({
    serverId: fx.server.id,
    jobId: fx.jobId,
    applicationId: fx.application.id,
    result: {
      releaseId: fx.releaseId,
      serviceName: fx.serviceName,
      port: fx.application.runtime.port,
      healthPath: fx.application.runtime.healthPath,
      healthy: true,
      restarted: true,
    },
  });

  const recovered = await recoverRunningNodeRestart({
    serverId: fx.server.id,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    applicationRegistry: fx.applicationRegistry,
    serviceStatus: stoppedConsumers,
    loadJobContext: (id) => fx.contextReader.read(id),
    readRestartReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
    inspectNodeStatus: async () => healthyStatus(fx),
  });

  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.recoveryMethod, 'verified_node_restart_receipt_and_status');
  assert.equal(fx.jobRegistry.recovery(), null);
  assert.deepEqual(fx.jobRegistry.recoveryRecord().jobs, []);

  const terminal = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.result.releaseId, fx.releaseId);
  assert.equal(terminal.result.restarted, true);
  assert.equal(terminal.result.healthy, true);

  const application = await fx.applicationRegistry.getApplication(fx.application.id);
  assert.equal(application.state, 'active');
  assert.equal(application.currentReleaseId, fx.releaseId);
  assert.equal(application.activeDeploymentId, null);
});

test('missing receipt keeps the durable Node restart unresolved before live status inspection', async (t) => {
  const fx = await fixture(t);
  let inspections = 0;

  await assert.rejects(
    recoverRunningNodeRestart({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      applicationRegistry: fx.applicationRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readRestartReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectNodeStatus: async () => { inspections += 1; return healthyStatus(fx); },
    }),
    { code: 'job_node_restart_recovery_receipt_missing' },
  );

  assert.equal(inspections, 0);
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
});

test('unhealthy current service cannot consume a valid Node restart receipt', async (t) => {
  const fx = await fixture(t);
  await fx.receiptStore.write({
    serverId: fx.server.id,
    jobId: fx.jobId,
    applicationId: fx.application.id,
    result: {
      releaseId: fx.releaseId,
      serviceName: fx.serviceName,
      port: fx.application.runtime.port,
      healthPath: fx.application.runtime.healthPath,
      healthy: true,
      restarted: true,
    },
  });
  const status = healthyStatus(fx);
  status.healthy = false;

  await assert.rejects(
    recoverRunningNodeRestart({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      applicationRegistry: fx.applicationRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readRestartReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectNodeStatus: async () => status,
    }),
    { code: 'job_node_restart_recovery_evidence_not_satisfied' },
  );

  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
});
