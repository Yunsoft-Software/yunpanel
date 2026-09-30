import assert from 'node:assert/strict';
import http from 'node:http';
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
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import {
  checkLocalApiHealth,
  resolveLocalApiHealthTarget,
  LocalApiHealthError,
  createSystemWatchdogService,
  SystemWatchdogError,
  mountSystemWatchdogRoutes,
} from '../src/local-api-health.js';

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
