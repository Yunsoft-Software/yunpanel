import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { recoverRunningServiceReceiptMutation } from '../src/job-running-service-receipt-recovery.js';
import { createManagedServiceMutationReceiptStore } from '../src/managed-service-mutation-receipt.js';
import { createServerRegistry } from '../src/server-registry.js';

function nginxActiveState() {
  return {
    id: 'nginx',
    installed: true,
    active: true,
    packages: [{ packageName: 'nginx', installed: true, version: '1.24.0-1' }],
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

async function fixture(t, operation, payload) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-service-receipt-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'service-receipt-recovery-host' });
  const jobStore = path.join(root, 'jobs.json');

  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: operation,
    operation,
    payload,
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
    receiptStore: createManagedServiceMutationReceiptStore({ root: path.join(root, 'receipts') }),
  };
}

const stoppedConsumers = async () => ({ apiActive: false, agentActive: false });

for (const scenario of [
  {
    name: 'install',
    operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
    payload: { serviceId: 'nginx' },
    receipt: { operation: OPERATIONS.SYSTEM_SERVICE_INSTALL, serviceId: 'nginx', changed: true },
  },
  {
    name: 'restart',
    operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    payload: { serviceId: 'nginx', action: 'restart' },
    receipt: { operation: OPERATIONS.SYSTEM_SERVICE_CONTROL, serviceId: 'nginx', action: 'restart' },
  },
]) {
  test(`verified ${scenario.name} receipt closes the same durable service mutation`, async (t) => {
    const fx = await fixture(t, scenario.operation, scenario.payload);
    await fx.receiptStore.write({ serverId: fx.server.id, jobId: fx.jobId, ...scenario.receipt });

    const recovered = await recoverRunningServiceReceiptMutation({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readMutationReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectServiceState: async () => nginxActiveState(),
    });

    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.recoveryMethod, 'verified_managed_service_receipt_and_state');
    assert.equal(fx.jobRegistry.recovery(), null);
    assert.deepEqual(fx.jobRegistry.recoveryRecord().jobs, []);

    const terminal = await fx.jobRegistry.getJob(fx.jobId);
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.result.id, 'nginx');
    assert.equal(terminal.result.active, true);
    if (scenario.name === 'install') assert.equal(terminal.result.changed, true);
    else assert.equal(terminal.result.action, 'restart');
  });
}
