import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/http/app.js';
import { createApplicationRegistry } from '../src/applications/application-registry.js';
import { createApplicationRuntimeBindingRegistry } from '../src/applications/application-runtime-binding-registry.js';
import { createAuditedJobRegistry } from '../src/jobs/audited-job-registry.js';
import { createAuthenticatedApi } from '../src/auth/auth-http.js';
import { createAuthStore } from '../src/auth/auth-store.js';
import { createCertificateRegistry } from '../src/certificates/certificate-registry.js';
import { createDomainRegistry } from '../src/domains/domain-registry.js';
import { createDurableJobRegistry } from '../src/jobs/durable-job-registry.js';
import { createJobRegistry } from '../src/jobs/job-registry.js';
import { reconcileCompletedJob } from '../src/jobs/job-reconciliation.js';
import { startLocalRuntime } from '../src/runtime/local-runtime.js';
import { createProcessStoreLock } from '../src/runtime/process-store-lock.js';
import { createServerRegistry } from '../src/runtime/server-registry.js';
import { createWebsiteRegistry } from '../src/websites/website-registry.js';

async function createRealRuntimeHarness(t, {
  onBeforeReconcile = null,
  liveReconciliationWindowMs = undefined,
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t899-live-queue-'));
  const gateReleases = [];
  function registerGateRelease(fn) {
    gateReleases.push(fn);
  }

  let authStore = null;
  let runtime = null;
  let server = null;

  // Register ONE ordered teardown hook so server, runtime executor, and SQLite FDs
  // always close completely before the temporary directory is removed.
  t.after(async () => {
    for (const release of gateReleases) {
      try { release(); } catch {}
    }
    if (server) {
      await new Promise((resolve) => {
        try { server.closeAllConnections(); } catch {}
        server.close(() => resolve());
      });
    }
    if (runtime) {
      await runtime.stop().catch(() => {});
    }
    if (authStore) {
      try { authStore.close(); } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  });

  const stagingDir = path.join(dir, 'nginx-staging');
  const sitesDir = path.join(dir, 'nginx-sites');
  const webRootBase = path.join(dir, 'www');
  await mkdir(stagingDir, { recursive: true });
  await mkdir(sitesDir, { recursive: true });
  await mkdir(webRootBase, { recursive: true });

  authStore = createAuthStore({ filePath: path.join(dir, 'auth.sqlite') });
  const password = randomBytes(32).toString('base64url');
  await authStore.completeSetup({
    setupToken: authStore.issueSetupToken().token,
    username: 't899-owner',
    password,
  });
  const login = await authStore.login({ username: 't899-owner', password });

  const serverRegistry = createServerRegistry({ filePath: path.join(dir, 'servers.json') });
  await serverRegistry.init();
  const localServer = await serverRegistry.createLocalServer({ hostname: 't899-local.example.internal' });

  const domainsFilePath = path.join(dir, 'domains.json');
  const domainRegistry = createDomainRegistry({
    filePath: domainsFilePath,
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await domainRegistry.init();
  const certificateRegistry = createCertificateRegistry({
    filePath: path.join(dir, 'certificates.json'),
    customRoot: path.join(dir, 'custom-certs'),
  });
  await certificateRegistry.init();
  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(dir, 'applications.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();
  const runtimeBindingRegistry = createApplicationRuntimeBindingRegistry({
    filePath: path.join(dir, 'runtime-bindings.json'),
  });
  await runtimeBindingRegistry.init();
  const websiteRegistry = createWebsiteRegistry({
    filePath: path.join(dir, 'websites.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getApplication: async (id) => applicationRegistry.getApplication(id),
  });
  await websiteRegistry.init();

  let deferredLiveWaitCount = 0;
  const deferredWaiters = [];
  function notifyDeferredLiveWait() {
    deferredLiveWaitCount += 1;
    for (let i = deferredWaiters.length - 1; i >= 0; i -= 1) {
      if (deferredLiveWaitCount >= deferredWaiters[i].target) {
        const [entry] = deferredWaiters.splice(i, 1);
        entry.resolve(deferredLiveWaitCount);
      }
    }
  }
  function waitForDeferredLiveWaiters(targetCount, timeoutMs = 5_000) {
    if (deferredLiveWaitCount >= targetCount) return Promise.resolve(deferredLiveWaitCount);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${targetCount} live reconciliation waiters (observed ${deferredLiveWaitCount})`));
      }, timeoutMs);
      deferredWaiters.push({
        target: targetCount,
        resolve: (count) => {
          clearTimeout(timer);
          resolve(count);
        },
      });
    });
  }

  const jobFilePath = path.join(dir, 'job-registry.json');
  const durableJobRegistry = createDurableJobRegistry({
    filePath: jobFilePath,
    registryFactory: createJobRegistry,
    automaticReconciliation: true,
    storeLockFactory: (lockOptions) => {
      const realLock = createProcessStoreLock(lockOptions);
      return {
        withLock: (fn) => realLock.withLock(async () => {
          const outcome = await fn();
          if (
            outcome
            && typeof outcome === 'object'
            && Reflect.ownKeys(outcome).some((key) => typeof key === 'symbol' && key.description === 'deferredLiveReconciliation')
          ) {
            notifyDeferredLiveWait();
          }
          return outcome;
        }),
      };
    },
    ...(liveReconciliationWindowMs === undefined ? {} : { liveReconciliationWindowMs }),
  });
  await durableJobRegistry.init();
  const jobRegistry = createAuditedJobRegistry({
    registry: durableJobRegistry,
    audit: authStore.audit,
  });

  const nginxManager = createNginxManager({ stagingDir, sitesDir });
  const hostOperations = {
    operations: [OPERATIONS.DOMAIN_STAGE],
    supports: (operation) => operation === OPERATIONS.DOMAIN_STAGE,
    executeOperation: async (operation, payload) => {
      if (operation === OPERATIONS.DOMAIN_STAGE) return nginxManager.stageDomain(payload);
      throw new Error(`Unsupported operation in harness: ${operation}`);
    },
  };

  const faults = [];
  runtime = await startLocalRuntime({
    serverId: localServer.id,
    hostname: localServer.hostname,
    runtimeVersion: '0.3.0-2026111001',
    lockPath: path.join(dir, 'local-executor.lock'),
    registry: serverRegistry,
    jobRegistry,
    domainRegistry,
    certificateRegistry,
    applicationRegistry,
    websiteRegistry,
    runtimeBindingRegistry,
    hostOperations,
    reconcile: async (context) => {
      if (onBeforeReconcile) await onBeforeReconcile(context);
      return reconcileCompletedJob(context);
    },
    onError: (err) => { faults.push(err); },
    snapshotIntervalMs: 60_000,
  });

  const origin = 'http://127.0.0.1:5173';
  server = http.createServer(createAuthenticatedApi({
    store: authStore,
    publicOrigin: origin,
    development: true,
    createHandler: () => createApp({
      registry: serverRegistry,
      domainRegistry,
      jobRegistry,
      durableJobRegistry,
      certificateRegistry,
      applicationRegistry,
      runtimeBindingRegistry,
      websiteRegistry,
      environment: 'development',
    }),
  })).listen(0, '127.0.0.1');
  await once(server, 'listening');

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    cookie: `yunpanel_session=${login.token}`,
    origin,
    'x-csrf-token': login.session.csrfToken,
    'content-type': 'application/json',
    connection: 'close',
  };

  async function createStaticDomainOverHttp(slug) {
    const docRoot = `/var/lib/yunpanel/apps/${slug}/current`;
    const response = await fetch(`${baseUrl}/api/domains`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serverId: localServer.id,
        primaryDomain: `${slug}.t899.example.test`,
        aliases: [],
        targetType: 'static',
        target: { root: docRoot, spaFallback: false },
        httpsMode: 'off',
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, `expected 201 creating domain ${slug}, got ${response.status}: ${JSON.stringify(body)}`);
    return body.data;
  }

  async function stageDomainOverHttp(domainId) {
    const response = await fetch(`${baseUrl}/api/domains/${domainId}/stage`, {
      method: 'POST',
      headers,
    });
    const body = await response.json();
    return { status: response.status, body };
  }

  return {
    dir,
    stagingDir,
    domainsFilePath,
    jobFilePath,
    recoveryFilePath: `${jobFilePath}.recovery.json`,
    localServer,
    domainRegistry,
    durableJobRegistry,
    jobRegistry,
    runtime,
    faults,
    registerGateRelease,
    waitForDeferredLiveWaiters,
    deferredLiveWaitCount: () => deferredLiveWaitCount,
    createStaticDomainOverHttp,
    stageDomainOverHttp,
  };
}

async function waitForTerminalJob(jobRegistry, jobId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await jobRegistry.getJob(jobId);
    if (job && (job.status === 'succeeded' || job.status === 'failed')) return job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach terminal state`);
}

async function waitForRecoveryCleared(durableJobRegistry, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (durableJobRegistry.recovery() !== null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('concurrent normal HTTP job enqueues during an active in-flight reconciliation succeed without transient 503', async (t) => {
  let enteredReconcileResolve;
  const enteredReconcile = new Promise((resolve) => { enteredReconcileResolve = resolve; });
  let allowReconcileFinishResolve;
  const allowReconcileFinish = new Promise((resolve) => { allowReconcileFinishResolve = resolve; });
  let hookedFirst = false;

  const harness = await createRealRuntimeHarness(t, {
    onBeforeReconcile: async () => {
      if (hookedFirst) return;
      hookedFirst = true;
      enteredReconcileResolve();
      await allowReconcileFinish;
    },
  });
  harness.registerGateRelease(() => allowReconcileFinishResolve());

  const domainAlpha = await harness.createStaticDomainOverHttp('alpha');
  const domainBeta = await harness.createStaticDomainOverHttp('beta');
  const domainGamma = await harness.createStaticDomainOverHttp('gamma');

  try {
    const first = await harness.stageDomainOverHttp(domainAlpha.id);
    assert.equal(first.status, 202);
    const firstJobId = first.body.data.id;

    await enteredReconcile;

    const secondPromise = harness.stageDomainOverHttp(domainBeta.id);
    const thirdPromise = harness.stageDomainOverHttp(domainGamma.id);

    // Deterministically prove both HTTP requests entered the live reconciliation wait branch
    // before Job 1's real reconcileCompletedJob is allowed to proceed.
    const waiterCount = await harness.waitForDeferredLiveWaiters(2);
    assert.equal(waiterCount >= 2, true);
    allowReconcileFinishResolve();

    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    assert.equal(second.status, 202, `expected 202 for second job, got ${second.status}: ${JSON.stringify(second.body)}`);
    assert.equal(third.status, 202, `expected 202 for third job, got ${third.status}: ${JSON.stringify(third.body)}`);
    assert.notEqual(second.body.data.id, firstJobId);
    assert.notEqual(third.body.data.id, firstJobId);
    assert.notEqual(second.body.data.id, third.body.data.id);

    const [job1, job2, job3] = await Promise.all([
      waitForTerminalJob(harness.jobRegistry, firstJobId),
      waitForTerminalJob(harness.jobRegistry, second.body.data.id),
      waitForTerminalJob(harness.jobRegistry, third.body.data.id),
    ]);
    assert.equal(job1.status, 'succeeded');
    assert.equal(job2.status, 'succeeded');
    assert.equal(job3.status, 'succeeded');

    await waitForRecoveryCleared(harness.durableJobRegistry);
    assert.equal(harness.durableJobRegistry.recovery(), null);
    assert.equal(harness.faults.length, 0);

    for (const created of [domainAlpha, domainBeta, domainGamma]) {
      const updated = await harness.domainRegistry.getDomain(created.id);
      assert.equal(updated.stagedRevision, 1);
      assert.match(updated.stagedChecksum, /^[0-9a-f]{64}$/);
      const stagedStat = await stat(path.join(harness.stagingDir, `yunpanel-${created.primaryDomain}.conf`));
      assert.equal(stagedStat.isFile(), true);
    }

    const recoveryDisk = JSON.parse(await readFile(harness.recoveryFilePath, 'utf8'));
    assert.deepEqual(recoveryDisk.jobs, []);
  } finally {
    allowReconcileFinishResolve();
  }
});

test('reconciliation fault immediately aborts any waiting enqueue and preserves the fail-closed 503 recovery gate', async (t) => {
  let enteredReconcileResolve;
  const enteredReconcile = new Promise((resolve) => { enteredReconcileResolve = resolve; });
  let proceedWithDiskFaultResolve;
  const proceedWithDiskFault = new Promise((resolve) => { proceedWithDiskFaultResolve = resolve; });
  let savedDomainsJson = null;

  const harness = await createRealRuntimeHarness(t, {
    onBeforeReconcile: async () => {
      enteredReconcileResolve();
      await proceedWithDiskFault;
    },
  });
  harness.registerGateRelease(() => proceedWithDiskFaultResolve());

  const domainAlpha = await harness.createStaticDomainOverHttp('fault-alpha');
  const domainBeta = await harness.createStaticDomainOverHttp('fault-beta');
  const domainGamma = await harness.createStaticDomainOverHttp('fault-gamma');

  try {
    const first = await harness.stageDomainOverHttp(domainAlpha.id);
    assert.equal(first.status, 202);
    await enteredReconcile;

    const concurrentPromise = harness.stageDomainOverHttp(domainBeta.id);
    await harness.waitForDeferredLiveWaiters(1);

    // Induce a real OS filesystem error (EISDIR) on domains.json right before
    // real reconcileCompletedJob -> domainRegistry.markStaged persists state.
    savedDomainsJson = await readFile(harness.domainsFilePath, 'utf8');
    await rm(harness.domainsFilePath, { force: true });
    await mkdir(harness.domainsFilePath);
    proceedWithDiskFaultResolve();

    const concurrent = await concurrentPromise;
    assert.equal(concurrent.status, 503);
    assert.equal(concurrent.body?.error?.code, 'durable_job_reconciliation_required');
    assert.equal(harness.faults.length, 1);
    assert.equal(harness.faults[0]?.code, 'local_reconciliation_failed');

    // Restore domains.json so domain lookup succeeds, proving the subsequent 503 comes
    // strictly from the unacknowledged durable recovery record on disk.
    await rm(harness.domainsFilePath, { recursive: true, force: true });
    await writeFile(harness.domainsFilePath, savedDomainsJson, { mode: 0o600 });
    savedDomainsJson = null;

    const subsequent = await harness.stageDomainOverHttp(domainGamma.id);
    assert.equal(subsequent.status, 503);
    assert.equal(subsequent.body?.error?.code, 'durable_job_reconciliation_required');

    const recoveryDisk = JSON.parse(await readFile(harness.recoveryFilePath, 'utf8'));
    assert.deepEqual(recoveryDisk.jobs, [{ jobId: first.body.data.id, serverId: harness.localServer.id }]);
  } finally {
    proceedWithDiskFaultResolve();
    if (savedDomainsJson !== null) {
      await rm(harness.domainsFilePath, { recursive: true, force: true }).catch(() => {});
      await writeFile(harness.domainsFilePath, savedDomainsJson, { mode: 0o600 }).catch(() => {});
    }
  }
});

test('stalled live reconciliation past the bounded window fails closed with durable_job_reconciliation_required', async (t) => {
  let enteredReconcileResolve;
  const enteredReconcile = new Promise((resolve) => { enteredReconcileResolve = resolve; });
  let releaseStalledResolve;
  const releaseStalled = new Promise((resolve) => { releaseStalledResolve = resolve; });
  let hookedFirst = false;
  let reconcileEnteredAt = null;
  const liveWindowMs = 80;

  const harness = await createRealRuntimeHarness(t, {
    liveReconciliationWindowMs: liveWindowMs,
    onBeforeReconcile: async () => {
      if (hookedFirst) return;
      hookedFirst = true;
      reconcileEnteredAt = performance.now();
      enteredReconcileResolve();
      await releaseStalled;
    },
  });
  harness.registerGateRelease(() => releaseStalledResolve());

  const domainAlpha = await harness.createStaticDomainOverHttp('stall-alpha');
  const domainBeta = await harness.createStaticDomainOverHttp('stall-beta');
  const betaBefore = await harness.domainRegistry.getDomain(domainBeta.id);
  let firstJobId;
  try {
    const first = await harness.stageDomainOverHttp(domainAlpha.id);
    assert.equal(first.status, 202);
    firstJobId = first.body.data.id;
    await enteredReconcile;

    // The live timer was registered before the real executor reached this hook.
    // Wait for that unchanged real 80ms window to expire, rather than requiring
    // an HTTP request to win an 80ms disk/scheduler race under suite load.
    const expiredBy = reconcileEnteredAt + liveWindowMs;
    while (performance.now() < expiredBy) {
      await new Promise(resolve => setTimeout(resolve, Math.ceil(expiredBy - performance.now())));
    }
    assert.equal(performance.now() - reconcileEnteredAt >= liveWindowMs, true);
    const expectedRecovery = [{ jobId: firstJobId, serverId: harness.localServer.id }];
    assert.deepEqual(harness.durableJobRegistry.recovery(), {
      code: 'durable_job_reconciliation_required', jobs: expectedRecovery,
    });
    assert.deepEqual(JSON.parse(await readFile(harness.recoveryFilePath, 'utf8')).jobs, expectedRecovery);

    const stalledResponse = await harness.stageDomainOverHttp(domainBeta.id);
    assert.equal(stalledResponse.status, 503);
    assert.equal(stalledResponse.body?.error?.code, 'durable_job_reconciliation_required');
    assert.deepEqual(harness.durableJobRegistry.recovery(), {
      code: 'durable_job_reconciliation_required', jobs: expectedRecovery,
    });
    assert.deepEqual(JSON.parse(await readFile(harness.recoveryFilePath, 'utf8')).jobs, expectedRecovery);
    assert.deepEqual((await harness.jobRegistry.listJobs()).map(job => job.id), [firstJobId]);
    const persistedJobs = JSON.parse(await readFile(harness.jobFilePath, 'utf8')).jobs;
    assert.deepEqual(persistedJobs.map(job => [job.id, job.serverId, job.resourceId]), [[firstJobId, harness.localServer.id, domainAlpha.id]]);
    assert.deepEqual(await harness.jobRegistry.listJobs({ resourceType: 'domain', resourceId: domainBeta.id }), []);
    assert.equal((await harness.domainRegistry.getDomain(domainBeta.id)).stagedRevision, betaBefore.stagedRevision);
    t.diagnostic(JSON.stringify({ phase: 'actual-expired-window', httpStatus: stalledResponse.status,
      errorCode: stalledResponse.body.error.code, deferredWaiters: harness.deferredLiveWaitCount(),
      exactRecoveryIdentityPreserved: true, betaEnqueueAbsent: true }));
    assert.equal(harness.deferredLiveWaitCount(), 0, 'An expired live window must fail closed without registering another live waiter');
  } finally {
    releaseStalledResolve();
    await waitForRecoveryCleared(harness.durableJobRegistry);
  }
  assert.equal(harness.durableJobRegistry.recovery(), null);
  assert.deepEqual(JSON.parse(await readFile(harness.recoveryFilePath, 'utf8')).jobs, []);
  assert.equal(harness.faults.length, 0);
  const firstJob = await harness.jobRegistry.getJob(firstJobId);
  assert.equal(firstJob.status, 'succeeded'); assert.equal(firstJob.resourceId, domainAlpha.id);
  assert.equal(firstJob.serverId, harness.localServer.id); assert.equal(firstJob.operation, OPERATIONS.DOMAIN_STAGE);
  const alpha = await harness.domainRegistry.getDomain(domainAlpha.id);
  assert.equal(alpha.stagedRevision, domainAlpha.desiredRevision);
  const stagedFile = path.join(harness.stagingDir, `yunpanel-${domainAlpha.primaryDomain}.conf`);
  assert.equal((await stat(stagedFile)).isFile(), true);
  const checksum = createHash('sha256').update(await readFile(stagedFile)).digest('hex');
  assert.equal(alpha.stagedChecksum, checksum); assert.equal(firstJob.result.checksum, checksum);
  assert.equal((await harness.domainRegistry.getDomain(domainBeta.id)).stagedRevision, betaBefore.stagedRevision);
  await assert.rejects(stat(path.join(harness.stagingDir, `yunpanel-${domainBeta.primaryDomain}.conf`)), { code: 'ENOENT' });
});
