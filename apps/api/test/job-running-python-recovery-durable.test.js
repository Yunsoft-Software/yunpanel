import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPythonSiteManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationRegistry } from '../src/applications/application-registry.js';
import { startConfiguredLocalRuntime } from '../src/runtime/configured-local-runtime.js';
import { createDurableJobRegistry } from '../src/jobs/durable-job-registry.js';
import { createJobRegistry } from '../src/jobs/job-registry.js';
import {
  runRunningPythonDeploymentRecoveryFromStores,
  runRunningPythonRestartRecoveryFromStores,
  runRunningPythonRollbackRecoveryFromStores,
} from '../src/jobs/job-running-python-recovery-runtime.js';
import { createPythonOperationReceiptStore } from '../src/applications/python-operation-receipt.js';
import { createServerRegistry } from '../src/runtime/server-registry.js';

const hostname = 'python-recovery-host';
const stoppedConsumers = async () => ({ apiActive: false, agentActive: false });
const RECOVER = Object.freeze({
  deploy: runRunningPythonDeploymentRecoveryFromStores,
  rollback: runRunningPythonRollbackRecoveryFromStores,
  restart: runRunningPythonRestartRecoveryFromStores,
});

async function deployRelease(applicationRegistry, applicationId, commitDigit) {
  const releaseId = randomUUID();
  await applicationRegistry.markDeploying(applicationId, releaseId);
  await applicationRegistry.markDeployed(applicationId, { deploymentId: releaseId, releaseId, commitSha: commitDigit.repeat(40) });
  return releaseId;
}

function queuedJob(kind, application, firstReleaseId) {
  const base = { applicationId: application.id, runtime: application.runtime, environmentRevision: 0 };
  if (kind === 'deploy') {
    return {
      type: 'app.python.deploy',
      operation: OPERATIONS.APP_PYTHON_DEPLOY,
      payload: { ...base, repositoryUrl: application.repositoryUrl, branch: application.branch, gitTarget: { kind: 'branch', value: 'main' }, retention: application.retention },
    };
  }
  if (kind === 'rollback') {
    return {
      type: 'app.python.rollback',
      operation: OPERATIONS.APP_PYTHON_ROLLBACK,
      payload: { ...base, releaseId: firstReleaseId, currentReleaseId: application.currentReleaseId },
    };
  }
  return { type: 'app.python.restart', operation: OPERATIONS.APP_PYTHON_RESTART, payload: { ...base, releaseId: application.currentReleaseId } };
}

async function fixture(t, kind) {
  const root = await mkdtemp(path.join(os.tmpdir(), `yunpanel-python-${kind}-recovery-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    YUNPANEL_SERVER_STORE: path.join(root, 'servers.json'),
    YUNPANEL_JOB_STORE: path.join(root, 'jobs.json'),
    YUNPANEL_APPLICATION_STORE: path.join(root, 'applications.json'),
  };

  const serverRegistry = createServerRegistry({ filePath: env.YUNPANEL_SERVER_STORE });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname });
  const applicationRegistry = createApplicationRegistry({
    filePath: env.YUNPANEL_APPLICATION_STORE,
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();
  const created = await applicationRegistry.createPythonApplication({
    serverId: server.id,
    name: 'Python Recovery App',
    repositoryUrl: 'https://github.com/Yunsoft-Software/python-recovery-app',
    branch: 'main',
    runtime: { pythonVersion: '3.12', appServer: 'gunicorn', entryPoint: 'app.wsgi:application', workers: 2 },
  });
  const firstReleaseId = await deployRelease(applicationRegistry, created.id, '1');
  if (kind !== 'deploy') await deployRelease(applicationRegistry, created.id, '2');
  const application = await applicationRegistry.getApplication(created.id);

  const live = createDurableJobRegistry({ filePath: env.YUNPANEL_JOB_STORE, registryFactory: createJobRegistry });
  await live.init();
  const queued = await live.enqueue({ serverId: server.id, ...queuedJob(kind, application, firstReleaseId), resourceType: 'application', resourceId: application.id });
  if (kind === 'deploy') await applicationRegistry.markDeploying(application.id, queued.id);
  if (kind === 'rollback') await applicationRegistry.markRollingBack(application.id, queued.id, firstReleaseId);
  const claimed = await live.claimNext(server.id);
  assert.equal(claimed.job.id, queued.id);

  return {
    root,
    env,
    kind,
    serverId: server.id,
    jobId: queued.id,
    operation: queued.operation,
    payload: claimed.envelope.payload,
    application,
    firstReleaseId,
    receiptStore: createPythonOperationReceiptStore({ root: path.join(root, 'receipts') }),
  };
}

function hostResult(fx) {
  const service = { serviceName: fx.application.serviceName, socketPath: fx.application.socketPath, port: null };
  if (fx.kind === 'deploy') {
    return {
      ...service, deploymentId: fx.jobId, releaseId: fx.jobId, previousReleaseId: fx.firstReleaseId, commit: '3'.repeat(40),
      commitSha: '3'.repeat(40), healthPath: fx.application.runtime.healthPath ?? null, active: true, healthy: true, applied: true,
    };
  }
  if (fx.kind === 'rollback') {
    return {
      ...service, releaseId: fx.firstReleaseId, previousReleaseId: fx.application.currentReleaseId,
      healthPath: fx.application.runtime.healthPath ?? null, active: true, healthy: true, rolledBack: true,
    };
  }
  return {
    ...service, releaseId: fx.application.currentReleaseId, active: true, activeState: 'active', subState: 'running',
    loadState: 'loaded', mainPid: 4321, socketExists: true, healthy: true, inspectionError: false, restarted: true,
  };
}

// The receipt is written through the same evidence hook the local executor
// calls after a successful host operation.
async function recordHostEvidence(fx, result = hostResult(fx)) {
  let recorder;
  await startConfiguredLocalRuntime({
    env: { YUNPANEL_LOCAL_SERVER_ID: fx.serverId },
    hostname,
    jobStorePath: fx.env.YUNPANEL_JOB_STORE,
    runtimeVersion: '0.3.0',
    registry: {}, jobRegistry: {}, domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {},
    applicationEnvironmentRegistry: { materialize: async () => ({}) },
    websiteRegistry: { listWebsites: async () => [] },
    runtimeBindingRegistry: { getBinding: async () => null, activate: async () => null },
    createOperations: () => ({ operations: [], supports: () => true, executeOperation: async () => ({}) }),
    createPythonOperationReceipts: () => fx.receiptStore,
    inspectInventory: async () => ({ hostname }),
    startRuntime: async (options) => { recorder = options.recordExecutionEvidence; return { stop: async () => {} }; },
  });
  await recorder({
    serverId: fx.serverId, jobId: fx.jobId, operation: fx.operation,
    resourceType: 'application', resourceId: fx.application.id, payload: fx.payload, result,
  });
}

function systemctl(serviceName, activeState) {
  return async (file, args) => {
    if (args[0] === '--version') return { stdout: 'systemd 255' };
    assert.deepEqual(args.slice(0, 2), ['show', serviceName]);
    return { stdout: `MainPID=4321\nActiveState=${activeState}\nSubState=running\nLoadState=loaded\n` };
  };
}

async function recover(fx, { command = RECOVER[fx.kind], activeState = 'active', serviceStatus = stoppedConsumers } = {}) {
  return command({
    serverId: fx.serverId,
    jobId: fx.jobId,
    hostname,
    env: fx.env,
    cwd: fx.root,
    receiptStoreFactory: () => fx.receiptStore,
    statusInspectorFactory: () => createPythonSiteManager({ run: systemctl(fx.application.serviceName, activeState) }),
    serviceStatus,
  });
}

async function reopen(fx) {
  const jobs = createDurableJobRegistry({ filePath: fx.env.YUNPANEL_JOB_STORE, registryFactory: createJobRegistry });
  await jobs.init();
  const applications = createApplicationRegistry({ filePath: fx.env.YUNPANEL_APPLICATION_STORE, serverExists: async () => true });
  await applications.init();
  return { jobs, job: await jobs.getJob(fx.jobId), application: await applications.getApplication(fx.application.id) };
}

for (const kind of ['deploy', 'rollback', 'restart']) {
  test(`API restart with a running Python ${kind} is recovered from its receipt and live service state`, async (t) => {
    const fx = await fixture(t, kind);
    await recordHostEvidence(fx);

    const afterRestart = await reopen(fx);
    assert.equal(afterRestart.jobs.recovery().code, 'durable_job_reconciliation_required');
    assert.equal(afterRestart.jobs.recovery().jobs[0].jobId, fx.jobId);
    assert.equal(afterRestart.job.status, 'running');

    const recovered = await recover(fx);
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.operation, fx.operation);
    assert.equal(recovered.recoveryMethod, `verified_python_${kind === 'deploy' ? 'deployment' : kind}_receipt_and_status`);
    assert.equal(recovered.statePaths.jobStore, fx.env.YUNPANEL_JOB_STORE);

    const after = await reopen(fx);
    assert.equal(after.jobs.recovery(), null);
    assert.deepEqual(after.jobs.recoveryRecord().jobs, []);
    assert.equal(after.job.status, 'succeeded');
    assert.equal(after.application.state, 'active');
    assert.equal(after.application.activeDeploymentId, null);
    if (kind === 'deploy') {
      assert.equal(after.job.result.releaseId, fx.jobId);
      assert.equal(after.application.currentReleaseId, fx.jobId);
      assert.equal(after.application.previousReleaseId, fx.firstReleaseId);
      assert.equal(after.application.currentCommitSha, '3'.repeat(40));
    } else if (kind === 'rollback') {
      assert.equal(after.job.result.active, true);
      assert.equal(after.application.currentReleaseId, fx.firstReleaseId);
      assert.equal(after.application.pendingRollbackReleaseId, null);
    } else {
      assert.equal(after.job.result.restarted, true);
      assert.equal(after.application.currentReleaseId, fx.application.currentReleaseId);
    }
  });
}

test('missing Python receipt leaves the running deployment unresolved', async (t) => {
  const fx = await fixture(t, 'deploy');
  await assert.rejects(recover(fx), { code: 'job_python_deployment_recovery_receipt_missing' });
  const after = await reopen(fx);
  assert.equal(after.job.status, 'running');
  assert.equal(after.jobs.recovery().jobs[0].jobId, fx.jobId);
  assert.equal(after.application.state, 'deploying');
  assert.equal(after.application.activeDeploymentId, fx.jobId);
});

test('inactive Python service cannot consume a valid rollback receipt', async (t) => {
  const fx = await fixture(t, 'rollback');
  await recordHostEvidence(fx);
  await assert.rejects(recover(fx, { activeState: 'failed' }), { code: 'job_python_rollback_recovery_evidence_not_satisfied' });
  const after = await reopen(fx);
  assert.equal(after.job.status, 'running');
  assert.equal(after.application.state, 'rolling_back');
});

test('foreign Python state stays fail-closed', async (t) => {
  const fx = await fixture(t, 'restart');
  await recordHostEvidence(fx);

  await assert.rejects(recover(fx, { command: RECOVER.deploy }), { code: 'job_python_deployment_recovery_job_mismatch' });
  await assert.rejects(recover(fx, { serviceStatus: async () => ({ apiActive: true, agentActive: false }) }),
    { code: 'job_python_recovery_consumers_must_be_stopped' });

  const receiptPath = fx.receiptStore.receiptPath(fx.serverId, fx.jobId);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, applicationId: randomUUID() }));
  await assert.rejects(recover(fx), { code: 'job_python_restart_recovery_receipt_mismatch' });

  await writeFile(receiptPath, JSON.stringify({ ...receipt, operation: 'app.python.unknown' }));
  await assert.rejects(recover(fx), { code: 'job_python_restart_recovery_receipt_failed' });

  const after = await reopen(fx);
  assert.equal(after.job.status, 'running');
  assert.equal(after.jobs.recovery().jobs[0].jobId, fx.jobId);
});

test('unconfirmed Python host result is never persisted as recovery evidence', async (t) => {
  const fx = await fixture(t, 'restart');
  const { restarted, ...unconfirmed } = hostResult(fx);
  assert.equal(restarted, true);
  await assert.rejects(recordHostEvidence(fx, unconfirmed), /not safe recovery evidence/);
  assert.equal(await fx.receiptStore.read(fx.serverId, fx.jobId), null);
});
