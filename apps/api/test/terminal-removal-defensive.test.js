import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createApplicationEnvironmentRegistry } from '../src/application-environment-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createApplicationRuntimeBindingRegistry } from '../src/application-runtime-binding-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';
import { createWebsiteRemovalCleanupAdapters } from '../src/website-removal-cleanup-adapters.js';
import { createWebsiteRemovalOperationRegistry } from '../src/website-removal-operation-registry.js';
import { createWebsiteRemovalPreview } from '../src/website-removal-plan.js';
import { previewResourceImpact } from '../src/resource-impact.js';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';
import { mountWebsiteRemovalRoutes, WebsiteRemovalHttpError } from '../src/website-removal-http.js';
import { startLocalRuntime } from '../src/local-runtime.js';
import { createSystemWatchdogService } from '../src/system-watchdog-service.js';
import * as terminalProcessManager from '../src/terminal-process-manager.js';

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
