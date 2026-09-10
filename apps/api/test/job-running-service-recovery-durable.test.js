import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { recoverRunningServiceControl } from '../src/job-running-service-recovery.js';
import { createServerRegistry } from '../src/server-registry.js';

function nginxState(active) {
  return {
    id: 'nginx',
    label: 'Nginx',
    category: 'web',
    installed: true,
    active,
    packages: [{ packageName: 'nginx', installed: true, version: '1.24.0-1' }],
    units: [{
      unit: 'nginx.service',
      loadState: 'loaded',
      activeState: active ? 'active' : 'inactive',
      subState: active ? 'running' : 'dead',
      unitFileState: 'enabled',
      inspectionError: false,
    }],
  };
}

async function fixture(t, action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-service-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'service-recovery-host' });
  const jobStore = path.join(root, 'jobs.json');

  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    payload: { serviceId: 'nginx', action },
    resourceType: 'system',
    resourceId: server.id,
  });
  const claimed = await first.claimNext(server.id);
  assert.equal(claimed.job.id, queued.id);

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);

  return {
    server,
    jobId: queued.id,
    jobRegistry: restarted,
    contextReader: createJobRecoveryContextReader({ filePath: jobStore }),
  };
}

const stoppedConsumers = async () => ({ apiActive: false, agentActive: false });

test('verified stopped service state closes the same durable control job', async (t) => {
  const fx = await fixture(t, 'stop');
  const recovered = await recoverRunningServiceControl({
    serverId: fx.server.id,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    serviceStatus: stoppedConsumers,
    loadJobContext: (id) => fx.contextReader.read(id),
    inspectServiceState: async () => nginxState(false),
  });

  assert.equal(recovered.action, 'stop');
  assert.equal(recovered.status, 'succeeded');
  assert.equal(fx.jobRegistry.recovery(), null);
  assert.deepEqual(fx.jobRegistry.recoveryRecord().jobs, []);

  const terminal = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.result.id, 'nginx');
  assert.equal(terminal.result.action, 'stop');
  assert.equal(terminal.result.active, false);
  assert.equal(Object.hasOwn(terminal.result, 'label'), false);
  assert.equal(Object.hasOwn(terminal.result, 'category'), false);
});

test('restart service control remains unresolved because final active state cannot prove a restart', async (t) => {
  const fx = await fixture(t, 'restart');
  let inspections = 0;
  await assert.rejects(
    recoverRunningServiceControl({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      inspectServiceState: async () => { inspections += 1; return nginxState(true); },
    }),
    { code: 'job_service_recovery_context_mismatch' },
  );

  assert.equal(inspections, 0);
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
});
