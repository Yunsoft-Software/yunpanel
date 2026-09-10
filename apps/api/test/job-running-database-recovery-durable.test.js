import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { recoverRunningDatabaseCreate } from '../src/job-running-database-recovery.js';
import { createJobRegistry } from '../src/job-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-create-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobStore = path.join(root, 'jobs.json');
  const serverId = 'server-1';
  const databaseName = 'app_db';

  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId,
    type: OPERATIONS.DATABASE_CREATE,
    operation: OPERATIONS.DATABASE_CREATE,
    payload: { name: databaseName },
    resourceType: 'database',
    resourceId: databaseName,
  });
  const claimed = await first.claimNext(serverId);
  assert.equal(claimed.job.id, queued.id);
  assert.equal(claimed.envelope.payload.name, databaseName);

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);
  const contextReader = createJobRecoveryContextReader({ filePath: jobStore });

  return { serverId, databaseName, jobId: queued.id, jobRegistry: restarted, contextReader };
}

test('verified database presence closes the original running durable create job', async (t) => {
  const fx = await fixture(t);
  const publicJob = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(Object.hasOwn(publicJob, 'payload'), false);

  const recovered = await recoverRunningDatabaseCreate({
    serverId: fx.serverId,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    loadJobContext: (id) => fx.contextReader.read(id),
    inspectDatabaseState: async () => ({
      engine: 'mariadb',
      version: '11.4.5-MariaDB',
      databases: [{ name: fx.databaseName, sizeBytes: 8192 }],
    }),
  });

  assert.equal(recovered.recoveryMethod, 'verified_database_presence');
  assert.equal(fx.jobRegistry.recovery(), null);
  assert.deepEqual(fx.jobRegistry.recoveryRecord().jobs, []);
  const terminal = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(terminal.status, 'succeeded');
  assert.deepEqual(terminal.result, {
    engine: 'mariadb',
    version: '11.4.5-MariaDB',
    database: { name: fx.databaseName, sizeBytes: 8192 },
    created: true,
  });
});

test('absent database keeps durable create job unresolved and running', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    recoverRunningDatabaseCreate({
      serverId: fx.serverId,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      loadJobContext: (id) => fx.contextReader.read(id),
      inspectDatabaseState: async () => ({ engine: 'mysql', version: '8.4.0', databases: [] }),
    }),
    { code: 'job_database_recovery_evidence_not_satisfied' },
  );

  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
});
