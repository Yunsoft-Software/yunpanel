import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStaticRollbackEvidenceInspector } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { recoverRunningStaticRollback } from '../src/job-running-static-rollback-recovery.js';
import { createServerRegistry } from '../src/server-registry.js';

const releaseOne = 'ff830043-9752-4640-83b4-3a1998de78a0';
const releaseTwo = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-static-rollback-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'static-rollback-recovery-host' });
  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(root, 'applications.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();
  const application = await applicationRegistry.createApplication({
    serverId: server.id,
    name: 'Rollback Recovery App',
    repositoryUrl: 'https://github.com/example/rollback-recovery',
  });
  await applicationRegistry.markDeploying(application.id, releaseOne);
  await applicationRegistry.markDeployed(application.id, { deploymentId: releaseOne, releaseId: releaseOne, commitSha: '1'.repeat(40) });
  await applicationRegistry.markDeploying(application.id, releaseTwo);
  await applicationRegistry.markDeployed(application.id, { deploymentId: releaseTwo, releaseId: releaseTwo, commitSha: '2'.repeat(40) });

  const jobStore = path.join(root, 'jobs.json');
  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: 'app.static.rollback',
    operation: OPERATIONS.APP_STATIC_ROLLBACK,
    payload: { applicationId: application.id, releaseId: releaseOne, currentReleaseId: releaseTwo },
    resourceType: 'application',
    resourceId: application.id,
  });
  await applicationRegistry.markRollingBack(application.id, queued.id, releaseOne);
  await first.claimNext(server.id);

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);

  const webRoot = path.join(root, 'web');
  const appRoot = path.join(webRoot, application.id);
  await mkdir(path.join(appRoot, 'releases', releaseOne), { recursive: true });
  await mkdir(path.join(appRoot, 'releases', releaseTwo), { recursive: true });
  return {
    server,
    application,
    applicationRegistry,
    jobRegistry: restarted,
    contextReader: createJobRecoveryContextReader({ filePath: jobStore }),
    evidenceInspector: createStaticRollbackEvidenceInspector({ webRoot }),
    appRoot,
    jobId: queued.id,
  };
}

const stoppedConsumers = async () => ({ apiActive: false, agentActive: false });

async function recover(fx) {
  return recoverRunningStaticRollback({
    serverId: fx.server.id,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    applicationRegistry: fx.applicationRegistry,
    serviceStatus: stoppedConsumers,
    loadJobContext: (id) => fx.contextReader.read(id),
    inspectRollbackEvidence: (intent) => fx.evidenceInspector.inspect(intent),
  });
}

test('exact static rollback symlink closes durable job and reconciles retained release state', async (t) => {
  const fx = await fixture(t);
  await symlink(path.join('releases', releaseOne), path.join(fx.appRoot, 'current'));

  const result = await recover(fx);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.recoveryMethod, 'verified_static_rollback_symlink');
  assert.equal(fx.jobRegistry.recovery(), null);
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'succeeded');

  const application = await fx.applicationRegistry.getApplication(fx.application.id);
  assert.equal(application.state, 'active');
  assert.equal(application.activeDeploymentId, null);
  assert.equal(application.pendingRollbackReleaseId, null);
  assert.equal(application.currentReleaseId, releaseOne);
  assert.equal(application.previousReleaseId, releaseTwo);
  assert.equal(application.currentCommitSha, '1'.repeat(40));
});

test('unchanged current symlink preserves running rollback and control-plane intent', async (t) => {
  const fx = await fixture(t);
  await symlink(path.join('releases', releaseTwo), path.join(fx.appRoot, 'current'));

  await assert.rejects(recover(fx), { code: 'job_static_rollback_recovery_evidence_not_satisfied' });
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
  const application = await fx.applicationRegistry.getApplication(fx.application.id);
  assert.equal(application.state, 'rolling_back');
  assert.equal(application.activeDeploymentId, fx.jobId);
  assert.equal(application.currentReleaseId, releaseTwo);
  assert.equal(application.pendingRollbackReleaseId, releaseOne);
});
