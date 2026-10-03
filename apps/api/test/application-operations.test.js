import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createApplicationEnvironmentRegistry } from '../src/application-environment-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { withPanelContext, ownerManagementContext, readOnlyManagementContext } from './helpers/panel-auth-fixture.js';

const customerAuthContext = (websiteIds = []) => Object.freeze({
  user: Object.freeze({
    id: 'customer-1',
    username: 'cust-user',
    role: 'customer',
    hosting: { kind: 'customer' },
    websiteIds,
  }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
});

function nodeRuntime(overrides = {}) {
  return {
    nodeMajor: 24,
    packageManager: 'npm',
    installMode: 'ci',
    buildScript: null,
    mode: 'production',
    documentRoot: '.',
    startMode: 'node',
    entryFile: 'server.js',
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 30,
    restartPolicy: 'on-failure',
    ...overrides,
  };
}

async function fixture(t) {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'ops-server' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'ops-host' });
  const serverId = enrolled.server.id;

  const applicationRegistry = createApplicationRegistry({
    serverExists: async (id) => id === serverId,
  });

  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => id === serverId,
    getApplication: async (id) => applicationRegistry.getApplication(id),
    getDockerWorkload: async (id) => ({
      id,
      serverId,
      name: 'docker-workload',
      managementMode: 'external',
      proxyTarget: { host: '127.0.0.1', port: 8080, websocket: true },
    }),
  });
  await websiteRegistry.init();

  const applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
    masterKey: Buffer.alloc(32, 9),
    applicationExists: async (id) => Boolean(await applicationRegistry.getApplication(id)),
  });

  const jobRegistry = createJobRegistry();

  // Mock log readers
  const journalLogReader = {
    async query(opts) {
      return {
        entries: [
          { timestamp: '2026-10-03T10:00:00.000Z', level: 'info', unit: 'yunpanel-node.service', message: 'Node app running on port 3100' },
        ],
        page: { limit: opts.limit, hasMore: false },
        range: { since: opts.since, until: opts.until },
      };
    },
  };

  const nginxLogReader = {
    async query(opts) {
      return {
        entries: [
          { timestamp: '2026-10-03T10:00:00.000Z', level: 'info', source: 'nginx', stage: opts.kind, message: 'GET / 200 OK' },
        ],
        page: { limit: opts.limit, hasMore: false },
        range: { since: opts.since, until: opts.until },
      };
    },
  };

  const siteHealthService = {
    async inspectSiteHealth({ websiteId }) {
      return { websiteId, status: 'operational', healthy: true };
    },
  };

  // 1. Create Node.js Application
  const nodeAppId = randomUUID();
  const nodeRel0 = randomUUID();
  const nodeRel1 = randomUUID();
  await applicationRegistry.createNodeApplication({
    applicationId: nodeAppId,
    serverId,
    name: 'Node Application',
    repositoryUrl: 'https://github.com/example/node-app',
    branch: 'main',
    runtime: nodeRuntime(),
  });
  const nodeService = `yunpanel-node-${createHash('sha256').update(nodeAppId).digest('hex').slice(0, 16)}.service`;
  await applicationRegistry.markDeploying(nodeAppId, nodeRel0);
  await applicationRegistry.markDeployed(nodeAppId, {
    deploymentId: nodeRel0,
    releaseId: nodeRel0,
    previousReleaseId: null,
    commitSha: '0'.repeat(40),
    serviceName: nodeService,
    port: 3100,
    healthPath: '/health',
    healthy: true,
  });
  await applicationRegistry.markDeploying(nodeAppId, nodeRel1);
  await applicationRegistry.markDeployed(nodeAppId, {
    deploymentId: nodeRel1,
    releaseId: nodeRel1,
    previousReleaseId: nodeRel0,
    commitSha: '1'.repeat(40),
    serviceName: nodeService,
    port: 3100,
    healthPath: '/health',
    healthy: true,
  });

  // 2. Create Python Application (YunPanel Product Extension)
  const pyRel0 = randomUUID();
  const pyRel1 = randomUUID();
  const pythonApp = await applicationRegistry.createPythonApplication({
    serverId,
    name: 'Python Application',
    repositoryUrl: 'https://github.com/example/python-app',
    branch: 'main',
    runtime: {
      pythonVersion: '3.12',
      appServer: 'gunicorn',
      entryPoint: 'app:wsgi',
      workers: 2,
    },
  });
  await applicationRegistry.markDeploying(pythonApp.id, pyRel0);
  await applicationRegistry.markDeployed(pythonApp.id, {
    deploymentId: pyRel0,
    releaseId: pyRel0,
    previousReleaseId: null,
    commitSha: 'a'.repeat(40),
  });
  await applicationRegistry.markDeploying(pythonApp.id, pyRel1);
  await applicationRegistry.markDeployed(pythonApp.id, {
    deploymentId: pyRel1,
    releaseId: pyRel1,
    previousReleaseId: pyRel0,
    commitSha: 'b'.repeat(40),
  });

  // 3. Create Websites
  const nodeSite = await websiteRegistry.createWebsite({
    serverId,
    name: 'nodesite.example.test',
    applicationId: nodeAppId,
    runtimeType: 'node',
  });

  const pythonSite = await websiteRegistry.createWebsite({
    serverId,
    name: 'pythonsite.example.test',
    applicationId: pythonApp.id,
    runtimeType: 'python',
  });

  const phpAppId = randomUUID();
  await applicationRegistry.createPhpApplication({
    applicationId: phpAppId,
    serverId,
    name: 'PHP Application',
  });

  const phpSite = await websiteRegistry.createWebsite({
    serverId,
    name: 'phpsite.example.test',
    applicationId: phpAppId,
    runtimeType: 'php',
  });

  const dockerWorkloadId = randomUUID();
  const dockerSite = await websiteRegistry.createWebsite({
    serverId,
    name: 'dockersite.example.test',
    runtimeType: 'docker',
    dockerWorkloadId,
  });

  const unboundSite = await websiteRegistry.createWebsite({
    serverId,
    name: 'unboundsite.example.test',
    runtimeType: 'proxy',
  });

  let activeAuthContext = ownerManagementContext;

  const app = createApp({
    environment: 'production',
    registry: serverRegistry,
    websiteRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    jobRegistry,
    siteHealthService,
    journalLogReader,
    nginxLogReader,
  });

  const wrapped = withPanelContext(app, (req) => {
    if (req.headers['x-test-role'] === 'customer') {
      const allowed = (req.headers['x-allowed-sites'] ?? '').split(',').filter(Boolean);
      return customerAuthContext(allowed);
    }
    if (req.headers['x-test-role'] === 'read_only') {
      return readOnlyManagementContext;
    }
    return activeAuthContext;
  });

  const server = http.createServer(wrapped).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const request = (pathname, { method = 'GET', body = null, headers = {} } = {}) => {
    return fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(body !== null ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  };

  return {
    serverId,
    serverRegistry,
    websiteRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    jobRegistry,
    nodeSite,
    pythonSite,
    phpSite,
    dockerSite,
    dockerWorkloadId,
    unboundSite,
    nodeAppId,
    nodeRel0,
    nodeRel1,
    pythonAppId: pythonApp.id,
    pyRel0,
    pyRel1,
    request,
    setAuth: (ctx) => { activeAuthContext = ctx; },
  };
}

test('GET /api/websites/:websiteId/application returns mapped runtime context for Node, Python, PHP, Docker and unbound', async (t) => {
  const f = await fixture(t);

  // 1. Node.js bound site
  const nodeRes = await f.request(`/api/websites/${f.nodeSite.id}/application`);
  assert.equal(nodeRes.status, 200);
  const nodeData = (await nodeRes.json()).data;
  assert.equal(nodeData.websiteId, f.nodeSite.id);
  assert.equal(nodeData.applicationId, f.nodeAppId);
  assert.equal(nodeData.runtimeType, 'node');
  assert.equal(nodeData.isProductExtension, false);
  assert.equal(nodeData.productExtensionLabel, null);
  assert.equal(nodeData.currentReleaseId, f.nodeRel1);
  assert.equal(nodeData.previousReleaseId, f.nodeRel0);
  assert.equal(nodeData.health.healthy, true);
  assert.ok(nodeData.actions.includes('deploy'));
  assert.ok(nodeData.actions.includes('rollback'));
  assert.ok(nodeData.actions.includes('restart'));
  assert.ok(nodeData.actions.includes('process'));

  // 2. Python bound site (YunPanel Product Extension)
  const pyRes = await f.request(`/api/websites/${f.pythonSite.id}/application`);
  assert.equal(pyRes.status, 200);
  const pyData = (await pyRes.json()).data;
  assert.equal(pyData.websiteId, f.pythonSite.id);
  assert.equal(pyData.applicationId, f.pythonAppId);
  assert.equal(pyData.runtimeType, 'python');
  assert.equal(pyData.isProductExtension, true);
  assert.equal(pyData.productExtensionLabel, 'Python (Ürün uzantısı)');
  assert.equal(pyData.currentReleaseId, f.pyRel1);
  assert.equal(pyData.previousReleaseId, f.pyRel0);
  assert.ok(pyData.actions.includes('deploy'));
  assert.ok(pyData.actions.includes('rollback'));
  assert.ok(pyData.actions.includes('restart'));

  // 3. PHP runtime site
  const phpRes = await f.request(`/api/websites/${f.phpSite.id}/application`);
  assert.equal(phpRes.status, 200);
  const phpData = (await phpRes.json()).data;
  assert.equal(phpData.websiteId, f.phpSite.id);
  assert.equal(phpData.runtimeType, 'php');
  assert.equal(phpData.isProductExtension, false);
  assert.equal(phpData.productExtensionLabel, null);
  assert.ok(phpData.actions.includes('wp_cli'));
  assert.ok(phpData.actions.includes('composer'));

  // 4. Docker runtime site (YunPanel Product Extension)
  const dockerRes = await f.request(`/api/websites/${f.dockerSite.id}/application`);
  assert.equal(dockerRes.status, 200);
  const dockerData = (await dockerRes.json()).data;
  assert.equal(dockerData.websiteId, f.dockerSite.id);
  assert.equal(dockerData.runtimeType, 'docker');
  assert.equal(dockerData.isProductExtension, true);
  assert.equal(dockerData.productExtensionLabel, 'Docker (Ürün uzantısı)');
  assert.equal(dockerData.dockerWorkloadId, f.dockerWorkloadId);
  assert.ok(dockerData.actions.includes('build'));
  assert.ok(dockerData.actions.includes('pull'));

  // 5. Unbound website
  const unboundRes = await f.request(`/api/websites/${f.unboundSite.id}/application`);
  assert.equal(unboundRes.status, 200);
  const unboundData = (await unboundRes.json()).data;
  assert.equal(unboundData.websiteId, f.unboundSite.id);
  assert.equal(unboundData.unbound, true);
  assert.equal(unboundData.isProductExtension, false);

  // 6. Non-existent website
  const notFound = await f.request(`/api/websites/${randomUUID()}/application`);
  assert.equal(notFound.status, 404);

  // 7. /runtime route alias
  const aliasRes = await f.request(`/api/websites/${f.nodeSite.id}/runtime`);
  assert.equal(aliasRes.status, 200);
  assert.equal((await aliasRes.json()).data.runtimeType, 'node');
});

test('Environment management under website application scope', async (t) => {
  const f = await fixture(t);

  // Initially empty
  const emptyRes = await f.request(`/api/websites/${f.nodeSite.id}/application/environment`);
  assert.equal(emptyRes.status, 200);
  const emptyData = await emptyRes.json();
  assert.deepEqual(emptyData.data, []);

  // PUT variable
  const putRes = await f.request(`/api/websites/${f.nodeSite.id}/application/environment/PORT_OVERRIDE`, {
    method: 'PUT',
    body: { value: '8080', secret: false },
  });
  assert.equal(putRes.status, 200);
  assert.equal((await putRes.json()).data.key, 'PORT_OVERRIDE');

  // PUT secret variable
  const putSecretRes = await f.request(`/api/websites/${f.nodeSite.id}/application/environment/API_SECRET`, {
    method: 'PUT',
    body: { value: 'super-secret-value-123', secret: true },
  });
  assert.equal(putSecretRes.status, 200);

  // List variables
  const listRes = await f.request(`/api/websites/${f.nodeSite.id}/application/environment`);
  assert.equal(listRes.status, 200);
  const listData = (await listRes.json()).data;
  assert.equal(listData.length, 2);
  const secretEntry = listData.find((item) => item.key === 'API_SECRET');
  assert.equal(secretEntry.secret, true);
  assert.equal(JSON.stringify(secretEntry).includes('super-secret-value-123'), false);

  // Environment status
  const statusRes = await f.request(`/api/websites/${f.nodeSite.id}/application/environment/status`);
  assert.equal(statusRes.status, 200);
  const statusData = (await statusRes.json()).data;
  assert.equal(statusData.variableCount, 2);
  assert.equal(statusData.secretCount, 1);

  // DELETE variable
  const delRes = await f.request(`/api/websites/${f.nodeSite.id}/application/environment/PORT_OVERRIDE`, {
    method: 'DELETE',
  });
  assert.equal(delRes.status, 204);

  // Verify deleted
  const afterDel = await f.request(`/api/websites/${f.nodeSite.id}/application/environment`);
  assert.equal((await afterDel.json()).data.length, 1);

  // Environment import
  const currentStatus = (await f.request(`/api/websites/${f.nodeSite.id}/application/environment/status`).then((r) => r.json())).data;
  const importRes = await f.request(`/api/websites/${f.nodeSite.id}/application/environment/import`, {
    method: 'POST',
    body: {
      confirmation: null,
      content: 'NEW_KEY=hello_world\nANOTHER_KEY=123',
      expectedRevision: currentStatus.savedRevision,
      mode: 'merge',
      secret: false,
    },
  });
  assert.equal(importRes.status, 200);

  // PHP site rejects environment
  const phpEnvRes = await f.request(`/api/websites/${f.phpSite.id}/application/environment`);
  assert.equal(phpEnvRes.status, 409);
  assert.equal((await phpEnvRes.json()).error.code, 'environment_not_supported');
});

test('Releases, deployment and rollback workflows mapped to website context', async (t) => {
  const f = await fixture(t);

  // 1. GET releases
  const relRes = await f.request(`/api/websites/${f.nodeSite.id}/application/releases`);
  assert.equal(relRes.status, 200);
  const relData = await relRes.json();
  assert.equal(relData.data.length, 2);
  assert.equal(relData.currentReleaseId, f.nodeRel1);
  assert.equal(relData.previousReleaseId, f.nodeRel0);

  // 2. Deploy via POST /api/websites/:websiteId/application/deploy
  const deployRes = await f.request(`/api/websites/${f.nodeSite.id}/application/deploy`, {
    method: 'POST',
    body: { gitTarget: { kind: 'branch', value: 'main' } },
  });
  assert.equal(deployRes.status, 202);
  const deployJson = await deployRes.json();
  assert.equal(deployJson.data.job.type, 'app.node.deploy');
  assert.equal(deployJson.data.job.resourceId, f.nodeAppId);

  // Clean up deployment state
  await f.jobRegistry.cancel(deployJson.data.job.id);
  await f.applicationRegistry.markFailed(f.nodeAppId, deployJson.data.job.id, 'test_cancelled');

  // 3. Rollback via POST /api/websites/:websiteId/application/rollback
  const rollbackRes = await f.request(`/api/websites/${f.nodeSite.id}/application/rollback`, {
    method: 'POST',
    body: { releaseId: f.nodeRel0 },
  });
  assert.equal(rollbackRes.status, 202);
  const rollbackJson = await rollbackRes.json();
  assert.equal(rollbackJson.data.job.type, 'app.node.rollback');
  assert.equal(rollbackJson.data.job.operation, OPERATIONS.APP_NODE_ROLLBACK);
  assert.equal(rollbackJson.data.application.id, f.nodeAppId);

  // Clean up node rollback job
  await f.jobRegistry.cancel(rollbackJson.data.job.id);
  await f.applicationRegistry.markFailed(f.nodeAppId, rollbackJson.data.job.id, 'test_cancelled');

  // 4. Rollback validation: unknown release
  const badRollback = await f.request(`/api/websites/${f.nodeSite.id}/application/rollback`, {
    method: 'POST',
    body: { releaseId: 'unknown-release-id' },
  });
  assert.equal(badRollback.status, 409);
  assert.equal((await badRollback.json()).error.code, 'invalid_rollback_release');

  // 5. Python site rollback enqueues app.python.rollback
  const pyRollbackRes = await f.request(`/api/websites/${f.pythonSite.id}/application/rollback`, {
    method: 'POST',
    body: { releaseId: f.pyRel0 },
  });
  assert.equal(pyRollbackRes.status, 202);
  const pyRollbackJson = await pyRollbackRes.json();
  assert.equal(pyRollbackJson.data.job.type, 'app.python.rollback');
  assert.equal(pyRollbackJson.data.job.operation, OPERATIONS.APP_PYTHON_ROLLBACK);

  // 6. PHP site deploy rejected
  const phpDeploy = await f.request(`/api/websites/${f.phpSite.id}/application/deploy`, {
    method: 'POST',
    body: {},
  });
  assert.equal(phpDeploy.status, 409);
  assert.equal((await phpDeploy.json()).error.code, 'deployment_not_supported');
});

test('Process control and restart operations under website scope', async (t) => {
  const f = await fixture(t);

  // 1. Restart Node application
  const restartRes = await f.request(`/api/websites/${f.nodeSite.id}/application/restart`, {
    method: 'POST',
  });
  assert.equal(restartRes.status, 202);
  const restartJob = (await restartRes.json()).data;
  assert.equal(restartJob.type, 'app.node.restart');
  assert.equal(restartJob.operation, OPERATIONS.APP_NODE_RESTART);

  // 2. Restart Python application
  const pyRestartRes = await f.request(`/api/websites/${f.pythonSite.id}/application/restart`, {
    method: 'POST',
  });
  assert.equal(pyRestartRes.status, 202);
  const pyRestartJob = (await pyRestartRes.json()).data;
  assert.equal(pyRestartJob.type, 'app.python.restart');
  assert.equal(pyRestartJob.operation, OPERATIONS.APP_PYTHON_RESTART);

  // Cancel earlier restart job so application is idle
  await f.jobRegistry.cancel(restartJob.id);

  // 3. Process control on Node application with exact confirmation
  const processRes = await f.request(`/api/websites/${f.nodeSite.id}/application/process`, {
    method: 'POST',
    body: {
      action: 'stop',
      confirmation: `node-process:${f.nodeAppId}:${f.nodeRel1}:stop`,
    },
  });
  assert.equal(processRes.status, 202);
  const processJob = (await processRes.json()).data;
  assert.equal(processJob.type, 'app.node.process');
  assert.equal(processJob.operation, OPERATIONS.APP_NODE_PROCESS);
  assert.equal(processJob.status, 'queued');

  // Cancel process job so application is idle
  await f.jobRegistry.cancel(processJob.id);

  // 4. Process control rejects bad confirmation
  const badConfirmation = await f.request(`/api/websites/${f.nodeSite.id}/application/process`, {
    method: 'POST',
    body: {
      action: 'stop',
      confirmation: 'wrong-confirmation-token',
    },
  });
  assert.equal(badConfirmation.status, 400);
  assert.equal((await badConfirmation.json()).error.code, 'node_process_confirmation_required');
});

test('Health inspection and log access in JSON, stream and download formats', async (t) => {
  const f = await fixture(t);

  // 1. Health inspection
  const healthRes = await f.request(`/api/websites/${f.nodeSite.id}/application/health`);
  assert.equal(healthRes.status, 200);
  const healthData = (await healthRes.json()).data;
  assert.equal(healthData.websiteId, f.nodeSite.id);
  assert.equal(healthData.healthy, true);
  assert.equal(healthData.status, 'active');
  assert.equal(healthData.port, 3100);
  assert.equal(healthData.healthPath, '/health');
  assert.ok(healthData.checkedAt);

  // 2. Logs - JSON format
  const jsonLogsRes = await f.request(`/api/websites/${f.nodeSite.id}/application/logs`);
  assert.equal(jsonLogsRes.status, 200);
  const jsonLogs = (await jsonLogsRes.json()).data;
  assert.ok(Array.isArray(jsonLogs.entries));
  assert.equal(jsonLogs.entries.length, 1);
  assert.ok(jsonLogs.entries[0].message.includes('Node app running'));

  // 3. Logs - Stream format (NDJSON)
  const streamLogsRes = await f.request(`/api/websites/${f.nodeSite.id}/application/logs/stream`);
  assert.equal(streamLogsRes.status, 200);
  assert.ok(streamLogsRes.headers.get('content-type').includes('application/x-ndjson'));
  const streamText = await streamLogsRes.text();
  assert.ok(streamText.includes('"type":"entry"'));

  // 4. Logs - Download format (text)
  const downloadLogsRes = await f.request(`/api/websites/${f.nodeSite.id}/application/logs/download`);
  assert.equal(downloadLogsRes.status, 200);
  assert.ok(downloadLogsRes.headers.get('content-disposition').includes('attachment; filename='));
  const downloadText = await downloadLogsRes.text();
  assert.ok(downloadText.includes('Node app running'));

  // 5. PHP site logs use Nginx log reader
  const phpLogsRes = await f.request(`/api/websites/${f.phpSite.id}/application/logs`);
  assert.equal(phpLogsRes.status, 200);
  const phpLogs = (await phpLogsRes.json()).data;
  assert.ok(phpLogs.entries[0].message.includes('GET / 200 OK'));
});

test('Fail-closed tenant boundary and read-only role protections', async (t) => {
  const f = await fixture(t);

  // 1. Customer with nodeSite access can view nodeSite application
  const customerAllowed = await f.request(`/api/websites/${f.nodeSite.id}/application`, {
    headers: {
      'x-test-role': 'customer',
      'x-allowed-sites': f.nodeSite.id,
    },
  });
  assert.equal(customerAllowed.status, 200);

  // 2. Customer attempting to access pythonSite (not granted) is rejected with 403 site_scope_forbidden
  const customerDenied = await f.request(`/api/websites/${f.pythonSite.id}/application`, {
    headers: {
      'x-test-role': 'customer',
      'x-allowed-sites': f.nodeSite.id, // pythonSite is NOT included
    },
  });
  assert.equal(customerDenied.status, 403);
  assert.ok(['tenant_boundary_forbidden', 'site_scope_forbidden'].includes((await customerDenied.json()).error.code));

  // 3. Read-Only user can read application, releases, health, logs
  const roApp = await f.request(`/api/websites/${f.nodeSite.id}/application`, {
    headers: { 'x-test-role': 'read_only' },
  });
  assert.equal(roApp.status, 200);

  const roRel = await f.request(`/api/websites/${f.nodeSite.id}/application/releases`, {
    headers: { 'x-test-role': 'read_only' },
  });
  assert.equal(roRel.status, 200);

  const roHealth = await f.request(`/api/websites/${f.nodeSite.id}/application/health`, {
    headers: { 'x-test-role': 'read_only' },
  });
  assert.equal(roHealth.status, 200);

  const roLogs = await f.request(`/api/websites/${f.nodeSite.id}/application/logs`, {
    headers: { 'x-test-role': 'read_only' },
  });
  assert.equal(roLogs.status, 200);

  // 4. Read-Only user is forbidden from performing mutations
  const roDeploy = await f.request(`/api/websites/${f.nodeSite.id}/application/deploy`, {
    method: 'POST',
    body: { gitTarget: { kind: 'branch', value: 'main' } },
    headers: { 'x-test-role': 'read_only' },
  });
  assert.equal(roDeploy.status, 403);
  assert.equal((await roDeploy.json()).error.code, 'forbidden');

  const roRestart = await f.request(`/api/websites/${f.nodeSite.id}/application/restart`, {
    method: 'POST',
    headers: { 'x-test-role': 'read_only' },
  });
  assert.equal(roRestart.status, 403);
  assert.equal((await roRestart.json()).error.code, 'forbidden');

  const roRollback = await f.request(`/api/websites/${f.nodeSite.id}/application/rollback`, {
    method: 'POST',
    body: { releaseId: f.nodeRel0 },
    headers: { 'x-test-role': 'read_only' },
  });
  assert.equal(roRollback.status, 403);
  assert.equal((await roRollback.json()).error.code, 'forbidden');

  const roEnv = await f.request(`/api/websites/${f.nodeSite.id}/application/environment/KEY`, {
    method: 'PUT',
    body: { value: 'val' },
    headers: { 'x-test-role': 'read_only' },
  });
  assert.equal(roEnv.status, 403);
  assert.equal((await roEnv.json()).error.code, 'forbidden');
});
