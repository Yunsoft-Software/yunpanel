import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createApplicationRuntimeBindingRegistry } from '../src/application-runtime-binding-registry.js';
import { createAuditedJobRegistry } from '../src/audited-job-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDurableJobRegistry, DurableJobRegistryError } from '../src/durable-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';
import { startLocalRuntime } from '../src/local-runtime.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

async function createRealRuntimeHarness(t, {
  onBeforeReconcile = null,
  reconcileOverride = null,
  liveReconciliationWindowMs = undefined,
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t899-live-queue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const stagingDir = path.join(dir, 'nginx-staging');
  const sitesDir = path.join(dir, 'nginx-sites');
  const webRootBase = path.join(dir, 'www');
  await mkdir(stagingDir, { recursive: true });
  await mkdir(sitesDir, { recursive: true });
  await mkdir(webRootBase, { recursive: true });

  const authStore = createAuthStore({ filePath: path.join(dir, 'auth.sqlite') });
  t.after(() => authStore.close());
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

  const domainRegistry = createDomainRegistry({
    filePath: path.join(dir, 'domains.json'),
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

  const jobFilePath = path.join(dir, 'job-registry.json');
  const durableJobRegistry = createDurableJobRegistry({
    filePath: jobFilePath,
    registryFactory: createJobRegistry,
    automaticReconciliation: true,
    ...(liveReconciliationWindowMs === undefined ? {} : { liveReconciliationWindowMs }),
  });
  await durableJobRegistry.init();
  const jobRegistry = createAuditedJobRegistry({
    registry: durableJobRegistry,
    audit: authStore.audit,
  });

  const nginxManager = createNginxManager({ stagingDir, sitesDir });
  const hostOperations = {
    operations: [OPERATIONS.DOMAIN_STAGE, OPERATIONS.SYSTEM_PACKAGES_INSPECT],
    supports: (operation) => operation === OPERATIONS.DOMAIN_STAGE || operation === OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    executeOperation: async (operation, payload) => {
      if (operation === OPERATIONS.DOMAIN_STAGE) return nginxManager.stageDomain(payload);
      return {
        packageName: 'yunpanel',
        installed: true,
        installedVersion: '0.3.0-2026111001',
        candidateVersion: '0.3.0-2026111001',
        updateAvailable: false,
      };
    },
  };

  const faults = [];
  const runtime = await startLocalRuntime({
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
      if (reconcileOverride) return reconcileOverride(context);
      return reconcileCompletedJob(context);
    },
    onError: (err) => { faults.push(err); },
    snapshotIntervalMs: 60_000,
  });
  t.after(async () => { await runtime.stop(); });

  const origin = 'http://127.0.0.1:5173';
  const server = http.createServer(createAuthenticatedApi({
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
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

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
    jobFilePath,
    recoveryFilePath: `${jobFilePath}.recovery.json`,
    localServer,
    domainRegistry,
    durableJobRegistry,
    jobRegistry,
    runtime,
    faults,
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

  const domainAlpha = await harness.createStaticDomainOverHttp('alpha');
  const domainBeta = await harness.createStaticDomainOverHttp('beta');
  const domainGamma = await harness.createStaticDomainOverHttp('gamma');

  const first = await harness.stageDomainOverHttp(domainAlpha.id);
  assert.equal(first.status, 202);
  const firstJobId = first.body.data.id;

  // Wait until Job 1 has completed host execution, opened beginReconciliation,
  // persisted terminal state, and entered reconcileCompletedJob.
  await enteredReconcile;

  // Fire two concurrent normal HTTP enqueue requests on independent domains during the exact
  // reconciliation window, releasing Job 1's reconciliation right after both requests arrive.
  const releaseSoon = new Promise((resolve) => setTimeout(resolve, 25)).then(() => {
    allowReconcileFinishResolve();
  });
  const [second, third] = await Promise.all([
    harness.stageDomainOverHttp(domainBeta.id),
    harness.stageDomainOverHttp(domainGamma.id),
    releaseSoon,
  ]);

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

  // Wait for the final job's reconciliation acknowledgement to settle on disk.
  const ackDeadline = Date.now() + 2_000;
  while (harness.durableJobRegistry.recovery() !== null && Date.now() < ackDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
});

test('reconciliation fault immediately aborts any waiting enqueue and preserves the fail-closed 503 recovery gate', async (t) => {
  let enteredReconcileResolve;
  const enteredReconcile = new Promise((resolve) => { enteredReconcileResolve = resolve; });
  let failReconcileResolve;
  const failReconcile = new Promise((resolve) => { failReconcileResolve = resolve; });

  const harness = await createRealRuntimeHarness(t, {
    reconcileOverride: async () => {
      enteredReconcileResolve();
      await failReconcile;
      return { reconciled: false, error: { code: 'local_reconciliation_failed' } };
    },
  });

  const domainAlpha = await harness.createStaticDomainOverHttp('fault-alpha');
  const domainBeta = await harness.createStaticDomainOverHttp('fault-beta');
  const domainGamma = await harness.createStaticDomainOverHttp('fault-gamma');

  const first = await harness.stageDomainOverHttp(domainAlpha.id);
  assert.equal(first.status, 202);
  await enteredReconcile;

  const triggerFailure = new Promise((resolve) => setTimeout(resolve, 25)).then(() => {
    failReconcileResolve();
  });
  const [concurrent] = await Promise.all([
    harness.stageDomainOverHttp(domainBeta.id),
    triggerFailure,
  ]);

  assert.equal(concurrent.status, 503);
  assert.equal(concurrent.body?.error?.code, 'durable_job_reconciliation_required');
  assert.equal(harness.faults.length, 1);
  assert.equal(harness.faults[0]?.code, 'local_reconciliation_failed');

  const subsequent = await harness.stageDomainOverHttp(domainGamma.id);
  assert.equal(subsequent.status, 503);
  assert.equal(subsequent.body?.error?.code, 'durable_job_reconciliation_required');

  const recoveryDisk = JSON.parse(await readFile(harness.recoveryFilePath, 'utf8'));
  assert.deepEqual(recoveryDisk.jobs, [{ jobId: first.body.data.id, serverId: harness.localServer.id }]);
});

test('stalled live reconciliation past the bounded window fails closed with durable_job_reconciliation_required', async (t) => {
  let enteredReconcileResolve;
  const enteredReconcile = new Promise((resolve) => { enteredReconcileResolve = resolve; });
  let releaseStalledResolve;
  const releaseStalled = new Promise((resolve) => { releaseStalledResolve = resolve; });

  const harness = await createRealRuntimeHarness(t, {
    liveReconciliationWindowMs: 80,
    onBeforeReconcile: async () => {
      enteredReconcileResolve();
      await releaseStalled;
    },
  });
  t.after(() => releaseStalledResolve());

  const domainAlpha = await harness.createStaticDomainOverHttp('stall-alpha');
  try {
    const first = await harness.stageDomainOverHttp(domainAlpha.id);
    assert.equal(first.status, 202);
    await enteredReconcile;

    await assert.rejects(
      harness.jobRegistry.enqueue({
        serverId: harness.localServer.id,
        type: 'system.packages.inspect',
        operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
        payload: {},
        resourceType: 'system',
        resourceId: harness.localServer.id,
      }),
      (err) => err instanceof DurableJobRegistryError && err.code === 'durable_job_reconciliation_required',
    );
  } finally {
    releaseStalledResolve();
  }
});
