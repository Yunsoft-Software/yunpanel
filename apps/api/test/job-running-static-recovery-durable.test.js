import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createStaticDeploymentEvidenceInspector,
  createStaticDeploymentReceiptStore,
} from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { recoverRunningStaticDeployment } from '../src/job-running-static-recovery.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-static-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'static-recovery-host' });
  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(root, 'applications.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();
  const application = await applicationRegistry.createApplication({
    serverId: server.id,
    name: 'Static Recovery App',
    repositoryUrl: 'https://github.com/example/static-recovery-app',
    branch: 'main',
    build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
    retention: 5,
  });

  const jobStore = path.join(root, 'jobs.json');
  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: OPERATIONS.APP_STATIC_DEPLOY,
    operation: OPERATIONS.APP_STATIC_DEPLOY,
    payload: {
      applicationId: application.id,
      repositoryUrl: application.repositoryUrl,
      branch: application.branch,
      build: application.build,
      retention: application.retention,
    },
    resourceType: 'application',
    resourceId: application.id,
  });
  await applicationRegistry.markDeploying(application.id, queued.id);
  const claimed = await first.claimNext(server.id);
  assert.equal(claimed.job.id, queued.id);
  assert.equal(claimed.envelope.payload.deploymentId, queued.id);

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);

  const webRoot = path.join(root, 'web');
  const receiptStore = createStaticDeploymentReceiptStore({ root: path.join(root, 'receipts') });
  const evidenceInspector = createStaticDeploymentEvidenceInspector({ webRoot, receiptStore });
  const result = {
    deploymentId: queued.id,
    releaseId: queued.id,
    commitSha: 'a'.repeat(40),
    previousReleaseId: null,
    artifactFiles: 3,
    artifactBytes: 1024,
  };

  return { root, server, application, applicationRegistry, jobRegistry: restarted, webRoot, receiptStore, evidenceInspector, result, jobId: queued.id };
}

test('verified static receipt and current release close the same durable job and application deployment', async (t) => {
  const fx = await fixture(t);
  await fx.receiptStore.write({ applicationId: fx.application.id, deploymentId: fx.jobId, result: fx.result });
  const appRoot = path.join(fx.webRoot, fx.application.id);
  await mkdir(path.join(appRoot, 'releases', fx.jobId), { recursive: true });
  await symlink(path.join('releases', fx.jobId), path.join(appRoot, 'current'));

  const recovered = await recoverRunningStaticDeployment({
    serverId: fx.server.id,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: fx.applicationRegistry,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    inspectDeploymentEvidence: (identity) => fx.evidenceInspector.inspect(identity),
  });

  assert.equal(recovered.recoveryMethod, 'verified_static_deployment_receipt');
  assert.equal(fx.jobRegistry.recovery(), null);
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'succeeded');
  const application = await fx.applicationRegistry.getApplication(fx.application.id);
  assert.equal(application.state, 'active');
  assert.equal(application.activeDeploymentId, null);
  assert.equal(application.currentReleaseId, fx.jobId);
  assert.equal(application.currentCommitSha, fx.result.commitSha);
  assert.equal(application.releases[0].artifactFiles, 3);
  assert.equal(application.releases[0].artifactBytes, 1024);
});

test('missing receipt evidence keeps job running and application deploying', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    recoverRunningStaticDeployment({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      domainRegistry: {},
      certificateRegistry: {},
      applicationRegistry: fx.applicationRegistry,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspectDeploymentEvidence: (identity) => fx.evidenceInspector.inspect(identity),
    }),
    { code: 'job_static_recovery_evidence_not_satisfied' },
  );
  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
  const application = await fx.applicationRegistry.getApplication(fx.application.id);
  assert.equal(application.state, 'deploying');
  assert.equal(application.activeDeploymentId, fx.jobId);
  assert.equal(application.currentReleaseId, null);
});
