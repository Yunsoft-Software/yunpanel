import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import express from 'express';

// Run existing client/web recovery wiring tests as baseline
import '../../web/test/provisioning-recovery-wiring.test.js';

import {
  mountWebsiteProvisioningRoutes,
  WebsiteProvisioningHttpError,
  websiteProvisioningHttpInternals,
} from '../src/website-provisioning-http.js';
import { requirePanelRouteAccess } from '../src/panel-http-guard.js';

const source = (file) => readFile(new URL(file, import.meta.url), 'utf8');

test('provisioning recovery HTTP routes enforce panel route access and strict parameter validators', async () => {
  const code = await source('../src/website-provisioning-http.js');

  // Route declarations use requirePanelRouteAccess guard
  assert.match(code, /app\.get\('\/api\/sites\/:websiteId\/provisioning\/latest',\s*requirePanelRouteAccess/);
  assert.match(code, /app\.get\('\/api\/sites\/provisioning\/:operationId',\s*requirePanelRouteAccess/);
  assert.match(code, /app\.post\('\/api\/sites\/provisioning\/:operationId\/continue',\s*requirePanelRouteAccess/);
  assert.match(code, /app\.post\('\/api\/sites\/provisioning\/:operationId\/steps\/:stepId\/retry',\s*requirePanelRouteAccess/);
  assert.match(code, /app\.post\('\/api\/sites\/provisioning\/:operationId\/steps\/:stepId\/compensate',\s*requirePanelRouteAccess/);

  // Exact confirmation tokens enforced for all mutation operations
  assert.match(code, /continueBody\(request\.body,\s*id\)/);
  assert.match(code, /retryBody\(request\.body,\s*id,\s*provisioningStepId\)/);
  assert.match(code, /compensateBody\(request\.body,\s*id,\s*provisioningStepId\)/);

  // Fail-closed tenant validation helper
  assert.match(code, /requireWebsiteAccess\(request,\s*operation\.websiteId/);
  assert.match(code, /extractActorTenant\(auth\)/);
  assert.match(code, /tenant_actor_inactive/);
});

test('provisioning recovery controller and panel wire multi-tenant session isolation and cleanup', async () => {
  const controllerCode = await source('../../web/src/workspace/provisioning-recovery.js');
  const panelCode = await source('../../web/src/workspace/ProvisioningRecoveryPanel.jsx');

  // 401 and 403 clear recovery records and approvals immediately
  assert.match(controllerCode, /if\s*\(error\?\.status === 401 \|\| error\?\.status === 403\)\s*\{\s*denied\(\);\s*return;\s*\}/);
  assert.match(controllerCode, /const denied = \(\) => publish\(\{\s*status: 'forbidden',\s*operation: null,\s*approval: null/);

  // Stale and error states clear approval and forbid new mutations
  assert.match(controllerCode, /status: uncertain \? 'uncertain' : state\.operation \? 'stale' : 'error',\s*approval: null/);
  assert.match(controllerCode, /if\s*\(disposed \|\| writing \|\| isCurrent\(\) !== true \|\| canManage\(\) !== true \|\| state\.status !== 'ready'/);

  // Preflight snapshot verification prevents mutation when record changes
  assert.match(controllerCode, /stamp\(latest\) !== approval\.snapshot \|\| !recoveryAllowed\(latest, approval\.action, approval\.stepId\)/);

  // Panel identity key ties component lifecycle to websiteId, user id, role, sessionVersion, and canManage
  assert.match(panelCode, /JSON\.stringify\(\[websiteId,\s*session\?\.user\?\.id,\s*session\?\.user\?\.role,\s*sessionVersion\(\),\s*canManage\]\)/);
  assert.match(panelCode, /<RecoveryPanel key=\{identity\}/);
});

test('job recovery commands and runtime enforce terminal status and isolation', async () => {
  const commandCode = await source('../src/job-recovery-command.js');
  const runtimeCode = await source('../src/job-recovery-runtime.js');

  assert.match(commandCode, /const TERMINAL_STATUSES = new Set\(\['succeeded', 'failed'\]\)/);
  assert.match(commandCode, /requireStoppedConsumers\(serviceStatus\)/);
  assert.match(commandCode, /reconcileTerminalRecovery/);

  assert.match(runtimeCode, /resolveJobRecoveryPaths/);
  assert.match(runtimeCode, /resolveRecoveryStorePath/);
  assert.match(runtimeCode, /PACKAGED_STATE_ROOT/);
});

test('provisioning HTTP server boundary enforces fail-closed authorization across roles and tenants', async () => {
  const localServerId = randomUUID();
  const siteAId = randomUUID();
  const siteBId = randomUUID();
  const siteAOpId = randomUUID();
  const siteBOpId = randomUUID();

  const websites = new Map([
    [siteAId, { id: siteAId, serverId: localServerId, customerId: 'cust-a' }],
    [siteBId, { id: siteBId, serverId: localServerId, customerId: 'cust-b' }],
  ]);

  const operations = new Map([
    [siteAOpId, {
      operationId: siteAOpId,
      websiteId: siteAId,
      ready: false,
      status: 'partial',
      progress: { required: 2, completed: 1, remaining: 1 },
      steps: [
        { id: 'unix_identity', kind: 'unix_identity', required: true, state: 'succeeded', error: null, compensation: { state: 'pending', error: null } },
        { id: 'nginx', kind: 'nginx', required: true, state: 'failed', error: 'nginx_failed', compensation: { state: 'failed', error: null } },
      ],
    }],
    [siteBOpId, {
      operationId: siteBOpId,
      websiteId: siteBId,
      ready: false,
      status: 'partial',
      progress: { required: 1, completed: 0, remaining: 1 },
      steps: [
        { id: 'database', kind: 'database', required: true, state: 'failed', error: 'db_failed', compensation: { state: 'pending', error: null } },
      ],
    }],
  ]);

  const mockRegistry = {
    get: async (id) => operations.get(id) || null,
    getLatestForWebsite: async (wid) => {
      for (const op of operations.values()) {
        if (op.websiteId === wid) return op;
      }
      return null;
    },
  };

  const executedMutations = [];
  const mockOrchestrator = {
    runNext: async (id, actor) => {
      executedMutations.push({ action: 'continue', id, actor });
      return { outcome: 'progressed', operation: operations.get(id) };
    },
    retryStep: async (id, stepId, actor) => {
      executedMutations.push({ action: 'retry', id, stepId, actor });
      return { outcome: 'progressed', operation: operations.get(id) };
    },
    compensateStep: async (id, stepId, actor) => {
      executedMutations.push({ action: 'compensate', id, stepId, actor });
      return { outcome: 'compensated', operation: operations.get(id) };
    },
    supportsCompensation: () => true,
  };

  const app = express();
  app.disable('x-powered-by');

  let currentAuth = null;
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });
  app.use(express.json());

  mountWebsiteProvisioningRoutes(app, {
    registry: mockRegistry,
    orchestrator: mockOrchestrator,
    websiteRegistry: { getWebsite: async (id) => websites.get(id) || null },
    localServerId,
  });

  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ code: err.code, message: err.message });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Unauthenticated request receives 401
    currentAuth = null;
    let res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`);
    assert.equal(res.status, 401);

    // 2. Read-only role cannot mutate (POST receives 403 forbidden)
    currentAuth = {
      id: 'sess-ro',
      user: { id: 'ro-user', role: 'read_only' },
      access: { mode: 'read_only', permissions: ['websites.read'] },
      security: { managementAllowed: false },
    };
    res = await fetch(`${base}/api/sites/provisioning/${siteAOpId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: `continue-site-provisioning:${siteAOpId}` }),
    });
    assert.equal(res.status, 403);

    // 3. Inactive tenant account receives 403 tenant_actor_inactive
    currentAuth = {
      id: 'sess-inactive',
      user: { id: 'inact-user', role: 'customer', active: false, websiteIds: [siteAId], hosting: { kind: 'customer', resellerId: null } },
      access: { mode: 'site_management' },
      security: { managementAllowed: true },
    };
    res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`);
    assert.equal(res.status, 403);
    const inactBody = await res.json();
    assert.equal(inactBody.code, 'tenant_actor_inactive');

    // 4. Site A manager can read Site A provisioning
    currentAuth = {
      id: 'sess-a',
      user: { id: 'sm-a', role: 'site_manager', active: true, websiteIds: [siteAId], hosting: { kind: 'customer', resellerId: null } },
      access: { mode: 'site_management' },
      security: { managementAllowed: true },
    };
    res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`);
    assert.equal(res.status, 200);
    const bodyA = await res.json();
    assert.equal(bodyA.data.operationId, siteAOpId);

    // 5. Site A manager CANNOT read Site B provisioning (404 fail-closed)
    res = await fetch(`${base}/api/sites/${siteBId}/provisioning/latest`);
    assert.equal(res.status, 404);

    // 6. Site A manager CANNOT access Site B operation by operationId (404 fail-closed)
    res = await fetch(`${base}/api/sites/provisioning/${siteBOpId}`);
    assert.equal(res.status, 404);

    // 7. Site A manager CANNOT mutate Site B operation (404 fail-closed)
    res = await fetch(`${base}/api/sites/provisioning/${siteBOpId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: `continue-site-provisioning:${siteBOpId}` }),
    });
    assert.equal(res.status, 404);

    // 8. Site A manager CAN mutate Site A operation with exact confirmation
    res = await fetch(`${base}/api/sites/provisioning/${siteAOpId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: `continue-site-provisioning:${siteAOpId}` }),
    });
    assert.equal(res.status, 202);
    assert.equal(executedMutations.length, 1);
    assert.equal(executedMutations[0].id, siteAOpId);
    assert.equal(executedMutations[0].actor.userId, 'sm-a');

    // 9. Mutation with wrong confirmation fails 400
    res = await fetch(`${base}/api/sites/provisioning/${siteAOpId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'wrong-confirmation-token' }),
    });
    assert.equal(res.status, 400);

    // 10. Owner can access both Site A and Site B
    currentAuth = {
      id: 'sess-owner',
      user: { id: 'owner-uid', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`);
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/sites/${siteBId}/provisioning/latest`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('provisioning recovery wires backend atomic lock and fail-closed concurrency protection', async () => {
  const httpCode = await source('../src/website-provisioning-http.js');
  const appCode = await source('../src/management-app.js');
  const controllerCode = await source('../../web/src/workspace/provisioning-recovery.js');

  // Backend wires siteMutationLock and translates SiteMutationLockError to 409
  assert.match(httpCode, /import\s*\{\s*SiteMutationLockError\s*\}\s*from\s*'\.\/site-mutation-lock\.js'/);
  assert.match(httpCode, /siteMutationLock\s*=\s*null/);
  assert.match(httpCode, /withOptionalLock\(operation\.websiteId/);
  assert.match(httpCode, /error\s*instanceof\s*SiteMutationLockError/);
  assert.match(appCode, /mountWebsiteProvisioningRoutes\([\s\S]*siteMutationLock/);

  // Client recovery controller enforces single POST on matching target, fail-closed on 409/429/5xx, and GET-only refresh
  assert.match(controllerCode, /approval\.operationId\s*!==\s*state\.operation\.operationId/);
  assert.match(controllerCode, /latest\.operationId\s*!==\s*approval\.operationId/);
  assert.match(controllerCode, /status:\s*uncertain\s*\?\s*'uncertain'\s*:\s*state\.operation\s*\?\s*'stale'\s*:\s*'error'/);
});

test('provisioning recovery wires mobile layout, keyboard focus trapping, dark theme tokens, and abort isolation', async () => {
  const panelCode = await source('../../web/src/workspace/ProvisioningRecoveryPanel.jsx');
  const panelKitCode = await source('../../web/src/workspace/PanelKit.jsx');
  const controllerCode = await source('../../web/src/workspace/provisioning-recovery.js');
  const workspaceCss = await source('../../web/src/workspace/workspace.css');
  const emberTheme = await source('../../web/src/workspace/ui/ember-theme.css');

  // 1. Mobile layout & overflow prevention: table-scroll, modal calculation, label word break
  assert.match(panelCode, /<div className="ws-table-scroll">/);
  assert.match(workspaceCss, /\.ws-table-scroll\s*\{[^}]*overflow-x:\s*auto;/);
  assert.match(workspaceCss, /\.ws-modal\s*\{[^}]*width:\s*min\(560px,\s*calc\(100vw\s*-\s*32px\)\)/);
  assert.match(emberTheme, /\.ws-modal\s+label\s+strong/);
  assert.match(emberTheme, /overflow-wrap:\s*anywhere;\s*word-break:\s*break-word;/);

  // 2. Keyboard focus trap, escape key, and focus restoration
  assert.match(panelKitCode, /event\.key === 'Tab'/);
  assert.match(panelKitCode, /event\.key === 'Escape'/);
  assert.match(panelKitCode, /previous\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(panelKitCode, /autoFocus/);

  // 3. Dark theme token usage and no hardcoded colors
  assert.match(emberTheme, /:root\[data-ws-theme='dark'\]/);
  assert.doesNotMatch(panelCode, /#[0-9a-fA-F]{3,6}/);

  // 4. Safe technical information disclosure (only operationId, websiteId, ready)
  assert.match(panelCode, /<details><summary>Teknik bilgiler ve tanılama<\/summary>/);
  assert.match(panelCode, /operation\.operationId/);
  assert.match(panelCode, /operation\.websiteId/);
  assert.match(panelCode, /operation\.ready/);
  assert.doesNotMatch(panelCode, /password|secret|token|credential/i);

  // 5. Abort != host rollback: cancel resets approval without mutation, abort signal stops request
  assert.match(panelCode, /onCancel=\{\(\) => client\.current\?\.cancel\(\)\}/);
  assert.match(controllerCode, /function cancel\(\)\s*\{\s*if\s*\(!disposed && !writing && isCurrent\(\) === true\)\s*publish\(\{\s*approval:\s*null\s*\}\);\s*\}/);
  assert.match(panelCode, /Sayfadan ayrılmak sunucuda başlamış bir işi geri almaz\./);
});
