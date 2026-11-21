import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cronTaskFileName, renderCronTaskFile } from '@yunpanel/config-templates';
import { createWebsiteCronManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { inspectDurableJobRecovery } from '../src/job-recovery-inspection.js';
import { JobRecoveryRuntimeError } from '../src/job-recovery-runtime.js';
import { createJobRegistry } from '../src/job-registry.js';
import {
  recoverRunningCron,
  JobRunningCronRecoveryError,
  jobRunningCronRecoveryInternals,
} from '../src/job-running-cron-recovery.js';
import { runRunningCronRecoveryFromStores } from '../src/job-running-cron-recovery-runtime.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteCronOperationReceiptStore } from '../src/website-cron-operation-receipt.js';
import { createWebsiteCronRegistry } from '../src/website-cron-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = '11111111-1111-4111-8111-111111111111';
const jobId = 'cron-recovery-job-01';
const taskId = '22222222-2222-4222-8222-222222222222';
const websiteId = '33333333-3333-4333-8333-333333333333';
const applicationId = '44444444-4444-4444-8444-444444444444';
const unixUser = 'yunapp-123456789abc';
const desiredStateSha256 = createHash('sha256').update('0 3 * * * /usr/bin/task.sh').digest('hex');
const contentSha256 = desiredStateSha256;

function createHarness({
  operation = OPERATIONS.CRON_APPLY,
  apiActive = false,
  agentActive = false,
  hasReceipt = true,
  receiptOverrides = {},
  hostFiles = [{ taskId, contentSha256 }],
  cronTaskInRegistry = { id: taskId, websiteId, applicationId, unixUser, revision: 1 },
  jobStatus = 'running',
  contextPayload = {},
} = {}) {
  const calls = [];
  const runningJob = {
    id: jobId,
    serverId,
    status: jobStatus,
    operation,
    resourceType: 'website_cron',
    resourceId: taskId,
  };

  const candidate = {
    jobId,
    serverId,
    status: jobStatus,
    operation,
    resourceType: 'website_cron',
  };

  const receipt = hasReceipt
    ? {
        version: 1,
        serverId,
        jobId,
        operation,
        result: {
          version: 1,
          taskId,
          websiteId,
          applicationId,
          unixUser,
          revision: 1,
          desiredStateSha256,
          contentSha256: operation === OPERATIONS.CRON_APPLY ? contentSha256 : null,
          [operation === OPERATIONS.CRON_APPLY ? 'applied' : 'removed']: true,
          sideEffects: operation === OPERATIONS.CRON_APPLY,
        },
        ...receiptOverrides,
      }
    : null;

  const jobRegistry = {
    async getJob(id) {
      calls.push(['getJob', id]);
      return id === jobId ? structuredClone(runningJob) : null;
    },
    async beginReconciliation(id) {
      calls.push(['beginReconciliation', id]);
      return { jobId: id.jobId, serverId: id.serverId, status: 'running', pending: true };
    },
    async complete({ serverId: sId, jobId: jId, status, result }) {
      calls.push(['complete', { serverId: sId, jobId: jId, status, result }]);
      return { ...runningJob, status, result };
    },
    async acknowledgeReconciliation(id) {
      calls.push(['acknowledgeReconciliation', id]);
      return { acknowledged: true };
    },
  };

  const websiteCronManager = {
    async listManagedFiles() {
      calls.push(['listManagedFiles']);
      return { files: hostFiles, cronServiceActive: true };
    },
  };

  const websiteCronRegistry = {
    async getTask(id) {
      calls.push(['getTask', id]);
      return id === taskId ? cronTaskInRegistry : null;
    },
  };

  return {
    calls,
    args: {
      serverId,
      jobId,
      jobRegistry,
      websiteCronRegistry,
      websiteCronManager,
      readOperationReceipt: async () => receipt,
      serviceStatus: async () => ({ apiActive, agentActive }),
      loadJobContext: async () => ({ id: jobId, payload: { taskId, websiteId, applicationId, unixUser, expectedRevision: 1, ...contextPayload } }),
      inspect: async () => ({ jobs: [candidate] }),
    },
  };
}

test('recoverRunningCron recovers running CRON_APPLY job with verified receipt and host state', async () => {
  const h = createHarness({ operation: OPERATIONS.CRON_APPLY });
  const result = await recoverRunningCron(h.args);

  assert.equal(result.serverId, serverId);
  assert.equal(result.jobId, jobId);
  assert.equal(result.operation, OPERATIONS.CRON_APPLY);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.recoveryMethod, 'verified_cron_receipt_and_host_state');
  assert.equal(result.reconciled, true);

  const callNames = h.calls.map(([name]) => name);
  assert.ok(callNames.includes('getJob'));
  assert.ok(callNames.includes('listManagedFiles'));
  assert.ok(callNames.includes('getTask'));
  assert.ok(callNames.includes('beginReconciliation'));
  assert.ok(callNames.includes('complete'));
  assert.ok(callNames.includes('acknowledgeReconciliation'));
});

test('recoverRunningCron recovers running CRON_REMOVE job when host file and registry task are absent', async () => {
  const h = createHarness({
    operation: OPERATIONS.CRON_REMOVE,
    hostFiles: [],
    cronTaskInRegistry: null,
  });
  const result = await recoverRunningCron(h.args);

  assert.equal(result.operation, OPERATIONS.CRON_REMOVE);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.reconciled, true);
});

test('recoverRunningCron rejects if active consumers (API or agent) are running', async () => {
  const h1 = createHarness({ apiActive: true });
  await assert.rejects(
    () => recoverRunningCron(h1.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_consumers_must_be_stopped',
  );

  const h2 = createHarness({ agentActive: true });
  await assert.rejects(
    () => recoverRunningCron(h2.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_consumers_must_be_stopped',
  );
});

test('recoverRunningCron fails closed if receipt is missing', async () => {
  const h = createHarness({ hasReceipt: false });
  await assert.rejects(
    () => recoverRunningCron(h.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_receipt_missing',
  );
});

test('recoverRunningCron fails closed if host state drifts for CRON_APPLY', async () => {
  // Host file missing
  const h1 = createHarness({ operation: OPERATIONS.CRON_APPLY, hostFiles: [] });
  await assert.rejects(
    () => recoverRunningCron(h1.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_host_state_mismatch',
  );

  // Host file checksum drifted
  const h2 = createHarness({
    operation: OPERATIONS.CRON_APPLY,
    hostFiles: [{ taskId, contentSha256: 'f'.repeat(64) }],
  });
  await assert.rejects(
    () => recoverRunningCron(h2.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_host_state_mismatch',
  );
});

test('recoverRunningCron fails closed if host file remains present for CRON_REMOVE', async () => {
  const h = createHarness({
    operation: OPERATIONS.CRON_REMOVE,
    hostFiles: [{ taskId, contentSha256 }],
    cronTaskInRegistry: null,
  });
  await assert.rejects(
    () => recoverRunningCron(h.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_host_state_mismatch',
  );
});

test('recoverRunningCron fails closed if registry state is inconsistent', async () => {
  // CRON_APPLY but task missing from registry
  const h1 = createHarness({ operation: OPERATIONS.CRON_APPLY, cronTaskInRegistry: null });
  await assert.rejects(
    () => recoverRunningCron(h1.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_registry_mismatch',
  );

  // CRON_REMOVE but task still present in registry
  const h2 = createHarness({
    operation: OPERATIONS.CRON_REMOVE,
    hostFiles: [],
    cronTaskInRegistry: { id: taskId, websiteId },
  });
  await assert.rejects(
    () => recoverRunningCron(h2.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_registry_mismatch',
  );
});

test('recoverRunningCron validates dependencies and identities fail-closed', async () => {
  await assert.rejects(
    () => recoverRunningCron({}),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_identity_invalid',
  );

  await assert.rejects(
    () => recoverRunningCron({ serverId, jobId, jobRegistry: null }),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_dependencies_invalid',
  );
});

async function setupRealCronStores(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-cron-recovery-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const cronDir = path.join(dir, 'cron.d');
  const receiptRoot = path.join(dir, 'receipts');
  await mkdir(cronDir, { recursive: true, mode: 0o755 });

  const env = {
    YUNPANEL_SERVER_STORE: path.join(dir, 'server-registry.json'),
    YUNPANEL_APPLICATION_STORE: path.join(dir, 'application-registry.json'),
    YUNPANEL_WEBSITE_STORE: path.join(dir, 'website-registry.json'),
    YUNPANEL_WEBSITE_CRON_STORE: path.join(dir, 'website-cron-registry.json'),
    YUNPANEL_JOB_STORE: path.join(dir, 'job-registry.json'),
  };

  const hostname = 'cron-recovery.example.test';
  const serverRegistry = createServerRegistry({ filePath: env.YUNPANEL_SERVER_STORE });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname });

  const serverExists = async (id) => Boolean(await serverRegistry.getServer(id));
  const applicationRegistry = createApplicationRegistry({
    filePath: env.YUNPANEL_APPLICATION_STORE,
    serverExists,
  });
  await applicationRegistry.init();
  const application = await applicationRegistry.createApplication({
    serverId: server.id,
    name: 'Cron Site App',
    repositoryUrl: null,
    branch: null,
    build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
  });

  const websiteRegistry = createWebsiteRegistry({
    filePath: env.YUNPANEL_WEBSITE_STORE,
    serverExists,
    getApplication: (id) => applicationRegistry.getApplication(id),
  });
  await websiteRegistry.init();
  const website = await websiteRegistry.createWebsite({
    serverId: server.id,
    name: 'Cron Site',
    applicationId: application.id,
  });

  const websiteCronRegistry = createWebsiteCronRegistry({
    filePath: env.YUNPANEL_WEBSITE_CRON_STORE,
    getWebsite: (id) => websiteRegistry.getWebsite(id),
  });
  await websiteCronRegistry.init();
  const task = await websiteCronRegistry.createTask({
    websiteId: website.id,
    name: 'Nightly report',
    schedule: '0 3 * * *',
    command: '/usr/bin/true',
    enabled: true,
  });

  const durableJobs = createDurableJobRegistry({
    filePath: env.YUNPANEL_JOB_STORE,
    registryFactory: createJobRegistry,
  });
  await durableJobs.init();

  const receiptStore = createWebsiteCronOperationReceiptStore({ root: receiptRoot });

  const websiteCronManagerFactory = () => createWebsiteCronManager({
    readdirFn: (_target, options) => readdir(cronDir, options),
    lstatFn: async (targetPath) => {
      const info = await lstat(path.join(cronDir, path.basename(targetPath)));
      return {
        isFile: () => info.isFile(),
        isSymbolicLink: () => info.isSymbolicLink(),
        uid: 0,
        gid: 0,
        mode: info.mode,
        size: info.size,
      };
    },
    readFileFn: (targetPath) => readFile(path.join(cronDir, path.basename(targetPath))),
    run: async () => ({ stdout: 'active\n' }),
  });

  return {
    dir,
    cronDir,
    receiptRoot,
    env,
    hostname,
    server,
    application,
    website,
    task,
    websiteCronRegistry,
    durableJobs,
    receiptStore,
    websiteCronManagerFactory,
  };
}

test('runRunningCronRecoveryFromStores recovers running CRON_APPLY and CRON_REMOVE jobs from real disk stores', async (t) => {
  const fx = await setupRealCronStores(t);
  const rendered = renderCronTaskFile({
    taskId: fx.task.id,
    user: fx.task.unixUser,
    schedule: fx.task.schedule,
    command: fx.task.command,
    enabled: fx.task.enabled,
  });
  const digest = createHash('sha256').update(rendered).digest('hex');
  const hostFilePath = path.join(fx.cronDir, cronTaskFileName(fx.task.id));
  await writeFile(hostFilePath, rendered, { encoding: 'utf8', mode: 0o644 });
  await chmod(hostFilePath, 0o644);

  // 1. Enqueue and claim a real CRON_APPLY job so it is durably left in running state.
  const actorAuth = {
    authorizationMode: 'user',
    actorSessionId: '55555555-5555-4555-8555-555555555555',
    actorUserId: '66666666-6666-4666-8666-666666666666',
    actorRole: 'owner',
  };
  const applyJob = await fx.durableJobs.enqueue({
    serverId: fx.server.id,
    type: OPERATIONS.CRON_APPLY,
    operation: OPERATIONS.CRON_APPLY,
    payload: {
      taskId: fx.task.id,
      websiteId: fx.website.id,
      applicationId: fx.application.id,
      unixUser: fx.task.unixUser,
      expectedRevision: fx.task.revision,
      desiredStateSha256: digest,
      ...actorAuth,
    },
    resourceType: 'website_cron',
    resourceId: fx.task.id,
    idempotencyKey: `cron.apply:${fx.task.id}:${fx.task.revision}:${digest}`,
  });
  const claimedApply = await fx.durableJobs.claimNext(fx.server.id);
  assert.equal(claimedApply.job.id, applyJob.id);

  await fx.receiptStore.write({
    serverId: fx.server.id,
    jobId: applyJob.id,
    operation: OPERATIONS.CRON_APPLY,
    result: {
      version: 1,
      taskId: fx.task.id,
      websiteId: fx.website.id,
      applicationId: fx.application.id,
      unixUser: fx.task.unixUser,
      revision: fx.task.revision,
      desiredStateSha256: digest,
      contentSha256: digest,
      applied: true,
      sideEffects: true,
    },
  });

  const applyResult = await runRunningCronRecoveryFromStores({
    serverId: fx.server.id,
    jobId: applyJob.id,
    hostname: fx.hostname,
    env: fx.env,
    cwd: fx.dir,
    websiteCronManagerFactory: fx.websiteCronManagerFactory,
    receiptStoreFactory: () => createWebsiteCronOperationReceiptStore({ root: fx.receiptRoot }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
  });
  assert.equal(applyResult.status, 'succeeded');
  assert.equal(applyResult.operation, OPERATIONS.CRON_APPLY);
  assert.equal(applyResult.recoveryMethod, 'verified_cron_receipt_and_host_state');
  assert.equal(applyResult.reconciled, true);
  assert.equal(applyResult.statePaths.websiteCronStore, fx.env.YUNPANEL_WEBSITE_CRON_STORE);

  const reopenedAfterApply = createDurableJobRegistry({
    filePath: fx.env.YUNPANEL_JOB_STORE,
    registryFactory: createJobRegistry,
  });
  await reopenedAfterApply.init();
  assert.equal((await reopenedAfterApply.getJob(applyJob.id)).status, 'succeeded');
  assert.equal((await inspectDurableJobRecovery({ registry: reopenedAfterApply })).state, 'clear');

  // 2. Enqueue and claim a real CRON_REMOVE job, remove host file + registry task, write receipt, and recover.
  const removeJob = await reopenedAfterApply.enqueue({
    serverId: fx.server.id,
    type: OPERATIONS.CRON_REMOVE,
    operation: OPERATIONS.CRON_REMOVE,
    payload: {
      taskId: fx.task.id,
      websiteId: fx.website.id,
      applicationId: fx.application.id,
      unixUser: fx.task.unixUser,
      expectedRevision: fx.task.revision,
      desiredStateSha256: digest,
      ...actorAuth,
    },
    resourceType: 'website_cron',
    resourceId: fx.task.id,
    idempotencyKey: `cron.remove:${fx.task.id}:${fx.task.revision}`,
  });
  const claimedRemove = await reopenedAfterApply.claimNext(fx.server.id);
  assert.equal(claimedRemove.job.id, removeJob.id);

  await rm(hostFilePath, { force: true });
  await fx.websiteCronRegistry.deleteTask(fx.task.id, { expectedRevision: fx.task.revision });
  await fx.receiptStore.write({
    serverId: fx.server.id,
    jobId: removeJob.id,
    operation: OPERATIONS.CRON_REMOVE,
    result: {
      version: 1,
      taskId: fx.task.id,
      websiteId: fx.website.id,
      applicationId: fx.application.id,
      unixUser: fx.task.unixUser,
      revision: fx.task.revision,
      desiredStateSha256: digest,
      contentSha256: null,
      removed: true,
      sideEffects: false,
    },
  });

  const removeResult = await runRunningCronRecoveryFromStores({
    serverId: fx.server.id,
    jobId: removeJob.id,
    hostname: fx.hostname,
    env: fx.env,
    cwd: fx.dir,
    websiteCronManagerFactory: fx.websiteCronManagerFactory,
    receiptStoreFactory: () => createWebsiteCronOperationReceiptStore({ root: fx.receiptRoot }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
  });
  assert.equal(removeResult.status, 'succeeded');
  assert.equal(removeResult.operation, OPERATIONS.CRON_REMOVE);
  assert.equal(removeResult.reconciled, true);

  const reopenedAfterRemove = createDurableJobRegistry({
    filePath: fx.env.YUNPANEL_JOB_STORE,
    registryFactory: createJobRegistry,
  });
  await reopenedAfterRemove.init();
  assert.equal((await reopenedAfterRemove.getJob(removeJob.id)).status, 'succeeded');
  assert.equal((await inspectDurableJobRecovery({ registry: reopenedAfterRemove })).state, 'clear');
});

test('runRunningCronRecoveryFromStores fails closed when manager or receipt store is invalid', async (t) => {
  const fx = await setupRealCronStores(t);
  await assert.rejects(
    () => runRunningCronRecoveryFromStores({
      serverId: fx.server.id,
      jobId,
      hostname: fx.hostname,
      env: fx.env,
      cwd: fx.dir,
      websiteCronManagerFactory: () => ({}),
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    }),
    (err) => err instanceof JobRecoveryRuntimeError && err.code === 'job_recovery_cron_manager_invalid',
  );

  await assert.rejects(
    () => runRunningCronRecoveryFromStores({
      serverId: fx.server.id,
      jobId,
      hostname: fx.hostname,
      env: fx.env,
      cwd: fx.dir,
      websiteCronManagerFactory: fx.websiteCronManagerFactory,
      receiptStoreFactory: () => ({}),
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    }),
    (err) => err instanceof JobRecoveryRuntimeError && err.code === 'job_recovery_cron_receipt_invalid',
  );
});

test('job-recovery CLI parses and dispatches recover-cron only in packaged root confirmed mode', async () => {
  assert.deepEqual(parseJobRecoveryArguments(['recover-cron', serverId, jobId, '--confirm']), {
    action: 'recover-cron',
    serverId,
    jobId,
    confirm: true,
  });
  assert.throws(() => parseJobRecoveryArguments(['recover-cron', serverId, jobId]), /recover-cron/);

  await assert.rejects(
    () => runJobRecoveryCli({
      argv: ['recover-cron', serverId, jobId, '--confirm'],
      filePath: '/tmp/scripts/job-recovery.mjs',
      uid: 0,
      env: {},
      cwd: '/tmp',
      recoveryAudit: null,
      stdout: { write() {} },
    }),
    /packaged YunPanel installation/,
  );

  await assert.rejects(
    () => runJobRecoveryCli({
      argv: ['recover-cron', serverId, jobId, '--confirm'],
      filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
      uid: 1000,
      env: {},
      cwd: '/tmp',
      recoveryAudit: null,
      stdout: { write() {} },
    }),
    /must be run as root/,
  );

  const writes = [];
  let dispatched = null;
  const result = await runJobRecoveryCli({
    argv: ['recover-cron', serverId, jobId, '--confirm'],
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    env: {},
    cwd: '/tmp',
    recoverCron: async (input) => {
      dispatched = input;
      return {
        serverId: input.serverId,
        jobId: input.jobId,
        status: 'succeeded',
        operation: OPERATIONS.CRON_APPLY,
        recoveryMethod: 'verified_cron_receipt_and_host_state',
        reconciled: true,
        statePaths: {
          jobStore: '/var/lib/yunpanel/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/job-registry.json.recovery.json',
        },
      };
    },
    recoveryAudit: null,
    stdout: { write: (line) => writes.push(line) },
  });

  assert.deepEqual(dispatched, {
    serverId,
    jobId,
    env: {},
    packaged: true,
    cwd: '/tmp',
  });
  assert.equal(result.operation, OPERATIONS.CRON_APPLY);
  assert.match(writes.join(''), /operation=cron\.apply/);
  assert.match(writes.join(''), /method=verified_cron_receipt_and_host_state/);
});
