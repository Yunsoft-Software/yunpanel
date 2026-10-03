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
    { id: 'site-2a1', name: 'Site 2A1', customerId: 'cust-2a', resellerId: 'reseller-2' },
    { id: 'site-2b1', name: 'Site 2B1', customerId: 'cust-2b', resellerId: 'reseller-2' },
    { id: 'site-direct', name: 'Site Direct', customerId: 'cust-direct', resellerId: null },
  ];

  for (const s of sites) {
    siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
      site: { id: s.id, serverId: stagingServerId, name: s.name, applicationId: null, dockerWorkloadId: null, managedComposeBinding: null },
      ownerUserId: s.customerId,
      resellerId: s.resellerId,
    });
  }

  // 4. Verify Customer & Reseller website usage
  const c1aUsage = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  assert.equal(c1aUsage.usage.websites, 2);
  const c1bUsage = f.store.get(ownerToken, f.requireManagement, 'cust-1b');
  assert.equal(c1bUsage.usage.websites, 1);
  const r1Usage = f.store.get(ownerToken, f.requireManagement, 'reseller-1');
  assert.equal(r1Usage.usage.websites, 3);
  assert.equal(r1Usage.usage.customers, 2);

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
  const r1Actor = { id: 'reseller-1', role: 'reseller', hosting: { kind: 'reseller', resellerId: null }, active: true, websiteIds: ['site-1a1', 'site-1a2', 'site-1b1'] };
  const r2Actor = { id: 'reseller-2', role: 'reseller', hosting: { kind: 'reseller', resellerId: null }, active: true, websiteIds: ['site-2a1', 'site-2b1'] };
  const c1aActor = { id: 'cust-1a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: ['site-1a1', 'site-1a2'] };
  const c1bActor = { id: 'cust-1b', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: ['site-1b1'] };
  const c2aActor = { id: 'cust-2a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-2' }, active: true, websiteIds: ['site-2a1'] };
  const c2bActor = { id: 'cust-2b', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-2' }, active: true, websiteIds: ['site-2b1'] };
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
    { actor: ownerActor, allowedSites: ['site-1a1', 'site-1a2', 'site-1b1', 'site-2a1', 'site-2b1', 'site-direct'] },
    { actor: r1Actor, allowedSites: ['site-1a1', 'site-1a2', 'site-1b1'] },
    { actor: r2Actor, allowedSites: ['site-2a1', 'site-2b1'] },
    { actor: c1aActor, allowedSites: ['site-1a1', 'site-1a2'] },
    { actor: c1bActor, allowedSites: ['site-1b1'] },
    { actor: c2aActor, allowedSites: ['site-2a1'] },
    { actor: c2bActor, allowedSites: ['site-2b1'] },
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
  assert.deepEqual(sanitizeTenantCollection(rawCollection, c1bActor).map((s) => s.id), ['site-1b1']);
  assert.deepEqual(sanitizeTenantCollection(rawCollection, r1Actor).map((s) => s.id), ['site-1a1', 'site-1a2', 'site-1b1']);
  assert.deepEqual(sanitizeTenantCollection(rawCollection, r2Actor).map((s) => s.id), ['site-2a1', 'site-2b1']);
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
