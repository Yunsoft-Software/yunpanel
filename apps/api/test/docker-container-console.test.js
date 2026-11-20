import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDockerComposeObserver,
  createDockerComposeValidator,
  createDockerContainerConsoleInspector,
} from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { createDockerComposeApiHandler } from '../src/docker-compose-api-handler.js';
import { createDockerComposeOperationReceiptStore } from '../src/docker-compose-operation-receipt.js';
import { createDockerComposeRuntime } from '../src/docker-compose-runtime.js';
import {
  buildContainerConsoleExecArgs,
  cleanupDockerContainerExec,
  dockerContainerConsoleCleanupInternals,
  formatContainerCleanupFailureLine,
  matchExecInspectForSession,
  parseProcStat,
  selectContainerSessionPids,
} from '../src/docker-container-console-cleanup.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import { createLocalDockerComposeOperation } from '../src/local-docker-compose-operation.js';
import { createOwnerMfaPolicy } from '../src/owner-mfa-policy.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import { createTerminalCapabilityRegistry, TerminalCapabilityError } from '../src/terminal-capability-registry.js';
import { createTerminalProcessManager } from '../src/terminal-process-manager.js';
import { resolveTerminalTarget } from '../src/terminal-target-resolver.js';
import { terminalWebSocketInternals } from '../src/terminal-websocket.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

async function resolveLocalDockerCommand() {
  for (const candidate of ['/usr/bin/docker', '/usr/local/bin/docker']) {
    try {
      await access(candidate, fsConstants.X_OK);
      return { binary: candidate, composeBinary: null };
    } catch {
      // continue
    }
  }
  for (const composeCandidate of [
    '/opt/homebrew/lib/docker/cli-plugins/docker-compose',
    '/usr/local/lib/docker/cli-plugins/docker-compose',
    '/usr/libexec/docker/cli-plugins/docker-compose',
  ]) {
    try {
      await access(composeCandidate, fsConstants.X_OK);
      return { binary: '/usr/bin/docker', composeBinary: composeCandidate };
    } catch {
      // continue
    }
  }
  return null;
}

function createRealComposeValidator(dockerCmd, rootDir) {
  return createDockerComposeValidator({
    root: path.join(rootDir, 'compose-validation'),
    accessFn: (candidate) => (
      candidate === '/usr/local/bin/docker'
        ? access(dockerCmd.composeBinary ?? dockerCmd.binary, fsConstants.X_OK)
        : access(candidate, fsConstants.X_OK)
    ),
    execFn: (_file, args, options) => new Promise((resolve, reject) => {
      const bin = dockerCmd.composeBinary && args[0] === 'compose' ? dockerCmd.composeBinary : dockerCmd.binary;
      const execArgs = dockerCmd.composeBinary && args[0] === 'compose' ? args.slice(1) : args;
      execFile(
        bin,
        execArgs,
        { ...options, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    }),
  });
}

function parseSetCookie(headers) {
  const raw = headers.getSetCookie?.() ?? [];
  const jar = new Map();
  for (const line of raw) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

async function createRealClient(baseUrl, username, password) {
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(loginRes.status, 200, `login failed for ${username}: ${loginRes.status}`);
  const cookies = parseSetCookie(loginRes.headers);
  const body = await loginRes.json();
  const csrf = body.data?.csrfToken ?? body.csrfToken;
  const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  return {
    async api(method, pathname, payload = undefined) {
      const headers = {
        cookie: cookieHeader(),
        origin: baseUrl,
      };
      if (method !== 'GET' && method !== 'HEAD') {
        headers['x-csrf-token'] = csrf;
      }
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
      }
      const res = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, json, text };
    },
  };
}

async function createRealFixture(t) {
  const dockerCmd = await resolveLocalDockerCommand();
  if (!dockerCmd) {
    t.skip('Local Docker Compose CLI is not installed on this machine');
    return null;
  }
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-slicec-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const liveSessions = createLiveSessionRegistry({ requireGenerationBoundary: false });
  const masterKeyBuf = randomBytes(32);
  const authStore = createAuthStore({
    filePath: path.join(rootDir, 'auth.sqlite'),
    masterKey: masterKeyBuf,
    liveSessions,
  });
  t.after(() => authStore.close());
  const setup = authStore.issueSetupToken();
  await authStore.completeSetup({
    setupToken: setup.token,
    username: 'owner-con',
    password: 'OwnerConPassword!2026',
  });
  const ownerSetupLogin = await authStore.login({
    username: 'owner-con',
    password: 'OwnerConPassword!2026',
  });
  const ownerPolicy = createOwnerMfaPolicy({ store: authStore, required: false }).requireManagement;
  const resellerUser = await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'reseller-con',
    password: 'ResellerConPassword!2026',
    role: 'site_manager',
    websiteIds: [],
  });
  authStore.users.hostingAccounts.registerReseller(ownerSetupLogin.token, ownerPolicy, {
    userId: resellerUser.id,
    expectedUserRevision: resellerUser.revision,
    limits: { maxCustomers: 5, maxWebsites: 5 },
  });
  const customerUser = await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'customer-con',
    password: 'CustomerConPassword!2026',
    role: 'site_manager',
    websiteIds: [],
  });
  authStore.users.hostingAccounts.registerCustomer(ownerSetupLogin.token, ownerPolicy, {
    userId: customerUser.id,
    expectedUserRevision: customerUser.revision,
    resellerId: resellerUser.id,
  });
  await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'sitemgr-con',
    password: 'SiteMgrConPassword!2026',
    role: 'site_manager',
    websiteIds: [],
  });
  await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'readonly-con',
    password: 'ReadOnlyConPassword!2026',
    role: 'read_only',
  });

  const serverRegistry = createServerRegistry({ filePath: path.join(rootDir, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({
    hostname: 'local.yunpanel.test',
    displayName: 'Local Host',
  });

  const websiteRegistry = createWebsiteRegistry({
    filePath: path.join(rootDir, 'websites.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await websiteRegistry.init();
  const domainRegistry = createDomainRegistry({
    filePath: path.join(rootDir, 'domains.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
  });
  await domainRegistry.init();

  const jobRegistry = createDurableJobRegistry({
    filePath: path.join(rootDir, 'jobs.json'),
    registryFactory: createJobRegistry,
    automaticReconciliation: true,
  });
  await jobRegistry.init();

  const siteMutationLock = createSiteMutationLock({ root: path.join(rootDir, 'locks') });
  const validateDockerCompose = createRealComposeValidator(dockerCmd, rootDir);
  const dockerComposeRuntime = await createDockerComposeRuntime({
    env: {
      YUNPANEL_SERVER_STORE: path.join(rootDir, 'servers.json'),
      YUNPANEL_SECRET_MASTER_KEY: randomBytes(32).toString('hex'),
    },
    serverRegistry,
    jobRegistry,
    websiteRegistry,
    domainRegistry,
    siteMutationLock,
    liveSessions,
    validateDockerCompose,
    observer: createDockerComposeObserver(),
    containerConsoleInspector: createDockerContainerConsoleInspector(),
    receiptStore: createDockerComposeOperationReceiptStore({ root: path.join(rootDir, 'recovery-compose') }),
  });

  const terminalCapabilityRegistry = createTerminalCapabilityRegistry({ liveSessions });
  let ttydStartCalled = 0;
  const ttydSessionManager = {
    async start() {
      ttydStartCalled += 1;
      throw new Error('ttyd start must never be invoked for docker_container');
    },
    terminateOwned() {
      return false;
    },
  };

  let listener = null;
  const httpServer = http.createServer((req, res) => listener(req, res));
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  const { port } = httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  listener = createAuthenticatedApi({
    store: authStore,
    publicOrigin: baseUrl,
    ownerMfaRequired: false,
    development: true,
    createHandler: () => createDockerComposeApiHandler({
      runtime: dockerComposeRuntime,
      domainRegistry,
      jobRegistry,
      siteMutationLock,
      localServerId: server.id,
      baseHandler: createApp({
        registry: serverRegistry,
        websiteRegistry,
        domainRegistry,
        jobRegistry,
        siteMutationLock,
        terminalCapabilityRegistry,
        ttydSessionManager,
        dockerComposeProjectRegistry: dockerComposeRuntime.projectRegistry,
        dockerContainerConsoleInspector: dockerComposeRuntime.containerConsoleInspector,
        localServerId: server.id,
      }),
    }),
  });

  return {
    baseUrl,
    serverId: server.id,
    liveSessions,
    terminalCapabilityRegistry,
    dockerComposeRuntime,
    getTtydStartCalled: () => ttydStartCalled,
  };
}

test('real SQLite/HTTP RBAC enforces Owner-only access on console-targets and docker_container capabilities and blocks ttyd takeover', async (t) => {
  const fx = await createRealFixture(t);
  if (!fx) return;

  const owner = await createRealClient(fx.baseUrl, 'owner-con', 'OwnerConPassword!2026');
  const created = await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'console_rbac_proj',
    document: 'services:\n  web:\n    image: nginx:alpine\n',
  });
  assert.equal(created.status, 201);
  const project = created.json.data.project;
  const validContainerId = 'a'.repeat(64);

  // Unauthenticated -> 401
  const unauthTargets = await fetch(`${fx.baseUrl}/api/docker/projects/${project.id}/console-targets`, {
    headers: { origin: fx.baseUrl },
  });
  assert.equal(unauthTargets.status, 401);
  const unauthCap = await fetch(`${fx.baseUrl}/api/terminal/capabilities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: fx.baseUrl },
    body: JSON.stringify({ scope: 'docker_container', dockerProjectId: project.id, containerId: validContainerId }),
  });
  assert.equal(unauthCap.status, 401);

  // Non-owner roles -> 403 on both console-targets and capability issuance
  for (const [username, password] of [
    ['reseller-con', 'ResellerConPassword!2026'],
    ['customer-con', 'CustomerConPassword!2026'],
    ['sitemgr-con', 'SiteMgrConPassword!2026'],
    ['readonly-con', 'ReadOnlyConPassword!2026'],
  ]) {
    const client = await createRealClient(fx.baseUrl, username, password);
    assert.equal((await client.api('GET', `/api/docker/projects/${project.id}/console-targets`)).status, 403);
    const capRes = await client.api('POST', '/api/terminal/capabilities', {
      scope: 'docker_container',
      dockerProjectId: project.id,
      containerId: validContainerId,
    });
    assert.equal(capRes.status, 403, `${username} must be denied docker_container capability`);
  }

  // Input validation for Owner: invalid containerId (short / flag), extra fields, unknown project, query params
  assert.equal((await owner.api('GET', `/api/docker/projects/${project.id}/console-targets?foo=bar`)).status, 400);
  const badIdRes = await owner.api('POST', '/api/terminal/capabilities', {
    scope: 'docker_container',
    dockerProjectId: project.id,
    containerId: 'short123',
  });
  assert.equal(badIdRes.status, 400);
  assert.equal(badIdRes.json.error.code, 'container_console_id_invalid');

  const extraFieldRes = await owner.api('POST', '/api/terminal/capabilities', {
    scope: 'docker_container',
    dockerProjectId: project.id,
    containerId: validContainerId,
    user: 'root',
  });
  assert.equal(extraFieldRes.status, 400);

  const missingProjRes = await owner.api('POST', '/api/terminal/capabilities', {
    scope: 'docker_container',
    dockerProjectId: '99999999-9999-4999-8999-999999999999',
    containerId: validContainerId,
  });
  assert.equal(missingProjRes.status, 404);

  // Single-engine rule: ttyd-sessions MUST reject docker_container capability with 409 without invoking ttyd
  const ownerSession = await owner.api('GET', '/api/auth/session');
  assert.equal(ownerSession.status, 200);
  const issued = fx.terminalCapabilityRegistry.issue({
    sessionId: ownerSession.json.data.id,
    userId: ownerSession.json.data.user.id,
    target: {
      scope: 'docker_container',
      serverId: fx.serverId,
      dockerProjectId: project.id,
      projectName: project.projectName,
      serviceName: 'web',
      containerId: validContainerId,
      containerName: 'console_rbac_proj-web-1',
      user: '65534:65534',
      uid: 65534,
      gid: 65534,
      cwd: '/',
      shell: '/bin/sh',
    },
  });
  const ttydRes = await owner.api('POST', '/api/terminal/ttyd-sessions', {
    capability: issued.capability,
  });
  assert.equal(ttydRes.status, 409);
  assert.equal(ttydRes.json.error.code, 'ttyd_docker_container_unsupported');
  assert.equal(fx.getTtydStartCalled(), 0);
});

test('terminal capability, resolver, websocket RBAC, and Docker Compose lifecycle fencing enforce non-root single-engine invariants', async () => {
  const liveSessions = createLiveSessionRegistry({ requireGenerationBoundary: false });
  const capabilities = createTerminalCapabilityRegistry({ liveSessions });
  const serverId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const containerId = 'b'.repeat(64);
  const validTarget = {
    scope: 'docker_container',
    serverId,
    dockerProjectId: projectId,
    projectName: 'demo_app',
    serviceName: 'web',
    containerId,
    containerName: 'demo_app-web-1',
    user: '65534:65534',
    uid: 65534,
    gid: 65534,
    cwd: '/',
    shell: '/bin/sh',
  };

  // Capability registry rejects root uid/gid, root user, non-allowlisted shell, short container IDs, and extra fields
  for (const badTarget of [
    { ...validTarget, uid: 0, user: '0:65534' },
    { ...validTarget, gid: 0, user: '65534:0' },
    { ...validTarget, user: 'root' },
    { ...validTarget, shell: '/usr/bin/python3' },
    { ...validTarget, containerId: 'deadbeef' },
    { ...validTarget, privileged: true },
  ]) {
    assert.throws(
      () => capabilities.issue({ sessionId: 'sess-1', userId: 'owner-1', target: badTarget }),
      (error) => error instanceof TerminalCapabilityError && error.code === 'terminal_target_invalid',
    );
  }

  // Resolver refuses docker_container by default (ttyd path), accepts only with allowDockerContainer: true (node-pty path)
  const statDocker = async (file) => (file === '/usr/bin/docker' ? { isFile: () => true } : Promise.reject(new Error('ENOENT')));
  const noop = async () => '';
  await assert.rejects(
    resolveTerminalTarget(validTarget, { statFn: statDocker, realpathFn: noop, readPasswd: noop }),
    (error) => error.code === 'terminal_target_invalid',
  );

  const sessionToken = 'c'.repeat(32);
  const resolved = await resolveTerminalTarget(validTarget, {
    statFn: statDocker,
    realpathFn: noop,
    readPasswd: noop,
    allowDockerContainer: true,
    consoleSessionId: sessionToken,
  });
  assert.equal(resolved.file, '/usr/bin/docker');
  assert.equal(resolved.hostPrivilegeDrop, false);
  assert.equal(resolved.cwd, '/');
  assert.equal(resolved.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
  assert.equal(resolved.env.DOCKER_CONFIG, '/nonexistent');
  assert.deepEqual(resolved.args, [
    '--host', 'unix:///var/run/docker.sock',
    'exec', '-i', '-t',
    '--user', '65534:65534',
    '--workdir', '/',
    containerId,
    '/bin/sh',
    '-c', 'exec "$1" -i',
    `yp-exec:${sessionToken}`,
    '/bin/sh',
  ]);

  // WebSocket RBAC requires Owner management with wildcard permission; preserves site Premium license gate
  const ownerSession = {
    user: { id: 'u-1', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  assert.equal(terminalWebSocketInternals.requireTerminalTargetAccess(ownerSession, validTarget), ownerSession);
  assert.throws(
    () => terminalWebSocketInternals.requireTerminalTargetAccess({
      user: { id: 'u-2', role: 'reseller', active: true },
      access: { mode: 'site_management', permissions: ['sites:manage'] },
      security: { managementAllowed: true },
    }, validTarget),
    (error) => error.code === 'terminal_docker_container_forbidden' && error.status === 403,
  );
  assert.throws(
    () => terminalWebSocketInternals.requireTerminalTargetAccess({
      user: { id: 'u-1', role: 'owner', active: true },
      access: { mode: 'management', permissions: [] },
      security: { managementAllowed: true },
    }, validTarget),
    (error) => error.code === 'terminal_docker_container_forbidden' && error.status === 403,
  );
  assert.deepEqual(terminalWebSocketInternals.auditResource(validTarget), {
    resourceType: 'docker_project',
    resourceId: projectId,
    scope: 'docker_container',
  });

  // Live session fencing during Compose stop/restart/remove revokes active consoles & blocks new issuance until released
  const terminatedReasons = [];
  liveSessions.register({
    sessionId: 'sess-1',
    userId: 'owner-1',
    dockerProjectId: projectId,
    containerId,
    terminate: (reason) => terminatedReasons.push(reason),
  });
  let fencedDuringStop = false;
  const localCompose = createLocalDockerComposeOperation({
    liveSessions,
    materialize: async (payload) => ({
      projectId: payload.projectId,
      projectName: 'demo_app',
      projectRevision: payload.expectedProjectRevision,
      environmentRevision: payload.expectedEnvironmentRevision,
      composeSha256: payload.expectedComposeSha256,
      document: 'services:\n  web:\n    image: nginx:alpine\n',
      environment: {},
      credentials: [],
    }),
    manager: {
      build: async () => ({}),
      pull: async () => ({}),
      start: async () => ({}),
      restart: async () => ({}),
      stop: async (bundle) => {
        // During stop, active console was revoked and new capabilities are fenced with 409
        assert.throws(
          () => capabilities.issue({ sessionId: 'sess-1', userId: 'owner-1', target: validTarget }),
          (error) => error instanceof TerminalCapabilityError && error.code === 'terminal_docker_project_busy' && error.status === 409,
        );
        fencedDuringStop = true;
        return {
          projectId: bundle.projectId,
          projectRevision: bundle.projectRevision,
          environmentRevision: bundle.environmentRevision,
          composeSha256: bundle.composeSha256,
          action: 'stop',
          runtimeState: 'stopped',
          executed: true,
          sideEffects: true,
        };
      },
    },
    receiptStore: { write: async () => {} },
  });

  await localCompose.execute(
    OPERATIONS.DOCKER_COMPOSE_STOP,
    {
      projectId,
      expectedProjectRevision: 1,
      expectedEnvironmentRevision: 0,
      expectedComposeSha256: 'd'.repeat(64),
    },
    {
      jobId: 'job-stop-1',
      serverId,
      resourceType: 'docker_project',
      resourceId: projectId,
    },
  );
  assert.equal(fencedDuringStop, true);
  assert.deepEqual(terminatedReasons, ['docker_compose_stop']);

  // After stop finishes, fence is released
  assert.equal(liveSessions.assertDockerProjectOpen(projectId), true);
});

test('deterministic container exec cleanup helpers bind exact session marker, parse /proc stat, and never select container PID 1', () => {
  const containerId = 'e'.repeat(64);
  const token = 'f'.repeat(32);
  const args = buildContainerConsoleExecArgs({
    containerId,
    uid: 65534,
    gid: 65534,
    cwd: '/app',
    shell: '/bin/sh',
    consoleSessionId: token,
  });
  assert.equal(args[args.length - 2], `yp-exec:${token}`);

  assert.equal(matchExecInspectForSession({
    ContainerID: containerId,
    ProcessConfig: { arguments: ['-c', 'exec "$1" -i', `yp-exec:${token}`, '/bin/sh'] },
  }, { containerId, consoleSessionId: token }), true);
  assert.equal(matchExecInspectForSession({
    ContainerID: '0'.repeat(64),
    ProcessConfig: { arguments: ['-c', 'exec "$1" -i', `yp-exec:${token}`, '/bin/sh'] },
  }, { containerId, consoleSessionId: token }), false);
  assert.equal(matchExecInspectForSession({
    ContainerID: containerId,
    ProcessConfig: { arguments: ['-c', 'exec "$1" -i', 'yp-exec:00000000000000000000000000000000', '/bin/sh'] },
  }, { containerId, consoleSessionId: token }), false);

  const parsed = parseProcStat('4120 (sh) S 1000 4120 4120 0 -1 4194304 100 0 0 0 1 0 0 0 20 0 1 0 998877 0 0');
  assert.deepEqual(parsed, { pid: 4120, ppid: 1000, pgid: 4120, sid: 4120, state: 'S', starttime: '998877' });

  // Container PID 1 (host pid 4000), unrelated nginx worker (host pid 4001), exec leader (4120) + child (4121) + subchild (4122)
  const selected = selectContainerSessionPids([
    { pid: 4000, ppid: 3999, pgid: 4000, sid: 4000, state: 'S', starttime: '100' },
    { pid: 4001, ppid: 4000, pgid: 4000, sid: 4000, state: 'S', starttime: '101' },
    { pid: 4120, ppid: 3999, pgid: 4120, sid: 4120, state: 'S', starttime: '200' },
    { pid: 4121, ppid: 4120, pgid: 4121, sid: 4120, state: 'S', starttime: '201' },
    { pid: 4122, ppid: 4121, pgid: 4121, sid: 4120, state: 'S', starttime: '202' },
  ], { leaderPid: 4120, containerInitPid: 4000 });
  assert.deepEqual(selected.map((p) => p.pid), [4120, 4121, 4122]);

  // Linux pidfd boundary: strictly uses pidfd_open + post-open verification + pidfd_send_signal (no plain process.kill)
  const py = dockerContainerConsoleCleanupInternals.containerPidfdCleanupPython;
  assert.match(py, /os\.pidfd_open\(/);
  assert.match(py, /if post is None:\n\s+os\.close\(fd\);continue/);
  assert.match(py, /signal\.pidfd_send_signal\(/);
  assert.doesNotMatch(py, /os\.kill\(/);

  // Safe diagnostic failure line formatting (bounded, no secrets)
  const line = formatContainerCleanupFailureLine({
    containerId,
    consoleSessionId: token,
    reason: 'docker_unavailable',
  });
  assert.equal(line, `[yunpanel-api] docker container console cleanup unverified container=${containerId.slice(0, 12)} session=${token.slice(0, 8)} reason=docker_unavailable`);
});

test('cleanupDockerContainerExec fails closed with metadata on docker_unavailable/exec_not_found and retries immediate-close discovery', async () => {
  const containerId = 'e'.repeat(64);
  const token = 'f'.repeat(32);

  // 1. docker_unavailable NEVER returns verified: true and emits safe failure metadata
  const loggedUnavailable = [];
  const unavailable = await cleanupDockerContainerExec({
    containerId,
    consoleSessionId: token,
    platform: 'linux',
    discoveryTimeoutMs: 10,
    timeoutMs: 50,
    sleepFn: async () => {},
    dockerGetJson: async () => ({ status: 500, data: null }),
    onCleanupError: (event) => loggedUnavailable.push(event),
  });
  assert.equal(unavailable.verified, false);
  assert.equal(unavailable.reason, 'docker_unavailable');
  assert.equal(loggedUnavailable.length, 1);
  assert.match(loggedUnavailable[0].line, /reason=docker_unavailable/);

  // 2. exec_not_found after discovery retries NEVER returns verified: true
  let notFoundScans = 0;
  const loggedNotFound = [];
  const notFound = await cleanupDockerContainerExec({
    containerId,
    consoleSessionId: token,
    platform: 'linux',
    discoveryTimeoutMs: 40,
    timeoutMs: 80,
    sleepFn: () => new Promise((resolve) => setTimeout(resolve, 15)),
    dockerGetJson: async () => {
      notFoundScans += 1;
      return { status: 200, data: { State: { Running: true, Pid: 4000 }, ExecIDs: [] } };
    },
    onCleanupError: (event) => loggedNotFound.push(event),
  });
  assert.ok(notFoundScans >= 2, 'must retry discovery briefly on immediate close');
  assert.equal(notFound.verified, false);
  assert.equal(notFound.reason, 'exec_not_found');
  assert.equal(loggedNotFound.length, 1);
  assert.match(loggedNotFound[0].line, /reason=exec_not_found/);

  // 3. Late-appearing exec discovered on second scan triggers pidfdDrain and confirms exit
  let containerCalls = 0;
  let execStatusCalls = 0;
  const drained = [];
  const execId = '1'.repeat(64);
  const recovered = await cleanupDockerContainerExec({
    containerId,
    consoleSessionId: token,
    platform: 'linux',
    discoveryTimeoutMs: 200,
    timeoutMs: 500,
    sleepFn: async () => {},
    dockerGetJson: async (_socket, reqPath) => {
      if (reqPath === `/containers/${containerId}/json`) {
        containerCalls += 1;
        return {
          status: 200,
          data: {
            State: { Running: true, Pid: 4000 },
            ExecIDs: containerCalls === 1 ? [] : [execId],
          },
        };
      }
      if (reqPath === `/exec/${execId}/json`) {
        execStatusCalls += 1;
        return {
          status: 200,
          data: {
            ID: execId,
            ContainerID: containerId,
            Running: execStatusCalls === 1,
            Pid: 4120,
            ProcessConfig: { arguments: ['-c', 'exec "$1" -i', `yp-exec:${token}`, '/bin/sh'] },
          },
        };
      }
      return { status: 404, data: null };
    },
    pidfdDrain: async (input) => {
      drained.push(input);
      return { ok: true, reason: 'terminated', signaledPids: [4120] };
    },
  });
  assert.equal(containerCalls, 2);
  assert.equal(drained.length, 1);
  assert.equal(drained[0].containerInitPid, 4000);
  assert.equal(drained[0].leaderPid, 4120);
  assert.equal(recovered.verified, true);
  assert.equal(recovered.reason, 'terminated');
  assert.deepEqual(recovered.signaledPids, [4120]);
});

test('terminal-process-manager runs in-container pidfd cleanup BEFORE signaling host docker exec CLI so background children cannot orphan', async () => {
  const liveSessions = createLiveSessionRegistry({ requireGenerationBoundary: false });
  const projectId = '22222222-2222-4222-8222-222222222222';
  const containerId = 'c'.repeat(64);
  const events = [];
  let resolveCleanup;
  const cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });

  const manager = createTerminalProcessManager({
    liveSessions,
    getuid: () => 0,
    statFn: async (file) => (file === '/usr/bin/docker' ? { isFile: () => true } : Promise.reject(new Error('ENOENT'))),
    realpathFn: async () => '/',
    readPasswd: async () => '',
    spawnPty: () => ({
      pid: 98765,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    }),
    killProcessGroup: (pid, sig) => {
      events.push(`host_signal:${pid}:${sig}`);
    },
    cleanupContainerExec: async ({ containerId: cid, consoleSessionId }) => {
      events.push(`container_cleanup_start:${cid}:${consoleSessionId.length}`);
      await cleanupPromise;
      events.push('container_cleanup_done');
      return { verified: true, reason: 'terminated', signaledPids: [] };
    },
  });

  const handle = await manager.open({
    target: {
      scope: 'docker_container',
      serverId: '11111111-1111-4111-8111-111111111111',
      dockerProjectId: projectId,
      projectName: 'demo_app',
      serviceName: 'web',
      containerId,
      containerName: 'demo_app-web-1',
      user: '65534:65534',
      uid: 65534,
      gid: 65534,
      cwd: '/',
      shell: '/bin/sh',
    },
    onData: () => {},
    onExit: () => {},
  });

  handle.close();
  // Before container cleanup finishes, host SIGHUP must NOT have been sent yet!
  assert.deepEqual(events, [`container_cleanup_start:${containerId}:32`]);

  resolveCleanup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, [
    `container_cleanup_start:${containerId}:32`,
    'container_cleanup_done',
    'host_signal:98765:SIGHUP',
  ]);
});
