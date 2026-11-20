import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDockerComposeObserver,
  createDockerComposeValidator,
  createDockerVolumeManager,
  dockerComposeManagerInternals,
} from '@yunpanel/host-runtime';
import { DOCKER_COMPOSE_OPERATIONS, OPERATIONS } from '@yunpanel/protocol';
import { apiKeyActor, createApiKeyActorAuthorizer } from '../src/api-key-actor.js';
import { createApiKeyStore } from '../src/api-key-store.js';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { createOwnerMfaPolicy } from '../src/owner-mfa-policy.js';
import { createDockerComposeApiHandler } from '../src/docker-compose-api-handler.js';
import { createDockerComposeOperationReceiptStore } from '../src/docker-compose-operation-receipt.js';
import { DockerComposeRecoveryError } from '../src/docker-compose-recovery.js';
import { createDockerComposeRuntime } from '../src/docker-compose-runtime.js';
import { createDockerVolumeOperationReceiptStore } from '../src/docker-volume-operation-receipt.js';
import {
  createDockerVolumeOperationsService,
  DockerVolumeOperationsError,
} from '../src/docker-volume-operations.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';
import {
  createLocalDockerVolumeOperation,
  LocalDockerVolumeOperationError,
} from '../src/local-docker-volume-operation.js';
import { createLocalHostOperations, createPanelJobAuthorizer } from '../src/local-host-operations.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import { createTenantSiteStore } from '../src/tenant-site-store.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

async function resolveLocalDockerCommand() {
  for (const candidate of ['/usr/bin/docker', '/usr/local/bin/docker']) {
    try {
      await access(candidate, fsConstants.X_OK);
      return { binary: candidate, composeBinary: null };
    } catch {
      // continue searching
    }
  }
  try {
    await access('/opt/homebrew/lib/docker/cli-plugins/docker-compose', fsConstants.X_OK);
    return {
      binary: '/opt/homebrew/bin/docker',
      composeBinary: '/opt/homebrew/lib/docker/cli-plugins/docker-compose',
    };
  } catch {
    return null;
  }
}

function createRealCliValidator(dockerCmd, rootDir) {
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

async function createRealClient(baseUrl, username, password) {
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(loginRes.status, 200, `login failed for ${username}`);
  const setCookies = loginRes.headers.getSetCookie();
  const cookieHeader = setCookies.map((item) => item.split(';')[0]).join('; ');
  const sessionRes = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(sessionRes.status, 200);
  const csrfToken = (await sessionRes.json()).data.csrfToken;
  assert.ok(csrfToken, `csrfToken missing for ${username}`);

  async function api(method, pathname, body = undefined) {
    const headers = { cookie: cookieHeader, origin: baseUrl };
    if (method !== 'GET' && method !== 'HEAD') {
      headers['x-csrf-token'] = csrfToken;
      if (body !== undefined) headers['content-type'] = 'application/json';
    }
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text };
  }

  return { api };
}

async function createRealFixture(t, {
  projectBackupLocked = async () => false,
  siteMutationLockOverride = undefined,
} = {}) {
  const dockerCmd = await resolveLocalDockerCommand();
  if (!dockerCmd) {
    t.skip('docker compose CLI not installed on this host');
    return null;
  }

  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'yp-docker-volume-delete-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const masterKeyBuf = randomBytes(32);
  const masterKey = masterKeyBuf.toString('hex');
  const authStore = createAuthStore({
    filePath: path.join(rootDir, 'auth.sqlite'),
    masterKey: masterKeyBuf,
  });
  t.after(() => authStore.close());

  const setup = authStore.issueSetupToken();
  await authStore.completeSetup({ setupToken: setup.token, username: 'owner-vol', password: 'OwnerVolPassword!2026' });
  const ownerSetupLogin = await authStore.login({ username: 'owner-vol', password: 'OwnerVolPassword!2026' });
  const ownerPolicy = createOwnerMfaPolicy({ store: authStore, required: false }).requireManagement;

  const resellerUser = await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'reseller-vol',
    password: 'ResellerVolPassword!2026',
    role: 'site_manager',
    websiteIds: [],
  });
  authStore.users.hostingAccounts.registerReseller(ownerSetupLogin.token, ownerPolicy, {
    userId: resellerUser.id,
    expectedUserRevision: resellerUser.revision,
    limits: { maxCustomers: 5, maxWebsites: 5 },
  });
  const customerUser = await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'customer-vol',
    password: 'CustomerVolPassword!2026',
    role: 'site_manager',
    websiteIds: [],
  });
  authStore.users.hostingAccounts.registerCustomer(ownerSetupLogin.token, ownerPolicy, {
    userId: customerUser.id,
    expectedUserRevision: customerUser.revision,
    resellerId: resellerUser.id,
  });
  await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'sitemgr-vol',
    password: 'SiteMgrVolPassword!2026',
    role: 'site_manager',
    websiteIds: [],
  });
  await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'readonly-vol',
    password: 'ReadOnlyVolPassword!2026',
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

  const siteMutationLock = siteMutationLockOverride === undefined
    ? createSiteMutationLock({ root: path.join(rootDir, 'locks') })
    : siteMutationLockOverride;

  const validateDockerCompose = createRealCliValidator(dockerCmd, rootDir);
  const volumeReceiptStore = createDockerVolumeOperationReceiptStore({
    root: path.join(rootDir, 'recovery-volumes'),
  });
  const dockerComposeRuntime = await createDockerComposeRuntime({
    env: {
      YUNPANEL_SERVER_STORE: path.join(rootDir, 'servers.json'),
      YUNPANEL_SECRET_MASTER_KEY: masterKey,
    },
    serverRegistry,
    jobRegistry,
    websiteRegistry,
    domainRegistry,
    siteMutationLock,
    projectBackupLocked,
    validateDockerCompose,
    observer: createDockerComposeObserver(),
    receiptStore: createDockerComposeOperationReceiptStore({ root: path.join(rootDir, 'recovery-compose') }),
    volumeManager: createDockerVolumeManager(),
    volumeReceiptStore,
  });

  let publicOrigin = 'http://127.0.0.1';
  const httpServer = http.createServer((req, res) => apiHandler(req, res));
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  publicOrigin = `http://127.0.0.1:${httpServer.address().port}`;

  const apiHandler = createAuthenticatedApi({
    store: authStore,
    publicOrigin,
    development: true,
    ownerMfaRequired: false,
    createHandler: () => createDockerComposeApiHandler({
      runtime: dockerComposeRuntime,
      domainRegistry,
      jobRegistry,
      siteMutationLock,
      localServerId: server.id,
      baseHandler: createApp({
        registry: serverRegistry,
        domainRegistry,
        websiteRegistry,
        jobRegistry,
        siteMutationLock,
        dockerComposeProjectRegistry: dockerComposeRuntime.projectRegistry,
        localServerId: server.id,
      }),
    }),
  });
  const baseUrl = publicOrigin;

  return {
    rootDir,
    baseUrl,
    authStore,
    serverRegistry,
    serverId: server.id,
    jobRegistry,
    siteMutationLock,
    validateDockerCompose,
    dockerComposeRuntime,
    volumeReceiptStore,
  };
}

const COMPOSE_TWO_VOLUMES = [
  'services:',
  '  app:',
  '    image: alpine:3.20',
  '    volumes:',
  '      - vol_del:/del',
  '      - vol_keep:/keep',
  '      - ./config:/app/config:ro',
  '      - /srv/shared:/shared',
  '      - /tmp/cache',
  'volumes:',
  '  vol_del: {}',
  '  vol_keep: {}',
  '',
].join('\n');

const COMPOSE_DETACHED_VOL_DEL = [
  'services:',
  '  app:',
  '    image: alpine:3.20',
  '    volumes:',
  '      - vol_keep:/keep',
  'volumes:',
  '  vol_keep: {}',
  '',
].join('\n');

test('real SQLite/HTTP RBAC denies unauthenticated, reseller, customer, site_manager, and read_only on all Docker volume routes', async (t) => {
  const fx = await createRealFixture(t);
  if (!fx) return;

  const owner = await createRealClient(fx.baseUrl, 'owner-vol', 'OwnerVolPassword!2026');
  const created = await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'vol_rbac_proj',
    document: COMPOSE_TWO_VOLUMES,
  });
  assert.equal(created.status, 201);
  const projectId = created.json.data.project.id;

  // Unauthenticated -> 401
  for (const [method, pathname, body] of [
    ['GET', `/api/docker/projects/${projectId}/volumes`, undefined],
    ['POST', `/api/docker/projects/${projectId}/volumes/delete-preview`, { volumeKey: 'vol_del' }],
    ['POST', `/api/docker/projects/${projectId}/volumes/delete`, { volumeKey: 'vol_del', expectedPreviewDigest: 'a'.repeat(64), confirmation: 'x' }],
  ]) {
    const res = await fetch(`${fx.baseUrl}${pathname}`, {
      method,
      headers: body ? { 'content-type': 'application/json', origin: fx.baseUrl } : { origin: fx.baseUrl },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(res.status, 401, `unauthenticated ${method} ${pathname} must be 401`);
  }

  // Non-owner roles -> 403
  for (const [username, password] of [
    ['reseller-vol', 'ResellerVolPassword!2026'],
    ['customer-vol', 'CustomerVolPassword!2026'],
    ['sitemgr-vol', 'SiteMgrVolPassword!2026'],
    ['readonly-vol', 'ReadOnlyVolPassword!2026'],
  ]) {
    const client = await createRealClient(fx.baseUrl, username, password);
    assert.equal((await client.api('GET', `/api/docker/projects/${projectId}/volumes`)).status, 403);
    assert.equal((await client.api('POST', `/api/docker/projects/${projectId}/volumes/delete-preview`, { volumeKey: 'vol_del' })).status, 403);
    assert.equal((await client.api('POST', `/api/docker/projects/${projectId}/volumes/delete`, {
      volumeKey: 'vol_del',
      expectedPreviewDigest: 'a'.repeat(64),
      confirmation: 'x',
    })).status, 403);
  }
});

test('real Compose CLI ownership, monotonic ownedVolumes, bind/ephemeral/unowned/cross-project underscore collision, and backup lock rejections', async (t) => {
  let backupLocked = false;
  const fx = await createRealFixture(t, { projectBackupLocked: async () => backupLocked });
  if (!fx) return;

  const owner = await createRealClient(fx.baseUrl, 'owner-vol', 'OwnerVolPassword!2026');
  const created = await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'shop',
    document: [
      'services:',
      '  app:',
      '    image: alpine:3.20',
      '    volumes:',
      '      - app_data:/data',
      '      - vol_del:/del',
      '      - ./config:/app/config:ro',
      '      - /srv/shared:/shared',
      '      - /tmp/cache',
      'volumes:',
      '  app_data: {}',
      '  vol_del: {}',
      '',
    ].join('\n'),
  });
  assert.equal(created.status, 201);
  const shop = created.json.data.project;
  assert.deepEqual(shop.ownedVolumes, ['app_data', 'vol_del']);

  // Detach vol_del in revision 2 -> project.ownedVolumes retains vol_del for immutable project.id ownership!
  const updated = await owner.api('PUT', `/api/docker/projects/${shop.id}`, {
    expectedRevision: shop.revision,
    document: [
      'services:',
      '  app:',
      '    image: alpine:3.20',
      '    volumes:',
      '      - app_data:/data',
      '      - ./config:/app/config:ro',
      '      - /srv/shared:/shared',
      '      - /tmp/cache',
      'volumes:',
      '  app_data: {}',
      '',
    ].join('\n'),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.data.volumes, ['app_data']);
  assert.deepEqual(updated.json.data.ownedVolumes, ['app_data', 'vol_del']);

  // Bind mounts rejected with 409 docker_volume_bind_mount_forbidden
  for (const bindKey of ['/srv/shared', './config', '/etc/passwd']) {
    const res = await owner.api('POST', `/api/docker/projects/${shop.id}/volumes/delete-preview`, { volumeKey: bindKey });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'docker_volume_bind_mount_forbidden');
  }

  // Ephemeral rejected with 409 docker_volume_ephemeral_unsupported
  const ephRes = await owner.api('POST', `/api/docker/projects/${shop.id}/volumes/delete-preview`, { volumeKey: 'ephemeral' });
  assert.equal(ephRes.status, 409);
  assert.equal(ephRes.json.error.code, 'docker_volume_ephemeral_unsupported');

  // Invalid keys / flags rejected with 400 docker_volume_key_invalid
  for (const badKey of ['', '--force', 'bad name', 'a*b']) {
    const res = await owner.api('POST', `/api/docker/projects/${shop.id}/volumes/delete-preview`, { volumeKey: badKey });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'docker_volume_key_invalid');
  }

  // Unowned / foreign volume rejected with 409 docker_volume_not_owned
  const foreignRes = await owner.api('POST', `/api/docker/projects/${shop.id}/volumes/delete-preview`, { volumeKey: 'unrelated_volume' });
  assert.equal(foreignRes.status, 409);
  assert.equal(foreignRes.json.error.code, 'docker_volume_not_owned');

  // Cross-project underscore collision: `shop` + `app_data` === `shop_app` + `data` === `shop_app_data`
  const colliding = await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'shop_app',
    document: 'services:\n  app:\n    image: alpine:3.20\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n',
  });
  assert.equal(colliding.status, 201);
  const crossRes = await owner.api('POST', `/api/docker/projects/${shop.id}/volumes/delete-preview`, { volumeKey: 'app_data' });
  assert.equal(crossRes.status, 409);
  assert.equal(crossRes.json.error.code, 'docker_volume_cross_project_referenced');

  // Backup lock blocks preview with 409 docker_compose_backup_conflict
  backupLocked = true;
  const backupRes = await owner.api('POST', `/api/docker/projects/${shop.id}/volumes/delete-preview`, { volumeKey: 'vol_del' });
  assert.equal(backupRes.status, 409);
  assert.equal(backupRes.json.error.code, 'docker_compose_backup_conflict');
  backupLocked = false;
});

test('shared SiteMutationLock fails closed 503 when missing and serializes inventory/project mutations against volume delete', async (t) => {
  const fx = await createRealFixture(t);
  if (!fx) return;

  const owner = await createRealClient(fx.baseUrl, 'owner-vol', 'OwnerVolPassword!2026');
  const created = await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'lock_vol_proj',
    document: COMPOSE_TWO_VOLUMES,
  });
  assert.equal(created.status, 201);
  const project = created.json.data.project;

  // Missing siteMutationLock fails closed 503 in queueDelete and localVolumeOperation
  const unlockedSvc = createDockerVolumeOperationsService({
    projectRegistry: fx.dockerComposeRuntime.projectRegistry,
    jobRegistry: fx.jobRegistry,
    volumeManager: createDockerVolumeManager(),
    validateDockerCompose: fx.validateDockerCompose,
    siteMutationLock: null,
  });
  await assert.rejects(
    unlockedSvc.queueDelete({
      projectId: project.id,
      volumeKey: 'vol_del',
      expectedPreviewDigest: 'a'.repeat(64),
      confirmation: 'docker-volume:delete:lock_vol_proj:vol_del:' + 'a'.repeat(64),
    }),
    (error) => error instanceof DockerVolumeOperationsError && error.code === 'docker_volume_lock_unavailable' && error.status === 503,
  );

  const unlockedLocal = createLocalDockerVolumeOperation({
    projectRegistry: fx.dockerComposeRuntime.projectRegistry,
    volumeManager: createDockerVolumeManager(),
    validateDockerCompose: fx.validateDockerCompose,
    siteMutationLock: null,
    receiptStore: fx.volumeReceiptStore,
  });
  await assert.rejects(
    unlockedLocal.execute(OPERATIONS.DOCKER_VOLUME_DELETE, {
      projectId: project.id,
      projectName: project.projectName,
      expectedProjectRevision: project.revision,
      expectedComposeSha256: project.composeSha256,
      volumeKey: 'vol_del',
      volumeName: 'lock_vol_proj_vol_del',
      volumeFingerprint: 'b'.repeat(64),
      previewDigest: 'c'.repeat(64),
    }, { serverId: fx.serverId, jobId: 'job-vol-lock-1', authorize: async () => {} }),
    (error) => error instanceof LocalDockerVolumeOperationError && error.code === 'docker_volume_lock_unavailable' && error.status === 503,
  );

  // Holding shared docker_inventory + docker_project + docker_volume locks blocks concurrent project create & update (409)
  await fx.siteMutationLock.withDockerVolumeOperationLocks(
    { serverId: fx.serverId, projectId: project.id, volumeName: 'lock_vol_proj_vol_del' },
    async () => {
      const concurrentCreate = await owner.api('POST', '/api/docker/projects', {
        serverId: fx.serverId,
        projectName: 'concurrent_other',
        document: 'services:\n  web:\n    image: alpine:3.20\n',
      });
      assert.equal(concurrentCreate.status, 409);
      assert.equal(concurrentCreate.json.error.code, 'site_mutation_locked');

      const concurrentUpdate = await owner.api('PUT', `/api/docker/projects/${project.id}`, {
        expectedRevision: project.revision,
        document: COMPOSE_DETACHED_VOL_DEL,
      });
      assert.equal(concurrentUpdate.status, 409);
      assert.equal(concurrentUpdate.json.error.code, 'site_mutation_locked');

      const previewStart = await owner.api('POST', `/api/docker/projects/${project.id}/operations/start/preview`);
      assert.equal(previewStart.status, 200);
      const concurrentStart = await owner.api('POST', `/api/docker/projects/${project.id}/operations/start`, {
        expectedPreviewDigest: previewStart.json.data.previewDigest,
        confirmation: previewStart.json.data.confirmation,
      });
      assert.equal(concurrentStart.status, 409);
      assert.equal(concurrentStart.json.error.code, 'site_mutation_locked');
    },
  );
});

test('two-phase 0600 pre-delete intent receipt blocks blind replay and recovery handles intent vs completed receipts safely', async (t) => {
  const fx = await createRealFixture(t);
  if (!fx) return;

  const owner = await createRealClient(fx.baseUrl, 'owner-vol', 'OwnerVolPassword!2026');
  const created = await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'receipt_proj',
    document: COMPOSE_TWO_VOLUMES,
  });
  const project = created.json.data.project;

  const fingerprint = 'd'.repeat(64);
  const digest = 'e'.repeat(64);
  const payload = {
    projectId: project.id,
    projectName: project.projectName,
    expectedProjectRevision: project.revision,
    expectedComposeSha256: project.composeSha256,
    volumeKey: 'vol_del',
    volumeName: 'receipt_proj_vol_del',
    volumeFingerprint: fingerprint,
    previewDigest: digest,
  };

  // Enqueue and claim a real durable DOCKER_VOLUME_DELETE job
  const job = await fx.jobRegistry.enqueue({
    serverId: fx.serverId,
    type: OPERATIONS.DOCKER_VOLUME_DELETE,
    operation: OPERATIONS.DOCKER_VOLUME_DELETE,
    resourceType: 'docker_project',
    resourceId: project.id,
    idempotencyKey: `docker-volume:delete:${project.id}:vol_del:${digest}`,
    payload,
  });
  const claimed = await fx.jobRegistry.claimNext(fx.serverId);
  assert.equal(claimed.job.id, job.id);

  // Persist phase: 'intent' (0600) simulating crash before absence verification
  const intentReceipt = await fx.volumeReceiptStore.writeIntent({
    serverId: fx.serverId,
    jobId: job.id,
    operation: OPERATIONS.DOCKER_VOLUME_DELETE,
    intent: {
      projectId: project.id,
      projectName: project.projectName,
      projectRevision: project.revision,
      composeSha256: project.composeSha256,
      volumeKey: 'vol_del',
      volumeName: 'receipt_proj_vol_del',
      volumeFingerprint: fingerprint,
      previewDigest: digest,
    },
  });
  assert.equal(intentReceipt.phase, 'intent');
  const fileStat = await stat(path.join(fx.rootDir, 'recovery-volumes', `${job.id}.json`));
  assert.equal(fileStat.mode & 0o777, 0o600);

  // Re-executing localVolumeOperation with existing intent receipt MUST fail closed without replaying docker volume rm
  await assert.rejects(
    fx.dockerComposeRuntime.localVolumeOperation.execute(OPERATIONS.DOCKER_VOLUME_DELETE, payload, {
      serverId: fx.serverId,
      jobId: job.id,
      authorize: async () => {},
    }),
    (error) => error instanceof LocalDockerVolumeOperationError && error.code === 'docker_volume_delete_recovery_required' && error.status === 409,
  );

  // Restart recovery sees running job with phase: 'intent' -> keeps pending with explicit reason (never falsely succeeds!)
  const reloadedJobsIntent = createDurableJobRegistry({
    filePath: path.join(fx.rootDir, 'jobs.json'),
    registryFactory: createJobRegistry,
    automaticReconciliation: true,
  });
  await reloadedJobsIntent.init();
  const recoveryRuntimeIntent = await createDockerComposeRuntime({
    env: {
      YUNPANEL_SERVER_STORE: path.join(fx.rootDir, 'servers.json'),
      YUNPANEL_SECRET_MASTER_KEY: randomBytes(32).toString('hex'),
    },
    serverRegistry: fx.serverRegistry,
    jobRegistry: reloadedJobsIntent,
    projectRegistry: fx.dockerComposeRuntime.projectRegistry,
    siteMutationLock: fx.siteMutationLock,
    validateDockerCompose: fx.validateDockerCompose,
    observer: createDockerComposeObserver(),
    receiptStore: createDockerComposeOperationReceiptStore({ root: path.join(fx.rootDir, 'recovery-compose-2') }),
    volumeManager: createDockerVolumeManager(),
    volumeReceiptStore: fx.volumeReceiptStore,
  });
  assert.ok(recoveryRuntimeIntent.recovery.pending.some((item) => item.jobId === job.id && item.reason === 'volume_delete_intent_interrupted'));

  // Corrupted/mismatched phase: 'intent' receipt MUST fail closed with docker_volume_recovery_receipt_mismatch
  const mismatchedReceiptStore = createDockerVolumeOperationReceiptStore({
    root: path.join(fx.rootDir, 'recovery-volumes-mismatch'),
  });
  await mismatchedReceiptStore.writeIntent({
    serverId: fx.serverId,
    jobId: job.id,
    operation: OPERATIONS.DOCKER_VOLUME_DELETE,
    intent: {
      projectId: project.id,
      projectName: project.projectName,
      projectRevision: project.revision,
      composeSha256: project.composeSha256,
      volumeKey: 'vol_del',
      volumeName: 'receipt_proj_vol_del',
      volumeFingerprint: 'f'.repeat(64), // mismatched fingerprint
      previewDigest: digest,
    },
  });
  await assert.rejects(
    createDockerComposeRuntime({
      env: {
        YUNPANEL_SERVER_STORE: path.join(fx.rootDir, 'servers.json'),
        YUNPANEL_SECRET_MASTER_KEY: randomBytes(32).toString('hex'),
      },
      serverRegistry: fx.serverRegistry,
      jobRegistry: reloadedJobsIntent,
      projectRegistry: fx.dockerComposeRuntime.projectRegistry,
      siteMutationLock: fx.siteMutationLock,
      validateDockerCompose: fx.validateDockerCompose,
      observer: createDockerComposeObserver(),
      receiptStore: createDockerComposeOperationReceiptStore({ root: path.join(fx.rootDir, 'recovery-compose-mismatch') }),
      volumeManager: createDockerVolumeManager(),
      volumeReceiptStore: mismatchedReceiptStore,
    }),
    (error) => error instanceof DockerComposeRecoveryError && error.code === 'docker_volume_recovery_receipt_mismatch',
  );

  // Promote receipt to phase: 'completed' -> recovery completes from exact receipt cleanly!
  await fx.volumeReceiptStore.writeCompleted({
    serverId: fx.serverId,
    jobId: job.id,
    operation: OPERATIONS.DOCKER_VOLUME_DELETE,
    result: {
      version: 1,
      projectId: project.id,
      projectName: project.projectName,
      projectRevision: project.revision,
      composeSha256: project.composeSha256,
      volumeKey: 'vol_del',
      volumeName: 'receipt_proj_vol_del',
      volumeFingerprint: fingerprint,
      previewDigest: digest,
      deleted: true,
      sideEffects: true,
    },
  });
  const reloadedJobsDone = createDurableJobRegistry({
    filePath: path.join(fx.rootDir, 'jobs.json'),
    registryFactory: createJobRegistry,
    automaticReconciliation: true,
  });
  await reloadedJobsDone.init();
  const recoveryRuntimeDone = await createDockerComposeRuntime({
    env: {
      YUNPANEL_SERVER_STORE: path.join(fx.rootDir, 'servers.json'),
      YUNPANEL_SECRET_MASTER_KEY: randomBytes(32).toString('hex'),
    },
    serverRegistry: fx.serverRegistry,
    jobRegistry: reloadedJobsDone,
    projectRegistry: fx.dockerComposeRuntime.projectRegistry,
    siteMutationLock: fx.siteMutationLock,
    validateDockerCompose: fx.validateDockerCompose,
    observer: createDockerComposeObserver(),
    receiptStore: createDockerComposeOperationReceiptStore({ root: path.join(fx.rootDir, 'recovery-compose-3') }),
    volumeManager: createDockerVolumeManager(),
    volumeReceiptStore: fx.volumeReceiptStore,
  });
  assert.ok(recoveryRuntimeDone.recovery.recovered.some((item) => item.jobId === job.id && item.source === 'volume_operation_receipt'));
  const finalJob = await reloadedJobsDone.getJob(job.id);
  assert.equal(finalJob.status, 'succeeded');
  assert.equal(finalJob.result.deleted, true);
  assert.equal(Object.hasOwn(finalJob.result, 'mountpoint'), false);

  // Failed DOCKER_VOLUME_DELETE jobs are strictly non-retryable (manual retry and transient requeue blocked)
  const failDigest = 'a'.repeat(64);
  const failPayload = { ...payload, previewDigest: failDigest };
  const failJob = await reloadedJobsDone.enqueue({
    serverId: fx.serverId,
    type: OPERATIONS.DOCKER_VOLUME_DELETE,
    operation: OPERATIONS.DOCKER_VOLUME_DELETE,
    resourceType: 'docker_project',
    resourceId: project.id,
    idempotencyKey: `docker-volume:delete:${project.id}:vol_del:${failDigest}`,
    payload: failPayload,
  });
  await reloadedJobsDone.claimNext(fx.serverId);
  const failed = await reloadedJobsDone.complete({
    serverId: fx.serverId,
    jobId: failJob.id,
    status: 'failed',
    error: { code: 'site_mutation_locked', message: 'Locked' },
  });
  await reloadedJobsDone.acknowledgeReconciliation({ serverId: fx.serverId, jobId: failJob.id });
  assert.equal(failed.manualRetryAllowed, false);
  assert.equal(failed.permanentError, true);
  await assert.rejects(
    reloadedJobsDone.retryJob({ jobId: failJob.id, serverId: fx.serverId }),
    (error) => error instanceof JobRegistryError && error.code === 'job_not_retryable' && error.status === 409,
  );
  await assert.rejects(
    reloadedJobsDone.enqueue({
      serverId: fx.serverId,
      type: OPERATIONS.DOCKER_VOLUME_DELETE,
      operation: OPERATIONS.DOCKER_VOLUME_DELETE,
      resourceType: 'docker_project',
      resourceId: project.id,
      idempotencyKey: `docker-volume:delete:${project.id}:vol_del:${failDigest}`,
      payload: failPayload,
      manual: true,
    }),
    (error) => error instanceof JobRegistryError && error.code === 'job_not_retryable' && error.status === 409,
  );
  const idempotentReturn = await reloadedJobsDone.enqueue({
    serverId: fx.serverId,
    type: OPERATIONS.DOCKER_VOLUME_DELETE,
    operation: OPERATIONS.DOCKER_VOLUME_DELETE,
    resourceType: 'docker_project',
    resourceId: project.id,
    idempotencyKey: `docker-volume:delete:${project.id}:vol_del:${failDigest}`,
    payload: failPayload,
  });
  assert.equal(idempotentReturn.status, 'failed');

  // Production createPanelJobAuthorizer + real API key store: reject API key fallback,
  // websiteId+scope:'server' bypass, mismatched serverId, website_provisioning, and non-owner roles
  const sessionInfo = await owner.api('GET', '/api/auth/session');
  assert.equal(sessionInfo.status, 200);
  const ownerUserId = sessionInfo.json.data.user.id;
  const ownerSessionId = sessionInfo.json.data.id;

  const apiKeyStore = createApiKeyStore({ filePath: path.join(fx.rootDir, 'api-keys.json') });
  const tenantSiteStore = createTenantSiteStore({ filePath: path.join(fx.rootDir, 'tenant-sites.json') });
  const { key: realApiKey } = await apiKeyStore.create({
    name: 'automation-key',
    parentDomain: 'tenant.example.test',
    portMin: 20000,
    portMax: 20100,
    createdBy: ownerUserId,
  });
  const tenantWebsiteId = '11111111-1111-4111-8111-111111111111';
  await tenantSiteStore.put({
    hostname: 'app.tenant.example.test',
    parentDomain: 'tenant.example.test',
    websiteId: tenantWebsiteId,
  });
  const authorizeApiKeyActor = createApiKeyActorAuthorizer({
    apiKeyStore,
    tenantSiteStore,
    getAutomationUser: (id) => (id === ownerUserId ? { id: ownerUserId, role: 'owner' } : null),
    ownerMfaRequired: false,
  });
  const authorizeWebsiteActor = async (actor, websiteId) => {
    const live = fx.authStore.getSessionById(actor.sessionId);
    if (!live) return authorizeApiKeyActor(actor, websiteId);
    return live.user.id === actor.userId && live.user.active !== false && live.user.role === actor.role ? actor : null;
  };
  const realBaseOps = createLocalHostOperations({
    authorizePanelJob: createPanelJobAuthorizer({
      authStore: fx.authStore,
      ownerMfaRequired: false,
      authorizeWebsiteActor,
    }),
  });
  const extended = fx.dockerComposeRuntime.extendLocalOperations(realBaseOps);
  const keyActor = apiKeyActor(realApiKey);

  // Confirm the real API key IS valid for its own tenant website (proving key fixture is live)...
  assert.ok(await authorizeApiKeyActor(keyActor, tenantWebsiteId));

  // ...and strictly FORBIDDEN on DOCKER_VOLUME_DELETE (both with and without websiteId, and on wrong serverId)
  for (const badAuth of [
    { kind: 'website_provisioning', role: 'owner', scope: 'server', serverId: fx.serverId },
    { kind: 'panel', role: 'reseller', scope: 'site', websiteId: tenantWebsiteId },
    { kind: 'panel', role: 'customer', scope: 'site', websiteId: tenantWebsiteId },
    { kind: 'panel', role: 'owner', scope: 'server', serverId: fx.serverId, websiteId: tenantWebsiteId, actorId: keyActor.userId, userId: keyActor.userId, sessionId: keyActor.sessionId },
    { kind: 'panel', role: 'owner', scope: 'server', serverId: '99999999-9999-4999-8999-999999999999', actorId: ownerUserId, userId: ownerUserId, sessionId: ownerSessionId },
  ]) {
    await assert.rejects(
      extended.executeOperation(OPERATIONS.DOCKER_VOLUME_DELETE, payload, {
        serverId: fx.serverId,
        jobId: 'job-bad-auth',
        resourceType: 'docker_project',
        resourceId: project.id,
        authorization: badAuth,
      }),
      (error) => error?.code === 'docker_volume_job_authorization_required' && error?.status === 403,
    );
  }
  // Direct authorizeExecution also rejects scope:'server' + websiteId and API key sessionId
  await assert.rejects(
    realBaseOps.authorizeExecution(OPERATIONS.DOCKER_VOLUME_DELETE, {
      serverId: fx.serverId,
      jobId: 'job-apikey-direct',
      resourceType: 'docker_project',
      resourceId: project.id,
      authorization: {
        kind: 'panel',
        actorId: keyActor.userId,
        userId: keyActor.userId,
        sessionId: keyActor.sessionId,
        role: 'owner',
        serverId: fx.serverId,
        scope: 'server',
      },
    }),
    (error) => error?.code === 'panel_job_actor_forbidden',
  );
  await assert.rejects(
    realBaseOps.authorizeExecution(OPERATIONS.DOCKER_VOLUME_DELETE, {
      serverId: fx.serverId,
      jobId: 'job-apikey-websiteid-bypass',
      resourceType: 'docker_project',
      resourceId: project.id,
      authorization: {
        kind: 'panel',
        actorId: keyActor.userId,
        userId: keyActor.userId,
        sessionId: keyActor.sessionId,
        role: 'owner',
        serverId: '99999999-9999-4999-8999-999999999999',
        scope: 'server',
        websiteId: tenantWebsiteId,
      },
    }),
    (error) => error?.code === 'panel_job_actor_forbidden',
  );

  // Revoking Owner's real SQLite session via POST /api/auth/logout blocks execution with panel_job_actor_forbidden
  const logoutRes = await owner.api('POST', '/api/auth/logout');
  assert.equal(logoutRes.status, 204);
  await assert.rejects(
    extended.executeOperation(OPERATIONS.DOCKER_VOLUME_DELETE, payload, {
      serverId: fx.serverId,
      jobId: 'job-revoked-session',
      resourceType: 'docker_project',
      resourceId: project.id,
      authorization: {
        kind: 'panel',
        actorId: ownerUserId,
        userId: ownerUserId,
        sessionId: ownerSessionId,
        role: 'owner',
        serverId: fx.serverId,
        scope: 'server',
      },
    }),
    (error) => error?.code === 'panel_job_actor_forbidden',
  );

  // Default stop/remove volume preservation invariant remains intact
  assert.equal(DOCKER_COMPOSE_OPERATIONS.length, 6);
  assert.deepEqual(dockerComposeManagerInternals.actions.get('remove'), ['down', '--remove-orphans']);
  assert.deepEqual(dockerComposeManagerInternals.actions.get('stop'), ['stop']);
});
