import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import express from 'express';
import {
  createTtydSessionManager,
  TtydSessionError,
  ttydSessionInternals,
} from '../src/terminal/ttyd-session-manager.js';
import { createAuthenticatedApi } from '../src/auth/auth-http.js';
import { createAuthStore } from '../src/auth/auth-store.js';
import { createServerRegistry } from '../src/runtime/server-registry.js';
import { createApplicationRegistry } from '../src/applications/application-registry.js';
import { createApplicationEnvironmentRegistry } from '../src/applications/application-environment-registry.js';
import { createWebsiteRegistry } from '../src/websites/website-registry.js';
import { createDomainRegistry } from '../src/domains/domain-registry.js';
import { createCertificateRegistry } from '../src/certificates/certificate-registry.js';
import { createDnsHostingRegistry } from '../src/dns/dns-hosting-registry.js';
import { createMailDomainRegistry } from '../src/mail/mail-domain-registry.js';
import { createApplicationRuntimeBindingRegistry } from '../src/applications/application-runtime-binding-registry.js';
import { createDurableJobRegistry } from '../src/jobs/durable-job-registry.js';
import { createJobRegistry } from '../src/jobs/job-registry.js';
import { createLiveSessionRegistry } from '../src/auth/live-session-registry.js';
import { createWebsiteProvisioningRuntime } from '../src/provisioning/website-provisioning-runtime.js';
import { createWebsiteRemovalCleanupAdapters } from '../src/websites/website-removal-cleanup-adapters.js';
import { createWebsiteRemovalOperationRegistry } from '../src/websites/website-removal-operation-registry.js';
import { createWebsiteRemovalPreview } from '../src/websites/website-removal-plan.js';
import { previewResourceImpact } from '../src/websites/resource-impact.js';
import { createWebsiteRemovalRuntime } from '../src/websites/website-removal-runtime.js';
import { mountWebsiteRemovalRoutes, WebsiteRemovalHttpError } from '../src/websites/website-removal-http.js';
import { startLocalRuntime } from '../src/runtime/local-runtime.js';
import { createSystemWatchdogService } from '../src/runtime/system-watchdog-service.js';
import * as terminalProcessManager from '../src/terminal/terminal-process-manager.js';

const {
  captureOwnedTerminalIdentity,
  captureTerminalGenerationBoundary,
} = terminalProcessManager;

const ORIGIN = 'https://panel.terminal-defensive.example.test';

async function listen(t, app) {
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setupRemovalHttp(t, { liveSessions }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-terminal-defensive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const serverRegistry = createServerRegistry({ filePath: path.join(dir, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'defensive.example.test' });

  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(dir, 'applications.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();
  const websiteRegistry = createWebsiteRegistry({
    filePath: path.join(dir, 'websites.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getApplication: (id) => applicationRegistry.getApplication(id),
  });
  await websiteRegistry.init();
  const website = await websiteRegistry.createWebsite({
    serverId: server.id,
    name: 'defensive.example.test',
    runtimeType: 'proxy',
  });

  const domainRegistry = createDomainRegistry({
    filePath: path.join(dir, 'domains.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getWebsite: (id) => websiteRegistry.getWebsite(id),
  });
  await domainRegistry.init();

  const authStore = createAuthStore({ filePath: path.join(dir, 'auth.sqlite'), liveSessions });
  t.after(() => authStore.close());
  const password = randomBytes(24).toString('base64url');
  await authStore.completeSetup({
    setupToken: authStore.issueSetupToken().token,
    username: 'admin',
    password,
  });

  const removalRegistry = createWebsiteRemovalOperationRegistry({
    filePath: path.join(dir, 'website-removals.json'),
  });
  await removalRegistry.init();

  const applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
    filePath: path.join(dir, 'application-environments.json'),
    applicationExists: async (id) => Boolean(await applicationRegistry.getApplication(id)),
    masterKey: randomBytes(32).toString('hex'),
  });
  await applicationEnvironmentRegistry.init();

  const websiteProvisioningRuntime = createWebsiteProvisioningRuntime({
    filePath: path.join(dir, 'provisioning.json'),
    isolationMigrationFilePath: path.join(dir, 'isolation-migrations.json'),
  });
  await websiteProvisioningRuntime.init();

  const cleanupAdapters = createWebsiteRemovalCleanupAdapters({
    websiteRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    websiteProvisioningRuntime,
  });

  const jobRegistry = createJobRegistry();
  const certificateRegistry = createCertificateRegistry();
  const dnsHostingRegistry = createDnsHostingRegistry({ filePath: path.join(dir, 'dns-hosting.json') });
  await dnsHostingRegistry.init();
  const mailDomainRegistry = createMailDomainRegistry({ filePath: path.join(dir, 'mail-domains.json') });
  await mailDomainRegistry.init();

  const runtime = createWebsiteRemovalRuntime({
    registry: removalRegistry,
    previewProvider: async ({ websiteId }) => {
      const ws = await websiteRegistry.getWebsite(websiteId);
      const impact = await previewResourceImpact({
        resourceType: 'website',
        resourceId: ws.id,
        operation: 'delete',
        targetServerId: null,
        registry: serverRegistry,
        applicationRegistry,
        websiteRegistry,
        domainRegistry,
        certificateRegistry,
        jobRegistry,
        dnsHostingRegistry,
        mailDomainRegistry,
        additionalProviders: {
          dockerWorkloads: async () => [],
          backups: async () => [],
          webmailMappings: async () => [],
          mailboxes: async () => [],
          crons: async () => [],
          databases: async () => [],
          sftpKeys: async () => [],
          runtimeBindings: async () => [],
          unixIdentities: async () => [],
          logScopes: async () => [],
        },
      });
      const applicationState = ws.applicationId
        ? await applicationRegistry.getApplication(ws.applicationId)
        : null;
      return createWebsiteRemovalPreview({ website: ws, impact, applicationState });
    },
    domainRemovalRuntime: { start: async () => { throw new Error('unexpected domain removal'); } },
    websiteRegistry,
    domainRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    fileCleanupHandler: cleanupAdapters.fileCleanupHandler,
    passengerEnvironmentCleanupHandler: cleanupAdapters.passengerEnvironmentCleanupHandler,
    unixIdentityCleanupHandler: cleanupAdapters.unixIdentityCleanupHandler,
    fileCleanupInspector: cleanupAdapters.inspectFileCleanup,
    unixIdentityCleanupInspector: cleanupAdapters.inspectUnixIdentityCleanup,
    liveSessions,
    authorizeActor: (actor) => {
      const session = authStore.getSessionById(actor?.sessionId);
      if (!session || session.user.id !== actor.userId || session.user.role !== 'owner') return null;
      return { sessionId: session.id, userId: session.user.id, role: session.user.role };
    },
    automaticExecution: true,
  });

  const app = express();
  app.use(express.json());
  mountWebsiteRemovalRoutes(app, {
    runtime,
    websiteRegistry,
    localServerId: server.id,
  });
  app.use((error, _req, res, _next) => {
    if (error instanceof WebsiteRemovalHttpError) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    return res.status(500).json({ error: { code: 'internal_error', message: 'Unexpected server error' } });
  });

  const baseUrl = await listen(t, createAuthenticatedApi({
    store: authStore,
    publicOrigin: ORIGIN,
    ownerMfaRequired: false,
    createHandler: () => app,
  }));
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: 'admin', password }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  const sessionRes = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie } });
  const { data: sessionData } = await sessionRes.json();
  const headers = {
    cookie,
    origin: ORIGIN,
    'x-csrf-token': sessionData.csrfToken,
    'content-type': 'application/json',
  };

  return { baseUrl, headers, website, removalRegistry };
}

test('POST website removal maps real TerminalLifecycleError from unverified generation boundary to typed 503 instead of 500 internal_error', async (t) => {
  const boundary = captureTerminalGenerationBoundary();
  assert.equal(boundary.verified, false);
  const liveSessions = createLiveSessionRegistry({
    requireGenerationBoundary: true,
    generationBoundary: boundary,
  });
  const { baseUrl, headers, website, removalRegistry } = await setupRemovalHttp(t, { liveSessions });

  const previewRes = await fetch(`${baseUrl}/api/panel/websites/${website.id}/removal`, { headers });
  assert.equal(previewRes.status, 200);
  const preview = (await previewRes.json()).data.preview;
  assert.deepEqual(preview.hardBlockers, []);
  assert.equal(preview.readyToStart, true);

  const startRes = await fetch(`${baseUrl}/api/panel/websites/${website.id}/removal`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
  });
  const body = await startRes.json();
  assert.equal(startRes.status, 503);
  assert.equal(body.error?.code, 'terminal_drain_generation_unknown');
  assert.deepEqual(await removalRegistry.listForWebsite(website.id), []);
});

test('POST website removal maps real TerminalProcessError from exited child identity probe to typed 503 and cancels provisional fence', async (t) => {
  const liveSessions = createLiveSessionRegistry();
  const { baseUrl, headers, website, removalRegistry } = await setupRemovalHttp(t, { liveSessions });

  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const childPid = child.pid;
  assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true);
  await once(child, 'exit');

  const lease = liveSessions.beginWebsiteOpen({
    websiteId: website.id,
    backend: 'ttyd',
    snapshot: async () => captureOwnedTerminalIdentity(childPid),
    stop: () => {},
    drain: async () => lease.settleWithoutProcess(),
  });

  const previewRes = await fetch(`${baseUrl}/api/panel/websites/${website.id}/removal`, { headers });
  assert.equal(previewRes.status, 200);
  const preview = (await previewRes.json()).data.preview;
  assert.deepEqual(preview.hardBlockers, []);
  assert.equal(preview.readyToStart, true);

  const startRes = await fetch(`${baseUrl}/api/panel/websites/${website.id}/removal`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
  });
  const body = await startRes.json();
  assert.equal(startRes.status, 503);
  assert.equal(['terminal_drain_identity_unavailable', 'terminal_drain_unsupported'].includes(body.error?.code), true);
  assert.doesNotThrow(() => liveSessions.assertWebsiteOpen(website.id));
  assert.deepEqual(await removalRegistry.listForWebsite(website.id), []);
  lease.settleWithoutProcess();
});

test('formatTerminalDrainFailureLine emits only allowlisted backend, UUID and drain code without leaking raw paths or messages', () => {
  assert.equal(typeof terminalProcessManager.formatTerminalDrainFailureLine, 'function');
  const websiteId = randomUUID();
  const secretPath = '/var/lib/yunpanel/secret-' + randomUUID();
  const line = terminalProcessManager.formatTerminalDrainFailureLine({
    backend: 'ttyd',
    websiteId,
    error: Object.assign(new Error(`sensitive ${secretPath}`), { code: 'terminal_drain_socket_unavailable' }),
  });
  assert.equal(line, `[yunpanel-api] terminal drain failed backend=ttyd website=${websiteId} code=terminal_drain_socket_unavailable`);
  assert.equal(line.includes(secretPath), false);

  const clamped = terminalProcessManager.formatTerminalDrainFailureLine({
    backend: 'injected\nbackend',
    websiteId: '../etc/passwd',
    error: Object.assign(new Error(`leak ${secretPath}`), { code: 'terminal_drain_fabricated_code' }),
  });
  assert.equal(clamped, '[yunpanel-api] terminal drain failed backend=unknown website=none code=terminal_drain_unverified');
  assert.equal(clamped.includes(secretPath), false);
});

test('real localRuntime claim fault exposes allowlisted T920 diagnostic fields through Watchdog without leaking raw store paths', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-watchdog-claim-diag-'));
  let runtime = null;
  t.after(async () => {
    try { await runtime?.stop(); } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  const jobStore = path.join(dir, 'jobs.json');
  const lockPath = path.join(dir, 'local-executor.lock');
  const serverRegistry = createServerRegistry({ filePath: path.join(dir, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'watchdog-claim.example.test' });
  const jobRegistry = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await jobRegistry.init();

  const marker = 'private-damaged-' + randomUUID();
  await writeFile(jobStore, `{${marker}\n`, { flag: 'wx', mode: 0o600 });

  const reported = [];
  runtime = await startLocalRuntime({
    serverId: server.id,
    hostname: 'watchdog-claim.example.test',
    runtimeVersion: '0.3.0',
    lockPath,
    registry: serverRegistry,
    jobRegistry,
    domainRegistry: createDomainRegistry(),
    certificateRegistry: createCertificateRegistry(),
    applicationRegistry: createApplicationRegistry(),
    websiteRegistry: createWebsiteRegistry(),
    runtimeBindingRegistry: createApplicationRuntimeBindingRegistry(),
    onError: (err) => reported.push(err),
  });

  for (let attempt = 0; reported.length === 0 && attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(reported.length, 1);
  assert.equal(runtime.running(), false);
  assert.deepEqual(runtime.failure(), {
    code: 'local_claim_unconfirmed',
    phase: 'claim',
    jobId: null,
    failureBoundary: 'select_queued',
    causeClass: 'DurableJobRegistryError',
    causeCode: 'durable_job_recovery_failed',
  });

  const watchdog = createSystemWatchdogService({
    localRuntime: runtime,
    jobRegistry,
    inspectServices: async () => [],
    serviceControl: async () => { throw new Error('No service mutation expected'); },
  });
  const report = await watchdog.inspect({ serverId: server.id });
  assert.equal(report.queue.worker.running, false);
  assert.deepEqual(report.queue.worker.fault, runtime.failure());
  const incident = report.incidents.find((item) => item.code === 'executor_faulted');
  assert.ok(incident);
  assert.deepEqual(incident.fault, runtime.failure());
  assert.equal(incident.message.includes('()'), false);
  assert.equal(incident.message.includes('select_queued/DurableJobRegistryError/durable_job_recovery_failed'), true);
  assert.equal(JSON.stringify(report).includes(marker), false);
  assert.equal(JSON.stringify(report).includes(dir), false);
});

const execFileAsync = promisify(execFile);

function ttydTestDeps(t, {
  maxSessions = 2,
  maxUserSessions = 1,
  liveSessions = null,
  applyRuntime = null,
  spawnImpl = null,
  createSocket = true,
  realpathFn = async (value) => value,
  lstatImpl = null,
  now = Date.now,
  setTimerImpl = null,
} = {}) {
  const children = [];
  const timers = [];
  const killGroupCalls = [];
  const childKillCalls = [];
  const fsState = new Map([
    [ttydSessionInternals.socketRoot, {
      uid: 0,
      gid: 995,
      mode: 0o2770,
      isDirectory: () => true,
      isSocket: () => false,
      isSymbolicLink: () => false,
    }],
  ]);
  t.after(() => {
    for (const child of children) {
      if (Number.isSafeInteger(child?.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {
          try { child.kill('SIGKILL'); } catch {}
        }
      }
    }
  });
  let spawnCount = 0;
  const manager = createTtydSessionManager({
    liveSessions,
    maxSessions,
    maxUserSessions,
    getuid: () => 0,
    killProcessGroup: (pid, signalName) => {
      killGroupCalls.push([pid, signalName]);
      return process.kill(-pid, signalName);
    },
    runtimeManager: {
      apply: applyRuntime ?? (async () => ({
        satisfied: true,
        binaryPath: ttydSessionInternals.ttydPath,
        binaryVersion: '1.7.4',
        distroServiceMasked: true,
        distroServiceActive: false,
      })),
    },
    run: async (_file, args) => {
      if (args[0] === 'passwd') return { stdout: 'yunpanel:x:995:995::/var/lib/yunpanel:/usr/sbin/nologin\n' };
      if (args[0] === 'group') return { stdout: 'yunpanel:x:995:\n' };
      throw new Error('unexpected getent');
    },
    statFn: async () => ({ isDirectory: () => true }),
    realpathFn,
    readPasswd: async () => 'root:x:0:0:root:/root:/bin/bash\nyunapp-123456789abc:x:901:902::/var/lib/yunpanel/data:/usr/sbin/nologin\n',
    lstatFn: lstatImpl
      ? (targetPath) => lstatImpl(targetPath, fsState)
      : async (targetPath) => {
        const value = fsState.get(targetPath);
        if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return value;
      },
    now,
    mkdirFn: async (targetPath) => {
      fsState.set(targetPath, {
        uid: 0,
        gid: 995,
        mode: 0o2770,
        isDirectory: () => true,
        isSocket: () => false,
        isSymbolicLink: () => false,
      });
    },
    rmFn: async (targetPath) => { fsState.delete(targetPath); },
    chmodFn: async (targetPath, mode) => {
      const item = fsState.get(targetPath);
      if (item) item.mode = mode;
    },
    chownFn: async (targetPath, uid, gid) => {
      const item = fsState.get(targetPath);
      if (item) { item.uid = uid; item.gid = gid; }
    },
    spawnProcess: (_file, args) => {
      spawnCount += 1;
      const socketPath = args[args.indexOf('--interface') + 1];
      const child = spawnImpl
        ? spawnImpl({ args, socketPath, fsState })
        : spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
      if (child && typeof child.kill === 'function') {
        const originalKill = child.kill.bind(child);
        child.kill = (signalName) => {
          childKillCalls.push([child.pid, signalName]);
          return originalKill(signalName);
        };
      }
      children.push(child);
      if (createSocket) {
        fsState.set(socketPath, {
          uid: 995,
          gid: 995,
          mode: 0o660,
          isDirectory: () => false,
          isSocket: () => true,
          isSymbolicLink: () => false,
        });
      }
      return child;
    },
    setTimer: setTimerImpl ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      const wrapped = { timer, ms, cleared: false, unref() { timer.unref?.(); } };
      timers.push(wrapped);
      return wrapped;
    }),
    clearTimer: (wrapped) => {
      if (wrapped?.timer) {
        wrapped.cleared = true;
        clearTimeout(wrapped.timer);
      }
    },
  });
  return {
    manager,
    children,
    timers,
    fsState,
    killGroupCalls,
    childKillCalls,
    get spawnCount() { return spawnCount; },
  };
}

test('ttyd-session-manager atomically enforces maxSessions and maxUserSessions across concurrent starts and awaits closeAll', async (t) => {
  const rootTarget = { scope: 'server', serverId: 'local', user: 'root', cwd: '/root' };
  let releaseApply;
  const applyGate = new Promise((resolve) => { releaseApply = resolve; });
  let runtimeCalls = 0;

  const fx = ttydTestDeps(t, {
    maxSessions: 2,
    maxUserSessions: 1,
    applyRuntime: async () => {
      runtimeCalls += 1;
      await applyGate;
      return {
        satisfied: true,
        binaryPath: ttydSessionInternals.ttydPath,
        binaryVersion: '1.7.4',
        distroServiceMasked: true,
        distroServiceActive: false,
      };
    },
  });

  const sameUserAttempts = [
    fx.manager.start({ ownerSessionId: 'owner-1', userId: 'user-a', target: rootTarget }),
    fx.manager.start({ ownerSessionId: 'owner-2', userId: 'user-a', target: rootTarget }),
    fx.manager.start({ ownerSessionId: 'owner-3', userId: 'user-a', target: rootTarget }),
  ];
  const otherUserAttempts = [
    fx.manager.start({ ownerSessionId: 'owner-4', userId: 'user-b', target: rootTarget }),
    fx.manager.start({ ownerSessionId: 'owner-5', userId: 'user-c', target: rootTarget }),
  ];

  // Only 2 slots exist globally (1 for user-a + 1 for user-b); all over-limit calls fail before runtimeManager.apply().
  releaseApply();
  const settled = await Promise.allSettled([...sameUserAttempts, ...otherUserAttempts]);
  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');

  assert.equal(fulfilled.length, 2);
  assert.equal(rejected.length, 3);
  for (const failure of rejected) {
    assert.ok(failure.reason instanceof TtydSessionError);
    assert.equal(failure.reason.status, 429);
    assert.equal(failure.reason.code, 'ttyd_session_limit');
  }
  assert.equal(runtimeCalls, 2);
  assert.equal(fx.spawnCount, 2);
  assert.equal(fx.manager.size(), 2);

  const closeResult = fx.manager.closeAll('test_shutdown');
  assert.equal(typeof closeResult?.then, 'function');
  assert.deepEqual(await closeResult, []);
  await Promise.all(fx.children.map((child) => (child.exitCode === null && child.signalCode === null
    ? once(child, 'exit')
    : Promise.resolve())));
  assert.equal(fx.manager.size(), 0);
});

test('ttyd-session-manager releases reserved slots on runtime failure, spawn throw, invalid PID, and early child exit without leaking leases', async (t) => {
  const rootTarget = { scope: 'server', serverId: 'local', user: 'root', cwd: '/root' };

  // 1. Runtime failure releases reserved pending slot so the next start succeeds.
  let failOnce = true;
  const runtimeFx = ttydTestDeps(t, {
    maxSessions: 1,
    maxUserSessions: 1,
    applyRuntime: async () => {
      if (failOnce) {
        failOnce = false;
        return { satisfied: false };
      }
      return {
        satisfied: true,
        binaryPath: ttydSessionInternals.ttydPath,
        binaryVersion: '1.7.4',
        distroServiceMasked: true,
        distroServiceActive: false,
      };
    },
  });
  await assert.rejects(
    () => runtimeFx.manager.start({ ownerSessionId: 'owner-1', userId: 'user-1', target: rootTarget }),
    (err) => err instanceof TtydSessionError && err.code === 'ttyd_runtime_not_ready',
  );
  assert.equal(runtimeFx.manager.size(), 0);
  const recovered = await runtimeFx.manager.start({ ownerSessionId: 'owner-1', userId: 'user-1', target: rootTarget });
  assert.ok(recovered.sessionId);
  await runtimeFx.manager.closeAll('test_cleanup');

  // 2. Synchronous spawn throw releases slot and keeps manager empty.
  const throwFx = ttydTestDeps(t, {
    maxSessions: 1,
    maxUserSessions: 1,
    spawnImpl: () => { throw new Error('spawn failed'); },
  });
  await assert.rejects(
    () => throwFx.manager.start({ ownerSessionId: 'owner-2', userId: 'user-2', target: rootTarget }),
    (err) => err instanceof TtydSessionError && err.status === 503 && err.code === 'ttyd_session_spawn_failed',
  );
  assert.equal(throwFx.manager.size(), 0);

  // 3. Real spawn of missing binary (pid === undefined + async error event) fails cleanly without unhandled error or slot leak.
  const missingBinaryFx = ttydTestDeps(t, {
    maxSessions: 1,
    maxUserSessions: 1,
    spawnImpl: () => spawn(`/nonexistent-yunpanel-ttyd-${randomUUID()}`, [], { stdio: 'ignore' }),
  });
  await assert.rejects(
    () => missingBinaryFx.manager.start({ ownerSessionId: 'owner-3', userId: 'user-3', target: rootTarget }),
    (err) => err instanceof TtydSessionError && err.status === 503 && err.code === 'ttyd_session_spawn_failed',
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(missingBinaryFx.manager.size(), 0);

  // 4. Real child exiting before socket becomes ready cleans up record and timers.
  const earlyExitFx = ttydTestDeps(t, {
    maxSessions: 1,
    maxUserSessions: 1,
    createSocket: false,
    spawnImpl: () => spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' }),
  });
  await assert.rejects(
    () => earlyExitFx.manager.start({ ownerSessionId: 'owner-4', userId: 'user-4', target: rootTarget }),
    (err) => err instanceof TtydSessionError && err.status === 503 && err.code === 'ttyd_session_start_failed',
  );
  assert.equal(earlyExitFx.manager.size(), 0);
  assert.equal(earlyExitFx.timers.filter((entry) => entry.ms >= 5_000).every((entry) => entry.cleared), true);

  // 5. Site-scoped failure before process spawn settles liveSessions lease cleanly so website removal is never bricked.
  const liveSessions = createLiveSessionRegistry();
  const siteWebsiteId = randomUUID();
  const siteAppId = randomUUID();
  const siteFx = ttydTestDeps(t, {
    maxSessions: 1,
    maxUserSessions: 1,
    liveSessions,
    applyRuntime: async () => ({ satisfied: false }),
  });
  await assert.rejects(
    () => siteFx.manager.start({
      ownerSessionId: 'owner-5',
      userId: 'user-5',
      target: {
        scope: 'site',
        serverId: 'local',
        websiteId: siteWebsiteId,
        user: 'yunapp-123456789abc',
        cwd: `/var/lib/yunpanel/apps/${siteAppId}/current`,
      },
    }),
    (err) => err instanceof TtydSessionError
      && ['ttyd_runtime_not_ready', 'terminal_drain_unsupported'].includes(err.code),
  );
  assert.equal(siteFx.manager.size(), 0);
  assert.equal(liveSessions.websiteLifecycleSize(siteWebsiteId), 0);
  const reservation = liveSessions.reserveWebsiteRemoval(siteWebsiteId);
  const snap = await reservation.snapshot();
  assert.deepEqual(snap.leases, []);
  reservation.cancel();
});

test('terminal-process-manager OWNED_PROCESS_PYTHON binds socketPath in initial without racing bind and guards natural child exit', async (t) => {
  const pythonSource = terminalProcessManager.terminalProcessInternals.ownedProcessPython;
  const { stdout } = await execFileAsync(
    'python3',
    ['-c', 'import ast, sys; ast.parse(sys.argv[1]); print("OK")', pythonSource],
    { encoding: 'utf8' },
  );
  assert.equal(stdout.trim(), 'OK');

  // Bug 4: natural exit between pidfd_open and proc(pid) must close fd and continue, never reject as pid_reused.
  assert.match(pythonSource, /try:fd=os\.pidfd_open\(pid,0\)\n\s+except ProcessLookupError:continue\n\s+post=proc\(pid\)\n\s+if post is None:os\.close\(fd\);continue\n\s+if not same\(post,known\[pid\]\):os\.close\(fd\);reject\('terminal_drain_pid_reused'\)/);

  // Linux procfs race guard: exiting processes between open() and read() raise ESRCH (ProcessLookupError) in proc() and /proc/<pid>/fd scans.
  assert.match(pythonSource, /def proc\(pid\):\n\s+try:\n\s+with open\('\/proc\/'\+str\(pid\)\+'\/stat'\) as f:text=f\.read\(8193\)[\s\S]*?except \(FileNotFoundError,ProcessLookupError\):return None/);
  assert.match(pythonSource, /os\.readlink\('\/proc\/'\+str\(pid\)\+'\/fd\/'\+name\)=='socket:\['\+inode\+'\]':owner=True\n\s+except \(FileNotFoundError,ProcessLookupError\):continue\n\s+except \(FileNotFoundError,ProcessLookupError\):continue/);

  // Blocking Fix #2: mode=='initial' validates socketPath regex, stores {'path': socketPath, 'identity': None},
  // and skips live socket_info/inode probing until mode=='capture' while drain fails closed if socket exists without pinned identity.
  assert.match(pythonSource, /if x\['mode'\]=='initial':\n\s+if x\.get\('socketPath'\) is not None:\n\s+if not isinstance\(x\['socketPath'\],str\) or not re\.fullmatch\(SOCKET_PATH_RE,x\['socketPath'\]\):reject\('terminal_drain_socket_changed'\)/);
  assert.match(pythonSource, /evidence=\{'version':1,'started':True,'creator':clean\(creator\),'root':clean\(root\),'known':\[clean\(root\)\],'socket':\{'path':x\['socketPath'\],'identity':None\} if x\.get\('socketPath'\) is not None else None\}/);
  assert.match(pythonSource, /if x\['mode'\]!='initial' and x\.get\('socketPath'\) is not None:\n\s+sp=x\['socketPath'\]\n\s+if not isinstance\(sp,str\) or not re\.fullmatch\(SOCKET_PATH_RE,sp\):reject\('terminal_drain_socket_changed'\)\n\s+if sockets is not None and sockets\.get\('path'\)!=sp:reject\('terminal_drain_socket_changed'\)/);
  assert.match(pythonSource, /if sockets is not None and sockets\.get\('identity'\) is not None and sockets\['identity'\]!=candidate\['identity'\]:reject\('terminal_drain_socket_changed'\)/);
  assert.match(pythonSource, /if now is not None:\n\s+if sockets\['identity'\] is None or now!=\{k:v for k,v in sockets\['identity'\]\.items\(\) if k!='kernelInode'\}:reject\('terminal_drain_socket_changed'\)/);

  // Blocking Fix #1 & #2: ttyd-session-manager passes socketPath directly to createOwnedTerminalLifecycle before sessions.set/waitForSocket,
  // never calls bare killProcessGroup or child.kill in captureOwnedTerminalIdentity / createOwnedTerminalLifecycle failure paths,
  // calls lifecycle.snapshot() after waitForSocket, and keeps unref() on the waitForSocket 25ms timer.
  const ttydSource = await readFile(new URL('../src/terminal/ttyd-session-manager.js', import.meta.url), 'utf8');
  const spawnAttemptedIdx = ttydSource.indexOf('spawnAttempted = true;');
  const lifecycleIdx = ttydSource.indexOf('createOwnedTerminalLifecycle({ seed, childExit: observation.exit, socketPath })');
  const sessionsSetIdx = ttydSource.indexOf('sessions.set(id, record);');
  const waitForSocketIdx = ttydSource.indexOf('await waitForSocket(record, gatewayIdentity);');
  const snapshotIdx = ttydSource.indexOf('if (lease) await lifecycle.snapshot();');
  assert.ok(spawnAttemptedIdx > 0);
  assert.ok(lifecycleIdx > spawnAttemptedIdx);
  assert.ok(sessionsSetIdx > lifecycleIdx);
  assert.ok(waitForSocketIdx > sessionsSetIdx);
  assert.ok(snapshotIdx > waitForSocketIdx);
  assert.equal(ttydSource.includes('socketPath: null'), false);
  assert.equal(ttydSource.includes('lifecycle.snapshot({ socketPath })'), false);
  assert.match(ttydSource, /const timer = setTimer\(resolve, 25\);\n\s+timer\?\.unref\?\.\(\);/);

  const ownershipRegion = ttydSource.slice(spawnAttemptedIdx, sessionsSetIdx);
  assert.equal(ownershipRegion.includes('killProcessGroup('), false, 'Leased ownership failure paths must never signal bare PGID');
  assert.equal(ownershipRegion.includes('child.kill('), false, 'Leased ownership failure paths must never signal bare PID');

  if (process.platform === 'linux') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const exit = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exit;
      }
    });
    const seed = captureOwnedTerminalIdentity(child.pid);
    await once(child, 'spawn');

    // Invalid socketPath rejected in mode=='initial'.
    await assert.rejects(
      () => terminalProcessManager.createOwnedTerminalLifecycle({ seed, childExit: exit, socketPath: '/tmp/not-ttyd.sock' }),
      { code: 'terminal_drain_socket_changed' },
    );

    // Valid socketPath accepted in mode=='initial' before ttyd creates the socket, and drain() verifies absence cleanly.
    const validSocketPath = `/run/yunpanel/ttyd/${randomUUID()}.sock`;
    const lifecycle = await terminalProcessManager.createOwnedTerminalLifecycle({ seed, childExit: exit, socketPath: validSocketPath });
    const drainResult = await lifecycle.drain({ timeoutMs: 10_000 });
    assert.equal(drainResult.verified, true);
    assert.equal(drainResult.socketRemoved, true);

    // Real rapid fork/exit child drain under Linux procfs ESRCH race must succeed without identity_unavailable or pid_reused.
    for (let round = 0; round < 5; round += 1) {
      const forker = spawn('/bin/sh', ['-c', 'while true; do : & wait; done'], { detached: true, stdio: 'ignore' });
      const forkerExit = once(forker, 'exit');
      t.after(async () => {
        if (forker.exitCode === null && forker.signalCode === null) {
          try { process.kill(-forker.pid, 'SIGKILL'); } catch {
            try { forker.kill('SIGKILL'); } catch {}
          }
          await forkerExit;
        }
      });
      const forkerSeed = captureOwnedTerminalIdentity(forker.pid);
      await once(forker, 'spawn');
      const forkerLifecycle = await terminalProcessManager.createOwnedTerminalLifecycle({
        seed: forkerSeed,
        childExit: forkerExit,
        socketPath: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const forkerDrain = await forkerLifecycle.drain({ timeoutMs: 10_000 });
      assert.equal(forkerDrain.verified, true);
      assert.equal(forkerDrain.processesExited, true);
    }
  }
});

test('ttyd-session-manager never invokes bare killProcessGroup or child.kill when site ownership proof fails', async (t) => {
  const siteWebsiteId = randomUUID();
  const siteAppId = randomUUID();
  const siteReleaseId = randomUUID();
  const siteTarget = {
    scope: 'site',
    serverId: 'local',
    websiteId: siteWebsiteId,
    user: 'yunapp-123456789abc',
    cwd: `/var/lib/yunpanel/apps/${siteAppId}/current`,
  };
  const siteRealpath = async (value) => (value === siteTarget.cwd
    ? `/var/lib/yunpanel/apps/${siteAppId}/releases/${siteReleaseId}`
    : value);

  // Scenario 1: captureOwnedTerminalIdentity fails on an already-exited real child.
  const liveSessions1 = createLiveSessionRegistry();
  const exitedChild = spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' });
  await once(exitedChild, 'exit');
  const fx1 = ttydTestDeps(t, {
    maxSessions: 1,
    maxUserSessions: 1,
    liveSessions: liveSessions1,
    createSocket: false,
    realpathFn: siteRealpath,
    spawnImpl: () => exitedChild,
  });
  await assert.rejects(
    () => fx1.manager.start({ ownerSessionId: 'owner-1', userId: 'user-1', target: siteTarget }),
    (err) => err instanceof TtydSessionError
      && ['terminal_drain_identity_unavailable', 'terminal_drain_unsupported'].includes(err.code),
  );
  assert.deepEqual(fx1.killGroupCalls, [], 'killProcessGroup must be called 0 times when captureOwnedTerminalIdentity fails');
  assert.deepEqual(fx1.childKillCalls, [], 'child.kill must be called 0 times when captureOwnedTerminalIdentity fails');
  assert.equal(fx1.manager.size(), 0);

  // Scenario 2: createOwnedTerminalLifecycle rejects while a real non-detached child exits during the await (post-await PID reuse window).
  const liveSessions2 = createLiveSessionRegistry();
  let childExitPromise = Promise.resolve();
  const fx2 = ttydTestDeps(t, {
    maxSessions: 1,
    maxUserSessions: 1,
    liveSessions: liveSessions2,
    createSocket: false,
    realpathFn: siteRealpath,
    spawnImpl: () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 60)'], { detached: false, stdio: 'ignore' });
      childExitPromise = once(child, 'exit');
      return child;
    },
  });
  await assert.rejects(
    () => fx2.manager.start({ ownerSessionId: 'owner-2', userId: 'user-2', target: siteTarget }),
    (err) => err instanceof TtydSessionError
      && ['terminal_drain_identity_unavailable', 'terminal_drain_timeout', 'terminal_drain_unsupported'].includes(err.code),
  );
  await childExitPromise;
  assert.deepEqual(fx2.killGroupCalls, [], 'killProcessGroup must be called 0 times when createOwnedTerminalLifecycle rejects');
  assert.deepEqual(fx2.childKillCalls, [], 'child.kill must be called 0 times when createOwnedTerminalLifecycle rejects');
  assert.equal(fx2.manager.size(), 0);

  // Verify reserved slot was cleanly released (next start is not blocked by 429 ttyd_session_limit).
  await assert.rejects(
    () => fx2.manager.start({ ownerSessionId: 'owner-3', userId: 'user-2', target: siteTarget }),
    (err) => err instanceof TtydSessionError && err.code !== 'ttyd_session_limit',
  );
  assert.equal(fx2.manager.size(), 0);
});

test('ttyd-session-manager waitForSocket tolerates transient root bind-to-chown/chmod window and fails closed on foreign, symlink, or unconverged sockets', async (t) => {
  const rootTarget = { scope: 'server', serverId: 'local', user: 'root', cwd: '/root' };
  const makeStat = ({ uid, gid, mode, socket = true, symlink = false }) => ({
    uid,
    gid,
    mode,
    isDirectory: () => false,
    isSocket: () => socket,
    isSymbolicLink: () => symlink,
  });

  // (a) Transient root-owned pre-chmod socket transitions to yunpanel:yunpanel 0660 on the next poll and succeeds cleanly.
  let convergePolls = 0;
  let convergeClock = 1_000_000;
  const convergeFx = ttydTestDeps(t, {
    maxSessions: 1,
    maxUserSessions: 1,
    createSocket: false,
    now: () => convergeClock,
    setTimerImpl: (callback, ms) => {
      if (ms === 25) {
        convergeClock += 25;
        queueMicrotask(callback);
        return { cleared: false, unref() {} };
      }
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return { timer, ms, cleared: false, unref() { timer.unref?.(); } };
    },
    lstatImpl: async (targetPath, fsState) => {
      if (targetPath === ttydSessionInternals.socketRoot) return fsState.get(targetPath);
      if (convergePolls === 0) {
        // Pre-spawn conflict probe must see ENOENT.
        convergePolls += 1;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      convergePolls += 1;
      if (convergePolls === 2) return makeStat({ uid: 0, gid: 995, mode: 0o755 });
      return makeStat({ uid: 995, gid: 995, mode: 0o660 });
    },
  });
  const started = await convergeFx.manager.start({ ownerSessionId: 'owner-conv', userId: 'user-conv', target: rootTarget });
  assert.ok(started.sessionId);
  assert.equal(convergePolls, 3);
  await convergeFx.manager.closeAll('test_cleanup');
  await Promise.all(convergeFx.children.map((child) => (child.exitCode === null && child.signalCode === null
    ? once(child, 'exit')
    : Promise.resolve())));

  // (b) Symlink and foreign-UID sockets reject immediately without polling until the 5s deadline.
  for (const [label, badStat] of [
    ['symlink', makeStat({ uid: 995, gid: 995, mode: 0o660, socket: true, symlink: true })],
    ['foreign-uid', makeStat({ uid: 1000, gid: 995, mode: 0o660, socket: true, symlink: false })],
  ]) {
    let socketProbes = 0;
    let pollTimersScheduled = 0;
    let preSpawnChecked = false;
    const badFx = ttydTestDeps(t, {
      maxSessions: 1,
      maxUserSessions: 1,
      createSocket: false,
      setTimerImpl: (callback, ms) => {
        if (ms === 25) pollTimersScheduled += 1;
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return { timer, ms, cleared: false, unref() { timer.unref?.(); } };
      },
      lstatImpl: async (targetPath, fsState) => {
        if (targetPath === ttydSessionInternals.socketRoot) return fsState.get(targetPath);
        if (!preSpawnChecked) {
          preSpawnChecked = true;
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        socketProbes += 1;
        return badStat;
      },
    });
    await assert.rejects(
      () => badFx.manager.start({ ownerSessionId: `owner-${label}`, userId: `user-${label}`, target: rootTarget }),
      (err) => err instanceof TtydSessionError && err.status === 503 && err.code === 'ttyd_session_socket_unsafe',
    );
    assert.equal(socketProbes, 1, `${label} socket must be rejected on the first waitForSocket probe`);
    assert.equal(pollTimersScheduled, 0, `${label} socket must not wait for the 5s deadline`);
    await Promise.all(badFx.children.map((child) => (child.exitCode === null && child.signalCode === null
      ? once(child, 'exit')
      : Promise.resolve())));
  }

  // (c) Root-owned/wrong-mode socket that never converges before the 5s deadline fails closed with ttyd_session_socket_unsafe.
  let staleClock = 2_000_000;
  let stalePreSpawnChecked = false;
  let staleProbes = 0;
  const staleFx = ttydTestDeps(t, {
    maxSessions: 1,
    maxUserSessions: 1,
    createSocket: false,
    now: () => staleClock,
    setTimerImpl: (callback, ms) => {
      if (ms === 25) {
        staleClock += 2_500;
        queueMicrotask(callback);
        return { cleared: false, unref() {} };
      }
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return { timer, ms, cleared: false, unref() { timer.unref?.(); } };
    },
    lstatImpl: async (targetPath, fsState) => {
      if (targetPath === ttydSessionInternals.socketRoot) return fsState.get(targetPath);
      if (!stalePreSpawnChecked) {
        stalePreSpawnChecked = true;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      staleProbes += 1;
      return makeStat({ uid: 0, gid: 995, mode: 0o755 });
    },
  });
  await assert.rejects(
    () => staleFx.manager.start({ ownerSessionId: 'owner-stale', userId: 'user-stale', target: rootTarget }),
    (err) => err instanceof TtydSessionError && err.status === 503 && err.code === 'ttyd_session_socket_unsafe',
  );
  assert.ok(staleProbes >= 2);
  await Promise.all(staleFx.children.map((child) => (child.exitCode === null && child.signalCode === null
    ? once(child, 'exit')
    : Promise.resolve())));
});
