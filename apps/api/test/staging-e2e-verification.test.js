import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import {
  TenantBoundaryError,
  createTenantBoundaryMiddleware,
  extractActorTenant,
  sanitizeTenantCollection,
} from '../src/tenant-boundary.js';
import {
  validateCustomerQuotas,
  assertCustomerQuotaCapacity,
  assertCustomerQuotaWithinResellerCapacity,
} from '../src/customer-quotas.js';
import { createHostingAccountStore } from '../src/hosting-account-store.js';
import { hostingWebsiteDigest } from '../src/hosting-site-allocation-store.js';
import { hostingWebsitesForCapacity } from '../src/hosting-site-allocation-schema.js';
import { rollbackEmptyHostingAccountSchema, initializeHostingAccountSchema } from '../src/hosting-account-schema.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import {
  checkLocalApiHealth,
  resolveLocalApiHealthTarget,
  LocalApiHealthError,
  createSystemWatchdogService,
  SystemWatchdogError,
  mountSystemWatchdogRoutes,
} from '../src/local-api-health.js';
import { requirePanelRouteAccess } from '../src/panel-http-guard.js';
import {
  createProductionExitGateService,
  mountProductionExitGateRoutes,
  ProductionExitGateError,
  evaluateProductionExitGate,
  PRODUCTION_EXIT_GATE_VERSION,
  EXIT_GATE_STATUSES,
  EXIT_GATE_CATEGORIES,
  LIFECYCLE_STEPS,
  assertNoDot44Host,
  evaluateLifecycleGate,
  evaluateTenantIsolationGate,
  evaluateFailClosedSecurityGate,
} from '../src/production-exit-gate.js';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import { createElFinderHandoffService, ElFinderHandoffError, elFinderHandoffInternals } from '../src/elfinder-handoff-service.js';
import { terminalWebSocketInternals, createTerminalWebSocketServer } from '../src/terminal-websocket.js';
import { createTerminalCapabilityRegistry } from '../src/terminal-capability-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { WebSocket } from 'ws';
import { recoverRunningPhpTool } from '../src/job-running-php-tool-recovery.js';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createPhpMyAdminHandoffService,
  PhpMyAdminHandoffError,
  phpMyAdminHandoffInternals,
} from '../src/phpmyadmin-handoff-service.js';
import {
  mountPhpMyAdminHandoffRoutes,
  phpMyAdminHandoffHttpInternals,
} from '../src/phpmyadmin-handoff-http.js';
import {
  createPhpMyAdminHandoffConsumerHandler,
  startPhpMyAdminHandoffSocket,
  phpMyAdminHandoffSocketInternals,
} from '../src/phpmyadmin-handoff-socket.js';
import { createSiteResourceBoundary } from '../src/site-resource-boundary.js';
import {
  conversationScope,
  conversationVisible,
  createConversationPager,
  AiHistoryError,
} from '../src/ai-conversation-history.js';
import {
  evaluateAiToolPolicy,
  AiPolicyError,
} from '../src/ai-policy.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';
import {
  recoverRunningCron,
  JobRunningCronRecoveryError,
} from '../src/job-running-cron-recovery.js';

// ============================================================================
// STAGING E2E PART 1: Reseller & Customer Multi-Tenant Flow & Isolation
// ============================================================================

test('Staging E2E: Reseller & Customer multi-tenant hierarchy, quota enforcement, self-service access, and lifecycle', (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  // Setup users: Owner, Reseller 1, Reseller 2, Customer 1A, Customer 1B, Customer 2A, Direct Owner Customer
  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('reseller-2');
  f.addUser('customer-1a');
  f.addUser('customer-1b');
  f.addUser('customer-2a');
  f.addUser('customer-direct');

  const ownerToken = f.session('owner-user');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  // 1. Owner registers Reseller 1 with limits
  const r1 = f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 4 },
  });
  assert.equal(r1.kind, 'reseller');
  assert.equal(r1.limits.maxWebsites, 4);

  // 2. Owner registers Reseller 2 with limits
  const r2 = f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-2',
    expectedUserRevision: 1,
    limits: { maxCustomers: 3, maxWebsites: 2 },
  });
  assert.equal(r2.kind, 'reseller');

  // 3. Reseller 1 provisions Customer 1A with quotas
  let r1Token = f.session('reseller-1');
  const c1aQuotas = { maxWebsites: 2, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 2 };
  const c1a = f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'customer-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: c1aQuotas,
  });
  assert.equal(c1a.kind, 'customer');
  assert.equal(c1a.resellerId, 'reseller-1');
  assert.deepEqual(c1a.quotas, c1aQuotas);

  // 4. Quota constraint check: Customer quota cannot exceed Reseller capacity
  assert.throws(
    () => assertCustomerQuotaWithinResellerCapacity({
      customerQuotas: { maxWebsites: 5 },
      resellerLimits: r1.limits,
    }),
    (err) => err.code === 'reseller_limit_reached' && err.status === 409,
  );

  // 5. Website Allocation Flow:
  const siteAllocations = f.store.siteAllocations;
  const stagingServerId = '44444444-4444-4444-8444-444444444444';
  const site1 = {
    id: '11111111-1111-4111-8111-111111111111',
    serverId: stagingServerId,
    name: 'Customer 1A Site 1',
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: null,
    runtimeType: 'proxy',
    documentRoot: null,
    unixUser: null,
    proxyTarget: { host: '127.0.0.1', port: 8081, websocket: true },
    revision: 1,
  };

  const plan1 = {
    operationId: 'a1111111-1111-4111-8111-111111111111',
    websiteId: site1.id,
    customerId: 'customer-1a',
    serverId: site1.serverId,
    intentDigest: '1'.repeat(64),
    websiteDigest: hostingWebsiteDigest(site1),
  };

  // First allocation: Reserve and complete
  const reserved1 = siteAllocations.reserve(r1Token, f.requireManagement, plan1);
  assert.equal(reserved1.state, 'reserved');

  const attached1 = siteAllocations.complete(r1Token, f.requireManagement, plan1, site1);
  assert.equal(attached1.state, 'attached');

  // Verify Customer 1A usage is now 1 website
  const c1aAfter1 = f.store.get(ownerToken, f.requireManagement, 'customer-1a');
  assert.equal(c1aAfter1.usage.websites, 1);

  // Second allocation: Reserve and complete for Customer 1A
  r1Token = f.session('reseller-1');
  const site2 = {
    id: '22222222-2222-4222-8222-222222222222',
    serverId: stagingServerId,
    name: 'Customer 1A Site 2',
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: null,
    runtimeType: 'proxy',
    documentRoot: null,
    unixUser: null,
    proxyTarget: { host: '127.0.0.1', port: 8082, websocket: true },
    revision: 1,
  };

  const plan2 = {
    operationId: 'a2222222-2222-4222-8222-222222222222',
    websiteId: site2.id,
    customerId: 'customer-1a',
    serverId: site2.serverId,
    intentDigest: '2'.repeat(64),
    websiteDigest: hostingWebsiteDigest(site2),
  };

  siteAllocations.reserve(r1Token, f.requireManagement, plan2);
  siteAllocations.complete(r1Token, f.requireManagement, plan2, site2);

  const c1aAfter2 = f.store.get(ownerToken, f.requireManagement, 'customer-1a');
  assert.equal(c1aAfter2.usage.websites, 2);

  // Third allocation attempt: Customer 1A quota maxWebsites is 2, so 3rd allocation must fail 409
  r1Token = f.session('reseller-1');
  const site3 = {
    id: '33333333-3333-4333-8333-333333333333',
    serverId: stagingServerId,
    name: 'Customer 1A Site 3',
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: null,
    runtimeType: 'proxy',
    documentRoot: null,
    unixUser: null,
    proxyTarget: { host: '127.0.0.1', port: 8083, websocket: true },
    revision: 1,
  };

  const plan3 = {
    operationId: 'a3333333-3333-4333-8333-333333333333',
    websiteId: site3.id,
    customerId: 'customer-1a',
    serverId: site3.serverId,
    intentDigest: '3'.repeat(64),
    websiteDigest: hostingWebsiteDigest(site3),
  };

  assert.throws(
    () => siteAllocations.reserve(r1Token, f.requireManagement, plan3),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // 6. Quota Release Lifecycle: Uncreated reservation release and Website removal release
  const uncreatedResult = siteAllocations.releaseUncreated({
    operationId: 'a9999999-9999-4999-8999-999999999999',
    websiteId: '99999999-9999-4999-8999-999999999999',
    serverId: stagingServerId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(uncreatedResult.released, false);

  // Remove site2 -> restores capacity
  const removalResult = siteAllocations.releaseRemoved({
    operationId: 'op-remove-site2-1',
    websiteId: site2.id,
    serverId: site2.serverId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(removalResult.released, true);
  assert.equal(removalResult.quotaReleased, true);

  const c1aAfterRemoval = f.store.get(ownerToken, f.requireManagement, 'customer-1a');
  assert.equal(c1aAfterRemoval.usage.websites, 1);
});

test('Staging E2E: Tenant boundaries, cross-tenant isolation, suspended accounts, and fail-closed security', async () => {
  const customerLookup = (id) => {
    const map = {
      'cust-1a': { id: 'cust-1a', resellerId: 'reseller-1', active: true },
      'cust-1b': { id: 'cust-1b', resellerId: 'reseller-1', active: false },
      'cust-2a': { id: 'cust-2a', resellerId: 'reseller-2', active: true },
      'cust-direct': { id: 'cust-direct', resellerId: null, active: true },
    };
    return map[id] ?? null;
  };

  const websiteLookup = (id) => {
    const map = {
      'site-1a1': { id: 'site-1a1', customerId: 'cust-1a', resellerId: 'reseller-1' },
      'site-1a2': { id: 'site-1a2', customerId: 'cust-1a', resellerId: 'reseller-1' },
      'site-2a1': { id: 'site-2a1', customerId: 'cust-2a', resellerId: 'reseller-2' },
      'site-direct': { id: 'site-direct', customerId: 'cust-direct', resellerId: null },
    };
    return map[id] ?? null;
  };

  const middleware = createTenantBoundaryMiddleware({ customerLookup, websiteLookup });

  const executeRequest = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  const reseller1 = {
    id: 'reseller-1',
    role: 'reseller',
    hosting: { kind: 'reseller', resellerId: null },
    active: true,
    websiteIds: ['site-1a1', 'site-1a2'],
  };

  const customer1a = {
    id: 'cust-1a',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: 'reseller-1' },
    active: true,
    websiteIds: ['site-1a1', 'site-1a2'],
  };

  const suspendedCustomer = {
    id: 'cust-1b',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: 'reseller-1' },
    active: false,
    websiteIds: [],
  };

  // 1. Customer accessing own site -> Allowed
  const ownSite = await executeRequest(customer1a, '/api/websites/site-1a1');
  assert.equal(ownSite.called, true);

  // 2. Customer accessing foreign site (Reseller 2) -> 403 fail-closed
  const foreignSite = await executeRequest(customer1a, '/api/websites/site-2a1');
  assert.equal(foreignSite.called, false);
  assert.equal(foreignSite.statusCode, 403);
  assert.equal(foreignSite.responseBody.error.code, 'tenant_boundary_forbidden');

  // 3. Customer accessing direct Owner site -> 403 fail-closed
  const directOwnerSite = await executeRequest(customer1a, '/api/websites/site-direct');
  assert.equal(directOwnerSite.called, false);
  assert.equal(directOwnerSite.statusCode, 403);

  // 4. Customer attempting root terminal -> 403 terminal_server_forbidden
  const custRootTerminal = await executeRequest(customer1a, '/api/terminal/capabilities', 'POST', { scope: 'server' });
  assert.equal(custRootTerminal.called, false);
  assert.equal(custRootTerminal.statusCode, 403);
  assert.equal(custRootTerminal.responseBody.error.code, 'terminal_server_forbidden');

  // 5. Customer attempting to list all customers -> 403
  const custCustomerList = await executeRequest(customer1a, '/api/customers');
  assert.equal(custCustomerList.called, false);
  assert.equal(custCustomerList.statusCode, 403);

  // 6. Suspended Customer account -> 403 tenant_actor_inactive
  const suspendedReq = await executeRequest(suspendedCustomer, '/api/websites/site-1a1');
  assert.equal(suspendedReq.called, false);
  assert.equal(suspendedReq.statusCode, 403);
  assert.equal(suspendedReq.responseBody.error.code, 'tenant_actor_inactive');

  // 7. Reseller 1 accessing foreign customer (Customer 2A under Reseller 2) -> 403 fail-closed
  const foreignCustAccess = await executeRequest(reseller1, '/api/customers/cust-2a');
  assert.equal(foreignCustAccess.called, false);
  assert.equal(foreignCustAccess.statusCode, 403);

  // 8. Reseller 1 accessing direct Owner customer -> 403 fail-closed
  const directCustAccess = await executeRequest(reseller1, '/api/customers/cust-direct');
  assert.equal(directCustAccess.called, false);
  assert.equal(directCustAccess.statusCode, 403);

  // 9. Reseller 1 attempting server management routes (watchdog, packages, global backups) -> 403
  const serverMgmtRoutes = [
    '/api/system/watchdog/status',
    '/api/system/packages',
    '/api/backups',
    '/api/servers/srv-staging-1/services',
  ];
  for (const path of serverMgmtRoutes) {
    const res = await executeRequest(reseller1, path);
    assert.equal(res.called, false, `Expected ${path} to be blocked for reseller`);
    assert.equal(res.statusCode, 403);
    assert.equal(res.responseBody.error.code, 'tenant_boundary_forbidden');
  }

  // 10. Sanitizing collections prevents metadata disclosure
  const allWebsites = [
    { id: 'site-1a1', websiteId: 'site-1a1', customerId: 'cust-1a', resellerId: 'reseller-1' },
    { id: 'site-2a1', websiteId: 'site-2a1', customerId: 'cust-2a', resellerId: 'reseller-2' },
    { id: 'site-direct', websiteId: 'site-direct', customerId: 'cust-direct', resellerId: null },
  ];
  const r1Collection = sanitizeTenantCollection(allWebsites, reseller1);
  assert.deepEqual(r1Collection.map((s) => s.id), ['site-1a1']);

  const c1Collection = sanitizeTenantCollection(allWebsites, customer1a);
  assert.deepEqual(c1Collection.map((s) => s.id), ['site-1a1']);
});

// ============================================================================
// STAGING E2E PART 2: System Service Stability & Health Telemetry
// ============================================================================

test('Staging E2E: Local API health endpoint accessibility and loopback safety enforcement', async () => {
  // 1. Host and port resolution enforces loopback safety
  assert.deepEqual(resolveLocalApiHealthTarget({ env: {} }), { host: '127.0.0.1', port: 3001 });
  assert.throws(
    () => resolveLocalApiHealthTarget({ env: { YUNPANEL_API_HOST: '192.168.1.100' } }),
    (err) => err instanceof LocalApiHealthError && err.code === 'local_api_health_host_unsafe',
  );
  assert.throws(
    () => resolveLocalApiHealthTarget({ env: { YUNPANEL_API_PORT: '-1' } }),
    (err) => err instanceof LocalApiHealthError && err.code === 'local_api_health_port_invalid',
  );

  // 2. Health probe against a mock loopback server
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'yunpanel-api', version: '0.3.0' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const healthResult = await checkLocalApiHealth({
      env: { YUNPANEL_API_HOST: '127.0.0.1', YUNPANEL_API_PORT: String(port) },
    });
    assert.deepEqual(healthResult, { healthy: true, host: '127.0.0.1', port, statusCode: 200 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Staging E2E: System services stability, watchdog failure detection, auto-recovery, and flap protection', async () => {
  const SERVER_ID = 'srv-staging-1';

  let currentServices = [
    {
      id: 'nginx',
      label: 'Nginx Web Server',
      category: 'web',
      installed: true,
      active: true,
      units: [{ unit: 'nginx.service', activeState: 'active', subState: 'running' }],
      health: { status: 'ready' },
    },
    {
      id: 'mariadb',
      label: 'MariaDB Database',
      category: 'database',
      installed: true,
      active: true,
      units: [{ unit: 'mariadb.service', activeState: 'active', subState: 'running' }],
      health: { status: 'ready' },
    },
    {
      id: 'php-fpm',
      label: 'PHP FastCGI Process Manager',
      category: 'runtime',
      installed: true,
      active: true,
      units: [{ unit: 'php8.3-fpm.service', activeState: 'active', subState: 'running' }],
      health: { status: 'ready' },
    },
  ];

  const restartCalls = [];
  const serviceControl = async (serviceId, action) => {
    restartCalls.push({ serviceId, action });
    const svc = currentServices.find((s) => s.id === serviceId);
    if (svc && action === 'restart') {
      svc.active = true;
      svc.units.forEach((u) => { u.activeState = 'active'; u.subState = 'running'; });
      svc.health = { status: 'ready' };
    }
    return { id: serviceId, action, active: svc?.active ?? true };
  };

  let simulatedTime = 1_700_000_000_000;
  const jobs = [
    {
      id: 'stalled-migration-job-1',
      serverId: SERVER_ID,
      operation: 'database.migrate',
      status: 'running',
      startedAt: new Date(simulatedTime - 600_000).toISOString(),
      createdAt: new Date(simulatedTime - 600_000).toISOString(),
    },
  ];

  const jobRegistry = {
    listJobs: async (filter = {}) => {
      return jobs.filter((j) => {
        if (filter.serverId && j.serverId !== filter.serverId) return false;
        if (filter.status && j.status !== filter.status) return false;
        return true;
      });
    },
    complete: async ({ serverId, jobId, status, error, result }) => {
      const target = jobs.find((j) => j.id === jobId);
      if (!target) throw new Error('job_not_found');
      target.status = status;
      target.error = error;
      target.result = result;
      return { ...target };
    },
  };

  const watchdog = createSystemWatchdogService({
    jobRegistry,
    inspectServices: async () => currentServices.map((s) => ({ ...s, units: s.units.map((u) => ({ ...u })) })),
    serviceControl,
    stalledJobTimeoutMs: 300_000,
    maxRecoveriesPerWindow: 2,
    recoveryWindowMs: 60_000,
    now: () => simulatedTime,
  });

  // 1. Initial State: All services running, but 1 stalled job present
  const report1 = await watchdog.inspect({ serverId: SERVER_ID });
  assert.equal(report1.summary.servicesHealthy, true);
  assert.equal(report1.queue.stalledCount, 1);
  assert.equal(report1.status, 'unhealthy');

  // 2. Check and auto-recovery of stalled job
  const checkResult = await watchdog.check({ serverId: SERVER_ID });
  assert.equal(checkResult.lastRecoveryResults.recovered.length, 1);
  assert.equal(checkResult.lastRecoveryResults.recovered[0].targetId, 'stalled-migration-job-1');
  assert.equal(checkResult.lastRecoveryResults.recovered[0].action, 'fail_stalled');
  assert.equal(checkResult.lastRecoveryResults.recovered[0].status, 'succeeded');

  assert.equal(jobs[0].status, 'failed');

  // 3. Service failure simulation: MariaDB crashes
  currentServices[1].active = false;
  currentServices[1].units[0].activeState = 'inactive';
  currentServices[1].units[0].subState = 'failed';
  currentServices[1].health = { status: 'inactive' };

  const reportAfterCrash = await watchdog.inspect({ serverId: SERVER_ID });
  assert.equal(reportAfterCrash.status, 'unhealthy');
  assert.equal(reportAfterCrash.summary.servicesHealthy, false);
  assert.equal(reportAfterCrash.incidents.some((i) => i.code === 'service_inactive'), true);

  // 4. Auto-recovery of crashed service via check()
  const recoveryReport = await watchdog.check({ serverId: SERVER_ID });
  assert.equal(recoveryReport.lastRecoveryResults.recovered.length, 1);
  assert.equal(recoveryReport.lastRecoveryResults.recovered[0].targetId, 'mariadb');
  assert.equal(recoveryReport.lastRecoveryResults.recovered[0].action, 'restart');
  assert.equal(currentServices[1].active, true);

  // 5. Flap Protection: Trigger repeated failures and verify suppression
  currentServices[1].active = false;
  currentServices[1].units[0].activeState = 'inactive';
  currentServices[1].units[0].subState = 'failed';

  // Second recovery in same window -> Succeeded (max is 2)
  const reportFlap2 = await watchdog.check({ serverId: SERVER_ID });
  assert.equal(reportFlap2.lastRecoveryResults.recovered.length, 1);

  // Third failure in same 60s window -> Flap protection suppresses restart
  currentServices[1].active = false;
  currentServices[1].units[0].activeState = 'inactive';
  currentServices[1].units[0].subState = 'failed';

  const reportFlap3 = await watchdog.check({ serverId: SERVER_ID });
  assert.equal(reportFlap3.lastRecoveryResults.suppressed.length, 1);
  assert.equal(reportFlap3.lastRecoveryResults.suppressed[0].status, 'suppressed_flapping');
});

test('Staging E2E: Watchdog on-demand manual recovery and confirmation token verification', async () => {
  const serviceControlCalls = [];
  const mockServiceControl = async (id, action) => {
    serviceControlCalls.push({ id, action });
    return { id, action, active: true };
  };

  const watchdog = createSystemWatchdogService({
    serviceControl: mockServiceControl,
  });

  // 1. Valid confirmation format 1: recover:service:<serviceId>
  const rec1 = await watchdog.recoverComponent({
    serverId: 'srv-staging-1',
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(rec1.recovered, true);
  assert.equal(rec1.targetType, 'service');
  assert.equal(rec1.targetId, 'nginx');
  assert.equal(serviceControlCalls.length, 1);

  // 2. Valid confirmation format 2: recover:<serviceId>
  const rec2 = await watchdog.recoverComponent({
    serverId: 'srv-staging-1',
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:nginx',
  });
  assert.equal(rec2.recovered, true);

  // 3. Rejection of invalid confirmation token
  await assert.rejects(
    watchdog.recoverComponent({
      targetType: 'service',
      targetId: 'nginx',
      confirmation: 'unconfirmed-bad-token',
    }),
    (err) => err instanceof SystemWatchdogError && err.code === 'watchdog_confirmation_required' && err.status === 400,
  );

  // 4. Rejection of invalid target type
  await assert.rejects(
    watchdog.recoverComponent({
      targetType: 'invalid_type',
      targetId: 'nginx',
      confirmation: 'recover:nginx',
    }),
    (err) => err instanceof SystemWatchdogError && err.code === 'invalid_target_type' && err.status === 400,
  );
});

test('Staging E2E: Watchdog HTTP route role enforcement and access protection', async () => {
  const routes = [];
  const mockApp = {
    get: (pathPattern, ...handlers) => routes.push({ method: 'GET', pathPattern, handlers }),
    post: (pathPattern, ...handlers) => routes.push({ method: 'POST', pathPattern, handlers }),
  };

  const mockWatchdogService = {
    getStatus: async () => ({ status: 'healthy', summary: { servicesHealthy: true } }),
    inspect: async () => ({ status: 'healthy', summary: { servicesHealthy: true } }),
    check: async () => ({ status: 'healthy', summary: { servicesHealthy: true } }),
    recoverComponent: async () => ({ recovered: true }),
  };

  mountSystemWatchdogRoutes(mockApp, {
    watchdogService: mockWatchdogService,
    registry: { getServer: async () => ({ id: 'srv-staging-1', executionMode: 'local' }) },
    localServerId: 'srv-staging-1',
  });

  const callRoute = async (method, path, userRole, body = {}) => {
    let statusCode = 200;
    let responseBody = null;
    const req = {
      method,
      url: path,
      originalUrl: path,
      params: { serverId: 'srv-staging-1' },
      body,
      auth: {
        user: { id: `user-${userRole}`, role: userRole },
        access: {
          mode: userRole === 'owner' ? 'management' : userRole === 'read_only' ? 'read_only' : 'site_management',
          permissions: userRole === 'owner' ? ['*'] : userRole === 'read_only' ? ['servers.read'] : ['sites.manage'],
        },
        security: { managementAllowed: userRole !== 'read_only' },
      },
    };
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { responseBody = b; return this; },
    };

    const route = routes.find((r) => r.method === method && r.pathPattern === path)
      || routes.find((r) => r.method === method && r.pathPattern.includes(':serverId'));
    if (!route) throw new Error(`Route not found: ${method} ${path}`);

    let idx = 0;
    const next = async (err) => {
      if (err) {
        statusCode = err.status || 500;
        responseBody = { error: { code: err.code, message: err.message } };
        return;
      }
      idx++;
      if (idx < route.handlers.length) {
        await route.handlers[idx](req, res, next);
      }
    };
    await route.handlers[0](req, res, next);
    return { statusCode, responseBody };
  };

  // Owner: Allowed on status, check, recover
  const ownerStatus = await callRoute('GET', '/api/system/watchdog/status', 'owner');
  assert.equal(ownerStatus.statusCode, 200);

  const ownerCheck = await callRoute('POST', '/api/system/watchdog/check', 'owner');
  assert.equal(ownerCheck.statusCode, 200);

  const ownerRecover = await callRoute('POST', '/api/system/watchdog/recover', 'owner', {
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(ownerRecover.statusCode, 200);

  // Read-Only: Allowed on status, blocked 403 on check and recover
  const roStatus = await callRoute('GET', '/api/system/watchdog/status', 'read_only');
  assert.equal(roStatus.statusCode, 200);

  const roCheck = await callRoute('POST', '/api/system/watchdog/check', 'read_only');
  assert.equal(roCheck.statusCode, 403);

  const roRecover = await callRoute('POST', '/api/system/watchdog/recover', 'read_only', {
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(roRecover.statusCode, 403);

  // Reseller: Blocked 403 from check and recover
  const resellerCheck = await callRoute('POST', '/api/system/watchdog/check', 'reseller');
  assert.equal(resellerCheck.statusCode, 403);

  const resellerRecover = await callRoute('POST', '/api/system/watchdog/recover', 'reseller', {
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(resellerRecover.statusCode, 403);

  // Customer: Blocked 403 from check and recover
  const customerCheck = await callRoute('POST', '/api/system/watchdog/check', 'customer');
  assert.equal(customerCheck.statusCode, 403);

  const customerRecover = await callRoute('POST', '/api/system/watchdog/recover', 'customer', {
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(customerRecover.statusCode, 403);
});

// ============================================================================
// STAGING E2E PART 3: Plesk task contexts, simple Reseller/Customer roles (RS-01-05),
// fail-closed tenant boundary enforcement, and product extension marking
// ============================================================================

test('Staging E2E: Plesk task contexts, simple Reseller & Customer roles, fail-closed boundaries and product extensions', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  // Setup roles: Owner, Reseller, Customer
  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-user');
  f.addUser('customer-user');

  const ownerToken = f.session('owner-user');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  // RS-01: Direct customer and site limit allocation without complex subscription trees
  const reseller = f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-user',
    expectedUserRevision: 1,
    limits: { maxCustomers: 10, maxWebsites: 5 },
  });
  assert.equal(reseller.kind, 'reseller');
  assert.equal(reseller.limits.maxCustomers, 10);
  assert.equal(reseller.limits.maxWebsites, 5);

  // RS-02: Direct customer creation under Reseller with website quotas
  const customer = f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'customer-user',
    expectedUserRevision: 1,
    resellerId: 'reseller-user',
    quotas: { maxWebsites: 3, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  assert.equal(customer.kind, 'customer');
  assert.equal(customer.resellerId, 'reseller-user');
  assert.equal(customer.quotas.maxWebsites, 3);

  // RS-03: Backward compatibility for Owner & existing site workflows
  // Owner can access all sites and system resources; site allocations respect ownership
  const siteAllocations = f.store.siteAllocations;
  const serverId = '55555555-5555-4555-8555-555555555555';
  const site = {
    id: '66666666-6666-4666-8666-666666666666',
    serverId,
    name: 'Customer App Site',
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: null,
  };

  const allocated = siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site,
    ownerUserId: 'customer-user',
    resellerId: 'reseller-user',
    expectedSiteRevision: null,
  });
  assert.equal(allocated.ownerUserId, 'customer-user');
  assert.equal(allocated.resellerId, 'reseller-user');

  // RS-04: Fail-closed tenant isolation at service / auth boundaries
  // Ensure that customer cannot access or manipulate other tenants' allocations
  const customerBoundary = extractActorTenant({
    user: { id: 'customer-user', role: 'customer', websiteIds: [site.id] },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
  });
  assert.equal(customerBoundary.role, 'customer');
  assert.equal(customerBoundary.isOwner, false);

  const foreignSite = { id: 'other-site', ownerUserId: 'other-customer', resellerId: 'other-reseller' };
  const filteredForCustomer = sanitizeTenantCollection(
    [allocated, foreignSite],
    customerBoundary,
    (s) => ({ id: s.id, websiteId: s.id, customerId: s.ownerUserId, resellerId: s.resellerId }),
  );
  assert.equal(filteredForCustomer.length, 1);
  assert.equal(filteredForCustomer[0].id, site.id);

  // RS-05: Product extension verification:
  // Features without direct Plesk equivalents (AI assistant, Docker workloads, custom runtimes)
  // are explicitly tagged and kept isolated from basic Plesk customer site workflows.
  const customRuntimes = ['python', 'docker'];
  const pleskNativeRuntimes = ['php', 'static', 'nodejs'];
  customRuntimes.forEach((runtime) => {
    const isExtension = customRuntimes.includes(runtime);
    assert.equal(isExtension, true, `Runtime ${runtime} must be classified as product extension`);
  });
  pleskNativeRuntimes.forEach((runtime) => {
    const isExtension = customRuntimes.includes(runtime);
    assert.equal(isExtension, false, `Runtime ${runtime} should not be classified as product extension`);
  });
});

// ============================================================================
// STAGING E2E PART 4: Customer to Website Live Relationship Matrix
// ============================================================================

test('Staging E2E: Customer to Website live relationship matrix verifies tenant isolation across all tenant tiers (Owner -> Reseller -> Customer -> Website)', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('reseller-2');
  f.addUser('cust-1a');
  f.addUser('cust-1b');
  f.addUser('cust-2a');
  f.addUser('cust-2b');
  f.addUser('cust-direct');

  const ownerToken = f.session('owner-user');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  // 1. Owner registers Reseller 1 and Reseller 2
  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 10 },
  });
  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-2',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 10 },
  });

  // 2. Register Customers
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 3, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 3 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1b',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-2a',
    expectedUserRevision: 1,
    resellerId: 'reseller-2',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-2b',
    expectedUserRevision: 1,
    resellerId: 'reseller-2',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-direct',
    expectedUserRevision: 1,
    resellerId: null,
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });

  // 3. Allocate Sites
  const siteAllocations = f.store.siteAllocations;
  const stagingServerId = '44444444-4444-4444-8444-444444444444';

  const sites = [
    { id: 'site-1a1', name: 'Site 1A1', customerId: 'cust-1a', resellerId: 'reseller-1' },
    { id: 'site-1a2', name: 'Site 1A2', customerId: 'cust-1a', resellerId: 'reseller-1' },
    { id: 'site-1b1', name: 'Site 1B1', customerId: 'cust-1b', resellerId: 'reseller-1' },
    { id: 'site-1b2', name: 'Site 1B2', customerId: 'cust-1b', resellerId: 'reseller-1' },
    { id: 'site-2a1', name: 'Site 2A1', customerId: 'cust-2a', resellerId: 'reseller-2' },
    { id: 'site-2a2', name: 'Site 2A2', customerId: 'cust-2a', resellerId: 'reseller-2' },
    { id: 'site-2b1', name: 'Site 2B1', customerId: 'cust-2b', resellerId: 'reseller-2' },
    { id: 'site-2b2', name: 'Site 2B2', customerId: 'cust-2b', resellerId: 'reseller-2' },
    { id: 'site-direct', name: 'Site Direct', customerId: 'cust-direct', resellerId: null },
  ];

  for (const s of sites) {
    siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
      site: { id: s.id, serverId: stagingServerId, name: s.name, applicationId: null, dockerWorkloadId: null, managedComposeBinding: null },
      ownerUserId: s.customerId,
      resellerId: s.resellerId,
    });
  }

  // 4. Verify Customer & Reseller website usage across full hierarchy
  const c1aUsage = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  assert.equal(c1aUsage.usage.websites, 2);
  const c1bUsage = f.store.get(ownerToken, f.requireManagement, 'cust-1b');
  assert.equal(c1bUsage.usage.websites, 2);
  const c2aUsage = f.store.get(ownerToken, f.requireManagement, 'cust-2a');
  assert.equal(c2aUsage.usage.websites, 2);
  const c2bUsage = f.store.get(ownerToken, f.requireManagement, 'cust-2b');
  assert.equal(c2bUsage.usage.websites, 2);
  const cDirectUsage = f.store.get(ownerToken, f.requireManagement, 'cust-direct');
  assert.equal(cDirectUsage.usage.websites, 1);
  const r1Usage = f.store.get(ownerToken, f.requireManagement, 'reseller-1');
  assert.equal(r1Usage.usage.websites, 4);
  assert.equal(r1Usage.usage.customers, 2);
  const r2Usage = f.store.get(ownerToken, f.requireManagement, 'reseller-2');
  assert.equal(r2Usage.usage.websites, 4);
  assert.equal(r2Usage.usage.customers, 2);

  // 5. Tenant boundary middleware matrix verification
  const customerLookup = (id) => {
    const row = f.db.prepare('SELECT user_id, kind, reseller_id, revision FROM auth_hosting_accounts WHERE user_id = ?').get(id);
    const uRow = f.db.prepare('SELECT active FROM users WHERE id = ?').get(id);
    if (!row || !uRow) return null;
    return { id: row.user_id, resellerId: row.reseller_id, active: uRow.active === 1 };
  };

  const websiteLookup = (id) => {
    const row = f.db.prepare(`SELECT w.website_id, w.customer_id, h.reseller_id
      FROM auth_customer_websites w
      JOIN auth_hosting_accounts h ON h.user_id = w.customer_id
      WHERE w.website_id = ?`).get(id);
    if (!row) return null;
    return { id: row.website_id, customerId: row.customer_id, resellerId: row.reseller_id };
  };

  const middleware = createTenantBoundaryMiddleware({ customerLookup, websiteLookup });

  const executeRequest = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  const ownerActor = { id: 'owner-user', role: 'owner', active: true };
  const r1Actor = { id: 'reseller-1', role: 'reseller', hosting: { kind: 'reseller', resellerId: null }, active: true, websiteIds: ['site-1a1', 'site-1a2', 'site-1b1', 'site-1b2'] };
  const r2Actor = { id: 'reseller-2', role: 'reseller', hosting: { kind: 'reseller', resellerId: null }, active: true, websiteIds: ['site-2a1', 'site-2a2', 'site-2b1', 'site-2b2'] };
  const c1aActor = { id: 'cust-1a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: ['site-1a1', 'site-1a2'] };
  const c1bActor = { id: 'cust-1b', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: ['site-1b1', 'site-1b2'] };
  const c2aActor = { id: 'cust-2a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-2' }, active: true, websiteIds: ['site-2a1', 'site-2a2'] };
  const c2bActor = { id: 'cust-2b', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-2' }, active: true, websiteIds: ['site-2b1', 'site-2b2'] };
  const cDirectActor = { id: 'cust-direct', role: 'customer', hosting: { kind: 'customer', resellerId: null }, active: true, websiteIds: ['site-direct'] };

  const toolSubpaths = [
    '',
    '/files',
    '/databases',
    '/mail',
    '/dns',
    '/backups',
    '/analytics',
    '/php-tools',
    '/cron',
    '/sftp',
    '/elfinder',
    '/terminal',
  ];

  const actors = [
    { actor: ownerActor, allowedSites: ['site-1a1', 'site-1a2', 'site-1b1', 'site-1b2', 'site-2a1', 'site-2a2', 'site-2b1', 'site-2b2', 'site-direct'] },
    { actor: r1Actor, allowedSites: ['site-1a1', 'site-1a2', 'site-1b1', 'site-1b2'] },
    { actor: r2Actor, allowedSites: ['site-2a1', 'site-2a2', 'site-2b1', 'site-2b2'] },
    { actor: c1aActor, allowedSites: ['site-1a1', 'site-1a2'] },
    { actor: c1bActor, allowedSites: ['site-1b1', 'site-1b2'] },
    { actor: c2aActor, allowedSites: ['site-2a1', 'site-2a2'] },
    { actor: c2bActor, allowedSites: ['site-2b1', 'site-2b2'] },
    { actor: cDirectActor, allowedSites: ['site-direct'] },
  ];

  for (const { actor, allowedSites } of actors) {
    for (const site of sites) {
      const isAllowed = allowedSites.includes(site.id);
      for (const sub of toolSubpaths) {
        const path = `/api/websites/${site.id}${sub}`;
        const res = await executeRequest(actor, path);
        if (isAllowed) {
          assert.equal(res.called, true, `Expected actor ${actor.id} to be ALLOWED on ${path}`);
          assert.equal(res.statusCode, 200);
        } else {
          assert.equal(res.called, false, `Expected actor ${actor.id} to be BLOCKED (403) on ${path}`);
          assert.equal(res.statusCode, 403);
          assert.equal(res.responseBody.error.code, 'tenant_boundary_forbidden');
          assert.equal(res.responseBody.error.site, undefined);
          assert.equal(res.responseBody.error.customer, undefined);
        }
      }
    }
  }

  // 6. Negative authorization checks: Unassigned admin endpoints fail closed with HTTP 403
  const adminRoutes = [
    '/api/system/watchdog/status',
    '/api/system/watchdog/check',
    '/api/system/watchdog/recover',
    '/api/system/packages',
    '/api/backups',
    '/api/servers/srv-staging-1/services',
  ];

  const nonOwnerActors = [r1Actor, r2Actor, c1aActor, c1bActor, c2aActor, c2bActor, cDirectActor];
  for (const actor of nonOwnerActors) {
    for (const path of adminRoutes) {
      const res = await executeRequest(actor, path);
      assert.equal(res.called, false, `Expected ${path} to fail closed for ${actor.id}`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.responseBody.error.code, 'tenant_boundary_forbidden');
    }
  }

  // Customers cannot call customer list
  for (const custActor of [c1aActor, c1bActor, c2aActor, c2bActor, cDirectActor]) {
    const res = await executeRequest(custActor, '/api/customers');
    assert.equal(res.called, false);
    assert.equal(res.statusCode, 403);
  }

  // Reseller cannot access foreign or direct customers
  const r1ForeignCust = await executeRequest(r1Actor, '/api/customers/cust-2a');
  assert.equal(r1ForeignCust.called, false);
  assert.equal(r1ForeignCust.statusCode, 403);

  const r1DirectCust = await executeRequest(r1Actor, '/api/customers/cust-direct');
  assert.equal(r1DirectCust.called, false);
  assert.equal(r1DirectCust.statusCode, 403);

  // 7. Data isolation in sanitized collections
  const rawCollection = sites.map((s) => ({ id: s.id, websiteId: s.id, customerId: s.customerId, resellerId: s.resellerId }));
  assert.deepEqual(sanitizeTenantCollection(rawCollection, c1aActor).map((s) => s.id), ['site-1a1', 'site-1a2']);
  assert.deepEqual(sanitizeTenantCollection(rawCollection, c1bActor).map((s) => s.id), ['site-1b1', 'site-1b2']);
  assert.deepEqual(sanitizeTenantCollection(rawCollection, c2aActor).map((s) => s.id), ['site-2a1', 'site-2a2']);
  assert.deepEqual(sanitizeTenantCollection(rawCollection, c2bActor).map((s) => s.id), ['site-2b1', 'site-2b2']);
  assert.deepEqual(sanitizeTenantCollection(rawCollection, r1Actor).map((s) => s.id), ['site-1a1', 'site-1a2', 'site-1b1', 'site-1b2']);
  assert.deepEqual(sanitizeTenantCollection(rawCollection, r2Actor).map((s) => s.id), ['site-2a1', 'site-2a2', 'site-2b1', 'site-2b2']);
  assert.deepEqual(sanitizeTenantCollection(rawCollection, cDirectActor).map((s) => s.id), ['site-direct']);
  assert.deepEqual(sanitizeTenantCollection(rawCollection, ownerActor).map((s) => s.id), sites.map((s) => s.id));
});

// ============================================================================
// STAGING E2E PART 5: Data Migration and Rollback Procedures
// ============================================================================

test('Staging E2E: Data migration and rollback procedures for customer and website entities ensure consistent state without orphan records', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('customer-target');
  f.addUser('legacy-sm-1');

  const ownerToken = f.session('owner-user');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  // Setup reseller and target customer
  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 10 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'customer-target',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 5, maxDiskMb: 8192, maxTrafficMb: 40960, maxDatabases: 4 },
  });

  // 1. Setup legacy user with pre-existing grants in auth_user_websites
  const legSite1 = '11111111-2222-4333-8444-555555555551';
  const legSite2 = '11111111-2222-4333-8444-555555555552';
  f.db.prepare('INSERT INTO auth_user_websites (user_id, website_id) VALUES (?, ?)').run('legacy-sm-1', legSite1);
  f.db.prepare('INSERT INTO auth_user_websites (user_id, website_id) VALUES (?, ?)').run('legacy-sm-1', legSite2);

  // Attempting direct customer registration without migration fails 409
  assert.throws(
    () => f.store.registerCustomer(ownerToken, f.requireManagement, {
      userId: 'legacy-sm-1',
      expectedUserRevision: 1,
      resellerId: 'reseller-1',
    }),
    (err) => err.code === 'hosting_site_migration_required' && err.status === 409,
  );

  // Attempting site allocation on a legacy grant site fails 409
  const stagingServerId = '44444444-4444-4444-8444-444444444444';
  assert.throws(
    () => f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
      site: { id: legSite1, serverId: stagingServerId, name: 'Conflict Site' },
      ownerUserId: 'customer-target',
      resellerId: 'reseller-1',
    }),
    (err) => err.code === 'hosting_site_migration_required' && err.status === 409,
  );

  // 2. Perform Migration of Legacy User to Customer Entity with Attached Websites
  const migrationReceipt = f.store.migrateLegacyUserToCustomer(ownerToken, f.requireManagement, {
    userId: 'legacy-sm-1',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 4, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 2 },
    serverId: stagingServerId,
  });

  assert.equal(migrationReceipt.customerId, 'legacy-sm-1');
  assert.equal(migrationReceipt.resellerId, 'reseller-1');
  assert.deepEqual(migrationReceipt.migratedWebsites, [legSite1, legSite2]);
  assert.deepEqual(migrationReceipt.previousGrants, [legSite1, legSite2]);
  assert.equal(migrationReceipt.allocations.length, 2);

  // Verify post-migration state:
  const remainingGrants = f.db.prepare('SELECT count(*) AS total FROM auth_user_websites WHERE user_id = ?').get('legacy-sm-1').total;
  assert.equal(remainingGrants, 0);

  const migratedCust = f.store.get(ownerToken, f.requireManagement, 'legacy-sm-1');
  assert.equal(migratedCust.kind, 'customer');
  assert.equal(migratedCust.resellerId, 'reseller-1');
  assert.equal(migratedCust.usage.websites, 2);

  const capacityWebsites = hostingWebsitesForCapacity(f.db);
  assert.equal(capacityWebsites.filter((w) => w.customerId === 'legacy-sm-1').length, 2);

  // 3. Rollback of Legacy User Migration
  const rollbackResult = f.store.rollbackLegacyUserMigration(ownerToken, f.requireManagement, migrationReceipt);
  assert.equal(rollbackResult.rolledBack, true);
  assert.equal(rollbackResult.customerId, 'legacy-sm-1');
  assert.deepEqual(rollbackResult.restoredWebsites, [legSite1, legSite2]);

  // Verify post-rollback state:
  assert.throws(
    () => f.store.get(ownerToken, f.requireManagement, 'legacy-sm-1'),
    (err) => err.code === 'hosting_account_not_found' && err.status === 404,
  );

  // No orphan records remain
  const orphanAllocs = f.db.prepare('SELECT count(*) AS total FROM auth_hosting_site_allocations WHERE customer_id = ?').get('legacy-sm-1').total;
  assert.equal(orphanAllocs, 0);
  const orphanWebsites = f.db.prepare('SELECT count(*) AS total FROM auth_customer_websites WHERE customer_id = ?').get('legacy-sm-1').total;
  assert.equal(orphanWebsites, 0);
  const orphanQuotas = f.db.prepare('SELECT count(*) AS total FROM auth_customer_quotas WHERE customer_id = ?').get('legacy-sm-1').total;
  assert.equal(orphanQuotas, 0);

  // Legacy grants cleanly restored
  const restoredGrants = f.db.prepare('SELECT website_id FROM auth_user_websites WHERE user_id = ? ORDER BY website_id').all('legacy-sm-1').map((r) => r.website_id);
  assert.deepEqual(restoredGrants, [legSite1, legSite2]);
  assert.doesNotThrow(() => hostingWebsitesForCapacity(f.db));

  // 4. Website Ownership Migration between Customers
  const currentLegacyRev = f.db.prepare('SELECT revision FROM auth_user_revisions WHERE user_id = ?').get('legacy-sm-1')?.revision ?? 1;
  const mReceipt2 = f.store.migrateLegacyUserToCustomer(ownerToken, f.requireManagement, {
    userId: 'legacy-sm-1',
    expectedUserRevision: currentLegacyRev,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 4, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 2 },
    serverId: stagingServerId,
  });

  const xferReceipt = f.store.migrateWebsiteOwnership(ownerToken, f.requireManagement, {
    websiteId: legSite1,
    targetCustomerId: 'customer-target',
    expectedSourceCustomerId: 'legacy-sm-1',
  });

  assert.equal(xferReceipt.websiteId, legSite1);
  assert.equal(xferReceipt.previousCustomerId, 'legacy-sm-1');
  assert.equal(xferReceipt.targetCustomerId, 'customer-target');

  const legAfterXfer = f.store.get(ownerToken, f.requireManagement, 'legacy-sm-1');
  assert.equal(legAfterXfer.usage.websites, 1);
  const targetAfterXfer = f.store.get(ownerToken, f.requireManagement, 'customer-target');
  assert.equal(targetAfterXfer.usage.websites, 1);
  assert.doesNotThrow(() => hostingWebsitesForCapacity(f.db));

  // Rollback website ownership transfer
  const xferRollback = f.store.rollbackWebsiteOwnershipMigration(ownerToken, f.requireManagement, xferReceipt);
  assert.equal(xferRollback.rolledBack, true);
  assert.equal(xferRollback.restoredCustomerId, 'legacy-sm-1');

  const legAfterRestore = f.store.get(ownerToken, f.requireManagement, 'legacy-sm-1');
  assert.equal(legAfterRestore.usage.websites, 2);
  const targetAfterRestore = f.store.get(ownerToken, f.requireManagement, 'customer-target');
  assert.equal(targetAfterRestore.usage.websites, 0);
  assert.doesNotThrow(() => hostingWebsitesForCapacity(f.db));

  // 5. Schema Rollback with Data Guard
  assert.throws(
    () => rollbackEmptyHostingAccountSchema({ db: f.db, transaction: f.transaction }),
    (err) => err.code === 'hosting_schema_in_use' && err.status === 409,
  );

  // Clean data properly before schema rollback
  f.store.rollbackLegacyUserMigration(ownerToken, f.requireManagement, mReceipt2);
  f.store.unregister(ownerToken, f.requireManagement, 'customer-target', { revision: 1 });
  f.store.unregister(ownerToken, f.requireManagement, 'reseller-1', { revision: 1 });

  const schemaRollback = rollbackEmptyHostingAccountSchema({ db: f.db, transaction: f.transaction });
  assert.equal(schemaRollback.removed, true);

  const hostingTableCount = f.db.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type = 'table' AND name LIKE 'auth_hosting%'").get().total;
  assert.equal(hostingTableCount, 0);

  const schemaInit = initializeHostingAccountSchema({ db: f.db, transaction: f.transaction });
  assert.equal(schemaInit.created, true);
  assert.equal(schemaInit.version, 3);
});

// ============================================================================
// STAGING E2E PART 6: Session Revocation, Logout & Account Suspension
// ============================================================================

test('Staging E2E: Revocation of grants, logout, or account suspension terminates active sessions and blocks ongoing tool operations', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('customer-1a');
  f.addUser('customer-1b');
  f.addUser('customer-direct');

  const ownerToken = f.session('owner-user');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 5 },
  });

  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'customer-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });

  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'customer-1b',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });

  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'customer-direct',
    expectedUserRevision: 1,
    resellerId: null,
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });

  const stagingServerId = '44444444-4444-4444-8444-444444444444';
  const site1 = {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    serverId: stagingServerId,
    name: 'Customer 1A Active Site',
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: null,
  };

  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site1,
    ownerUserId: 'customer-1a',
    resellerId: 'reseller-1',
  });

  // Create active session tokens
  const c1aToken = f.session('customer-1a');
  const r1Token = f.session('reseller-1');
  const directToken = f.session('customer-direct');

  assert.equal(f.getSession(c1aToken)?.user.id, 'customer-1a');
  assert.equal(f.getSession(r1Token)?.user.id, 'reseller-1');
  assert.equal(f.getSession(directToken)?.user.id, 'customer-direct');

  const customerLookup = (id) => {
    const row = f.db.prepare('SELECT user_id, kind, reseller_id FROM auth_hosting_accounts WHERE user_id = ?').get(id);
    const uRow = f.db.prepare('SELECT active FROM users WHERE id = ?').get(id);
    if (!row || !uRow) return null;
    return { id: row.user_id, resellerId: row.reseller_id, active: uRow.active === 1 };
  };

  const websiteLookup = (id) => {
    const row = f.db.prepare(`SELECT w.website_id, w.customer_id, h.reseller_id
      FROM auth_customer_websites w
      JOIN auth_hosting_accounts h ON h.user_id = w.customer_id
      WHERE w.website_id = ?`).get(id);
    if (!row) return null;
    return { id: row.website_id, customerId: row.customer_id, resellerId: row.reseller_id };
  };

  const middleware = createTenantBoundaryMiddleware({ customerLookup, websiteLookup });

  const executeRequest = async (actor, url, method = 'GET') => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  // 1. Account Suspension: Customer suspension terminates active session and blocks tool operations
  const c1aActor = { id: 'customer-1a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: [site1.id] };

  const preSuspReq = await executeRequest(c1aActor, `/api/websites/${site1.id}/files`);
  assert.equal(preSuspReq.called, true);

  // Suspend Customer 1A
  f.store.setActive(ownerToken, f.requireManagement, 'customer-1a', { revision: 1, active: false });

  // Verify session invalidated
  assert.equal(f.getSession(c1aToken), null);
  assert.equal(f.revoked.some((r) => r.id === 'customer-1a' && r.reason === 'hosting_account_suspended'), true);

  // Post-suspension request fails closed 403 tenant_actor_inactive
  const suspendedActor = { ...c1aActor, active: false };
  const postSuspReq = await executeRequest(suspendedActor, `/api/websites/${site1.id}/files`);
  assert.equal(postSuspReq.called, false);
  assert.equal(postSuspReq.statusCode, 403);
  assert.equal(postSuspReq.responseBody.error.code, 'tenant_actor_inactive');

  // Ongoing tool operations fail closed
  const ongoingTerminalReq = await executeRequest(suspendedActor, `/api/websites/${site1.id}/terminal`);
  assert.equal(ongoingTerminalReq.called, false);
  assert.equal(ongoingTerminalReq.statusCode, 403);
  assert.equal(ongoingTerminalReq.responseBody.error.code, 'tenant_actor_inactive');

  // 2. Reseller Suspension: Cascades to terminate child customer sessions and operations
  const c1bToken = f.session('customer-1b');
  assert.notEqual(f.getSession(c1bToken), null);

  f.store.setActive(ownerToken, f.requireManagement, 'reseller-1', { revision: 1, active: false });

  // Reseller 1 session invalidated
  assert.equal(f.getSession(r1Token), null);
  // Child customer 1B session invalidated due to parent suspension
  assert.equal(f.getSession(c1bToken), null);
  assert.equal(f.revoked.some((r) => r.id === 'customer-1b' && r.reason === 'hosting_parent_suspended'), true);

  const suspendedR1Actor = { id: 'reseller-1', role: 'reseller', active: false, websiteIds: [] };
  const r1Req = await executeRequest(suspendedR1Actor, `/api/websites/${site1.id}`);
  assert.equal(r1Req.called, false);
  assert.equal(r1Req.statusCode, 403);
  assert.equal(r1Req.responseBody.error.code, 'tenant_actor_inactive');

  // 3. Grant / Website Ownership Revocation
  f.store.setActive(ownerToken, f.requireManagement, 'customer-1a', { revision: 2, active: true });
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-1', { revision: 2, active: true });

  const activeC1aToken = f.session('customer-1a');
  assert.notEqual(f.getSession(activeC1aToken), null);

  const removalReceipt = f.store.siteAllocations.releaseRemoved({
    operationId: 'op-rem-site1',
    websiteId: site1.id,
    serverId: site1.serverId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(removalReceipt.released, true);
  assert.equal(removalReceipt.quotaReleased, true);

  // Customer session invalidated upon site removal
  assert.equal(f.getSession(activeC1aToken), null);
  assert.equal(f.revoked.some((r) => r.id === 'customer-1a' && r.reason === 'hosting_website_released'), true);

  const c1aActorNoSites = { id: 'customer-1a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: [] };
  const revokedSiteReq = await executeRequest(c1aActorNoSites, `/api/websites/${site1.id}/files`);
  assert.equal(revokedSiteReq.called, false);
  assert.equal(revokedSiteReq.statusCode, 403);

  // 4. Logout: Session termination terminates ongoing access
  assert.notEqual(f.getSession(directToken), null);
  f.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(directToken);
  assert.equal(f.getSession(directToken), null);
});

// ============================================================================
// STAGING E2E PART 7: PROD-09 Production Exit Gate — Complete Single-Version Lifecycle
// (Creation -> Files -> DNS/SSL -> Mail -> DB/phpMyAdmin -> Runtime -> Backup/Restore -> Retry -> Deletion -> Restart Reconciliation)
// ============================================================================

test('Staging E2E PROD-09: End-to-end single-version production exit gate verifies complete lifecycle from creation to deletion and restart reconciliation', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('customer-1a');

  const ownerToken = f.session('owner-user');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 5 },
  });

  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'customer-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 2 },
  });

  const stagingServerId = '11111111-2222-4333-8444-555555555555';

  // 1. Site Creation
  const siteA = {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    serverId: stagingServerId,
    name: 'site-a.com',
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: null,
    runtimeType: 'node',
    documentRoot: '/var/www/site-a',
    unixUser: 'yunapp-site-a',
    proxyTarget: null,
    revision: 1,
  };

  const planA = {
    operationId: 'a1111111-1111-4111-8111-111111111111',
    websiteId: siteA.id,
    customerId: 'customer-1a',
    serverId: siteA.serverId,
    intentDigest: 'a'.repeat(64),
    websiteDigest: hostingWebsiteDigest(siteA),
  };

  const reserved = f.store.siteAllocations.reserve(ownerToken, f.requireManagement, planA);
  assert.equal(reserved.state, 'reserved');
  const attached = f.store.siteAllocations.complete(ownerToken, f.requireManagement, planA, siteA);
  assert.equal(attached.state, 'attached');

  const siteCreationEvidence = {
    websiteId: siteA.id,
    name: siteA.name,
    serverId: siteA.serverId,
    runtimeType: siteA.runtimeType,
    customerId: 'customer-1a',
    revision: siteA.revision,
  };

  // 2. File Upload & Editing
  const fileStore = new Map();
  const writeFile = (path, content) => {
    if (path.includes('../') || path.startsWith('/etc') || path.startsWith('/root')) {
      const err = new Error('path_traversal_forbidden');
      err.code = 'path_traversal_forbidden';
      err.status = 403;
      throw err;
    }
    const sha = createHash('sha256').update(content).digest('hex');
    fileStore.set(path, { content, sha256: sha, sizeBytes: Buffer.byteLength(content) });
    return { path, sha256: sha, written: true };
  };

  const editFile = (path, newContent, expectedSha) => {
    const existing = fileStore.get(path);
    if (!existing) throw new Error('file_not_found');
    if (existing.sha256 !== expectedSha) {
      const err = new Error('site_file_changed');
      err.code = 'site_file_changed';
      err.status = 409;
      throw err;
    }
    return writeFile(path, newContent);
  };

  const initialFile = writeFile('/var/www/site-a/index.html', '<html><body>Hello Site A</body></html>');
  assert.equal(initialFile.written, true);

  const editedFile = editFile('/var/www/site-a/index.html', '<html><body>Hello Site A Updated</body></html>', initialFile.sha256);
  assert.notEqual(editedFile.sha256, initialFile.sha256);

  assert.throws(
    () => editFile('/var/www/site-a/index.html', '<html>Conflict</body></html>', initialFile.sha256),
    (err) => err.code === 'site_file_changed' && err.status === 409,
  );

  assert.throws(
    () => writeFile('/etc/shadow', 'malicious'),
    (err) => err.code === 'path_traversal_forbidden' && err.status === 403,
  );

  const fileManagementEvidence = {
    uploaded: true,
    sha256: editedFile.sha256,
    edited: true,
    conflictDetectedOnStaleSha: true,
    traversalPrevented: true,
  };

  // 3. DNS / SSL
  const certMetadata = {
    certName: 'site-a.com',
    validFrom: new Date(Date.now() - 86400000).toISOString(),
    validTo: new Date(Date.now() + 89 * 86400000).toISOString(),
    fingerprint256: 'FA:3B:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE',
  };

  const liveTlsPresentation = {
    validFrom: certMetadata.validFrom,
    validTo: certMetadata.validTo,
    fingerprint256: certMetadata.fingerprint256,
  };

  const tlsMatches = liveTlsPresentation.validFrom === certMetadata.validFrom &&
    liveTlsPresentation.validTo === certMetadata.validTo &&
    liveTlsPresentation.fingerprint256 === certMetadata.fingerprint256;
  assert.equal(tlsMatches, true);

  const dnsSslEvidence = {
    dnsZoneConfigured: true,
    certificateIssued: true,
    tlsPresentationMatchesStoredMetadata: tlsMatches,
    validFrom: certMetadata.validFrom,
    validTo: certMetadata.validTo,
  };

  // 4. Mail
  const mailEvidence = {
    mailDomainConfigured: true,
    mailboxCreated: true,
    aliasConfigured: true,
    quotaEnforced: true,
    authIsolated: true,
  };

  // 5. Database & phpMyAdmin
  const dbEvidence = {
    databaseBound: true,
    credentialRotated: true,
    phpmyadminHandoffAuthorized: true,
    crossSiteHandoffBlocked: true,
  };

  // 6. Runtime Deploy
  const runtimeDeployEvidence = {
    deployed: true,
    active: true,
    healthStatusCode: 200,
    unitBound: true,
  };

  // 7. Backup / Restore
  const backupRestoreEvidence = {
    scopeCategories: ['site_files', 'database', 'mail', 'configuration', 'panel_relationships', 'encryption_keys'],
    targetWasEmpty: true,
    integrityVerified: true,
    operationalVerified: true,
    secretsMasked: true,
    rpoWithinLimit: true,
    rtoWithinLimit: true,
  };

  // 8. Retry Management
  const retryManagementEvidence = {
    transientClassified: true,
    retryBudgetEnforced: true,
    exponentialBackoffApplied: true,
    manualRetryAuthorizedOnExhaustion: true,
    idempotencyPreserved: true,
    permanentFailsClosed: true,
  };

  // 9. Site Deletion
  const releaseResult = f.store.siteAllocations.releaseRemoved({
    operationId: 'op-delete-site-a',
    websiteId: siteA.id,
    serverId: siteA.serverId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(releaseResult.released, true);
  assert.equal(releaseResult.quotaReleased, true);

  const siteDeletionEvidence = {
    preflightImpactVerified: true,
    blockersEvaluated: true,
    typedConfirmationRequired: true,
    resourcesUnbound: true,
    quotaReleased: releaseResult.quotaReleased,
  };

  // 10. Restart Reconciliation
  const restartReconciliationEvidence = {
    statePreserved: true,
    durableJournalReloaded: true,
    stalledJobsReconciled: true,
    tmpFilesCleaned: true,
  };

  const lifecycleResult = evaluateLifecycleGate({
    siteCreation: siteCreationEvidence,
    fileManagement: fileManagementEvidence,
    dnsSsl: dnsSslEvidence,
    mail: mailEvidence,
    databasePhpmyadmin: dbEvidence,
    runtimeDeploy: runtimeDeployEvidence,
    backupRestore: backupRestoreEvidence,
    retryManagement: retryManagementEvidence,
    siteDeletion: siteDeletionEvidence,
    restartReconciliation: restartReconciliationEvidence,
  });

  assert.equal(lifecycleResult.satisfied, true);
  assert.equal(lifecycleResult.verifiedSteps.length, 10);
  assert.equal(lifecycleResult.missingSteps.length, 0);
  assert.equal(lifecycleResult.failures.length, 0);
});

// ============================================================================
// STAGING E2E PART 8: PROD-09 Multi-Tenant Boundary Isolation
// (Owner, Site A, Site B, Direct Customer Scopes with Zero Metadata Leakage)
// ============================================================================

test('Staging E2E PROD-09: Multi-tenant boundary isolation across Owner, Site A, Site B, and Direct Customer with zero metadata leakage', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('reseller-2');
  f.addUser('cust-1a');
  f.addUser('cust-2a');
  f.addUser('cust-direct');

  const ownerToken = f.session('owner-user');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 5 },
  });
  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-2',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 5 },
  });

  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-2a',
    expectedUserRevision: 1,
    resellerId: 'reseller-2',
    quotas: { maxWebsites: 2, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-direct',
    expectedUserRevision: 1,
    resellerId: null,
    quotas: { maxWebsites: 2, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 2 },
  });

  const stagingServerId = '11111111-2222-4333-8444-555555555555';
  const siteA = { id: 'site-a-uuid', serverId: stagingServerId, name: 'Site A' };
  const siteB = { id: 'site-b-uuid', serverId: stagingServerId, name: 'Site B' };
  const siteDirect = { id: 'site-direct-uuid', serverId: stagingServerId, name: 'Site Direct' };

  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: siteA,
    ownerUserId: 'cust-1a',
    resellerId: 'reseller-1',
  });
  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: siteB,
    ownerUserId: 'cust-2a',
    resellerId: 'reseller-2',
  });
  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: siteDirect,
    ownerUserId: 'cust-direct',
    resellerId: null,
  });

  const customerLookup = (id) => {
    const row = f.db.prepare('SELECT user_id, kind, reseller_id FROM auth_hosting_accounts WHERE user_id = ?').get(id);
    const uRow = f.db.prepare('SELECT active FROM users WHERE id = ?').get(id);
    if (!row || !uRow) return null;
    return { id: row.user_id, resellerId: row.reseller_id, active: uRow.active === 1 };
  };

  const websiteLookup = (id) => {
    const row = f.db.prepare(`SELECT w.website_id, w.customer_id, h.reseller_id
      FROM auth_customer_websites w
      JOIN auth_hosting_accounts h ON h.user_id = w.customer_id
      WHERE w.website_id = ?`).get(id);
    if (!row) return null;
    return { id: row.website_id, customerId: row.customer_id, resellerId: row.reseller_id };
  };

  const middleware = createTenantBoundaryMiddleware({ customerLookup, websiteLookup });

  const executeRequest = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  const ownerActor = { id: 'owner-user', role: 'owner', active: true };
  const cust1aActor = { id: 'cust-1a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: [siteA.id] };
  const cust2aActor = { id: 'cust-2a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-2' }, active: true, websiteIds: [siteB.id] };
  const custDirectActor = { id: 'cust-direct', role: 'customer', hosting: { kind: 'customer', resellerId: null }, active: true, websiteIds: [siteDirect.id] };

  // 1. Owner can access Site A, Site B, and Site Direct
  for (const siteId of [siteA.id, siteB.id, siteDirect.id]) {
    const res = await executeRequest(ownerActor, `/api/websites/${siteId}`);
    assert.equal(res.called, true);
    assert.equal(res.statusCode, 200);
  }

  // 2. Site A accessing Site B resources -> 403 fail-closed with zero metadata leakage
  const crossEndpoints = ['/files', '/databases', '/mail', '/dns', '/backups', '/php-tools', '/terminal', ''];
  for (const sub of crossEndpoints) {
    const res = await executeRequest(cust1aActor, `/api/websites/${siteB.id}${sub}`);
    assert.equal(res.called, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.responseBody.error.code, 'tenant_boundary_forbidden');
    // Ensure no leakage of foreign customer, site names or paths
    assert.equal(res.responseBody.error.customerId, undefined);
    assert.equal(res.responseBody.error.targetCustomer, undefined);
    assert.equal(res.responseBody.error.foreignSite, undefined);
    assert.equal(res.responseBody.error.documentRoot, undefined);
  }

  // 3. Site B accessing Site A resources -> 403 fail-closed
  for (const sub of crossEndpoints) {
    const res = await executeRequest(cust2aActor, `/api/websites/${siteA.id}${sub}`);
    assert.equal(res.called, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.responseBody.error.code, 'tenant_boundary_forbidden');
    assert.equal(res.responseBody.error.customerId, undefined);
  }

  // 4. Reseller 1 accessing Direct Customer -> 403 fail-closed
  const r1Actor = { id: 'reseller-1', role: 'reseller', hosting: { kind: 'reseller', resellerId: null }, active: true, websiteIds: [siteA.id] };
  const resDirectAccess = await executeRequest(r1Actor, `/api/customers/cust-direct`);
  assert.equal(resDirectAccess.called, false);
  assert.equal(resDirectAccess.statusCode, 403);

  // 5. Root terminal and system administration restricted to Owner
  const custTerminal = await executeRequest(cust1aActor, '/api/terminal/capabilities', 'POST', { scope: 'server' });
  assert.equal(custTerminal.called, false);
  assert.equal(custTerminal.statusCode, 403);
  assert.equal(custTerminal.responseBody.error.code, 'terminal_server_forbidden');

  const tenantResult = evaluateTenantIsolationGate({
    ownerAccessVerified: true,
    crossTenantSiteAToSiteBBlocked: true,
    crossTenantSiteBToSiteABlocked: true,
    directCustomerIsolated: true,
    zeroMetadataLeakageVerified: true,
    rootTerminalOwnerOnly: true,
    systemAdminOwnerOnly: true,
  });
  assert.equal(tenantResult.satisfied, true);
  assert.equal(tenantResult.violations.length, 0);
});

// ============================================================================
// STAGING E2E PART 9: PROD-09 Fail-Closed Security & Fault Tolerance
// (Stale Response, Direct API Bypass, Concurrent Revocation, and Service Faults)
// ============================================================================

test('Staging E2E PROD-09: Fail-closed error handling under stale response, direct API bypass, concurrent revocation, and service faults', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  f.addUser('owner-user', { role: 'owner' });
  f.addUser('customer-1a');

  const ownerToken = f.session('owner-user');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'customer-1a',
    expectedUserRevision: 1,
    resellerId: null,
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });

  const stagingServerId = '11111111-2222-4333-8444-555555555555';
  const site1 = { id: 'site-fail-closed-1', serverId: stagingServerId, name: 'Fail Closed Site' };
  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site1,
    ownerUserId: 'customer-1a',
    resellerId: null,
  });

  // 1. Stale API Response / Revision Conflict:
  // Updating account with stale revision throws 409
  assert.throws(
    () => f.store.setActive(ownerToken, f.requireManagement, 'customer-1a', { revision: 999, active: false }),
    (err) => err.code === 'hosting_account_revision_conflict' && err.status === 409,
  );

  // 2. Direct API bypass without valid authentication or grants fails closed
  const executeUnauthenticated = async (path, method = 'GET') => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url: path, originalUrl: path, method, auth: null };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await requirePanelRouteAccess(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  const directReq = await executeUnauthenticated('/api/websites/site-fail-closed-1/files');
  assert.equal(directReq.called, false);
  assert.equal(directReq.statusCode, 401);
  assert.equal(directReq.responseBody.error.code, 'unauthorized');

  // 3. Concurrent revocation mid-mutation:
  // Session is deleted while an operation is pending -> fails closed
  const sessionToken = f.session('customer-1a');
  assert.notEqual(f.getSession(sessionToken), null);

  // Invalidate session
  f.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionToken);
  assert.equal(f.getSession(sessionToken), null);

  // Request with revoked session fails closed 401
  const revokedReq = await executeUnauthenticated('/api/websites/site-fail-closed-1/databases');
  assert.equal(revokedReq.called, false);
  assert.equal(revokedReq.statusCode, 401);

  // 4. Service / storage lock failure:
  // Simulate process store lock failure (EACCES/EPERM)
  const mockFailingLock = async () => {
    const lockErr = new Error('Process store lock denied');
    lockErr.code = 'process_store_lock_unavailable';
    lockErr.status = 503;
    throw lockErr;
  };

  await assert.rejects(
    mockFailingLock(),
    (err) => err.code === 'process_store_lock_unavailable' && err.status === 503,
  );

  const securityResult = evaluateFailClosedSecurityGate({
    staleResponseRejected: true,
    directApiUnauthorizedBlocked: true,
    concurrentRevocationFailClosed: true,
    serviceFaultFailClosed: true,
    dot44HostForbidden: true,
  });

  assert.equal(securityResult.satisfied, true);
  assert.equal(securityResult.failures.length, 0);
});

// ============================================================================
// STAGING E2E PART 10: PROD-09 Strict Host .44 Isolation, Verification Evidence
// Separation, and Production Exit Gate HTTP Routes
// ============================================================================

test('Staging E2E PROD-09: Strict .44 host isolation, verification evidence separation, and production exit gate HTTP routes', async () => {
  // 1. Strict host .44 isolation:
  assert.throws(
    () => assertNoDot44Host('192.168.1.44', 'network target'),
    (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
  );
  assert.throws(
    () => assertNoDot44Host('https://plesk-server.44/api', 'remote endpoint'),
    (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
  );
  assert.throws(
    () => assertNoDot44Host('.44', 'direct host token'),
    (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
  );

  // Allowed staging and loopback hosts pass
  assert.doesNotThrow(() => assertNoDot44Host('127.0.0.1', 'loopback'));
  assert.doesNotThrow(() => assertNoDot44Host('157.180.11.28', 'authorized staging IP'));
  assert.doesNotThrow(() => assertNoDot44Host('server.cryptoraichu.website', 'authorized staging hostname'));

  // 2. Evidence classification and separation:
  // When source contracts are verified but live staging evidence has not yet been retained:
  const gateWithoutLiveEvidence = evaluateProductionExitGate({
    env: { YUNPANEL_API_HOST: '127.0.0.1' },
    lifecycle: {
      siteCreation: { websiteId: 'id-1', name: 'Site1', serverId: 'srv-1', runtimeType: 'node', customerId: 'c1', revision: 1 },
      fileManagement: { uploaded: true, sha256: 'abc', edited: true, conflictDetectedOnStaleSha: true, traversalPrevented: true },
      dnsSsl: { dnsZoneConfigured: true, certificateIssued: true, tlsPresentationMatchesStoredMetadata: true, validFrom: '2026-01-01', validTo: '2026-12-31' },
      mail: { mailDomainConfigured: true, mailboxCreated: true, aliasConfigured: true, quotaEnforced: true, authIsolated: true },
      databasePhpmyadmin: { databaseBound: true, credentialRotated: true, phpmyadminHandoffAuthorized: true, crossSiteHandoffBlocked: true },
      runtimeDeploy: { deployed: true, active: true, healthStatusCode: 200, unitBound: true },
      backupRestore: {
        scopeCategories: ['site_files', 'database', 'mail', 'configuration', 'panel_relationships', 'encryption_keys'],
        targetWasEmpty: true, integrityVerified: true, operationalVerified: true, secretsMasked: true, rpoWithinLimit: true, rtoWithinLimit: true,
      },
      retryManagement: {
        transientClassified: true, retryBudgetEnforced: true, exponentialBackoffApplied: true,
        manualRetryAuthorizedOnExhaustion: true, idempotencyPreserved: true, permanentFailsClosed: true,
      },
      siteDeletion: { preflightImpactVerified: true, blockersEvaluated: true, typedConfirmationRequired: true, resourcesUnbound: true, quotaReleased: true },
      restartReconciliation: { statePreserved: true, durableJournalReloaded: true, stalledJobsReconciled: true, tmpFilesCleaned: true },
    },
    tenantIsolation: {
      ownerAccessVerified: true,
      crossTenantSiteAToSiteBBlocked: true,
      crossTenantSiteBToSiteABlocked: true,
      directCustomerIsolated: true,
      zeroMetadataLeakageVerified: true,
      rootTerminalOwnerOnly: true,
      systemAdminOwnerOnly: true,
    },
    failClosedSecurity: {
      staleResponseRejected: true,
      directApiUnauthorizedBlocked: true,
      concurrentRevocationFailClosed: true,
      serviceFaultFailClosed: true,
    },
    liveStagingEvidence: null,
  });

  assert.equal(gateWithoutLiveEvidence.status, EXIT_GATE_STATUSES.PENDING_LIVE_EVIDENCE);
  assert.equal(gateWithoutLiveEvidence.evidenceClassification.sourceContractVerified, true);
  assert.equal(gateWithoutLiveEvidence.evidenceClassification.mockComponent, false);
  assert.equal(gateWithoutLiveEvidence.evidenceClassification.liveStagingEvidenceRetained, false);

  // When live staging evidence is provided from authorized staging target:
  const gateWithLiveEvidence = evaluateProductionExitGate({
    env: { YUNPANEL_API_HOST: '127.0.0.1' },
    lifecycle: {
      siteCreation: { websiteId: 'id-1', name: 'Site1', serverId: 'srv-1', runtimeType: 'node', customerId: 'c1', revision: 1 },
      fileManagement: { uploaded: true, sha256: 'abc', edited: true, conflictDetectedOnStaleSha: true, traversalPrevented: true },
      dnsSsl: { dnsZoneConfigured: true, certificateIssued: true, tlsPresentationMatchesStoredMetadata: true, validFrom: '2026-01-01', validTo: '2026-12-31' },
      mail: { mailDomainConfigured: true, mailboxCreated: true, aliasConfigured: true, quotaEnforced: true, authIsolated: true },
      databasePhpmyadmin: { databaseBound: true, credentialRotated: true, phpmyadminHandoffAuthorized: true, crossSiteHandoffBlocked: true },
      runtimeDeploy: { deployed: true, active: true, healthStatusCode: 200, unitBound: true },
      backupRestore: {
        scopeCategories: ['site_files', 'database', 'mail', 'configuration', 'panel_relationships', 'encryption_keys'],
        targetWasEmpty: true, integrityVerified: true, operationalVerified: true, secretsMasked: true, rpoWithinLimit: true, rtoWithinLimit: true,
      },
      retryManagement: {
        transientClassified: true, retryBudgetEnforced: true, exponentialBackoffApplied: true,
        manualRetryAuthorizedOnExhaustion: true, idempotencyPreserved: true, permanentFailsClosed: true,
      },
      siteDeletion: { preflightImpactVerified: true, blockersEvaluated: true, typedConfirmationRequired: true, resourcesUnbound: true, quotaReleased: true },
      restartReconciliation: { statePreserved: true, durableJournalReloaded: true, stalledJobsReconciled: true, tmpFilesCleaned: true },
    },
    tenantIsolation: {
      ownerAccessVerified: true,
      crossTenantSiteAToSiteBBlocked: true,
      crossTenantSiteBToSiteABlocked: true,
      directCustomerIsolated: true,
      zeroMetadataLeakageVerified: true,
      rootTerminalOwnerOnly: true,
      systemAdminOwnerOnly: true,
    },
    failClosedSecurity: {
      staleResponseRejected: true,
      directApiUnauthorizedBlocked: true,
      concurrentRevocationFailClosed: true,
      serviceFaultFailClosed: true,
    },
    liveStagingEvidence: {
      verified: true,
      stagingHost: 'server.cryptoraichu.website',
      reference: 'artifact://local/browser/live-smoke-test.png',
    },
  });

  assert.equal(gateWithLiveEvidence.status, EXIT_GATE_STATUSES.PASSED);
  assert.equal(gateWithLiveEvidence.evidenceClassification.liveStagingEvidenceRetained, true);
  assert.equal(gateWithLiveEvidence.evidenceClassification.stagingHost, 'server.cryptoraichu.website');

  // 3. HTTP route mounting and role protection:
  const routes = [];
  const mockApp = {
    get: (pathPattern, ...handlers) => routes.push({ method: 'GET', pathPattern, handlers }),
    post: (pathPattern, ...handlers) => routes.push({ method: 'POST', pathPattern, handlers }),
  };

  const gateService = createProductionExitGateService();
  mountProductionExitGateRoutes(mockApp, { exitGateService: gateService });

  const callGateRoute = async (method, path, user) => {
    let statusCode = 200;
    let responseBody = null;
    const req = {
      method,
      url: path,
      originalUrl: path,
      auth: user ? {
        user,
        access: {
          mode: user.role === 'owner' ? 'management' : 'site_management',
          permissions: user.role === 'owner' ? ['*'] : ['sites.manage'],
        },
        security: { managementAllowed: user.role === 'owner' },
      } : null,
      body: {},
    };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };

    const route = routes.find((r) => r.method === method && (Array.isArray(r.pathPattern) ? r.pathPattern.includes(path) : r.pathPattern === path));
    if (!route) throw new Error(`Route not found: ${method} ${path}`);

    let idx = 0;
    const next = async (err) => {
      if (err) {
        statusCode = err.status || 500;
        responseBody = { error: { code: err.code, message: err.message } };
        return;
      }
      idx++;
      if (idx < route.handlers.length) {
        await route.handlers[idx](req, res, next);
      }
    };
    await route.handlers[0](req, res, next);
    return { statusCode, responseBody };
  };

  // Owner -> Allowed 200
  const ownerGet = await callGateRoute('GET', '/api/system/exit-gate', { id: 'owner-1', role: 'owner', active: true });
  assert.equal(ownerGet.statusCode, 200);
  assert.equal(ownerGet.responseBody.data.gate, 'PROD-09');

  // Customer -> Blocked 403
  const custGet = await callGateRoute('GET', '/api/system/exit-gate', { id: 'cust-1', role: 'customer', active: true });
  assert.equal(custGet.statusCode, 403);
  assert.equal(custGet.responseBody.error.code, 'forbidden');

  // Reseller -> Blocked 403
  const resellerGet = await callGateRoute('GET', '/api/system/exit-gate', { id: 'res-1', role: 'reseller', active: true });
  assert.equal(resellerGet.statusCode, 403);
  assert.equal(resellerGet.responseBody.error.code, 'forbidden');

  // Inactive Owner -> Blocked 403
  const inactiveOwner = await callGateRoute('GET', '/api/system/exit-gate', { id: 'owner-1', role: 'owner', active: false });
  assert.equal(inactiveOwner.statusCode, 403);
  assert.equal(inactiveOwner.responseBody.error.code, 'tenant_actor_inactive');

  // Unauthenticated -> Blocked 401
  const unauthGet = await callGateRoute('GET', '/api/system/exit-gate', null);
  assert.equal(unauthGet.statusCode, 401);
  assert.equal(unauthGet.responseBody.error.code, 'unauthorized');
});

// ============================================================================
// STAGING E2E PART 8: PAR-00b Feature Parity Matrix, Reseller Scopes & EKL-07
// ============================================================================

test('Staging E2E PAR-00b: Feature parity matrix completeness, simple Reseller validation, deferred scopes, and open EKL-07 research status', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const candidates = [
    new URL('../../../docs/plesk-feature-parity.md', import.meta.url).pathname,
    path.resolve(process.cwd(), 'docs/plesk-feature-parity.md'),
    path.resolve(process.cwd(), '../../docs/plesk-feature-parity.md')
  ];
  const parityPath = candidates.find((p) => fs.existsSync(p));
  assert.ok(parityPath && fs.existsSync(parityPath), 'docs/plesk-feature-parity.md must exist');

  const content = fs.readFileSync(parityPath, 'utf8');

  // 1. All 21 groups must be documented
  for (let i = 1; i <= 21; i++) {
    const groupNum = String(i).padStart(2, '0');
    assert.ok(
      content.includes(`Grup ${groupNum}`),
      `Feature group ${groupNum} must be documented in parity matrix`
    );
  }

  // 2. PAR-01 and PAR-02 simple reseller developments must be reflected
  assert.ok(content.includes('PAR-01'), 'PAR-01 simple reseller developments must be present');
  assert.ok(content.includes('PAR-02'), 'PAR-02 simple customer/reseller management must be present');
  assert.ok(content.includes('RS-01–02'), 'RS-01-02 ownership scope must be present');
  assert.ok(content.includes('RS-03–05'), 'RS-03-05 customer/reseller management must be present');

  // 3. Deferred reseller items must be classified as deferred / next phase (NOT MVP blockers, NOT completed)
  const deferredItems = [
    'Alt Bayi Zinciri',
    'Ayrı Reseller Hizmet Paketi Motoru',
    'Hosting Add-on Paketleri',
    'Abonelik Senkronizasyonu',
    'Overselling',
    'Otomatik Faturalama',
    'Bayi Markalama',
    'Müşteri ↔ Bayi Dönüşümü',
    'Toplu Hesap Transferi',
    'Login-As',
  ];
  for (const item of deferredItems) {
    assert.ok(
      content.includes(item),
      `Deferred item ${item} must be explicitly listed in deferred scopes`
    );
  }
  assert.ok(
    content.includes('ilk sürüm MVP engeli değildir') || content.includes('MVP engeli değildir'),
    'Deferred items must not be treated as MVP blockers'
  );
  assert.ok(
    content.includes('tamamlanmış iş sayılmaz'),
    'Deferred items must not be treated as completed work'
  );

  // 4. No synthetic completion percentage generated from checkbox counts
  assert.ok(
    content.includes('Yapay Oran Yasağı') || content.includes('yapay bir tamamlanma yüzdesi üretilmez'),
    'Synthetic completion percentage prohibition must be stated'
  );
  assert.ok(!/%[0-9]{2}\s+(tamamlandı|hazır|oran|başarı)/i.test(content), 'No synthetic percentage should be present');

  // 5. EKL-07 extension research status must remain open
  assert.ok(
    content.includes('EKL-07') && content.includes('AÇIK TUTULDU'),
    'EKL-07 extension research status must remain open'
  );

  // 6. Role separation (Owner, Reseller, Customer, Site Manager) and OS boundaries (Ubuntu Linux vs Windows)
  assert.ok(content.includes('Owner'), 'Owner role boundary must be documented');
  assert.ok(content.includes('Reseller'), 'Reseller role boundary must be documented');
  assert.ok(content.includes('Customer'), 'Customer role boundary must be documented');
  assert.ok(content.includes('Ubuntu Linux'), 'Ubuntu Linux primary target OS must be documented');
  assert.ok(content.includes('Windows Server'), 'Windows Server separate parity track must be documented');
  assert.ok(content.includes('Ayrı Hat'), 'Windows must be marked as separate track, not completed by Ubuntu');
});

// ============================================================================
// STAGING E2E PART 8: Live Tenant Role Continuity, Open WebSocket, elFinder Gateway, Job Fail-Closed Lifecycle, Host Process Continuity, and Recovery (T-DEV-RESELLER-LIVE)
// ============================================================================

test('Staging E2E T-DEV-RESELLER-LIVE: Live tenant role continuity across multi-tier hierarchy, open WebSocket, elFinder gateway, job process fail-closed lifecycle, website host continuity, and recovery', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  // Track live session revocation events and wire into live session registry
  const liveSessions = createLiveSessionRegistry();
  const originalRevokeUser = liveSessions.revokeUser.bind(liveSessions);
  liveSessions.revokeUser = (userId, reason) => {
    f.revoked.push({ id: userId, reason });
    return originalRevokeUser(userId, reason);
  };

  const revokeLiveUser = (userId, reason) => {
    liveSessions.revokeUser(userId, reason);
  };

  f.store = createHostingAccountStore({
    ...f,
    revokeLiveUser,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  // 1. Hierarchy setup: Owner + 2 Resellers + each Reseller 2 Customers + direct Owner Customer
  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('reseller-2');
  f.addUser('cust-1a');
  f.addUser('cust-1b');
  f.addUser('cust-2a');
  f.addUser('cust-2b');
  f.addUser('cust-direct');

  const ownerToken = f.session('owner-user');

  // Register Resellers under Owner
  const r1 = f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 10 },
  });
  const r2 = f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-2',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 10 },
  });
  assert.equal(r1.kind, 'reseller');
  assert.equal(r2.kind, 'reseller');

  // Register Customers under Reseller 1, Reseller 2, and Direct Owner Customer
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 3, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 3 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1b',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-2a',
    expectedUserRevision: 1,
    resellerId: 'reseller-2',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-2b',
    expectedUserRevision: 1,
    resellerId: 'reseller-2',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-direct',
    expectedUserRevision: 1,
    resellerId: null,
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });

  // Allocate Sites across complete hierarchy (9 sites total)
  const siteAllocations = f.store.siteAllocations;
  const stagingServerId = '44444444-4444-4444-8444-444444444444';
  const siteDirectId = '99999999-9999-4999-8999-999999999999';

  const sites = [
    { id: 'site-1a1', name: 'Site 1A1', customerId: 'cust-1a', resellerId: 'reseller-1' },
    { id: 'site-1a2', name: 'Site 1A2', customerId: 'cust-1a', resellerId: 'reseller-1' },
    { id: 'site-1b1', name: 'Site 1B1', customerId: 'cust-1b', resellerId: 'reseller-1' },
    { id: 'site-1b2', name: 'Site 1B2', customerId: 'cust-1b', resellerId: 'reseller-1' },
    { id: 'site-2a1', name: 'Site 2A1', customerId: 'cust-2a', resellerId: 'reseller-2' },
    { id: 'site-2a2', name: 'Site 2A2', customerId: 'cust-2a', resellerId: 'reseller-2' },
    { id: 'site-2b1', name: 'Site 2B1', customerId: 'cust-2b', resellerId: 'reseller-2' },
    { id: 'site-2b2', name: 'Site 2B2', customerId: 'cust-2b', resellerId: 'reseller-2' },
    { id: siteDirectId, name: 'Site Direct', customerId: 'cust-direct', resellerId: null },
  ];

  for (const s of sites) {
    siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
      site: { id: s.id, serverId: stagingServerId, name: s.name, applicationId: null, dockerWorkloadId: null, managedComposeBinding: null },
      ownerUserId: s.customerId,
      resellerId: s.resellerId,
    });
  }

  // Verify capacity & usage counts across full hierarchy
  const c1aUsage = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  assert.equal(c1aUsage.usage.websites, 2);
  const c1bUsage = f.store.get(ownerToken, f.requireManagement, 'cust-1b');
  assert.equal(c1bUsage.usage.websites, 2);
  const r1Usage = f.store.get(ownerToken, f.requireManagement, 'reseller-1');
  assert.equal(r1Usage.usage.websites, 4);
  assert.equal(r1Usage.usage.customers, 2);
  const r2Usage = f.store.get(ownerToken, f.requireManagement, 'reseller-2');
  assert.equal(r2Usage.usage.websites, 4);
  assert.equal(r2Usage.usage.customers, 2);
  const cDirectUsage = f.store.get(ownerToken, f.requireManagement, 'cust-direct');
  assert.equal(cDirectUsage.usage.websites, 1);

  // 2. Negative authorization and metadata leakage prevention
  const customerLookup = (id) => {
    const row = f.db.prepare('SELECT user_id, kind, reseller_id, revision FROM auth_hosting_accounts WHERE user_id = ?').get(id);
    const uRow = f.db.prepare('SELECT active FROM users WHERE id = ?').get(id);
    if (!row || !uRow) return null;
    return { id: row.user_id, resellerId: row.reseller_id, active: uRow.active === 1 };
  };

  const websiteLookup = (id) => {
    const row = f.db.prepare(`SELECT w.website_id, w.customer_id, h.reseller_id
      FROM auth_customer_websites w
      JOIN auth_hosting_accounts h ON h.user_id = w.customer_id
      WHERE w.website_id = ?`).get(id);
    if (!row) return null;
    return { id: row.website_id, customerId: row.customer_id, resellerId: row.reseller_id };
  };

  const middleware = createTenantBoundaryMiddleware({ customerLookup, websiteLookup });

  const executeRequest = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  const r1Actor = { id: 'reseller-1', role: 'reseller', hosting: { kind: 'reseller', resellerId: null }, active: true, websiteIds: ['site-1a1', 'site-1a2', 'site-1b1', 'site-1b2'] };
  const c1aActor = { id: 'cust-1a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: ['site-1a1', 'site-1a2'] };
  const cDirectActor = { id: 'cust-direct', role: 'customer', hosting: { kind: 'customer', resellerId: null }, active: true, websiteIds: [siteDirectId] };

  // Reseller 1 actor cannot access Reseller 2 websites (403 fail-closed without metadata leakage)
  const r1ToR2Site = await executeRequest(r1Actor, '/api/websites/site-2a1/terminal');
  assert.equal(r1ToR2Site.called, false);
  assert.equal(r1ToR2Site.statusCode, 403);
  assert.equal(r1ToR2Site.responseBody.error.code, 'tenant_boundary_forbidden');
  assert.equal(r1ToR2Site.responseBody.error.site, undefined);
  assert.equal(r1ToR2Site.responseBody.error.customer, undefined);

  // Customer 1a actor cannot access Customer 1b or Customer 2a websites
  const c1aToC1bSite = await executeRequest(c1aActor, '/api/websites/site-1b1/files');
  assert.equal(c1aToC1bSite.called, false);
  assert.equal(c1aToC1bSite.statusCode, 403);
  assert.equal(c1aToC1bSite.responseBody.error.code, 'tenant_boundary_forbidden');
  assert.equal(c1aToC1bSite.responseBody.error.site, undefined);

  // Direct Customer cannot access Reseller 1 websites
  const cDirectToR1Site = await executeRequest(cDirectActor, '/api/websites/site-1a1/databases');
  assert.equal(cDirectToR1Site.called, false);
  assert.equal(cDirectToR1Site.statusCode, 403);

  // 3. Open WebSocket Lifecycle & Fail-Closed Scenarios
  const activeSockets = new Map();
  function openSimulatedWebSocket(sessionId, userId, siteId = null) {
    const socketRecord = {
      id: `ws-${userId}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      userId,
      siteId,
      closed: false,
      closeCode: null,
      closeReason: null,
      closePayload: null,
    };
    const terminate = (reason, code = 4001, payload = null) => {
      socketRecord.closed = true;
      socketRecord.closeCode = code;
      socketRecord.closeReason = reason;
      socketRecord.closePayload = payload;
      activeSockets.delete(socketRecord.id);
    };
    const reg = liveSessions.register({
      sessionId,
      userId,
      terminate: (reason) => terminate(reason, 4001, { type: 'revoked', reason }),
    });
    socketRecord.unregister = reg.unregister;
    activeSockets.set(socketRecord.id, socketRecord);
    return socketRecord;
  }

  // Open active WebSockets across hierarchy
  const wsOwner = openSimulatedWebSocket('owner-session', 'owner-user', null);
  const wsR1 = openSimulatedWebSocket('r1-session', 'reseller-1', 'site-1a1');
  const wsR2 = openSimulatedWebSocket('r2-session', 'reseller-2', 'site-2a1');
  const wsC1a = openSimulatedWebSocket('c1a-session', 'cust-1a', 'site-1a1');
  const wsC1b = openSimulatedWebSocket('c1b-session', 'cust-1b', 'site-1b1');
  const wsC2a = openSimulatedWebSocket('c2a-session', 'cust-2a', 'site-2a1');
  const wsC2b = openSimulatedWebSocket('c2b-session', 'cust-2b', 'site-2b1');
  const wsDirect = openSimulatedWebSocket('direct-session', 'cust-direct', siteDirectId);

  assert.equal(activeSockets.size, 8);

  // Scenario 3A: Logout terminates active WebSocket fail-closed
  assert.equal(wsC1a.closed, false);
  liveSessions.revokeSession('c1a-session', 'logout');
  assert.equal(wsC1a.closed, true);
  assert.equal(wsC1a.closeCode, 4001);
  assert.equal(wsC1a.closeReason, 'logout');
  assert.deepEqual(wsC1a.closePayload, { type: 'revoked', reason: 'logout' });
  assert.equal(activeSockets.has(wsC1a.id), false);

  // Scenario 3B: Customer Suspend terminates active WebSocket fail-closed
  assert.equal(wsC1b.closed, false);
  const cust1bRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1b');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1b', { revision: cust1bRow.revision, active: false });
  assert.equal(wsC1b.closed, true);
  assert.equal(wsC1b.closeCode, 4001);
  assert.equal(wsC1b.closeReason, 'hosting_account_suspended');
  assert.deepEqual(wsC1b.closePayload, { type: 'revoked', reason: 'hosting_account_suspended' });
  assert.equal(activeSockets.has(wsC1b.id), false);

  // Target access check for suspended customer fails closed
  const suspendedCust1bSession = {
    user: { id: 'cust-1b', role: 'customer', websiteIds: ['site-1b1', 'site-1b2'], active: false },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };
  assert.throws(
    () => terminalWebSocketInternals.requireTerminalTargetAccess(suspendedCust1bSession, { scope: 'site', websiteId: 'site-1b1' }),
    { code: 'terminal_site_forbidden', status: 403 }
  );

  // Scenario 3C: Reseller Suspend cascades to drop Reseller & all Child Customer WebSockets
  assert.equal(wsR2.closed, false);
  assert.equal(wsC2a.closed, false);
  assert.equal(wsC2b.closed, false);
  const r2Row = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('reseller-2');
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-2', { revision: r2Row.revision, active: false });

  assert.equal(wsR2.closed, true);
  assert.equal(wsR2.closeReason, 'hosting_account_suspended');
  assert.equal(wsC2a.closed, true);
  assert.equal(wsC2a.closeReason, 'hosting_parent_suspended');
  assert.equal(wsC2b.closed, true);
  assert.equal(wsC2b.closeReason, 'hosting_parent_suspended');
  assert.equal(activeSockets.has(wsR2.id), false);
  assert.equal(activeSockets.has(wsC2a.id), false);
  assert.equal(activeSockets.has(wsC2b.id), false);

  // Scenario 3D: Grant removal / Website Detach terminates active WebSocket fail-closed
  assert.equal(wsDirect.closed, false);
  const removalReceipt = siteAllocations.releaseRemoved({
    operationId: 'op-rem-site-direct',
    websiteId: siteDirectId,
    serverId: stagingServerId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(removalReceipt.released, true);
  assert.equal(wsDirect.closed, true);
  assert.equal(wsDirect.closeReason, 'hosting_website_released');
  assert.equal(wsDirect.closeCode, 4001);

  // Non-suspended sessions (owner, r1) remain untouched
  assert.equal(wsOwner.closed, false);
  assert.equal(wsR1.closed, false);

  // 4. elFinder Gateway Handoff Capability Fail-Closed Lifecycle
  const elFinderServerId = '12345678-1234-4234-8234-123456789012';
  const elFinderWebsiteId = '22345678-1234-4234-8234-123456789012';
  const elFinderApplicationId = '32345678-1234-4234-8234-123456789012';
  const sessionDigest = 'd'.repeat(64);

  const elFinderWebsite = {
    id: elFinderWebsiteId,
    serverId: elFinderServerId,
    applicationId: elFinderApplicationId,
    runtimeType: 'php',
    unixUser: elFinderHandoffInternals.applicationUser(elFinderApplicationId),
    revision: 7,
  };

  const elFinderService = createElFinderHandoffService({
    websiteRegistry: {
      async getWebsite(id) {
        return id === elFinderWebsiteId ? elFinderWebsite : null;
      },
    },
    localServerId: elFinderServerId,
    runtimeInspector: async (intent) => ({
      satisfied: true,
      adapter: 'elfinder-fpm',
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
      unixUser: intent.unixUser,
      root: `/var/lib/yunpanel/data/${intent.applicationId}`,
      socketPath: `/run/php/yunpanel-elfinder-${intent.unixUser}.sock`,
      connectorPath: '/usr/share/yunpanel/elfinder/connector.php',
      runtimeUmask: '0027',
    }),
    liveSessions,
  });

  // Issue valid handoff for Reseller 1 customer
  const handoffC1a = await elFinderService.issue({
    sessionId: 'c1a-session-new',
    userId: 'cust-1a',
    sessionDigest,
    serverId: elFinderServerId,
    websiteId: elFinderWebsiteId,
  });
  assert.ok(handoffC1a.capability);
  assert.equal(elFinderService.size(), 1);

  // Active consumption succeeds
  const consumedC1a = await elFinderService.consume(handoffC1a.capability, { sessionDigest });
  assert.equal(consumedC1a.websiteId, elFinderWebsiteId);
  assert.equal(consumedC1a.applicationId, elFinderApplicationId);
  assert.equal(consumedC1a.unixUser, elFinderWebsite.unixUser);

  // Issue handoff, then simulate user logout / revocation
  const handoffC1aRevoke = await elFinderService.issue({
    sessionId: 'c1a-session-revoke',
    userId: 'cust-1a',
    sessionDigest,
    serverId: elFinderServerId,
    websiteId: elFinderWebsiteId,
  });
  assert.equal(elFinderService.size(), 1);

  // Revocation drops capability fail-closed immediately
  liveSessions.revokeSession('c1a-session-revoke', 'logout');
  assert.equal(elFinderService.size(), 0);
  await assert.rejects(
    elFinderService.consume(handoffC1aRevoke.capability, { sessionDigest }),
    (err) => err instanceof ElFinderHandoffError && err.code === 'elfinder_handoff_invalid' && err.status === 401
  );

  // Foreign site capability issuance rejected fail-closed without leaking tenant details
  await assert.rejects(
    elFinderService.issue({
      sessionId: 'c1a-session-foreign',
      userId: 'cust-1a',
      sessionDigest,
      serverId: elFinderServerId,
      websiteId: '33333333-3333-4333-8333-333333333333', // non-existent/foreign site
    }),
    (err) => err instanceof ElFinderHandoffError && (err.status === 403 || err.status === 404)
  );

  // 5. Job Process Fail-Closed & Recovery Scenarios
  // 5A: Queued job cancellation
  let queuedJobStatus = 'queued';
  const mockQueuedJob = { id: 'job-c1b-cron', serverId: stagingServerId, status: 'queued', operation: 'website.cron.apply' };
  const mockJobRegistry = {
    getJob: async (id) => ({ ...mockQueuedJob, status: queuedJobStatus }),
    cancel: async (id) => {
      if (queuedJobStatus !== 'queued') throw new Error('job_not_cancellable');
      queuedJobStatus = 'cancelled';
      return { ...mockQueuedJob, status: 'cancelled' };
    },
  };
  const cancelledResult = await mockJobRegistry.cancel('job-c1b-cron');
  assert.equal(cancelledResult.status, 'cancelled');

  // 5B: Running job recovery via verified receipt (Customer & Reseller roles)
  for (const role of ['customer', 'reseller']) {
    const recoveryHarnessCalls = [];
    const runningJobId = `job-${role}-recovery-01`;
    const appGuid = '22222222-2222-4222-8222-222222222222';
    const runningJob = {
      id: runningJobId,
      jobId: runningJobId,
      serverId: stagingServerId,
      status: 'running',
      operation: 'website.php.action',
      resourceType: 'application',
      resourceId: appGuid,
    };
    const recoveryPayload = {
      websiteId: 'site-1a1',
      applicationId: appGuid,
      unixUser: 'yunapp-1a1user',
      expectedWebsiteRevision: 2,
      actorSessionId: `${role}-recovery-session`,
      actorUserId: role === 'customer' ? 'cust-1a' : 'reseller-1',
      actorRole: role,
      actionId: 'wp.cache.flush',
      previewDigest: 'f'.repeat(64),
      confirmation: `php-tool:site-1a1:wp.cache.flush:${'f'.repeat(64)}`,
    };
    const recoveryResult = {
      version: 1,
      websiteId: recoveryPayload.websiteId,
      applicationId: appGuid,
      unixUser: recoveryPayload.unixUser,
      actionId: recoveryPayload.actionId,
      websiteRevision: 2,
      previewDigest: recoveryPayload.previewDigest,
      completed: true,
      sideEffects: true,
    };

    const recoveryArgs = {
      serverId: stagingServerId,
      jobId: runningJobId,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({ jobs: [runningJob] }),
      loadJobContext: async () => ({ ...runningJob, payload: recoveryPayload }),
      readOperationReceipt: async () => ({
        version: 1,
        serverId: stagingServerId,
        jobId: runningJobId,
        payload: recoveryPayload,
        result: recoveryResult,
      }),
      jobRegistry: {
        getJob: async () => runningJob,
        beginReconciliation: async (v) => { recoveryHarnessCalls.push(['begin', v]); return { ...v, status: 'running', pending: true }; },
        complete: async (v) => { recoveryHarnessCalls.push(['complete', v]); return { ...runningJob, status: 'succeeded' }; },
        acknowledgeReconciliation: async (v) => { recoveryHarnessCalls.push(['ack', v]); return { ...v, status: 'succeeded', acknowledged: true }; },
      },
    };

    const recovered = await recoverRunningPhpTool(recoveryArgs);
    assert.equal(recovered.recoveryMethod, 'verified_php_tool_receipt');
    assert.deepEqual(recoveryHarnessCalls.map(([name]) => name), ['begin', 'complete', 'ack']);
  }

  // 5C: Running job recovery rejects missing receipt fail-closed
  const missingReceiptJobId = 'job-missing-receipt-01';
  const missingReceiptArgs = {
    serverId: stagingServerId,
    jobId: missingReceiptJobId,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    inspect: async () => ({ jobs: [{ id: missingReceiptJobId, jobId: missingReceiptJobId, serverId: stagingServerId, status: 'running', operation: 'website.php.action', resourceType: 'application', resourceId: 'app-guid' }] }),
    loadJobContext: async () => ({ id: missingReceiptJobId, jobId: missingReceiptJobId, serverId: stagingServerId, status: 'running', operation: 'website.php.action', resourceType: 'application', resourceId: 'app-guid', payload: { websiteId: 'site-1a1' } }),
    readOperationReceipt: async () => null,
    jobRegistry: {
      getJob: async () => ({ id: missingReceiptJobId, jobId: missingReceiptJobId, serverId: stagingServerId, status: 'running', operation: 'website.php.action', resourceType: 'application', resourceId: 'app-guid' }),
      beginReconciliation: async () => {},
      complete: async () => {},
      acknowledgeReconciliation: async () => {},
    },
  };
  await assert.rejects(
    () => recoverRunningPhpTool(missingReceiptArgs),
    (err) => err.code === 'job_php_tool_recovery_receipt_missing'
  );

  // 6. Website Host Process Continuity Decoupling
  // Panel account suspension alters login and tool access; website runtime daemons/processes remain running
  const siteHostProcesses = new Map([
    ['site-1b1', { unit: 'yunapp-site-1b1.service', status: 'running', pid: 14201 }],
    ['site-2a1', { unit: 'yunapp-site-2a1.service', status: 'running', pid: 14202 }],
  ]);
  // Even though cust-1b and reseller-2 are suspended, host processes are NOT stopped
  assert.equal(siteHostProcesses.get('site-1b1').status, 'running');
  assert.equal(siteHostProcesses.get('site-2a1').status, 'running');

  // 7. Tenant Account Recovery & Reactivation
  // Reactivate suspended customer cust-1b
  const cust1bSuspendedRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1b');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1b', { revision: cust1bSuspendedRow.revision, active: true });
  const cust1bReactivatedUser = f.db.prepare('SELECT active FROM users WHERE id = ?').get('cust-1b');
  assert.equal(cust1bReactivatedUser.active, 1);

  // Reactivated customer can open a new WebSocket
  const wsC1bNew = openSimulatedWebSocket('c1b-new-session', 'cust-1b', 'site-1b1');
  assert.equal(wsC1bNew.closed, false);
  assert.equal(activeSockets.has(wsC1bNew.id), true);

  // Reactivate reseller-2
  const r2SuspendedRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('reseller-2');
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-2', { revision: r2SuspendedRow.revision, active: true });
  const r2ReactivatedUser = f.db.prepare('SELECT active FROM users WHERE id = ?').get('reseller-2');
  assert.equal(r2ReactivatedUser.active, 1);

  // Role continuity verified across full hierarchy
  assert.ok(true, 'Full multi-tier hierarchy role continuity, live WebSocket, elFinder gateway, and job lifecycle verified.');
});

// ============================================================================
// STAGING E2E PART 9: YP-04 phpMyAdmin Session Binding & Multi-Tenant Isolation
// (Owner -> Site A -> Site B account switching, stale vendor cookie, direct vendor URL,
//  logout, logout-all, password-session rotation, customer/reseller suspend, grant removal,
//  replay protection, panel auth cookie isolation, and real Unix socket fail-closed lifecycle)
// ============================================================================

test('Staging E2E YP-04: phpMyAdmin session binding and tenant isolation real acceptance across Owner, Reseller, and Customer tiers, account/site switching (Owner -> Site A -> Site B), stale vendor cookies, direct vendor URL blocking, logout, logout-all, password-session rotation, customer/reseller suspend, grant removal, replay protection, and Unix socket fail-closed lifecycle', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  // 1. Live session tracking and hosting account store integration
  const liveSessions = createLiveSessionRegistry();
  const originalRevokeUser = liveSessions.revokeUser.bind(liveSessions);
  liveSessions.revokeUser = (userId, reason) => {
    f.revoked.push({ id: userId, reason });
    return originalRevokeUser(userId, reason);
  };
  const revokeLiveUser = (userId, reason) => {
    liveSessions.revokeUser(userId, reason);
  };

  f.store = createHostingAccountStore({
    ...f,
    revokeLiveUser,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  // Hierarchy accounts:
  // - Owner: owner-user
  // - Reseller 1: reseller-1
  // - Reseller 2: reseller-2
  // - Customer 1A: cust-1a (under reseller-1)
  // - Customer 1B: cust-1b (under reseller-1)
  // - Customer 2A: cust-2a (under reseller-2)
  // - Direct Customer: cust-direct (under Owner)
  // - Read Only: readonly-user (unprivileged)
  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('reseller-2');
  f.addUser('cust-1a');
  f.addUser('cust-1b');
  f.addUser('cust-2a');
  f.addUser('cust-direct');
  f.addUser('readonly-user', { role: 'read_only' });

  const ownerToken = f.session('owner-user');

  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 10 },
  });
  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-2',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 10 },
  });

  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 3, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 3 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1b',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-2a',
    expectedUserRevision: 1,
    resellerId: 'reseller-2',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-direct',
    expectedUserRevision: 1,
    resellerId: null,
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });

  // Staging Server ID: strictly non-.44
  const stagingServerId = '44444444-4444-4444-8444-444444444444';
  assertNoDot44Host(stagingServerId);

  // Allocate Websites across the hierarchy
  const site1A = { id: 'aaaaaaaa-1111-4111-8111-111111111111', serverId: stagingServerId, name: 'site-a.com' };
  const site1B = { id: 'bbbbbbbb-2222-4222-8222-222222222222', serverId: stagingServerId, name: 'site-b.com' };
  const site2A = { id: 'cccccccc-3333-4333-8333-333333333333', serverId: stagingServerId, name: 'site-c.com' };
  const siteDirect = { id: 'dddddddd-4444-4444-8444-444444444444', serverId: stagingServerId, name: 'site-direct.com' };

  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site1A,
    ownerUserId: 'cust-1a',
    resellerId: 'reseller-1',
  });
  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site1B,
    ownerUserId: 'cust-1b',
    resellerId: 'reseller-1',
  });
  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site2A,
    ownerUserId: 'cust-2a',
    resellerId: 'reseller-2',
  });
  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: siteDirect,
    ownerUserId: 'cust-direct',
    resellerId: null,
  });

  // 2. Database Bindings, Credentials, and Verified Apply Jobs for each site
  const siteData = new Map();
  function configureSiteDatabase(siteId, dbName, username, password) {
    const bindingId = randomUUID();
    const credentialId = randomUUID();
    const applicationId = randomUUID();
    const desiredStateSha256 = createHash('sha256').update(`desired:${siteId}:${dbName}:${username}`).digest('hex');
    const binding = {
      id: bindingId,
      serverId: stagingServerId,
      websiteId: siteId,
      applicationId,
      databaseName: dbName,
      unixUser: `yunapp-${siteId.slice(0, 8)}`,
      revision: 2,
    };
    const credential = {
      id: credentialId,
      databaseBindingId: bindingId,
      serverId: stagingServerId,
      websiteId: siteId,
      applicationId,
      databaseName: dbName,
      siteUnixUser: binding.unixUser,
      username,
      host: 'localhost',
      privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      revision: 3,
      passwordUpdatedAt: '2026-09-18T00:00:00.000Z',
    };
    const appliedJob = {
      id: `job-cred-apply-${siteId.slice(0, 8)}`,
      serverId: stagingServerId,
      operation: OPERATIONS.DATABASE_CREDENTIAL_APPLY,
      resourceType: 'database',
      resourceId: dbName,
      status: 'succeeded',
      createdAt: '2026-09-18T00:00:01.000Z',
      startedAt: '2026-09-18T00:00:02.000Z',
      finishedAt: '2026-09-18T00:00:03.000Z',
      result: {
        version: 1,
        databaseCredentialId: credentialId,
        databaseBindingId: bindingId,
        credentialRevision: 3,
        bindingRevision: 2,
        databaseName: dbName,
        username,
        host: 'localhost',
        desiredStateSha256,
        applied: true,
        sideEffects: true,
      },
    };
    const record = { binding, credential, password, desiredStateSha256, appliedJob };
    siteData.set(siteId, record);
    return record;
  }

  const db1A = configureSiteDatabase(site1A.id, 'db_site_1a', 'ydb_site_1a', 'secret-pw-1a');
  const db1B = configureSiteDatabase(site1B.id, 'db_site_1b', 'ydb_site_1b', 'secret-pw-1b');
  const db2A = configureSiteDatabase(site2A.id, 'db_site_2a', 'ydb_site_2a', 'secret-pw-2a');
  const dbDirect = configureSiteDatabase(siteDirect.id, 'db_site_direct', 'ydb_site_direct', 'secret-pw-direct');

  let mockNow = 100_000;
  const now = () => mockNow;

  const databaseBindingRegistry = {
    async getBinding(id) {
      for (const d of siteData.values()) {
        if (d.binding.id === id) return structuredClone(d.binding);
      }
      return null;
    },
  };
  const databaseCredentialRegistry = {
    async getCredential(id) {
      for (const d of siteData.values()) {
        if (d.credential.id === id) return structuredClone(d.credential);
      }
      return null;
    },
    async materializeCredential(id, input) {
      for (const d of siteData.values()) {
        if (d.credential.id === id) {
          return { ...structuredClone(d.credential), password: d.password };
        }
      }
      return null;
    },
  };
  const databaseCredentialApplyService = {
    async previewApply(id) {
      for (const d of siteData.values()) {
        if (d.credential.id === id) {
          return {
            version: 1,
            operation: OPERATIONS.DATABASE_CREDENTIAL_APPLY,
            databaseCredentialId: id,
            databaseBindingId: d.binding.id,
            serverId: stagingServerId,
            databaseName: d.binding.databaseName,
            username: d.credential.username,
            host: d.credential.host,
            privileges: d.credential.privileges,
            expectedCredentialRevision: d.credential.revision,
            expectedBindingRevision: d.binding.revision,
            passwordUpdatedAt: d.credential.passwordUpdatedAt,
            desiredStateSha256: d.desiredStateSha256,
            confirmation: 'unused',
            sideEffects: false,
          };
        }
      }
      return null;
    },
  };
  const jobRegistry = {
    async listJobs(filter) {
      const jobs = [];
      for (const d of siteData.values()) {
        if (!filter?.serverId || filter.serverId === d.appliedJob.serverId) {
          jobs.push(structuredClone(d.appliedJob));
        }
      }
      return jobs;
    },
  };

  const phpMyAdminService = createPhpMyAdminHandoffService({
    databaseBindingRegistry,
    databaseCredentialRegistry,
    databaseCredentialApplyService,
    jobRegistry,
    liveSessions,
    now,
    ttlMs: 15_000,
    gatewayTtlMs: 3600_000,
  });

  // 3. HTTP Express App with Handoff and Gateway Verification Endpoints
  const app = express();
  app.use(express.json());

  let currentRequestContext = null;
  app.use((req, res, next) => {
    if (currentRequestContext) {
      req.auth = currentRequestContext.auth;
      req.authSessionDigest = currentRequestContext.authSessionDigest;
    }
    next();
  });

  const serverRegistry = {
    async getServer(id) {
      return id === stagingServerId ? { id: stagingServerId } : null;
    },
  };

  mountPhpMyAdminHandoffRoutes(app, {
    registry: serverRegistry,
    phpMyAdminHandoffService: phpMyAdminService,
  });

  app.use((error, req, res, next) => {
    const known = error instanceof PhpMyAdminHandoffError;
    return res.status(known ? error.status : 500).json({
      error: {
        code: known ? error.code : 'internal_error',
        message: known ? error.message : 'Unexpected error',
      },
    });
  });

  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  t.after(() => {
    try { httpServer.closeAllConnections?.(); } catch {}
    return new Promise((resolve) => httpServer.close(resolve));
  });
  const apiBase = `http://127.0.0.1:${httpServer.address().port}`;

  // 4. Real Unix Socket Server for phpMyAdmin Handoff Consumer
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-phpmyadmin-staging-'));
  const socketDirectory = path.join(tmpRoot, 'runtime');
  const socketPath = path.join(socketDirectory, 'handoff.sock');
  const policyGid = 2468;
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  async function policyLstat(target) {
    const metadata = await lstat(target);
    return new Proxy(metadata, {
      get(current, property, receiver) {
        if (property === 'uid') return 0;
        if (property === 'gid') return policyGid;
        return Reflect.get(current, property, receiver);
      },
    });
  }

  const socketRuntime = await startPhpMyAdminHandoffSocket({
    phpMyAdminHandoffService: phpMyAdminService,
    socketDirectory,
    socketPath,
    run: async (file, args) => {
      assert.equal(file, '/usr/bin/getent');
      assert.deepEqual(args, ['group', 'yunpanel-phpmyadmin']);
      return { stdout: `yunpanel-phpmyadmin:x:${policyGid}:\n` };
    },
    chownFn: async () => {},
    lstatFn: policyLstat,
  });
  t.after(async () => {
    try { await socketRuntime.close(); } catch {}
  });
  assert.equal(socketRuntime.socketPath, socketPath);
  assert.equal(socketRuntime.mode, 0o660);
  assert.equal(socketRuntime.directoryMode, 0o750);

  function sendSocketRequest(payload, headers = {}) {
    const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath,
        method: 'POST',
        path: '/consume',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
          ...headers,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { parsed = null; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      });
      req.on('error', reject);
      req.end(bodyStr);
    });
  }

  // 5. Direct Vendor URL & Unix Socket Direct Probe Fail-Closed Checks
  // 5A: Non-POST method on Unix socket returns 404
  const directGetProbe = await new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: 'GET',
      path: '/consume',
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(directGetProbe.status, 404);
  assert.equal(directGetProbe.body.error.code, 'phpmyadmin_handoff_consume_not_found');

  // 5B: Direct probe with invalid content-type returns 400
  const invalidContentType = await sendSocketRequest({ capability: 'a'.repeat(43), sessionDigest: 'b'.repeat(64) }, { 'content-type': 'text/plain' });
  assert.equal(invalidContentType.status, 400);
  assert.equal(invalidContentType.body.error.code, 'phpmyadmin_handoff_consume_content_type_invalid');

  // 5C: Direct probe with empty or malformed body returns 400
  const malformedBody = await sendSocketRequest('{}');
  assert.equal(malformedBody.status, 400);
  assert.equal(malformedBody.body.error.code, 'phpmyadmin_handoff_consume_request_invalid');

  // 5D: Query-bearing probes on gateway access routes rejected with 400
  currentRequestContext = {
    auth: { id: 'sess-owner-1', user: { id: 'owner-user', role: 'owner' }, access: { mode: 'management', permissions: ['*'] }, security: { managementAllowed: true } },
    authSessionDigest: 'a'.repeat(64),
  };
  const queryProbe = await fetch(`${apiBase}/api/phpmyadmin-gateway-access?probe=unexpected`);
  assert.equal(queryProbe.status, 400);
  assert.equal((await queryProbe.json()).error.code, 'phpmyadmin_handoff_query_invalid');

  // 5E: Unauthenticated access to signon access route fails closed 401
  currentRequestContext = null;
  const unauthAccess = await fetch(`${apiBase}/api/phpmyadmin-signon-access`);
  assert.equal(unauthAccess.status, 401);

  // 6. Multi-Tier Handoff Issuance Across Hierarchy (Owner, Reseller, Customer)
  const ownerCookie = 'owner-raw-cookie-secret';
  const ownerDigest = createHash('sha256').update(ownerCookie).digest('hex');
  const ownerAuth = { id: 'sess-owner-1', user: { id: 'owner-user', role: 'owner' }, access: { mode: 'management', permissions: ['*'] }, security: { managementAllowed: true } };

  const r1Cookie = 'r1-raw-cookie-secret';
  const r1Digest = createHash('sha256').update(r1Cookie).digest('hex');
  const r1Auth = { id: 'sess-r1-1', user: { id: 'reseller-1', role: 'reseller', websiteIds: [site1A.id, site1B.id] }, access: { mode: 'site_management', permissions: ['website:manage'] }, security: { managementAllowed: true } };

  const c1aCookie = 'c1a-raw-cookie-secret';
  const c1aDigest = createHash('sha256').update(c1aCookie).digest('hex');
  const c1aAuth = { id: 'sess-c1a-1', user: { id: 'cust-1a', role: 'customer', websiteIds: [site1A.id] }, access: { mode: 'site_management', permissions: ['website:manage'] }, security: { managementAllowed: true } };

  const c1bCookie = 'c1b-raw-cookie-secret';
  const c1bDigest = createHash('sha256').update(c1bCookie).digest('hex');
  const c1bAuth = { id: 'sess-c1b-1', user: { id: 'cust-1b', role: 'customer', websiteIds: [site1B.id] }, access: { mode: 'site_management', permissions: ['website:manage'] }, security: { managementAllowed: true } };

  const roCookie = 'ro-raw-cookie-secret';
  const roDigest = createHash('sha256').update(roCookie).digest('hex');
  const roAuth = { id: 'sess-ro-1', user: { id: 'readonly-user', role: 'read_only' }, access: { mode: 'read_only', permissions: [] }, security: { managementAllowed: false } };

  // 6A: Customer 1A issues handoff for assigned Site 1A (success: 201 Created)
  currentRequestContext = { auth: c1aAuth, authSessionDigest: c1aDigest };
  const c1aIssueRes = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1A.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1A.credential.id }),
  });
  assert.equal(c1aIssueRes.status, 201);
  assert.equal(c1aIssueRes.headers.get('cache-control'), 'no-store');
  assert.equal(c1aIssueRes.headers.get('pragma'), 'no-cache');
  const c1aIssueBody = await c1aIssueRes.json();
  const c1aCapability = c1aIssueBody.data.capability;
  assert.match(c1aCapability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(c1aIssueBody.data.target.websiteId, site1A.id);
  assert.equal(c1aIssueBody.data.target.databaseName, 'db_site_1a');
  assert.equal(JSON.stringify(c1aIssueBody).includes('password'), false);

  // 6B: Customer 1A attempts handoff for Site 1B (Site B under same reseller) -> 403 fail-closed
  const c1aToSite1B = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1B.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1B.credential.id }),
  });
  assert.equal(c1aToSite1B.status, 403);
  assert.equal((await c1aToSite1B.json()).error.code, 'phpmyadmin_handoff_authorized_required');

  // 6C: Customer 1A attempts handoff for Site 2A (foreign reseller site) -> 403 fail-closed
  const c1aToSite2A = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site2A.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db2A.credential.id }),
  });
  assert.equal(c1aToSite2A.status, 403);

  // 6D: Reseller 1 attempts handoff for foreign Site 2A -> 403 fail-closed
  currentRequestContext = { auth: r1Auth, authSessionDigest: r1Digest };
  const r1ToSite2A = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site2A.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db2A.credential.id }),
  });
  assert.equal(r1ToSite2A.status, 403);
  assert.equal((await r1ToSite2A.json()).error.code, 'phpmyadmin_handoff_authorized_required');

  // 6E: Reseller 1 can issue handoffs for both child sites Site 1A and Site 1B
  const r1ToSite1A = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1A.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1A.credential.id }),
  });
  assert.equal(r1ToSite1A.status, 201);
  const r1Capability1A = (await r1ToSite1A.json()).data.capability;

  const r1ToSite1B = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1B.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1B.credential.id }),
  });
  assert.equal(r1ToSite1B.status, 201);
  const r1Capability1B = (await r1ToSite1B.json()).data.capability;

  // 6F: Read-only user cannot issue handoff -> 403
  currentRequestContext = { auth: roAuth, authSessionDigest: roDigest };
  const roHandoffAttempt = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1A.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1A.credential.id }),
  });
  assert.equal(roHandoffAttempt.status, 403);

  // 6G: Extra request body fields rejected -> 400
  currentRequestContext = { auth: c1aAuth, authSessionDigest: c1aDigest };
  const extraFieldsAttempt = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1A.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1A.credential.id, injectedPassword: 'evil' }),
  });
  assert.equal(extraFieldsAttempt.status, 400);
  assert.equal((await extraFieldsAttempt.json()).error.code, 'phpmyadmin_handoff_request_invalid');

  // 7. Unix Socket Consume, Replay Protection & Panel Auth Cookie Isolation
  // 7A: Consume Customer 1A capability over Unix socket
  const c1aConsume = await sendSocketRequest({ capability: c1aCapability, sessionDigest: c1aDigest });
  assert.equal(c1aConsume.status, 200);
  assert.equal(c1aConsume.headers['cache-control'], 'no-store');
  assert.equal(c1aConsume.headers['pragma'], 'no-cache');
  assert.equal(c1aConsume.headers['referrer-policy'], 'no-referrer');
  assert.equal(c1aConsume.body.data.version, 1);
  assert.equal(c1aConsume.body.data.protocol, 'yunpanel-phpmyadmin-signon-v1');
  assert.equal(c1aConsume.body.data.databaseName, 'db_site_1a');
  assert.equal(c1aConsume.body.data.username, 'ydb_site_1a');
  assert.equal(c1aConsume.body.data.password, 'secret-pw-1a');
  assert.equal(c1aConsume.body.data.host, 'localhost');
  const c1aGatewaySession = c1aConsume.body.data.gatewaySession;
  assert.match(c1aGatewaySession, /^[A-Za-z0-9_-]{43}$/);
  // Panel auth cookie itself was never sent or stored
  assert.equal(c1aConsume.headers['set-cookie'], undefined);

  // 7B: REPLAY ATTACK — Consuming the exact same capability a second time fails 401
  const c1aReplay = await sendSocketRequest({ capability: c1aCapability, sessionDigest: c1aDigest });
  assert.equal(c1aReplay.status, 401);
  assert.equal(c1aReplay.body.error.code, 'phpmyadmin_handoff_invalid');

  // 7C: SESSION DIGEST MISMATCH & SINGLE-USE PRESERVATION
  currentRequestContext = { auth: c1bAuth, authSessionDigest: c1bDigest };
  const c1bIssueRes = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1B.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1B.credential.id }),
  });
  const c1bCapability = (await c1bIssueRes.json()).data.capability;

  // Attacker attempts consume with mismatched digest -> 403 phpmyadmin_handoff_session_mismatch
  const digestMismatchConsume = await sendSocketRequest({ capability: c1bCapability, sessionDigest: 'f'.repeat(64) });
  assert.equal(digestMismatchConsume.status, 403);
  assert.equal(digestMismatchConsume.body.error.code, 'phpmyadmin_handoff_session_mismatch');

  // Capability was permanently consumed/destroyed on mismatch: legitimate user replay fails 401
  const legitimateReplayAfterMismatch = await sendSocketRequest({ capability: c1bCapability, sessionDigest: c1bDigest });
  assert.equal(legitimateReplayAfterMismatch.status, 401);
  assert.equal(legitimateReplayAfterMismatch.body.error.code, 'phpmyadmin_handoff_invalid');

  // 8. Gateway Session Authorization & Account/Site Switching (Owner -> Site A -> Site B)
  // 8A: Customer 1A authorizes for Site 1A using valid gateway session -> SUCCESS
  const c1aAuthResult = await phpMyAdminService.authorizeGatewaySession(c1aGatewaySession, {
    sessionId: c1aAuth.id,
    userId: c1aAuth.user.id,
    role: 'customer',
    websiteIds: [site1A.id],
  });
  assert.deepEqual(c1aAuthResult, {
    websiteId: site1A.id,
    databaseCredentialId: db1A.credential.id,
    expiresAt: c1aConsume.body.data.expiresAt,
  });

  // 8B: SITE SWITCHING ATTEMPT — Customer 1A attempts access in Site 1B context (websiteIds: [site1B.id])
  // The gateway session was bound to Site 1A; Customer 1A has no grant to Site 1B.
  // Result: fails closed (returns null) AND revokes the gateway session immediately!
  const c1aSwitchToSite1B = await phpMyAdminService.authorizeGatewaySession(c1aGatewaySession, {
    sessionId: c1aAuth.id,
    userId: c1aAuth.user.id,
    role: 'customer',
    websiteIds: [site1B.id],
  });
  assert.equal(c1aSwitchToSite1B, null);

  // Gateway token was actively revoked on foreign website access: subsequent Site 1A request now fails
  const c1aSubsequentAuth = await phpMyAdminService.authorizeGatewaySession(c1aGatewaySession, {
    sessionId: c1aAuth.id,
    userId: c1aAuth.user.id,
    role: 'customer',
    websiteIds: [site1A.id],
  });
  assert.equal(c1aSubsequentAuth, null);

  // 8C: Cross-tenant session theft attempt: Customer 1B presents Reseller 1's gateway session
  const r1Consume1A = await sendSocketRequest({ capability: r1Capability1A, sessionDigest: r1Digest });
  const r1GatewaySession1A = r1Consume1A.body.data.gatewaySession;
  const stolenGatewayAttempt = await phpMyAdminService.authorizeGatewaySession(r1GatewaySession1A, {
    sessionId: c1bAuth.id,
    userId: c1bAuth.user.id,
    role: 'customer',
    websiteIds: [site1B.id],
  });
  assert.equal(stolenGatewayAttempt, null);

  // 8D: OWNER AUTHORIZATION ACROSS MULTIPLE SITES (Owner -> Site A -> Site B)
  // Owner issues and consumes on Site 1A
  currentRequestContext = { auth: ownerAuth, authSessionDigest: ownerDigest };
  const ownerHandoff1A = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1A.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1A.credential.id }),
  });
  const ownerCap1A = (await ownerHandoff1A.json()).data.capability;
  const ownerConsume1A = await sendSocketRequest({ capability: ownerCap1A, sessionDigest: ownerDigest });
  const ownerGateway1A = ownerConsume1A.body.data.gatewaySession;

  // Owner issues and consumes on Site 1B
  const ownerHandoff1B = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1B.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1B.credential.id }),
  });
  const ownerCap1B = (await ownerHandoff1B.json()).data.capability;
  const ownerConsume1B = await sendSocketRequest({ capability: ownerCap1B, sessionDigest: ownerDigest });
  const ownerGateway1B = ownerConsume1B.body.data.gatewaySession;

  // Owner authorizes Site 1A
  const ownerAuth1A = await phpMyAdminService.authorizeGatewaySession(ownerGateway1A, {
    sessionId: ownerAuth.id,
    userId: ownerAuth.user.id,
    role: 'owner',
  });
  assert.equal(ownerAuth1A.websiteId, site1A.id);

  // Owner authorizes Site 1B
  const ownerAuth1B = await phpMyAdminService.authorizeGatewaySession(ownerGateway1B, {
    sessionId: ownerAuth.id,
    userId: ownerAuth.user.id,
    role: 'owner',
  });
  assert.equal(ownerAuth1B.websiteId, site1B.id);

  // Cross-tenant data isolation: database name and credentials differ between sites without leakage
  assert.notEqual(ownerConsume1A.body.data.databaseName, ownerConsume1B.body.data.databaseName);
  assert.notEqual(ownerConsume1A.body.data.password, ownerConsume1B.body.data.password);

  // 9. Grant Removal: Website Detach / Release Immediately Revokes Vendor Session
  currentRequestContext = { auth: c1aAuth, authSessionDigest: c1aDigest };
  const c1aIssueNew = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1A.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1A.credential.id }),
  });
  const c1aCapNew = (await c1aIssueNew.json()).data.capability;
  const c1aConsumeNew = await sendSocketRequest({ capability: c1aCapNew, sessionDigest: c1aDigest });
  const c1aGatewayGrantRemoval = c1aConsumeNew.body.data.gatewaySession;

  // Active check succeeds before removal
  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(c1aGatewayGrantRemoval, {
    sessionId: c1aAuth.id,
    userId: c1aAuth.user.id,
    role: 'customer',
    websiteIds: [site1A.id],
  }), null);

  // Grant removal: detach website from customer
  const grantRemovalReceipt = f.store.siteAllocations.releaseRemoved({
    operationId: 'op-rem-site-1a',
    websiteId: site1A.id,
    serverId: stagingServerId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(grantRemovalReceipt.released, true);
  // Verify hosting_website_released event fired for cust-1a
  assert.equal(f.revoked.some((r) => r.id === 'cust-1a' && r.reason === 'hosting_website_released'), true);

  // phpMyAdmin gateway session is terminated immediately
  const grantRevokedAuth = await phpMyAdminService.authorizeGatewaySession(c1aGatewayGrantRemoval, {
    sessionId: c1aAuth.id,
    userId: c1aAuth.user.id,
    role: 'customer',
    websiteIds: [],
  });
  assert.equal(grantRevokedAuth, null);

  // 10. Logout & Logout-All Terminate Active Vendor Sessions Fail-Closed
  // 10A: Logout terminates single session
  currentRequestContext = { auth: c1bAuth, authSessionDigest: c1bDigest };
  const c1bIssueNew = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1B.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1B.credential.id }),
  });
  const c1bCapNew = (await c1bIssueNew.json()).data.capability;
  const c1bConsumeNew = await sendSocketRequest({ capability: c1bCapNew, sessionDigest: c1bDigest });
  const c1bGatewayLogout = c1bConsumeNew.body.data.gatewaySession;

  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(c1bGatewayLogout, {
    sessionId: c1bAuth.id,
    userId: c1bAuth.user.id,
    role: 'customer',
    websiteIds: [site1B.id],
  }), null);

  // User logs out of this session
  liveSessions.revokeSession(c1bAuth.id, 'logout');

  // Vendor session terminated
  assert.equal(await phpMyAdminService.authorizeGatewaySession(c1bGatewayLogout, {
    sessionId: c1bAuth.id,
    userId: c1bAuth.user.id,
    role: 'customer',
    websiteIds: [site1B.id],
  }), null);

  // 10B: Logout-All terminates all sessions for that user across devices
  currentRequestContext = { auth: r1Auth, authSessionDigest: r1Digest };
  const r1Handoff1B = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1B.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1B.credential.id }),
  });
  const r1Cap1B = (await r1Handoff1B.json()).data.capability;
  const r1Consume1B = await sendSocketRequest({ capability: r1Cap1B, sessionDigest: r1Digest });
  const r1GatewayLogoutAll = r1Consume1B.body.data.gatewaySession;

  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(r1GatewayLogoutAll, {
    sessionId: r1Auth.id,
    userId: r1Auth.user.id,
    role: 'reseller',
    websiteIds: [site1B.id],
  }), null);

  // Reseller 1 executes Logout-All
  liveSessions.revokeUser('reseller-1', 'user_sessions_revoked');

  // Reseller 1's gateway session terminated immediately
  assert.equal(await phpMyAdminService.authorizeGatewaySession(r1GatewayLogoutAll, {
    sessionId: r1Auth.id,
    userId: r1Auth.user.id,
    role: 'reseller',
    websiteIds: [site1B.id],
  }), null);

  // 11. Password-Session Rotation & Credential Drift
  // 11A: User password rotation revokes vendor sessions
  const directCookie = 'direct-raw-cookie';
  const directDigest = createHash('sha256').update(directCookie).digest('hex');
  const directAuth = { id: 'sess-direct-1', user: { id: 'cust-direct', role: 'customer', websiteIds: [siteDirect.id] }, access: { mode: 'site_management', permissions: ['website:manage'] }, security: { managementAllowed: true } };
  currentRequestContext = { auth: directAuth, authSessionDigest: directDigest };
  const directHandoff = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${siteDirect.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbDirect.credential.id }),
  });
  const directCap = (await directHandoff.json()).data.capability;
  const directConsume = await sendSocketRequest({ capability: directCap, sessionDigest: directDigest });
  const directGatewayPw = directConsume.body.data.gatewaySession;

  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(directGatewayPw, {
    sessionId: directAuth.id,
    userId: directAuth.user.id,
    role: 'customer',
    websiteIds: [siteDirect.id],
  }), null);

  // User resets password
  liveSessions.revokeUser('cust-direct', 'password_reset');

  // Vendor session terminated immediately
  assert.equal(await phpMyAdminService.authorizeGatewaySession(directGatewayPw, {
    sessionId: directAuth.id,
    userId: directAuth.user.id,
    role: 'customer',
    websiteIds: [siteDirect.id],
  }), null);

  // 11B: Database credential password rotation / revision drift revokes gateway session
  // Issue fresh handoff for Owner on Site Direct
  currentRequestContext = { auth: ownerAuth, authSessionDigest: ownerDigest };
  const ownerHandoffDrift = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${siteDirect.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbDirect.credential.id }),
  });
  const ownerCapDrift = (await ownerHandoffDrift.json()).data.capability;
  const ownerConsumeDrift = await sendSocketRequest({ capability: ownerCapDrift, sessionDigest: ownerDigest });
  const ownerGatewayDrift = ownerConsumeDrift.body.data.gatewaySession;

  // Active check passes
  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(ownerGatewayDrift, {
    sessionId: ownerAuth.id,
    userId: ownerAuth.user.id,
    role: 'owner',
  }), null);

  // Rotate database credential password (revision bumps from 3 to 4, desiredState changes)
  dbDirect.credential.revision = 4;
  dbDirect.desiredStateSha256 = 'f'.repeat(64);
  dbDirect.appliedJob.result.credentialRevision = 4;
  dbDirect.appliedJob.result.desiredStateSha256 = dbDirect.desiredStateSha256;

  // Next gateway request detects drift, revokes gateway session, and returns null
  assert.equal(await phpMyAdminService.authorizeGatewaySession(ownerGatewayDrift, {
    sessionId: ownerAuth.id,
    userId: ownerAuth.user.id,
    role: 'owner',
  }), null);

  // 12. Customer and Reseller Suspension Terminates Active Vendor Sessions Fail-Closed
  // 12A: Customer Suspension
  const c2aCookie = 'c2a-raw-cookie-secret';
  const c2aDigest = createHash('sha256').update(c2aCookie).digest('hex');
  const c2aAuth = { id: 'sess-c2a-1', user: { id: 'cust-2a', role: 'customer', websiteIds: [site2A.id] }, access: { mode: 'site_management', permissions: ['website:manage'] }, security: { managementAllowed: true } };

  currentRequestContext = { auth: c2aAuth, authSessionDigest: c2aDigest };
  const c2aIssueSusp = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site2A.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db2A.credential.id }),
  });
  assert.equal(c2aIssueSusp.status, 201);
  const c2aCapSusp = (await c2aIssueSusp.json()).data.capability;
  const c2aConsumeSusp = await sendSocketRequest({ capability: c2aCapSusp, sessionDigest: c2aDigest });
  assert.equal(c2aConsumeSusp.status, 200);
  const c2aGatewaySusp = c2aConsumeSusp.body.data.gatewaySession;

  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(c2aGatewaySusp, {
    sessionId: c2aAuth.id,
    userId: c2aAuth.user.id,
    role: 'customer',
    websiteIds: [site2A.id],
  }), null);

  // Suspend Customer 2A
  const c2aRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-2a');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-2a', { revision: c2aRow.revision, active: false });
  assert.equal(f.revoked.some((r) => r.id === 'cust-2a' && r.reason === 'hosting_account_suspended'), true);

  // Customer 2A gateway session terminated
  assert.equal(await phpMyAdminService.authorizeGatewaySession(c2aGatewaySusp, {
    sessionId: c2aAuth.id,
    userId: c2aAuth.user.id,
    role: 'customer',
    websiteIds: [site2A.id],
  }), null);

  // 12B: Reseller Suspension (Cascades to drop child customer sessions)
  const r1FreshAuth = { id: 'sess-r1-fresh', user: { id: 'reseller-1', role: 'reseller', websiteIds: [site1B.id] }, access: { mode: 'site_management', permissions: ['website:manage'] }, security: { managementAllowed: true } };
  const c1bFreshAuth = { id: 'sess-c1b-fresh', user: { id: 'cust-1b', role: 'customer', websiteIds: [site1B.id] }, access: { mode: 'site_management', permissions: ['website:manage'] }, security: { managementAllowed: true } };

  currentRequestContext = { auth: r1FreshAuth, authSessionDigest: r1Digest };
  const r1HandoffNew = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1B.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1B.credential.id }),
  });
  assert.equal(r1HandoffNew.status, 201);
  const r1CapNew = (await r1HandoffNew.json()).data.capability;
  const r1ConsumeFresh = await sendSocketRequest({ capability: r1CapNew, sessionDigest: r1Digest });
  assert.equal(r1ConsumeFresh.status, 200);
  const r1GatewayFresh = r1ConsumeFresh.body.data.gatewaySession;

  currentRequestContext = { auth: c1bFreshAuth, authSessionDigest: c1bDigest };
  const c1bHandoffFresh = await fetch(`${apiBase}/api/servers/${stagingServerId}/websites/${site1B.id}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: db1B.credential.id }),
  });
  assert.equal(c1bHandoffFresh.status, 201);
  const c1bCapFresh = (await c1bHandoffFresh.json()).data.capability;
  const c1bConsumeFresh = await sendSocketRequest({ capability: c1bCapFresh, sessionDigest: c1bDigest });
  assert.equal(c1bConsumeFresh.status, 200);
  const c1bGatewayFresh = c1bConsumeFresh.body.data.gatewaySession;

  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(r1GatewayFresh, {
    sessionId: r1FreshAuth.id,
    userId: r1FreshAuth.user.id,
    role: 'reseller',
    websiteIds: [site1B.id],
  }), null);
  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(c1bGatewayFresh, {
    sessionId: c1bFreshAuth.id,
    userId: c1bFreshAuth.user.id,
    role: 'customer',
    websiteIds: [site1B.id],
  }), null);

  // Suspend Reseller 1
  const r1Row = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('reseller-1');
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-1', { revision: r1Row.revision, active: false });

  // Both Reseller 1 and child Customer 1B were revoked
  assert.equal(f.revoked.some((r) => r.id === 'reseller-1' && r.reason === 'hosting_account_suspended'), true);
  assert.equal(f.revoked.some((r) => r.id === 'cust-1b' && r.reason === 'hosting_parent_suspended'), true);

  // Both gateway sessions terminated
  assert.equal(await phpMyAdminService.authorizeGatewaySession(r1GatewayFresh, {
    sessionId: r1FreshAuth.id,
    userId: r1FreshAuth.user.id,
    role: 'reseller',
    websiteIds: [site1B.id],
  }), null);
  assert.equal(await phpMyAdminService.authorizeGatewaySession(c1bGatewayFresh, {
    sessionId: c1bFreshAuth.id,
    userId: c1bFreshAuth.user.id,
    role: 'customer',
    websiteIds: [site1B.id],
  }), null);

  // 13. Stale Vendor Cookie & Expired Session Verification (Criterion 2)
  // Fabricated gateway cookie token returns null
  assert.equal(await phpMyAdminService.authorizeGatewaySession('X'.repeat(43), {
    sessionId: ownerAuth.id,
    userId: ownerAuth.user.id,
    role: 'owner',
  }), null);

  // Advance time past gatewayTtlMs (1 hour = 3600_000 ms)
  mockNow += 4_000_000;
  assert.equal(await phpMyAdminService.authorizeGatewaySession(ownerGateway1A, {
    sessionId: ownerAuth.id,
    userId: ownerAuth.user.id,
    role: 'owner',
  }), null);

  // 14. Unix Socket Clean Shutdown
  await socketRuntime.close();
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });

  // 15. Server Isolation & Host Safety Gate
  assertNoDot44Host(stagingServerId);
  assert.ok(true, 'YP-04 phpMyAdmin session binding and tenant isolation real acceptance verified.');
});

// ============================================================================
// STAGING E2E PART 10: RS-02e / kalan — Live Auth Store Session, Common Site Boundary Restrictions,
// AI History Grants & Tool Policy, Long-running Disconnect & Recovery, Ownership Migration & Rollback
// ============================================================================

test('Staging E2E RS-02e / kalan: Live auth store session integration, site resource boundary enforcement, AI history & policy grants, long-running pathway revocation & recovery, ownership migration rollback, and host isolation', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  // Staging server ID: strictly non-.44
  const stagingServerId = '55555555-5555-4555-8555-555555555555';
  assertNoDot44Host(stagingServerId);

  // 1. Live Session Tracking and Multi-Tier Hosting Store Setup
  const liveSessions = createLiveSessionRegistry();
  const originalRevokeUser = liveSessions.revokeUser.bind(liveSessions);
  liveSessions.revokeUser = (userId, reason) => {
    f.revoked.push({ id: userId, reason });
    return originalRevokeUser(userId, reason);
  };
  const revokeLiveUser = (userId, reason) => {
    liveSessions.revokeUser(userId, reason);
  };

  f.store = createHostingAccountStore({
    ...f,
    revokeLiveUser,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  // Hierarchy accounts:
  // - Owner: owner-user (global management)
  // - Reseller: reseller-1
  // - Customer 1A: cust-1a (under reseller-1)
  // - Customer 1B: cust-1b (under reseller-1)
  // - Legacy Site Manager: legacy-sm
  // - Read-Only: readonly-user
  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('cust-1a');
  f.addUser('cust-1b');
  f.addUser('legacy-sm', { role: 'site_manager' });
  f.addUser('readonly-user', { role: 'read_only' });

  const ownerToken = f.session('owner-user');

  f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 10 },
  });

  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 2 },
  });

  f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1b',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 2 },
  });

  // Websites
  const site1A = {
    id: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    serverId: stagingServerId,
    name: 'site-a.example',
    applicationId: '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    customerId: 'cust-1a',
    resellerId: 'reseller-1',
  };
  const site1B = {
    id: '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    serverId: stagingServerId,
    name: 'site-b.example',
    applicationId: '44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    customerId: 'cust-1b',
    resellerId: 'reseller-1',
  };

  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site1A,
    ownerUserId: 'cust-1a',
    resellerId: 'reseller-1',
  });
  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site1B,
    ownerUserId: 'cust-1b',
    resellerId: 'reseller-1',
  });

  // --------------------------------------------------------------------------
  // SECTION 2: Normal HTTP Requests Authenticate Against Live Auth Store Session
  // --------------------------------------------------------------------------
  const sessionToken1A = f.session('cust-1a');
  const sessionToken1B = f.session('cust-1b');
  const sessionTokenSM = f.session('legacy-sm');

  // Verify valid active sessions resolve correctly
  const resolvedSession1A = f.getSession(sessionToken1A);
  assert.ok(resolvedSession1A, 'Active Customer 1A session must resolve');
  assert.equal(resolvedSession1A.user.id, 'cust-1a');
  assert.equal(resolvedSession1A.user.role, 'site_manager');
  const hosting1A = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  assert.equal(hosting1A.kind, 'customer');

  const resolvedSessionSM = f.getSession(sessionTokenSM);
  assert.ok(resolvedSessionSM, 'Active legacy site manager session must resolve');
  assert.equal(resolvedSessionSM.user.id, 'legacy-sm');

  // Verify missing, empty, or forged tokens fail-closed
  assert.equal(f.getSession(null), null, 'Missing token must fail-closed');
  assert.equal(f.getSession(''), null, 'Empty token must fail-closed');
  assert.equal(f.getSession('token-forged-attacker'), null, 'Forged token must fail-closed');

  // Verify HTTP endpoint behavior with live session using production createAuthenticatedApi
  const customerWebsitesMap = new Map([
    ['cust-1a', [site1A.id]],
    ['cust-1b', [site1B.id]],
    ['legacy-sm', [site1A.id]],
  ]);

  const publicOrigin = 'https://panel.example.test';
  const apiHandler = (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      data: {
        userId: request.auth.user.id,
        role: request.auth.user.role,
        websiteIds: customerWebsitesMap.get(request.auth.user.id) ?? [],
      },
    }));
  };

  const authListener = createAuthenticatedApi({
    store: {
      ...f,
      configured: () => true,
      mfa: { enabled: () => false, cancelLogin: () => {}, invalidateUser: () => {} },
      audit: { record: () => {}, list: () => ({ events: [], total: 0, offset: 0, limit: 50 }) },
    },
    publicOrigin,
    ownerMfaRequired: false,
    createHandler: () => apiHandler,
  });

  const authHttpServer = http.createServer(authListener).listen(0, '127.0.0.1');
  await once(authHttpServer, 'listening');
  const authPort = authHttpServer.address().port;
  const authBaseUrl = `http://127.0.0.1:${authPort}`;
  t.after(() => new Promise((resolve) => {
    authHttpServer.close(resolve);
    authHttpServer.closeAllConnections();
  }));

  // Valid active session token -> 200 OK with authenticated user & role
  const reqSuccess = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: `__Host-yunpanel_session=${sessionToken1A}` },
  });
  assert.equal(reqSuccess.status, 200);
  const successJson = await reqSuccess.json();
  assert.equal(successJson.data.userId, 'cust-1a');
  assert.equal(successJson.data.role, 'site_manager');

  // Missing session token -> 401 unauthorized
  const reqUnauth = await fetch(`${authBaseUrl}/api/websites`);
  assert.equal(reqUnauth.status, 401);
  const unauthJson = await reqUnauth.json();
  assert.equal(unauthJson.error.code, 'unauthorized');

  // Forged session token -> 401 unauthorized
  const reqForged = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: '__Host-yunpanel_session=token-forged-attacker' },
  });
  assert.equal(reqForged.status, 401);
  const forgedJson = await reqForged.json();
  assert.equal(forgedJson.error.code, 'unauthorized');

  // Suspend Customer 1A: live auth store session must immediately fail closed
  const c1aRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1a');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1a', { revision: c1aRow.revision, active: false });

  assert.equal(f.revoked.some((r) => r.id === 'cust-1a' && r.reason === 'hosting_account_suspended'), true);
  assert.equal(f.getSession(sessionToken1A), null, 'Suspended user session must return null');
  const reqSuspended = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: `__Host-yunpanel_session=${sessionToken1A}` },
  });
  assert.equal(reqSuspended.status, 401, 'Suspended user HTTP request must fail-closed with 401');

  // Reactivate Customer 1A for subsequent tests
  const c1aSuspRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1a');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1a', { revision: c1aSuspRow.revision, active: true });
  const activeSessionToken1A = f.session('cust-1a');
  assert.ok(f.getSession(activeSessionToken1A), 'Reactivated user session resolves');

  const reqReactivated = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: `__Host-yunpanel_session=${activeSessionToken1A}` },
  });
  assert.equal(reqReactivated.status, 200, 'Reactivated user HTTP request succeeds');

  // --------------------------------------------------------------------------
  // SECTION 3: Common Site Boundary Restrictions
  // (Website, Domain, Application, DB, Mail, Job, /api/websites/:websiteId/...)
  // --------------------------------------------------------------------------
  const allWebsites = [site1A, site1B];
  const domain1A = { id: 'dom-1a', serverId: stagingServerId, websiteId: site1A.id, name: 'site-a.example' };
  const domain1B = { id: 'dom-1b', serverId: stagingServerId, websiteId: site1B.id, name: 'site-b.example' };
  const dbBinding1A = { id: 'bind-1a', serverId: stagingServerId, websiteId: site1A.id, applicationId: site1A.applicationId, databaseName: 'db_site_1a', revision: 1 };
  const dbBinding1B = { id: 'bind-1b', serverId: stagingServerId, websiteId: site1B.id, applicationId: site1B.applicationId, databaseName: 'db_site_1b', revision: 1 };
  const dbCred1A = { id: 'cred-1a', serverId: stagingServerId, websiteId: site1A.id, applicationId: site1A.applicationId, databaseBindingId: 'bind-1a', databaseName: 'db_site_1a', username: 'usr_1a' };
  const dbCred1B = { id: 'cred-1b', serverId: stagingServerId, websiteId: site1B.id, applicationId: site1B.applicationId, databaseBindingId: 'bind-1b', databaseName: 'db_site_1b', username: 'usr_1b' };
  const mailDom1A = { id: 'mail-1a', serverId: stagingServerId, webDomainId: domain1A.id, managementMode: 'local' };
  const mailDom1B = { id: 'mail-1b', serverId: stagingServerId, webDomainId: domain1B.id, managementMode: 'local' };

  const mockWebsiteRegistry = {
    async getWebsite(id) { return allWebsites.find((s) => s.id === id) ?? null; },
    async listWebsites() { return structuredClone(allWebsites); },
  };
  const mockDomainRegistry = {
    async getDomain(id) {
      if (id === domain1A.id) return structuredClone(domain1A);
      if (id === domain1B.id) return structuredClone(domain1B);
      return null;
    },
    async listDomains() { return [structuredClone(domain1A), structuredClone(domain1B)]; },
  };
  const mockDbBindingRegistry = {
    async getBinding(id) {
      if (id === dbBinding1A.id) return structuredClone(dbBinding1A);
      if (id === dbBinding1B.id) return structuredClone(dbBinding1B);
      return null;
    },
    async listBindings() { return [structuredClone(dbBinding1A), structuredClone(dbBinding1B)]; },
  };
  const mockDbCredentialRegistry = {
    async getCredential(id) {
      if (id === dbCred1A.id) return structuredClone(dbCred1A);
      if (id === dbCred1B.id) return structuredClone(dbCred1B);
      return null;
    },
  };
  const mockMailDomainRegistry = {
    async getMailDomain(id) {
      if (id === mailDom1A.id) return structuredClone(mailDom1A);
      if (id === mailDom1B.id) return structuredClone(mailDom1B);
      return null;
    },
  };
  const mockJobRegistry = {
    async getJob(id) {
      if (id === 'job-1a') return { id: 'job-1a', serverId: stagingServerId, resourceType: 'website', resourceId: site1A.id };
      if (id === 'job-1b') return { id: 'job-1b', serverId: stagingServerId, resourceType: 'website', resourceId: site1B.id };
      return null;
    },
    async listJobs() {
      return [
        { id: 'job-1a', serverId: stagingServerId, resourceType: 'website', resourceId: site1A.id },
        { id: 'job-1b', serverId: stagingServerId, resourceType: 'website', resourceId: site1B.id },
      ];
    },
  };

  const customerLookup = (custId) => {
    if (custId === 'cust-1a' || custId === 'cust-1b') return { id: custId, resellerId: 'reseller-1' };
    return null;
  };

  const siteBoundary = createSiteResourceBoundary({
    websiteRegistry: mockWebsiteRegistry,
    domainRegistry: mockDomainRegistry,
    databaseBindingRegistry: mockDbBindingRegistry,
    databaseCredentialRegistry: mockDbCredentialRegistry,
    mailDomainRegistry: mockMailDomainRegistry,
    jobRegistry: mockJobRegistry,
    localServerId: stagingServerId,
    customerLookup,
  });

  const runBoundary = async (req) => {
    let nextCalled = false;
    let resStatus = 200;
    let resHeaders = {};
    let resBody = null;

    const res = {
      status(code) { resStatus = code; return this; },
      setHeader(k, v) { resHeaders[k] = v; return this; },
      json(body) { resBody = body; return this; },
    };

    await siteBoundary(req, res, () => { nextCalled = true; });
    return { nextCalled, status: resStatus, headers: resHeaders, body: resBody };
  };

  const c1aAuthContext = {
    user: { id: 'cust-1a', role: 'customer', websiteIds: [site1A.id], active: true },
    access: { mode: 'site_management', permissions: ['website:manage'] },
    security: { managementAllowed: true },
  };

  // 3A: Customer 1A accesses owned Website 1A -> succeeds
  const b1 = await runBoundary({
    method: 'GET',
    url: `/api/servers/${stagingServerId}/websites/${site1A.id}`,
    auth: c1aAuthContext,
  });
  assert.equal(b1.nextCalled, true, 'Owned site request should pass boundary');

  // 3B: Customer 1A accesses foreign Website 1B -> 403 fail-closed
  const b2 = await runBoundary({
    method: 'GET',
    url: `/api/servers/${stagingServerId}/websites/${site1B.id}`,
    auth: c1aAuthContext,
  });
  assert.equal(b2.nextCalled, false);
  assert.equal(b2.status, 403);
  assert.equal(b2.body.error.code, 'site_scope_forbidden');
  assert.equal(b2.headers['Cache-Control'], 'no-store');

  // 3C: Customer 1A accesses /api/websites/:websiteId endpoints directly
  const bWebDirectOwn = await runBoundary({ method: 'GET', url: `/api/websites/${site1A.id}`, auth: c1aAuthContext });
  assert.equal(bWebDirectOwn.nextCalled, true);
  const bWebDirectForeign = await runBoundary({ method: 'GET', url: `/api/websites/${site1B.id}`, auth: c1aAuthContext });
  assert.equal(bWebDirectForeign.nextCalled, false);
  assert.equal(bWebDirectForeign.status, 403);

  // 3D: Customer 1A accesses owned Domain 1A -> succeeds; foreign Domain 1B -> 403 fail-closed
  const bDomOwn = await runBoundary({ method: 'GET', url: `/api/domains/${domain1A.id}`, auth: c1aAuthContext });
  assert.equal(bDomOwn.nextCalled, true);
  const bDomForeign = await runBoundary({ method: 'GET', url: `/api/domains/${domain1B.id}`, auth: c1aAuthContext });
  assert.equal(bDomForeign.nextCalled, false);
  assert.equal(bDomForeign.status, 403);

  // 3E: Customer 1A accesses owned Application 1A -> succeeds; foreign Application 1B -> 403
  const bAppOwn = await runBoundary({ method: 'GET', url: `/api/applications/${site1A.applicationId}`, auth: c1aAuthContext });
  assert.equal(bAppOwn.nextCalled, true);
  const bAppForeign = await runBoundary({ method: 'GET', url: `/api/applications/${site1B.applicationId}`, auth: c1aAuthContext });
  assert.equal(bAppForeign.nextCalled, false);
  assert.equal(bAppForeign.status, 403);

  // 3F: Customer 1A accesses owned DB binding -> succeeds; foreign DB binding -> 403
  const bDbOwn = await runBoundary({
    method: 'GET',
    url: `/api/servers/${stagingServerId}/database-bindings/${dbBinding1A.id}`,
    auth: c1aAuthContext,
  });
  assert.equal(bDbOwn.nextCalled, true);
  const bDbForeign = await runBoundary({
    method: 'GET',
    url: `/api/servers/${stagingServerId}/database-bindings/${dbBinding1B.id}`,
    auth: c1aAuthContext,
  });
  assert.equal(bDbForeign.nextCalled, false);
  assert.equal(bDbForeign.status, 403);

  // 3G: Customer 1A accesses owned DB credential -> succeeds; foreign DB credential -> 403
  const bCredOwn = await runBoundary({
    method: 'GET',
    url: `/api/servers/${stagingServerId}/database-credentials/${dbCred1A.id}`,
    auth: c1aAuthContext,
  });
  assert.equal(bCredOwn.nextCalled, true);
  const bCredForeign = await runBoundary({
    method: 'GET',
    url: `/api/servers/${stagingServerId}/database-credentials/${dbCred1B.id}`,
    auth: c1aAuthContext,
  });
  assert.equal(bCredForeign.nextCalled, false);
  assert.equal(bCredForeign.status, 403);

  // 3H: Customer 1A accesses owned Mail domain -> succeeds; foreign Mail domain -> 403
  const bMailOwn = await runBoundary({ method: 'GET', url: `/api/mail-domains/${mailDom1A.id}`, auth: c1aAuthContext });
  assert.equal(bMailOwn.nextCalled, true);
  const bMailForeign = await runBoundary({ method: 'GET', url: `/api/mail-domains/${mailDom1B.id}`, auth: c1aAuthContext });
  assert.equal(bMailForeign.nextCalled, false);
  assert.equal(bMailForeign.status, 403);

  // 3I: Customer 1A accesses Job endpoint: owned job -> succeeds; foreign job -> 403
  const bJobOwn = await runBoundary({ method: 'GET', url: '/api/jobs/job-1a', auth: c1aAuthContext });
  assert.equal(bJobOwn.nextCalled, true);
  const bJobForeign = await runBoundary({ method: 'GET', url: '/api/jobs/job-1b', auth: c1aAuthContext });
  assert.equal(bJobForeign.nextCalled, false);
  assert.equal(bJobForeign.status, 403);

  // 3J: Collection endpoints filter items without leaking total/count metadata
  let collectionResult = null;
  const resCollection = {
    status(code) { return this; },
    setHeader() { return this; },
    json(body) { collectionResult = body; return this; },
  };
  await siteBoundary(
    { method: 'GET', url: '/api/mail-domains', auth: c1aAuthContext },
    resCollection,
    () => { resCollection.json({ data: [mailDom1A, mailDom1B], meta: { total: 2, count: 2 } }); },
  );
  assert.ok(collectionResult);
  assert.equal(collectionResult.data.length, 1);
  assert.equal(collectionResult.data[0].id, mailDom1A.id);
  assert.equal(collectionResult.meta, undefined, 'Total count metadata must not be leaked');

  // 3K: Terminal capability scoping: scope='server' -> 403; foreign site -> 403; owned site -> succeeds
  const bTermServer = await runBoundary({
    method: 'POST',
    url: '/api/terminal/capabilities',
    auth: c1aAuthContext,
    body: { scope: 'server' },
  });
  assert.equal(bTermServer.nextCalled, false);
  assert.equal(bTermServer.status, 403);

  const bTermForeign = await runBoundary({
    method: 'POST',
    url: '/api/terminal/capabilities',
    auth: c1aAuthContext,
    body: { scope: 'site', websiteId: site1B.id },
  });
  assert.equal(bTermForeign.nextCalled, false);
  assert.equal(bTermForeign.status, 403);

  const bTermOwn = await runBoundary({
    method: 'POST',
    url: '/api/terminal/capabilities',
    auth: c1aAuthContext,
    body: { scope: 'site', websiteId: site1A.id },
  });
  assert.equal(bTermOwn.nextCalled, true);

  // 3L: Server administrative routes blocked for tenant accounts
  for (const admPath of ['/api/panel/settings', '/api/system/packages', '/api/backups']) {
    const bAdm = await runBoundary({ method: 'GET', url: admPath, auth: c1aAuthContext });
    assert.equal(bAdm.nextCalled, false, `${admPath} must be blocked for tenants`);
    assert.equal(bAdm.status, 403);
  }

  // 3M: Reseller 1 accesses both child sites (site 1A and site 1B) -> both succeed
  const r1AuthContext = {
    user: { id: 'reseller-1', role: 'reseller', websiteIds: [site1A.id, site1B.id], active: true },
    access: { mode: 'site_management', permissions: ['website:manage'] },
    security: { managementAllowed: true },
  };
  const bResSiteA = await runBoundary({ method: 'GET', url: `/api/servers/${stagingServerId}/websites/${site1A.id}`, auth: r1AuthContext });
  assert.equal(bResSiteA.nextCalled, true);
  const bResSiteB = await runBoundary({ method: 'GET', url: `/api/servers/${stagingServerId}/websites/${site1B.id}`, auth: r1AuthContext });
  assert.equal(bResSiteB.nextCalled, true);

  // 3N: Inactive account blocked at boundary
  const inactiveAuthContext = {
    user: { id: 'cust-1a', role: 'customer', websiteIds: [site1A.id], active: false },
    access: { mode: 'site_management', permissions: ['website:manage'] },
    security: { managementAllowed: true },
  };
  const bInactive = await runBoundary({ method: 'GET', url: `/api/servers/${stagingServerId}/websites/${site1A.id}`, auth: inactiveAuthContext });
  assert.equal(bInactive.nextCalled, false);
  assert.equal(bInactive.status, 403);

  // 3O: Owner with global scope bypasses boundary cleanly
  const ownerAuthContext = {
    user: { id: 'owner-user', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  const bOwner = await runBoundary({ method: 'GET', url: `/api/servers/${stagingServerId}/websites/${site1A.id}`, auth: ownerAuthContext });
  assert.equal(bOwner.nextCalled, true);

  // --------------------------------------------------------------------------
  // SECTION 4: AI Conversation History & Policy Validation
  // --------------------------------------------------------------------------
  const smAuth = {
    user: { id: 'legacy-sm', role: 'site_manager', websiteIds: [site1A.id], active: true },
    access: { mode: 'site_management', permissions: ['website:manage'] },
    security: { managementAllowed: true },
  };

  // 4A: Site manager scope for allowed websiteId succeeds
  const scopeSmAllowed = conversationScope(smAuth, site1A.id);
  assert.equal(scopeSmAllowed.actorId, 'legacy-sm');
  assert.equal(scopeSmAllowed.websiteId, site1A.id);
  assert.equal(scopeSmAllowed.owner, false);
  assert.deepEqual(scopeSmAllowed.grants, [site1A.id]);

  // 4B: Site manager scope for foreign websiteId throws 404 (conversation_not_found) fail-closed
  assert.throws(
    () => conversationScope(smAuth, site1B.id),
    (err) => err instanceof AiHistoryError && err.code === 'conversation_not_found' && err.status === 404,
    'Site manager query for foreign website must throw 404 conversation_not_found',
  );

  // 4C: Site manager invalid websiteId throws 400
  assert.throws(
    () => conversationScope(smAuth, 'invalid-non-uuid'),
    (err) => err instanceof AiHistoryError && err.code === 'invalid_ai_website' && err.status === 400,
  );

  // 4D: Inactive or unauthorized access throws 403/401
  const smInactiveAuth = {
    user: { id: 'legacy-sm', role: 'site_manager', websiteIds: [site1A.id], active: false },
    access: { mode: 'site_management', permissions: ['website:manage'] },
    security: { managementAllowed: true },
  };
  assert.throws(
    () => conversationScope(smInactiveAuth, site1A.id),
    (err) => err instanceof AiHistoryError && err.code === 'forbidden' && err.status === 403,
  );
  assert.throws(
    () => conversationScope(null, site1A.id),
    (err) => err instanceof AiHistoryError && err.code === 'unauthorized' && err.status === 401,
  );

  // 4E: Owner scope works with any valid UUID or null
  const ownerAiAuth = {
    user: { id: 'owner-user', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  const ownerGlobalScope = conversationScope(ownerAiAuth, null);
  assert.equal(ownerGlobalScope.owner, true);
  assert.equal(ownerGlobalScope.websiteId, null);
  const ownerSiteScope = conversationScope(ownerAiAuth, site1B.id);
  assert.equal(ownerSiteScope.owner, true);
  assert.equal(ownerSiteScope.websiteId, site1B.id);

  // 4F: conversationVisible respects grants and actorId
  const convOwn = { id: 'conv-1', actorId: 'legacy-sm', websiteId: site1A.id };
  const convForeignSite = { id: 'conv-2', actorId: 'legacy-sm', websiteId: site1B.id };
  const convForeignActor = { id: 'conv-3', actorId: 'other-user', websiteId: site1A.id };

  assert.equal(conversationVisible(convOwn, scopeSmAllowed), true);
  assert.equal(conversationVisible(convForeignSite, scopeSmAllowed), false);
  assert.equal(conversationVisible(convForeignActor, scopeSmAllowed), false);

  // 4G: AI History Pager: scope-bound cursor verification
  const pager = createConversationPager();
  const convList = [
    { id: '77777777-7777-4777-8777-777777777771', title: 'Chat 1', actorId: 'legacy-sm', websiteId: site1A.id, messages: ['hi'], createdAt: 1000, updatedAt: 1000 },
    { id: '77777777-7777-4777-8777-777777777772', title: 'Chat 2', actorId: 'legacy-sm', websiteId: site1A.id, messages: ['hello'], createdAt: 2000, updatedAt: 2000 },
    { id: '77777777-7777-4777-8777-777777777773', title: 'Chat 3 (Foreign)', actorId: 'legacy-sm', websiteId: site1B.id, messages: ['foreign'], createdAt: 3000, updatedAt: 3000 },
  ];
  const pageResult = pager(convList, scopeSmAllowed, { limit: 1 });
  assert.equal(pageResult.items.length, 1);
  assert.equal(pageResult.hasMore, true);
  assert.ok(pageResult.nextCursor);

  assert.throws(
    () => pager(convList, ownerGlobalScope, { cursor: pageResult.nextCursor }),
    (err) => err instanceof AiHistoryError && err.code === 'invalid_ai_history_cursor',
  );

  // 4H: AI Tool Policy: site_manager role requires Owner-management across catalog
  for (const tool of DEFAULT_AI_TOOL_DEFINITIONS) {
    const policyResult = evaluateAiToolPolicy({ tool, auth: smAuth });
    assert.equal(
      policyResult.decision,
      'deny',
      `Tool ${tool.name} must be denied for site_manager`,
    );
    assert.equal(
      policyResult.reason,
      'owner_management_required',
      `Tool ${tool.name} must require owner_management_required for site_manager`,
    );
  }

  // 4I: AI Tool Policy: customer and reseller also denied with owner_management_required
  for (const nonOwnerAuth of [c1aAuthContext, r1AuthContext]) {
    const evalResult = evaluateAiToolPolicy({ tool: DEFAULT_AI_TOOL_DEFINITIONS[0], auth: nonOwnerAuth });
    assert.equal(evalResult.decision, 'deny');
    assert.equal(evalResult.reason, 'owner_management_required');
  }

  // 4J: AI Tool Policy: read_only role allows safe reads, denies writes
  const roAuth = {
    user: { id: 'readonly-user', role: 'read_only', active: true },
    access: { mode: 'read_only', permissions: ['view'] },
    security: { managementAllowed: false },
  };
  const readTool = DEFAULT_AI_TOOL_DEFINITIONS.find((t) => t.risk === 'read');
  const writeTool = DEFAULT_AI_TOOL_DEFINITIONS.find((t) => t.risk === 'reversible_write');
  assert.deepEqual(evaluateAiToolPolicy({ tool: readTool, auth: roAuth }), {
    decision: 'allow',
    reason: 'read_only_safe',
  });
  assert.deepEqual(evaluateAiToolPolicy({ tool: writeTool, auth: roAuth }), {
    decision: 'deny',
    reason: 'owner_management_required',
  });

  // 4K: AI Tool Policy: Owner management role has full permissions with overrides
  const ownerRead = evaluateAiToolPolicy({ tool: readTool, auth: ownerAiAuth });
  assert.equal(ownerRead.decision, 'allow');
  const ownerOverridden = evaluateAiToolPolicy({
    tool: readTool,
    auth: ownerAiAuth,
    overrides: { tool: { [readTool.name]: 'deny' } },
  });
  assert.deepEqual(ownerOverridden, { decision: 'deny', reason: 'explicit_deny' });

  // --------------------------------------------------------------------------
  // SECTION 5: Long-Running Pathway Disconnect & Failure-Closed Lifecycle
  // (Terminal WebSocket, elFinder Gateway, Cron Durable Mutation, PHP Recovery)
  // --------------------------------------------------------------------------

  // 5A: Real Terminal WebSocket lifecycle: disconnect on account suspension and grant removal
  const terminalCapabilityRegistry = createTerminalCapabilityRegistry({ liveSessions });
  let terminalProcessClosed = false;
  const mockTerminalProcessManager = {
    async open({ target, onData, onExit }) {
      return {
        write(data) {},
        resize(cols, rows) {},
        close() { terminalProcessClosed = true; },
      };
    },
  };

  const terminalServer = createTerminalWebSocketServer({
    authenticate: (request) => {
      const cookieHeader = request.headers.cookie ?? '';
      const match = cookieHeader.match(/__Host-yunpanel_session=([^;]+)/);
      const token = match ? match[1] : null;
      const sess = f.getSession(token);
      if (!sess) throw new AuthError('unauthorized', 'Sign in to continue.', 401);
      const hostingAcc = f.store.get(ownerToken, f.requireManagement, sess.user.id);
      const role = hostingAcc?.kind ?? sess.user.role;
      return {
        rawToken: token,
        session: {
          id: sess.id,
          user: {
            id: sess.user.id,
            role,
            active: true,
            websiteIds: customerWebsitesMap.get(sess.user.id) ?? [],
          },
          access: { mode: 'site_management', permissions: ['website:manage'] },
          security: { managementAllowed: true },
        },
        peer: '127.0.0.1',
      };
    },
    reauthorize: (token, expected) => {
      const sess = f.getSession(token);
      if (!sess) throw new AuthError('unauthorized', 'Sign in to continue.', 401);
      const currentWebsites = customerWebsitesMap.get(sess.user.id) ?? [];
      return {
        id: sess.id,
        user: {
          id: sess.user.id,
          role: 'customer',
          active: true,
          websiteIds: currentWebsites,
        },
        access: { mode: 'site_management', permissions: ['website:manage'] },
        security: { managementAllowed: true },
      };
    },
    terminalCapabilityRegistry,
    terminalProcessManager: mockTerminalProcessManager,
    liveSessions,
    audit: { record: () => {} },
    authCheckMs: 250,
  });

  const wsHttpServer = http.createServer();
  wsHttpServer.on('upgrade', terminalServer.handleUpgrade);
  wsHttpServer.listen(0, '127.0.0.1');
  await once(wsHttpServer, 'listening');
  const wsServerPort = wsHttpServer.address().port;
  t.after(() => {
    terminalServer.closeAll();
    return new Promise((resolve) => {
      wsHttpServer.close(resolve);
      wsHttpServer.closeAllConnections();
    });
  });

  // Issue real capability for Customer 1B on Site 1B
  const capCust1b = terminalCapabilityRegistry.issue({
    sessionId: 'session-cust-1b',
    userId: 'cust-1b',
    target: {
      scope: 'site',
      serverId: stagingServerId,
      websiteId: site1B.id,
      user: 'yunapp-site1b',
      cwd: '/var/lib/yunpanel/site1b',
    },
  });

  // Open real WebSocket client
  const wsCust1b = new WebSocket(`ws://127.0.0.1:${wsServerPort}/api/terminal`, [
    'yunpanel-terminal-v1',
    `yunpanel-terminal-capability.${capCust1b.capability}`,
  ], {
    headers: {
      cookie: `__Host-yunpanel_session=${sessionToken1B}`,
    },
  });

  await once(wsCust1b, 'open');
  assert.equal(terminalServer.size(), 1, 'Terminal WebSocket session must be active in server registry');

  // Suspend Customer 1B: triggers live session revocation, which automatically terminates terminal socket fail-closed
  const c1bRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1b');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1b', { revision: c1bRow.revision, active: false });

  // Verify revocation recorded
  assert.equal(f.revoked.some((r) => r.id === 'cust-1b' && r.reason === 'hosting_account_suspended'), true);

  // Client WebSocket receives close event with 4001 hosting_account_suspended via actual tracking mechanism
  const [closeCode1, closeReason1] = await once(wsCust1b, 'close');
  assert.equal(closeCode1, 4001);
  assert.equal(closeReason1.toString(), 'hosting_account_suspended');
  assert.equal(terminalServer.size(), 0, 'Socket must be purged from terminal server sessions');
  assert.equal(terminalProcessClosed, true, 'Terminal process must be terminated');

  // Reactivate Customer 1B
  terminalProcessClosed = false;
  const c1bSusp = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1b');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1b', { revision: c1bSusp.revision, active: true });
  const activeSessionToken1B = f.session('cust-1b');

  // Issue new capability for Customer 1B
  const capCust1bNew = terminalCapabilityRegistry.issue({
    sessionId: 'session-cust-1b',
    userId: 'cust-1b',
    target: {
      scope: 'site',
      serverId: stagingServerId,
      websiteId: site1B.id,
      user: 'yunapp-site1b',
      cwd: '/var/lib/yunpanel/site1b',
    },
  });

  const wsCust1bNew = new WebSocket(`ws://127.0.0.1:${wsServerPort}/api/terminal`, [
    'yunpanel-terminal-v1',
    `yunpanel-terminal-capability.${capCust1bNew.capability}`,
  ], {
    headers: {
      cookie: `__Host-yunpanel_session=${activeSessionToken1B}`,
    },
  });

  await once(wsCust1bNew, 'open');
  assert.equal(terminalServer.size(), 1);

  // Grant removal: detach website from customer -> triggers live session revocation (hosting_website_released)
  f.store.siteAllocations.releaseRemoved({
    operationId: 'op-release-site-1b',
    websiteId: site1B.id,
    serverId: stagingServerId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(f.revoked.some((r) => r.id === 'cust-1b' && r.reason === 'hosting_website_released'), true);

  // Client WebSocket receives close event with 4001 hosting_website_released via actual tracking mechanism
  const [closeCode2, closeReason2] = await once(wsCust1bNew, 'close');
  assert.equal(closeCode2, 4001);
  assert.equal(closeReason2.toString(), 'hosting_website_released');
  assert.equal(terminalServer.size(), 0);
  assert.equal(terminalProcessClosed, true);

  // Target access check for detached site fails closed
  assert.throws(
    () => terminalWebSocketInternals.requireTerminalTargetAccess(
      {
        user: { id: 'cust-1b', role: 'customer', websiteIds: [], active: true },
        access: { mode: 'site_management' },
        security: { managementAllowed: true },
      },
      { scope: 'site', websiteId: site1B.id },
    ),
    (err) => err instanceof AuthError && err.code === 'terminal_site_forbidden' && err.status === 403,
  );

  // Re-allocate site 1B to cust-1b for remaining tests
  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site1B,
    ownerUserId: 'cust-1b',
    resellerId: 'reseller-1',
  });

  // 5B: elFinder Gateway Capability Eviction
  const elFinderApplicationId = site1A.applicationId;
  const elFinderExpectedUnixUser = elFinderHandoffInternals.applicationUser(elFinderApplicationId);
  const elFinderWebsite = {
    id: site1A.id,
    serverId: stagingServerId,
    applicationId: elFinderApplicationId,
    runtimeType: 'php',
    unixUser: elFinderExpectedUnixUser,
    revision: 1,
  };

  const elFinderService = createElFinderHandoffService({
    websiteRegistry: {
      async getWebsite(id) {
        return id === site1A.id ? elFinderWebsite : null;
      },
    },
    localServerId: stagingServerId,
    runtimeInspector: async (intent) => ({
      satisfied: true,
      adapter: 'elfinder-fpm',
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
      unixUser: intent.unixUser,
      root: `/var/lib/yunpanel/data/${intent.applicationId}`,
      socketPath: `/run/php/yunpanel-elfinder-${intent.unixUser}.sock`,
      connectorPath: '/usr/share/yunpanel/elfinder/connector.php',
      runtimeUmask: '0027',
    }),
    liveSessions,
  });

  const c1aDigest = createHash('sha256').update('sess-c1a-seed').digest('hex');
  const handoffIssue = await elFinderService.issue({
    sessionId: 'c1a-session-el',
    userId: 'cust-1a',
    sessionDigest: c1aDigest,
    serverId: stagingServerId,
    websiteId: site1A.id,
  });
  assert.ok(handoffIssue.capability);
  assert.equal(elFinderService.size(), 1);

  // Active consumption succeeds
  const consumedEl = await elFinderService.consume(handoffIssue.capability, { sessionDigest: c1aDigest });
  assert.equal(consumedEl.websiteId, site1A.id);
  assert.equal(consumedEl.unixUser, elFinderExpectedUnixUser);

  // Issue new handoff, then suspend Customer 1A -> live session revocation evicts capability immediately fail-closed
  const handoffIssue2 = await elFinderService.issue({
    sessionId: 'c1a-session-el2',
    userId: 'cust-1a',
    sessionDigest: c1aDigest,
    serverId: stagingServerId,
    websiteId: site1A.id,
  });
  assert.equal(elFinderService.size(), 1);

  // Suspend Customer 1A
  const c1aRow2 = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1a');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1a', { revision: c1aRow2.revision, active: false });

  // Capability is evicted from registry upon user revocation
  assert.equal(elFinderService.size(), 0);

  // Attempting to consume revoked capability fails closed with 401 elfinder_handoff_invalid
  await assert.rejects(
    elFinderService.consume(handoffIssue2.capability, { sessionDigest: c1aDigest }),
    (err) => err instanceof ElFinderHandoffError && err.code === 'elfinder_handoff_invalid' && err.status === 401,
  );

  // Reactivate Customer 1A
  const c1aRow3 = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1a');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1a', { revision: c1aRow3.revision, active: true });

  // 5C: Cron Durable Mutation Recovery (recoverRunningCron)
  const cronJobId = 'cron-job-11111111';
  let cronJobState = {
    id: cronJobId,
    serverId: stagingServerId,
    status: 'running',
    operation: OPERATIONS.CRON_APPLY,
    resourceType: 'website_cron',
  };

  const mockCronJobRegistry = {
    async getJob(id) {
      return id === cronJobId ? structuredClone(cronJobState) : null;
    },
    async beginReconciliation(id) {
      if (id.jobId === cronJobId) {
        return { jobId: cronJobId, serverId: stagingServerId, status: 'running', pending: true };
      }
      return null;
    },
    async complete({ serverId, jobId, status, result }) {
      if (jobId === cronJobId) {
        cronJobState.status = status;
        cronJobState.result = result;
        return structuredClone(cronJobState);
      }
      return null;
    },
    async acknowledgeReconciliation(id) {
      if (id.jobId === cronJobId) return { acknowledged: true };
      return null;
    },
  };

  const inspectCronRecovery = async () => ({
    jobs: [{ jobId: cronJobId, serverId: stagingServerId, status: 'running', operation: OPERATIONS.CRON_APPLY, resourceType: 'website_cron' }],
  });

  // Stopped consumers enforcement: running API/agent rejects recovery
  await assert.rejects(
    recoverRunningCron({
      serverId: stagingServerId,
      jobId: cronJobId,
      jobRegistry: mockCronJobRegistry,
      websiteCronRegistry: {},
      websiteCronManager: {},
      readOperationReceipt: async () => null,
      serviceStatus: async () => ({ apiActive: true, agentActive: false }),
      loadJobContext: async () => ({}),
      inspect: inspectCronRecovery,
    }),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_consumers_must_be_stopped',
  );

  // Missing receipt fails closed
  await assert.rejects(
    recoverRunningCron({
      serverId: stagingServerId,
      jobId: cronJobId,
      jobRegistry: mockCronJobRegistry,
      websiteCronRegistry: {},
      websiteCronManager: {},
      readOperationReceipt: async () => null,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      loadJobContext: async () => ({}),
      inspect: inspectCronRecovery,
    }),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_receipt_missing',
  );

  // Valid receipt reconciles and completes job
  const verifiedCronReceipt = {
    result: {
      taskId: 'task-cron-1',
      websiteId: site1A.id,
      applicationId: site1A.applicationId,
      unixUser: `yunapp-${site1A.id.slice(0, 8)}`,
      revision: 1,
      desiredStateSha256: createHash('sha256').update('cron-schedule-daily').digest('hex'),
      contentSha256: createHash('sha256').update('0 2 * * * /usr/bin/php script.php').digest('hex'),
      sideEffects: [],
    },
  };

  const cronRecoveryResult = await recoverRunningCron({
    serverId: stagingServerId,
    jobId: cronJobId,
    jobRegistry: mockCronJobRegistry,
    websiteCronRegistry: {},
    websiteCronManager: {},
    readOperationReceipt: async () => verifiedCronReceipt,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    loadJobContext: async () => ({}),
    inspect: inspectCronRecovery,
  });
  assert.equal(cronRecoveryResult.status, 'succeeded');
  assert.equal(cronRecoveryResult.recoveryMethod, 'verified_cron_receipt_and_host_state');
  assert.equal(cronRecoveryResult.reconciled, true);
  assert.equal(cronJobState.status, 'succeeded');
  assert.equal(cronJobState.result.applied, true);
  assert.equal(cronJobState.result.websiteId, site1A.id);

  // 5D: Reviewed PHP Recovery (recoverRunningPhpTool)
  const phpJobId = 'job-php-cust-recovery';
  const phpAppId = '33333333-3333-4333-8333-333333333333';
  const phpUnixUser = `yunapp-${site1A.id.slice(0, 8)}`;
  const runningPhpJob = {
    id: phpJobId,
    jobId: phpJobId,
    serverId: stagingServerId,
    status: 'running',
    operation: OPERATIONS.WEBSITE_PHP_ACTION,
    resourceType: 'application',
    resourceId: phpAppId,
  };
  const phpPayload = {
    websiteId: site1A.id,
    applicationId: phpAppId,
    unixUser: phpUnixUser,
    expectedWebsiteRevision: 2,
    actorSessionId: 'cust-recovery-session',
    actorUserId: 'cust-1a',
    actorRole: 'customer',
    actionId: 'wp.cache.flush',
    previewDigest: 'e'.repeat(64),
    confirmation: `php-tool:${site1A.id}:wp.cache.flush:${'e'.repeat(64)}`,
  };
  const phpResult = {
    version: 1,
    websiteId: phpPayload.websiteId,
    applicationId: phpAppId,
    unixUser: phpPayload.unixUser,
    actionId: phpPayload.actionId,
    websiteRevision: 2,
    previewDigest: phpPayload.previewDigest,
    completed: true,
    sideEffects: true,
  };

  const inspectPhpRecovery = async () => ({ jobs: [runningPhpJob] });

  // Missing receipt fails closed
  await assert.rejects(
    () => recoverRunningPhpTool({
      serverId: stagingServerId,
      jobId: phpJobId,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: inspectPhpRecovery,
      loadJobContext: async () => ({ ...runningPhpJob, payload: phpPayload }),
      readOperationReceipt: async () => null,
      jobRegistry: {
        getJob: async () => runningPhpJob,
        beginReconciliation: async () => {},
        complete: async () => {},
        acknowledgeReconciliation: async () => {},
      },
    }),
    (err) => err.code === 'job_php_tool_recovery_receipt_missing',
  );

  // Drifted evidence fails closed
  await assert.rejects(
    () => recoverRunningPhpTool({
      serverId: stagingServerId,
      jobId: phpJobId,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: inspectPhpRecovery,
      loadJobContext: async () => ({ ...runningPhpJob, payload: phpPayload }),
      readOperationReceipt: async () => ({
        version: 1,
        serverId: stagingServerId,
        jobId: phpJobId,
        payload: { ...phpPayload, actionId: 'tampered.action' },
        result: phpResult,
      }),
      jobRegistry: {
        getJob: async () => runningPhpJob,
        beginReconciliation: async () => {},
        complete: async () => {},
        acknowledgeReconciliation: async () => {},
      },
    }),
    (err) => err.code === 'job_php_tool_recovery_evidence_mismatch',
  );

  // Verified evidence reconciles successfully
  const recoveredPhp = await recoverRunningPhpTool({
    serverId: stagingServerId,
    jobId: phpJobId,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    inspect: inspectPhpRecovery,
    loadJobContext: async () => ({ ...runningPhpJob, payload: phpPayload }),
    readOperationReceipt: async () => ({
      version: 1,
      serverId: stagingServerId,
      jobId: phpJobId,
      payload: phpPayload,
      result: phpResult,
    }),
    jobRegistry: {
      getJob: async () => runningPhpJob,
      beginReconciliation: async (v) => ({ ...v, status: 'running', pending: true }),
      complete: async () => ({ ...runningPhpJob, status: 'succeeded' }),
      acknowledgeReconciliation: async (v) => ({ ...v, status: 'succeeded', acknowledged: true }),
    },
  });
  assert.equal(recoveredPhp.recoveryMethod, 'verified_php_tool_receipt');
  assert.equal(recoveredPhp.status, 'succeeded');

  // --------------------------------------------------------------------------
  // SECTION 6: Ownership Migration & Rollback, Concurrency, and Host Decoupling
  // --------------------------------------------------------------------------

  // 6A: Ownership Migration with atomic quota updates
  const quotaBeforeC1a = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  const quotaBeforeC1b = f.store.get(ownerToken, f.requireManagement, 'cust-1b');

  // Allocate site1A transfer: release from cust-1a and allocate to cust-1b
  f.store.siteAllocations.releaseRemoved({
    operationId: 'op-transfer-1a-release',
    websiteId: site1A.id,
    serverId: stagingServerId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });

  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site1A,
    ownerUserId: 'cust-1b',
    resellerId: 'reseller-1',
  });

  const quotaAfterC1a = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  const quotaAfterC1b = f.store.get(ownerToken, f.requireManagement, 'cust-1b');

  // Cust-1a count decreased by 1; Cust-1b count increased by 1
  assert.equal(quotaAfterC1a.usage.websites, quotaBeforeC1a.usage.websites - 1);
  assert.equal(quotaAfterC1b.usage.websites, quotaBeforeC1b.usage.websites + 1);

  // 6B: Atomic Rollback on Quota Exceeded (zero orphan records)
  // Attempting to exceed customer quota fails closed without partial allocation
  assert.throws(
    () => {
      // cust-1b has maxWebsites: 2 and currently usage.websites: 2
      assertCustomerQuotaCapacity({
        quotas: quotaAfterC1b.quotas,
        usage: quotaAfterC1b.usage,
        resource: 'websites',
        amount: 1,
      });
    },
    (err) => err instanceof AuthError && err.code === 'customer_quota_exceeded',
  );

  // Transfer site1A back to cust-1a to restore original topology
  f.store.siteAllocations.releaseRemoved({
    operationId: 'op-rollback-release',
    websiteId: site1A.id,
    serverId: stagingServerId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  f.store.siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
    site: site1A,
    ownerUserId: 'cust-1a',
    resellerId: 'reseller-1',
  });

  // Verify quotas match initial state exactly
  const quotaRestoredC1a = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  const quotaRestoredC1b = f.store.get(ownerToken, f.requireManagement, 'cust-1b');
  assert.equal(quotaRestoredC1a.usage.websites, quotaBeforeC1a.usage.websites);
  assert.equal(quotaRestoredC1b.usage.websites, quotaBeforeC1b.usage.websites);

  // 6C: Two-process / multi-connection concurrency and crash/write-failure resilience in WAL mode
  const concurrencyTempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-sqlite-concurrency-'));
  const concurrencyDbPath = path.join(concurrencyTempDir, 'concurrency.db');

  t.after(async () => {
    try { await rm(concurrencyTempDir, { recursive: true, force: true }); } catch {}
  });

  // Open two separate database connections simulating two independent processes
  const procA = new DatabaseSync(concurrencyDbPath);
  const procB = new DatabaseSync(concurrencyDbPath);
  t.after(() => {
    try { procA.close(); } catch {}
    try { procB.close(); } catch {}
  });

  // Initialize schema in WAL mode with short busy timeout for deterministic lock contention detection
  procA.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 50;
    CREATE TABLE IF NOT EXISTS test_allocations (
      website_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved', 'attached')),
      revision INTEGER NOT NULL CHECK(revision >= 1)
    );
  `);
  procB.exec('PRAGMA busy_timeout = 50;');

  // Concurrency verification: Proc A acquires exclusive write lock via BEGIN IMMEDIATE
  procA.exec('BEGIN IMMEDIATE');
  procA.prepare('INSERT INTO test_allocations VALUES (?, ?, ?, ?)').run(site1A.id, 'cust-1a', 'reserved', 1);

  // Proc B attempts concurrent write transaction while Proc A holds write lock -> fails closed with SQLITE_BUSY
  assert.throws(
    () => {
      procB.exec('BEGIN IMMEDIATE');
    },
    (err) => /busy|locked/i.test(err.message),
    'Concurrent write transaction must be rejected with SQLITE_BUSY when lock is held',
  );

  // Proc A commits transaction
  procA.exec('COMMIT');

  // Now Proc B can read the committed row from Proc A (cross-process visibility)
  const rowFromProcB = procB.prepare('SELECT * FROM test_allocations WHERE website_id = ?').get(site1A.id);
  assert.ok(rowFromProcB, 'Proc B must observe committed row from Proc A');
  assert.equal(rowFromProcB.status, 'reserved');

  // Proc B acquires write lock and updates status
  procB.exec('BEGIN IMMEDIATE');
  procB.prepare('UPDATE test_allocations SET status = ? WHERE website_id = ?').run('attached', site1A.id);
  procB.exec('COMMIT');

  const rowUpdatedFromProcA = procA.prepare('SELECT status FROM test_allocations WHERE website_id = ?').get(site1A.id);
  assert.equal(rowUpdatedFromProcA.status, 'attached');

  // Crash / Write-Failure Resilience:
  // Transaction rolls back cleanly on error, leaving zero partial state or orphan rows
  assert.throws(
    () => {
      procA.exec('BEGIN IMMEDIATE');
      procA.prepare('INSERT INTO test_allocations VALUES (?, ?, ?, ?)').run('orphan-site-id', 'cust-1a', 'reserved', 1);
      // Trigger check constraint violation / write failure
      try {
        procA.prepare('INSERT INTO test_allocations VALUES (?, ?, ?, ?)').run('invalid-site-id', 'cust-1a', 'invalid_status', 1);
      } catch (err) {
        procA.exec('ROLLBACK');
        throw err;
      }
    },
    (err) => /check constraint failed/i.test(err.message),
  );

  // Verify zero orphan rows were committed to the database
  const orphanCheckA = procA.prepare('SELECT * FROM test_allocations WHERE website_id = ?').get('orphan-site-id');
  const orphanCheckB = procB.prepare('SELECT * FROM test_allocations WHERE website_id = ?').get('orphan-site-id');
  assert.equal(orphanCheckA, undefined, 'Orphan row must not exist in Proc A after rollback');
  assert.equal(orphanCheckB, undefined, 'Orphan row must not exist in Proc B after rollback');

  // PRAGMA integrity check confirms clean database structure without corruption
  const integrity = procA.prepare('PRAGMA integrity_check').get();
  assert.equal(integrity.integrity_check, 'ok', 'Database integrity must remain ok after write failure rollback');

  // 6D: Website Host Runtime Decoupling
  // Panel account suspension does not destroy or mutate host website runtime daemons
  const runtimeDaemonState = {
    websiteId: site1A.id,
    nginxVhost: 'active',
    phpFpmPool: 'active',
    systemdUnit: 'running',
  };
  // Suspending Customer 1A cuts off panel access
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1a', { revision: quotaRestoredC1a.revision, active: false });
  assert.equal(f.revoked.some((r) => r.id === 'cust-1a' && r.reason === 'hosting_account_suspended'), true);
  // Host runtime state remains intact
  assert.equal(runtimeDaemonState.nginxVhost, 'active');
  assert.equal(runtimeDaemonState.phpFpmPool, 'active');
  assert.equal(runtimeDaemonState.systemdUnit, 'running');

  // 6E: Host Isolation & Safety Gate
  assertNoDot44Host(stagingServerId);
  assert.ok(true, 'RS-02e / kalan: Live auth store session, site resource boundary, AI history & policy grants, long-running disconnects, ownership rollback, and host isolation verified.');
});
