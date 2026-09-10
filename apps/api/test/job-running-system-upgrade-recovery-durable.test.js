import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { recoverRunningSystemUpgrade } from '../src/job-running-system-upgrade-recovery.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSystemUpgradeReceiptStore } from '../src/system-upgrade-receipt.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-system-upgrade-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'upgrade-recovery-host' });
  const jobStore = path.join(root, 'jobs.json');

  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: 'system.upgrade',
    operation: OPERATIONS.SYSTEM_UPGRADE,
    payload: {},
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
    receiptStore: createSystemUpgradeReceiptStore({ root: path.join(root, 'receipts') }),
  };
}

const stoppedConsumers = async () => ({ apiActive: false, agentActive: false });

for (const scenario of [
  {
    name: 'upgraded package',
    result: {
      packageName: 'yunpanel',
      installed: true,
      installedVersion: '0.4.0',
      candidateVersion: '0.4.0',
      updateAvailable: false,
      previousVersion: '0.3.0',
      upgraded: true,
      restartScheduled: true,
    },
  },
  {
    name: 'no-op upgrade',
    result: {
      packageName: 'yunpanel',
      installed: true,
      installedVersion: '0.4.0',
      candidateVersion: '0.4.0',
      updateAvailable: false,
      previousVersion: '0.4.0',
      upgraded: false,
      restartScheduled: false,
    },
  },
]) {
  test(`verified ${scenario.name} receipt closes the same durable upgrade job`, async (t) => {
    const fx = await fixture(t);
    await fx.receiptStore.write({ serverId: fx.server.id, jobId: fx.jobId, result: scenario.result });

    const recovered = await recoverRunningSystemUpgrade({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readUpgradeReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectPackageState: async () => ({
        packageName: 'yunpanel',
        installed: true,
        installedVersion: scenario.result.installedVersion,
        candidateVersion: scenario.result.candidateVersion,
        updateAvailable: scenario.result.updateAvailable,
      }),
    });

    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.upgraded, scenario.result.upgraded);
    assert.equal(recovered.recoveryMethod, 'verified_system_upgrade_receipt_and_package_state');
    assert.equal(fx.jobRegistry.recovery(), null);
    assert.deepEqual(fx.jobRegistry.recoveryRecord().jobs, []);

    const terminal = await fx.jobRegistry.getJob(fx.jobId);
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.result.previousVersion, scenario.result.previousVersion);
    assert.equal(terminal.result.restartScheduled, scenario.result.restartScheduled);
  });
}

test('missing system upgrade receipt preserves durable running recovery state', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    recoverRunningSystemUpgrade({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      serviceStatus: stoppedConsumers,
      loadJobContext: (id) => fx.contextReader.read(id),
      readUpgradeReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectPackageState: async () => ({
        packageName: 'yunpanel', installed: true, installedVersion: '0.4.0', candidateVersion: '0.4.0', updateAvailable: false,
      }),
    }),
    { code: 'job_system_upgrade_recovery_receipt_missing' },
  );
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
});
