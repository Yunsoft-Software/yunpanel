import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { recoverRunningInspection } from '../src/job-running-recovery.js';

const serverId = 'server-1';
const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const stopped = async () => ({ apiActive: false, agentActive: false });

async function fixture(t, { type, operation, payload, resourceType, resourceId }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-readonly-payload-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'jobs.json');

  const first = createJobRegistry({ filePath });
  await first.init();
  const queued = await first.enqueue({ serverId, type, operation, payload, resourceType, resourceId });
  const claim = await first.claimNext(serverId);
  assert.equal(claim.job.id, queued.id);

  const durable = createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
  await durable.init();
  return {
    jobId: queued.id,
    durable,
    contextReader: createJobRecoveryContextReader({ filePath }),
  };
}

function nginxState() {
  return {
    id: 'nginx',
    installed: true,
    active: true,
    packages: [{ packageName: 'nginx', installed: true, version: '1.24.0-2ubuntu7.4' }],
    units: [{
      unit: 'nginx.service',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      unitFileState: 'enabled',
      inspectionError: false,
    }],
  };
}

function nodeServiceName() {
  return `yunpanel-node-${createHash('sha256').update(applicationId).digest('hex').slice(0, 16)}.service`;
}

test('single-service inspection recovery reuses exact private persisted payload after restart', async (t) => {
  const fx = await fixture(t, {
    type: 'system.services.inspect',
    operation: OPERATIONS.SYSTEM_SERVICES_INSPECT,
    payload: { serviceId: 'nginx' },
    resourceType: 'system',
    resourceId: serverId,
  });
  const executions = [];

  const recovered = await recoverRunningInspection({
    serverId,
    jobId: fx.jobId,
    jobRegistry: fx.durable,
    serviceStatus: stopped,
    loadJobContext: (id) => fx.contextReader.read(id),
    executeOperation: async (operation, payload) => {
      executions.push([operation, payload]);
      return nginxState();
    },
  });

  assert.deepEqual(executions, [[OPERATIONS.SYSTEM_SERVICES_INSPECT, { serviceId: 'nginx' }]]);
  assert.equal(recovered.status, 'succeeded');
  assert.equal((await fx.durable.getJob(fx.jobId)).result.id, 'nginx');
  assert.equal(fx.durable.recovery(), null);
});

test('Node status recovery reuses exact private application/release/runtime payload after restart', async (t) => {
  const runtime = { port: 3100, healthPath: '/health' };
  const fx = await fixture(t, {
    type: 'app.node.status',
    operation: OPERATIONS.APP_NODE_STATUS,
    payload: { applicationId, releaseId, runtime },
    resourceType: 'application',
    resourceId: applicationId,
  });
  const executions = [];

  const recovered = await recoverRunningInspection({
    serverId,
    jobId: fx.jobId,
    jobRegistry: fx.durable,
    serviceStatus: stopped,
    loadJobContext: (id) => fx.contextReader.read(id),
    executeOperation: async (operation, payload) => {
      executions.push([operation, payload]);
      return {
        releaseId,
        serviceName: nodeServiceName(),
        port: 3100,
        healthPath: '/health',
        loadState: 'loaded',
        activeState: 'active',
        subState: 'running',
        restartCount: 0,
        mainPid: 4242,
        healthy: true,
        inspectionError: false,
      };
    },
  });

  assert.deepEqual(executions, [[OPERATIONS.APP_NODE_STATUS, { applicationId, releaseId, runtime }]]);
  assert.equal(recovered.status, 'succeeded');
  assert.equal((await fx.durable.getJob(fx.jobId)).result.serviceName, nodeServiceName());
  assert.equal(fx.durable.recovery(), null);
});

test('missing private context leaves payload-backed read-only job unresolved', async (t) => {
  const fx = await fixture(t, {
    type: 'system.services.inspect',
    operation: OPERATIONS.SYSTEM_SERVICES_INSPECT,
    payload: { serviceId: 'nginx' },
    resourceType: 'system',
    resourceId: serverId,
  });

  await assert.rejects(
    recoverRunningInspection({
      serverId,
      jobId: fx.jobId,
      jobRegistry: fx.durable,
      serviceStatus: stopped,
      executeOperation: async () => nginxState(),
    }),
    { code: 'job_running_recovery_context_unavailable' },
  );
  assert.equal((await fx.durable.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.durable.recovery().jobs[0].jobId, fx.jobId);
});
