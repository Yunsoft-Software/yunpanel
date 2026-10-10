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

async function fixture(t, passenger = false) {
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
    runtimeAdapter: passenger ? 'passenger' : 'direct-systemd',
    runtime: { port: passenger ? null : 34123, healthPath: '/health' },
  });
  const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  const serviceName = nodeServiceName(created.id);
  if (passenger) await applicationRegistry.activatePassengerRelease(created.id, {
    operationId: releaseId, releaseId, commitSha: '2'.repeat(40), runtime: created.runtime, healthy: true,
  });
  else {
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
  }
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
      ...(passenger ? { runtimeAdapter: 'passenger', environmentRevision: 4 } : {}),
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
    jobStore,
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

function passengerRecovery(fx, patch = {}) {
  return {
    serverId: fx.server.id, jobId: fx.jobId, jobRegistry: fx.jobRegistry,
    applicationRegistry: fx.applicationRegistry, serviceStatus: stoppedConsumers,
    loadJobContext: id => fx.contextReader.read(id),
    readRestartReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
    writeRestartReceipt: input => fx.receiptStore.write(input),
    inspectNodeStatus: async () => { throw new Error('Passenger must not inspect a fabricated systemd service'); },
    inspectPassengerState: async () => ({ verified: true, applicationId: fx.application.id, releaseId: fx.releaseId,
      runtimeAdapter: 'passenger', environmentRevision: 4, port: null, healthPath: '/health', healthy: true,
      processes: 1, appliedAt: new Date().toISOString() }),
    ...patch,
  };
}

test('exact Passenger applied-state recovery persists a private v2 receipt and survives a cold job-store reload', async t => {
  const fx = await fixture(t, true);
  const result = await recoverRunningNodeRestart(passengerRecovery(fx, { allowAppliedStateRecoveryJobId: fx.jobId }));
  assert.equal(result.status, 'succeeded');
  const receipt = await fx.receiptStore.read(fx.server.id, fx.jobId);
  assert.equal(receipt.version, 2);
  assert.equal(receipt.environmentRevision, 4);
  assert.equal(receipt.port, null);
  const cold = createDurableJobRegistry({ filePath: fx.jobStore, registryFactory: createJobRegistry });
  await cold.init();
  assert.equal((await cold.getJob(fx.jobId)).status, 'succeeded');
  assert.equal(cold.recovery(), null);
  assert.deepEqual(cold.recoveryRecord().jobs, []);
});

test('Passenger receipt absence requires the same explicitly allowed job and never inspects or writes otherwise', async t => {
  for (const allowed of [null, '71581dea-2d46-48ca-909a-e286be9feb60']) {
    const fx = await fixture(t, true); let inspections = 0, writes = 0;
    await assert.rejects(recoverRunningNodeRestart(passengerRecovery(fx, {
      allowAppliedStateRecoveryJobId: allowed,
      inspectPassengerState: async () => { inspections++; }, writeRestartReceipt: async () => { writes++; },
    })), { code: 'job_node_restart_recovery_receipt_missing' });
    assert.equal(inspections, 0); assert.equal(writes, 0);
    assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  }
});

test('foreign, stale, missing process and unhealthy Passenger proof leave the original durable job unresolved', async t => {
  for (const patch of [{ applicationId: 'foreign' }, { releaseId: 'foreign' }, { environmentRevision: 5 },
    { runtimeAdapter: 'direct-systemd' }, { port: 3000 }, { healthPath: '/' }, { verified: false },
    { healthy: false }, { processes: 0 }, { processes: 1.5 }, { appliedAt: '2000-01-01T00:00:00Z' }]) {
    const fx = await fixture(t, true), options = passengerRecovery(fx, { allowAppliedStateRecoveryJobId: fx.jobId });
    const proof = await options.inspectPassengerState();
    options.inspectPassengerState = async () => ({ ...proof, ...patch });
    await assert.rejects(recoverRunningNodeRestart(options), { code: 'job_node_restart_recovery_evidence_not_satisfied' });
    assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
    assert.equal(await fx.receiptStore.read(fx.server.id, fx.jobId), null);
  }
});

test('normal v2 Passenger receipt still requires real current process evidence and stopped consumers', async t => {
  const fx = await fixture(t, true), options = passengerRecovery(fx);
  const proof = await options.inspectPassengerState();
  await fx.receiptStore.write({ serverId: fx.server.id, jobId: fx.jobId, applicationId: fx.application.id,
    result: { ...proof, restarted: true } });
  await assert.rejects(recoverRunningNodeRestart({ ...options, serviceStatus: async () => ({ apiActive: true, agentActive: false }) }),
    { code: 'job_node_restart_recovery_consumers_must_be_stopped' });
  await assert.rejects(recoverRunningNodeRestart({ ...options, inspectPassengerState: async () => ({ ...proof, processes: 0 }) }),
    { code: 'job_node_restart_recovery_evidence_not_satisfied' });
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal((await recoverRunningNodeRestart(options)).status, 'succeeded');
});

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
