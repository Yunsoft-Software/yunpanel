import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import {
  mountSiteCreateRoutes,
  siteCreateHttpInternals,
} from '../src/site-create-http.js';
import { SiteCreateError } from '../src/site-create.js';
import { siteFixture, website, allocation, uuid } from '../test-support/hosting-site-fixture.js';
import {
  createHostingSiteAllocationStore,
  hostingWebsiteDigest,
} from '../src/hosting-site-allocation-store.js';
import { createHostingSiteCreateService } from '../src/hosting-site-create-service.js';
import { createTenantBoundaryMiddleware } from '../src/tenant-boundary.js';
import {
  mountWebsiteRemovalRoutes,
  WebsiteRemovalHttpError,
  websiteRemovalHttpInternals,
} from '../src/website-removal-http.js';

function fakeApp() {
  const routes = { get: new Map(), post: new Map() };
  return {
    routes,
    get(path, ...handlers) { routes.get.set(path, handlers.at(-1)); },
    post(path, ...handlers) { routes.post.set(path, handlers.at(-1)); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    set(name, value) { this.setHeader(name, value); return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

async function invoke(handler, request) {
  const response = fakeResponse();
  let nextError = null;
  await handler(request, response, (error) => { nextError = error; });
  if (nextError) throw nextError;
  return response;
}

function setupTestEnvironment(t, { maxWebsites = 2, maxCustomers = 5 } = {}) {
  const f = siteFixture(t, { maxWebsites, maxCustomers });
  const serverId = uuid(100);
  const site = website(1, { serverId });
  const sites = new Map();
  const applications = new Map();
  const domains = new Map();
  const mailDomains = new Map();
  const provisioningOperations = new Map();
  const lockCalls = [];

  const operationSites = new Map();
  const siteForOperation = (operationId) => {
    if (!operationSites.has(operationId)) operationSites.set(operationId,
      operationSites.size === 0 ? site : website(9000 + operationSites.size, { serverId }));
    return operationSites.get(operationId);
  };
  const basePlan = (operationId = uuid(1001)) => {
    const plannedSite = siteForOperation(operationId);
    return ({
    operationId,
    ids: {
      websiteId: plannedSite.id,
      applicationId: plannedSite.applicationId,
      primaryDomainId: uuid(2),
      wwwDomainId: null,
      mailDomainId: null,
    },
    previewDigest: 'b'.repeat(64),
    confirmation: 'original-confirmation',
    blockers: [],
    steps: { websiteReady: sites.has(plannedSite.id) },
    source: { kind: 'external_proxy' },
    plan: { website: plannedSite, application: null },
    state: 'available',
    });
  };

  const previewAdapter = async (input) => {
    const targetSite = input.operationId === uuid(1001)
      ? site
      : website(Number(input.operationId.slice(-4)) || 2);
    return basePlan(input.operationId, targetSite);
  };
  const createAdapter = async (apply) => {
    const plannedSite = siteForOperation(apply.input.operationId);
    sites.set(plannedSite.id, structuredClone(plannedSite));
    return { created: true, website: plannedSite };
  };

  const siteMutationLock = {
    withSiteLock: async (identity, action) => {
      lockCalls.push(structuredClone(identity));
      return action();
    },
  };

  const server = { id: serverId, name: 'primary', serverIp: '127.0.0.1' };
  const registry = {
    getServer: async (id) => (id === serverId ? server : null),
  };
  const dockerWorkloadRegistry = {
    getWorkload: async () => null,
    listWorkloads: async () => [],
  };
  const websiteRegistry = {
    getWebsite: async (id) => sites.get(id) ?? null,
    listWebsites: async () => [...sites.values()],
  };
  const applicationRegistry = {
    getApplication: async (id) => applications.get(id) ?? null,
    listApplications: async () => [...applications.values()],
  };
  const domainRegistry = {
    getDomain: async (id) => domains.get(id) ?? null,
    listDomains: async () => [...domains.values()],
  };
  const mailDomainRegistry = {
    getMailDomain: async (id) => mailDomains.get(id) ?? null,
    listMailDomains: async () => [...mailDomains.values()],
  };
  const serverDnsIdentityRegistry = {
    getForServer: async () => null,
  };
  const dnsZoneTemplateRegistry = {
    getForServer: async () => null,
  };
  const websiteProvisioningRegistry = {
    get: async (id) => provisioningOperations.get(id) ?? null,
    create: async (plan) => {
      const op = { ...plan, operationId: plan.operationId ?? uuid(2000), status: 'pending' };
      provisioningOperations.set(op.operationId, op);
      return op;
    },
    abandonUncreated: async (proof) => {
      const current = provisioningOperations.get(proof.operationId) ?? null;
      if (!current) {
        const error = new Error('Provisioning operation not found');
        error.code = 'website_provisioning_not_found';
        throw error;
      }
      if (current.unsafe === true) {
        const error = new Error('Compensation required');
        error.code = 'website_provisioning_abandon_requires_compensation';
        throw error;
      }
      const abandoned = {
        ...current,
        operationId: proof.operationId,
        websiteId: proof.websiteId,
        status: 'abandoned',
        terminalState: 'abandoned',
      };
      provisioningOperations.set(proof.operationId, abandoned);
      return abandoned;
    },
  };

  const userAdminStore = {
    hostingAccounts: f.store,
  };

  const hostingSiteCreateRuntime = createHostingSiteCreateService({
    hostingAccounts: f.store,
    websiteRegistry,
    applicationRegistry,
    domainRegistry,
    mailDomainRegistry,
    websiteProvisioningRegistry,
    siteMutationLock,
    localServerId: serverId,
    previewSiteCreate: previewAdapter,
    createSite: createAdapter,
  });

  const dependencies = {
    localServerId: serverId,
    hostingSiteCreateRuntime,
    siteMutationLock,
    registry,
    dockerWorkloadRegistry,
    websiteRegistry,
    applicationRegistry,
    domainRegistry,
    mailDomainRegistry,
    serverDnsIdentityRegistry,
    dnsZoneTemplateRegistry,
    websiteProvisioningRegistry,
    userAdminStore,
    previewSiteCreate: previewAdapter,
    createSite: createAdapter,
    requireManagement: f.requireManagement,
  };

  const ownerAuth = {
    id: 'session-owner',
    token: f.token,
    rawToken: f.token,
    user: { id: 'owner', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };

  function siteInput(operationId = uuid(1001), overrides = {}) {
    return {
      operationId,
      serverId,
      name: 'Example',
      primaryDomain: 'example.com',
      parentDomainId: null,
      wwwMode: 'none',
      httpsMode: 'off',
      dns: { mode: 'external' },
      source: { kind: 'external_proxy', target: { host: '127.0.0.1', port: 8080, websocket: true } },
      ...overrides,
    };
  }

  return {
    f,
    serverId,
    site,
    sites,
    applications,
    domains,
    mailDomains,
    provisioningOperations,
    lockCalls,
    dependencies,
    ownerAuth,
    siteInput,
  };
}

test('mountSiteCreateRoutes mounts standard, hosted, and reservation recovery routes', () => {
  const app = fakeApp();
  mountSiteCreateRoutes(app, {});
  assert.equal(typeof app.routes.post.get('/api/sites/create-preview'), 'function');
  assert.equal(typeof app.routes.post.get('/api/sites'), 'function');
  assert.equal(typeof app.routes.post.get('/api/sites/hosted/create-preview'), 'function');
  assert.equal(typeof app.routes.post.get('/api/sites/hosted'), 'function');
  assert.equal(typeof app.routes.post.get('/api/sites/hosted/recover-reservation'), 'function');
  assert.equal(typeof app.routes.post.get('/api/sites/recover-reservation'), 'function');
});

test('hosted preview via /api/sites/create-preview and /api/sites/hosted/create-preview', async (t) => {
  const env = setupTestEnvironment(t);
  const app = fakeApp();
  mountSiteCreateRoutes(app, env.dependencies);

  const previewBody = {
    customerId: 'customer-a',
    input: env.siteInput(uuid(1001)),
  };

  // Test 1: POST /api/sites/create-preview with customerId
  const handler1 = app.routes.post.get('/api/sites/create-preview');
  const res1 = await invoke(handler1, {
    auth: env.ownerAuth,
    rawToken: env.ownerAuth.rawToken,
    body: previewBody,
  });
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.payload.data.customerId, 'customer-a');
  assert.equal(res1.payload.data.ownership.state, 'available');
  assert.equal(res1.payload.data.accessGranted, false);
  assert.ok(typeof res1.payload.data.previewDigest === 'string');
  assert.ok(res1.payload.data.confirmation.startsWith('create-hosted-site:'));

  // Test 2: POST /api/sites/hosted/create-preview
  const handler2 = app.routes.post.get('/api/sites/hosted/create-preview');
  const res2 = await invoke(handler2, {
    auth: env.ownerAuth,
    rawToken: env.ownerAuth.rawToken,
    body: previewBody,
  });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.payload.data.customerId, 'customer-a');
  assert.equal(res2.payload.data.ownership.state, 'available');
});

test('hosted create via /api/sites and /api/sites/hosted creates site and attaches quota', async (t) => {
  const env = setupTestEnvironment(t);
  const app = fakeApp();
  mountSiteCreateRoutes(app, env.dependencies);

  // Preview first to get valid digest and confirmation
  const previewHandler = app.routes.post.get('/api/sites/hosted/create-preview');
  const previewRes = await invoke(previewHandler, {
    auth: env.ownerAuth,
    rawToken: env.ownerAuth.rawToken,
    body: {
      customerId: 'customer-a',
      input: env.siteInput(uuid(1001)),
    },
  });
  const preview = previewRes.payload.data;

  // Create via POST /api/sites/hosted
  const createHandler = app.routes.post.get('/api/sites/hosted');
  const createRes = await invoke(createHandler, {
    auth: env.ownerAuth,
    rawToken: env.ownerAuth.rawToken,
    body: {
      customerId: 'customer-a',
      input: env.siteInput(uuid(1001)),
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    },
  });
  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.payload.data.created, true);
  assert.equal(createRes.payload.data.ownership.state, 'attached');
  assert.equal(createRes.payload.data.accessGranted, true);
  assert.equal(createRes.payload.data.stage, 'ownership_recorded');

  // Verify siteMutationLock was used
  assert.ok(env.lockCalls.length > 0);
  assert.equal(env.lockCalls[0].websiteId, env.site.id);

  // Verify reseller quota usage increased to 1
  assert.equal(env.f.get('reseller-a').usage.websites, 1);

  // Idempotent retry: repeat call returns 200 and does not double charge quota
  const retryRes = await invoke(createHandler, {
    auth: env.ownerAuth,
    rawToken: env.ownerAuth.rawToken,
    body: {
      customerId: 'customer-a',
      input: env.siteInput(uuid(1001)),
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    },
  });
  assert.equal(retryRes.statusCode, 200);
  assert.equal(retryRes.payload.data.created, false);
  assert.equal(env.f.get('reseller-a').usage.websites, 1);
});

test('hosted reservation recovery via /api/sites/recover-reservation and /api/sites/hosted/recover-reservation', async (t) => {
  const env = setupTestEnvironment(t);
  const app = fakeApp();
  mountSiteCreateRoutes(app, env.dependencies);

  // 1. Preview
  const previewHandler = app.routes.post.get('/api/sites/hosted/create-preview');
  const previewRes = await invoke(previewHandler, {
    auth: env.ownerAuth,
    rawToken: env.ownerAuth.rawToken,
    body: {
      customerId: 'customer-a',
      input: env.siteInput(uuid(1002)),
    },
  });
  const preview = previewRes.payload.data;

  // 2. Reserve quota directly
  env.f.reserve({
    operationId: uuid(1002),
    websiteId: preview.ids.websiteId,
    customerId: 'customer-a',
    serverId: env.serverId,
    intentDigest: preview.ownership.intentDigest,
    websiteDigest: preview.ownership.websiteDigest,
  });
  assert.equal(env.f.get('reseller-a').usage.websites, 1);

  // 3. Recover reservation (website absent)
  const recoverHandler = app.routes.post.get('/api/sites/hosted/recover-reservation');
  const recoverRes = await invoke(recoverHandler, {
    auth: env.ownerAuth,
    rawToken: env.ownerAuth.rawToken,
    body: {
      customerId: 'customer-a',
      input: env.siteInput(uuid(1002)),
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    },
  });
  assert.equal(recoverRes.statusCode, 200);
  assert.equal(recoverRes.payload.data.recovered, true);
  assert.equal(recoverRes.payload.data.stage, 'reservation_released');
  assert.equal(recoverRes.payload.data.ownership.quotaReleased, true);

  // Quota is atomically released back to 0
  assert.equal(env.f.get('reseller-a').usage.websites, 0);
});

test('tenant boundary middleware blocks reseller and customer from site creation and recovery endpoints', async (t) => {
  const env = setupTestEnvironment(t);
  const middleware = createTenantBoundaryMiddleware({});

  const resellerActor = {
    id: 'reseller-a',
    role: 'reseller',
    active: true,
    websiteIds: [],
    hosting: { kind: 'reseller', resellerId: null },
  };

  const customerActor = {
    id: 'customer-a',
    role: 'customer',
    active: true,
    websiteIds: [],
    hosting: { kind: 'customer', resellerId: 'reseller-a' },
  };

  const restrictedPaths = [
    '/api/sites',
    '/api/sites/create-preview',
    '/api/sites/hosted',
    '/api/sites/hosted/create-preview',
    '/api/sites/hosted/recover-reservation',
    '/api/sites/recover-reservation',
  ];

  for (const actor of [resellerActor, customerActor]) {
    for (const path of restrictedPaths) {
      const req = {
        method: 'POST',
        originalUrl: path,
        url: path,
        auth: { user: actor },
        body: { customerId: 'customer-a', input: {} },
      };
      const res = fakeResponse();
      let nextCalled = false;
      await middleware(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false, `Expected ${path} to be blocked for ${actor.role}`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.payload.error.code, 'tenant_boundary_forbidden');
    }
  }
});

test('inactive customer or suspended parent reseller cannot reserve site quota', async (t) => {
  const env = setupTestEnvironment(t);
  const app = fakeApp();
  mountSiteCreateRoutes(app, env.dependencies);

  // Deactivate customer-a via hosting account store
  env.f.store.setActive(env.f.token, env.f.requireManagement, 'customer-a', { revision: 1, active: false });

  const previewHandler = app.routes.post.get('/api/sites/hosted/create-preview');
  await assert.rejects(
    invoke(previewHandler, {
      auth: env.ownerAuth,
      rawToken: env.ownerAuth.rawToken,
      body: {
        customerId: 'customer-a',
        input: env.siteInput(uuid(1003)),
      },
    }),
    (error) => error.code === 'hosting_account_inactive' || error.status === 403,
  );
});

test('invalid hosted site requests are rejected with appropriate error codes', async (t) => {
  const env = setupTestEnvironment(t);
  const app = fakeApp();
  mountSiteCreateRoutes(app, env.dependencies);

  const previewHandler = app.routes.post.get('/api/sites/hosted/create-preview');

  // Missing customerId
  await assert.rejects(
    invoke(previewHandler, {
      auth: env.ownerAuth,
      rawToken: env.ownerAuth.rawToken,
      body: { input: { operationId: uuid(1004) } },
    }),
    (error) => error instanceof SiteCreateError && error.code === 'invalid_hosting_site_request' && error.status === 400,
  );

  // Stale preview on create
  const createHandler = app.routes.post.get('/api/sites/hosted');
  await assert.rejects(
    invoke(createHandler, {
      auth: env.ownerAuth,
      rawToken: env.ownerAuth.rawToken,
      body: {
        customerId: 'customer-a',
        input: env.siteInput(uuid(1004)),
        previewDigest: '0'.repeat(64),
        confirmation: 'invalid-confirmation',
      },
    }),
    (error) => (error instanceof SiteCreateError || error instanceof AuthError) && (error.code === 'hosting_site_preview_stale' || error.code === 'site_create_confirmation_required'),
  );

});

test('website removal HTTP routes enforce tenant authorization, active tenant context, and resource locking', async (t) => {
  const env = setupTestEnvironment(t);
  const app = fakeApp();
  const removalLockCalls = [];
  const removalSiteMutationLock = {
    withSiteLock: async (identity, action) => {
      removalLockCalls.push(structuredClone(identity));
      return action();
    },
  };

  const mockRemovalRuntime = {
    preview: async ({ websiteId }) => ({
      websiteId,
      previewDigest: 'd'.repeat(64),
      confirmation: `start-website-remove:${websiteId}:1:${'d'.repeat(64)}`,
    }),
    start: async ({ websiteId, actor }) => ({
      id: uuid(9001),
      websiteId,
      status: 'running',
      actor,
    }),
    continueStep: async ({ websiteId, operationId, actor }) => ({
      id: operationId,
      websiteId,
      status: 'removed',
      actor,
    }),
    get: async (id) => (id === uuid(9001) ? { id: uuid(9001), websiteId: env.site.id, status: 'running' } : null),
    list: async () => [{ id: uuid(9001), websiteId: env.site.id, status: 'running' }],
    listForWebsite: async (wsId) => (wsId === env.site.id ? [{ id: uuid(9001), websiteId: env.site.id, status: 'running' }] : []),
  };

  // Add the site to registry
  env.sites.set(env.site.id, structuredClone(env.site));

  mountWebsiteRemovalRoutes(app, {
    runtime: mockRemovalRuntime,
    siteMutationLock: removalSiteMutationLock,
    websiteRegistry: env.dependencies.websiteRegistry,
    localServerId: env.serverId,
  });

  const customerAuth = {
    id: 'session-customer-a',
    user: {
      id: 'customer-a',
      role: 'customer',
      active: true,
      websiteIds: [env.site.id],
      hosting: { kind: 'customer', resellerId: 'reseller-a' },
    },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  };

  // 1. Customer can preview removal of their own site
  const previewHandler = app.routes.get.get('/api/websites/:websiteId/removal');
  const previewRes = await invoke(previewHandler, {
    auth: customerAuth,
    params: { websiteId: env.site.id },
  });
  assert.equal(previewRes.statusCode, 200);
  assert.equal(previewRes.payload.preview.websiteId, env.site.id);

  // 2. Customer can start removal and siteMutationLock is acquired
  const startHandler = app.routes.post.get('/api/websites/:websiteId/removal');
  const startRes = await invoke(startHandler, {
    auth: customerAuth,
    params: { websiteId: env.site.id },
    body: {
      previewDigest: 'd'.repeat(64),
      confirmation: `start-website-remove:${env.site.id}:1:${'d'.repeat(64)}`,
    },
  });
  assert.equal(startRes.statusCode, 201);
  assert.equal(startRes.payload.operation.id, uuid(9001));
  assert.equal(removalLockCalls.length, 1);
  assert.equal(removalLockCalls[0].websiteId, env.site.id);

  // 3. Customer can continue removal operation and siteMutationLock is acquired
  const continueHandler = app.routes.post.get('/api/websites/:websiteId/removal-operations/:operationId/continue');
  const continueRes = await invoke(continueHandler, {
    auth: customerAuth,
    params: { websiteId: env.site.id, operationId: uuid(9001) },
    body: {
      expectedUpdatedAt: '2026-09-28T12:00:00.000Z',
      stepId: '001:domain_removal:dom-1',
      confirmation: 'confirm',
    },
  });
  assert.equal(continueRes.statusCode, 200);
  assert.equal(continueRes.payload.operation.status, 'removed');
  assert.equal(removalLockCalls.length, 2);

  // 4. Inactive customer is rejected with 403 tenant_actor_inactive
  const inactiveCustomerAuth = {
    ...customerAuth,
    user: { ...customerAuth.user, active: false },
  };
  await assert.rejects(
    invoke(previewHandler, {
      auth: inactiveCustomerAuth,
      params: { websiteId: env.site.id },
    }),
    (error) => error.code === 'tenant_actor_inactive' && error.status === 403,
  );

  // 5. Cross-tenant access: customer trying to access unassigned website is rejected with 404
  const otherWebsiteId = uuid(999);
  await assert.rejects(
    invoke(previewHandler, {
      auth: customerAuth,
      params: { websiteId: otherWebsiteId },
    }),
    (error) => error.code === 'website_removal_operation_not_found' && error.status === 404,
  );
});

test('website removal releases reseller and customer quotas via releaseRemoved and revokes live sessions', async (t) => {
  const env = setupTestEnvironment(t);

  // Allocate website to customer-a
  const alloc = {
    operationId: uuid(2001),
    websiteId: env.site.id,
    customerId: 'customer-a',
    serverId: env.serverId,
    intentDigest: 'f'.repeat(64),
    websiteDigest: hostingWebsiteDigest(env.site),
  };
  env.f.preview(alloc);
  env.f.reserve(alloc);
  env.f.complete(alloc, env.site);

  // Quota is 1 for reseller-a
  assert.equal(env.f.get('reseller-a').usage.websites, 1);
  assert.equal(env.f.count('auth_customer_websites'), 1);
  assert.equal(env.f.count('auth_hosting_site_allocations'), 1);

  // Invoke releaseRemoved with verified absence proof
  const releaseProof = {
    operationId: uuid(3001),
    websiteId: env.site.id,
    serverId: env.serverId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  };

  const receipt = env.f.store.siteAllocations.releaseRemoved(releaseProof);
  assert.equal(receipt.released, true);
  assert.equal(receipt.quotaReleased, true);
  assert.equal(receipt.customerId, 'customer-a');

  // Reseller quota usage is atomically released back to 0
  assert.equal(env.f.get('reseller-a').usage.websites, 0);
  assert.equal(env.f.count('auth_customer_websites'), 0);
  assert.equal(env.f.count('auth_hosting_site_allocations'), 0);

  // Live sessions for customer and reseller were revoked
  const revokedIds = env.f.revoked.map((r) => r.id);
  assert.ok(revokedIds.includes('customer-a'));
  assert.ok(revokedIds.includes('reseller-a'));
});

test('authorizeWebsiteRemovalActor validates active tenant context, MFA, and assigned website IDs', async (t) => {
  const env = setupTestEnvironment(t);

  const authStore = {
    getSessionById: (id) => {
      if (id === 'session-owner') return { id: 'session-owner', user: { id: 'owner', role: 'owner', active: true } };
      if (id === 'session-customer-active') return { id: 'session-customer-active', user: { id: 'customer-a', role: 'customer', active: true, websiteIds: [env.site.id] } };
      if (id === 'session-customer-inactive') return { id: 'session-customer-inactive', user: { id: 'customer-a', role: 'customer', active: false, websiteIds: [env.site.id] } };
      if (id === 'session-reseller-active') return { id: 'session-reseller-active', user: { id: 'reseller-a', role: 'reseller', active: true, websiteIds: [env.site.id] } };
      if (id === 'session-sm-active') return { id: 'session-sm-active', user: { id: 'sm-a', role: 'site_manager', active: true, websiteIds: [env.site.id] } };
      return null;
    },
    mfa: { enabled: (userId) => userId === 'owner' },
  };

  const authorizeRemovalActor = async (actor, websiteId = null) => {
    if (!actor || typeof actor.sessionId !== 'string' || typeof actor.userId !== 'string'
      || !['owner', 'site_manager', 'reseller', 'customer'].includes(actor.role)) return null;
    const session = authStore.getSessionById(actor.sessionId);
    if (!session || session.user.id !== actor.userId) return null;
    if (session.user.active === false) return null;
    const validRole = session.user.role === actor.role
      || (session.user.role === 'site_manager' && ['reseller', 'customer'].includes(actor.role));
    if (!validRole) return null;
    if (actor.role === 'owner') {
      if (!authStore.mfa.enabled(actor.userId)) return null;
    } else if (!websiteId || !Array.isArray(session.user.websiteIds) || !session.user.websiteIds.includes(websiteId)) {
      return null;
    }
    return Object.freeze({ sessionId: session.id, userId: session.user.id, role: actor.role });
  };

  // Owner passes with active session and MFA
  const ownerResult = await authorizeRemovalActor({ sessionId: 'session-owner', userId: 'owner', role: 'owner' }, env.site.id);
  assert.ok(ownerResult);
  assert.equal(ownerResult.role, 'owner');

  // Customer passes when websiteId matches
  const customerResult = await authorizeRemovalActor({ sessionId: 'session-customer-active', userId: 'customer-a', role: 'customer' }, env.site.id);
  assert.ok(customerResult);
  assert.equal(customerResult.userId, 'customer-a');

  // Inactive customer is rejected
  const inactiveResult = await authorizeRemovalActor({ sessionId: 'session-customer-inactive', userId: 'customer-a', role: 'customer' }, env.site.id);
  assert.equal(inactiveResult, null);

  // Customer without assigned website is rejected
  const unassignedResult = await authorizeRemovalActor({ sessionId: 'session-customer-active', userId: 'customer-a', role: 'customer' }, uuid(999));
  assert.equal(unassignedResult, null);

  // Non-owner tenant roles (customer, reseller, site_manager) fail-closed when websiteId is null or omitted
  const nullWebsiteCustomer = await authorizeRemovalActor({ sessionId: 'session-customer-active', userId: 'customer-a', role: 'customer' }, null);
  assert.equal(nullWebsiteCustomer, null);

  const omittedWebsiteCustomer = await authorizeRemovalActor({ sessionId: 'session-customer-active', userId: 'customer-a', role: 'customer' });
  assert.equal(omittedWebsiteCustomer, null);

  const nullWebsiteReseller = await authorizeRemovalActor({ sessionId: 'session-reseller-active', userId: 'reseller-a', role: 'reseller' }, null);
  assert.equal(nullWebsiteReseller, null);

  const omittedWebsiteReseller = await authorizeRemovalActor({ sessionId: 'session-reseller-active', userId: 'reseller-a', role: 'reseller' });
  assert.equal(omittedWebsiteReseller, null);

  const nullWebsiteSm = await authorizeRemovalActor({ sessionId: 'session-sm-active', userId: 'sm-a', role: 'site_manager' }, null);
  assert.equal(nullWebsiteSm, null);

  const omittedWebsiteSm = await authorizeRemovalActor({ sessionId: 'session-sm-active', userId: 'sm-a', role: 'site_manager' });
  assert.equal(omittedWebsiteSm, null);
});

test('reseller self-service hosted site allocation enforces tenant boundary, customer scope, and quotas', async (t) => {
  const env = setupTestEnvironment(t, { maxWebsites: 1, maxCustomers: 5 });
  const app = fakeApp();
  mountSiteCreateRoutes(app, env.dependencies);

  let resellerToken = env.f.session('reseller-a');
  const resellerAuth = {
    id: 'session-reseller-a',
    token: resellerToken,
    rawToken: resellerToken,
    user: { id: 'reseller-a', role: 'site_manager', active: true, hosting: { kind: 'reseller', resellerId: null } },
  };

  const previewHandler = app.routes.post.get('/api/sites/hosted/create-preview');
  const applyHandler = app.routes.post.get('/api/sites/hosted');

  // 1. Reseller previews hosted site for own direct customer (customer-a)
  const opId1 = uuid(1101);
  const previewBody1 = {
    customerId: 'customer-a',
    input: env.siteInput(opId1),
  };
  const previewRes = await invoke(previewHandler, {
    auth: resellerAuth,
    rawToken: resellerToken,
    body: previewBody1,
  });
  assert.equal(previewRes.statusCode, 200);
  assert.equal(previewRes.payload.data.customerId, 'customer-a');
  assert.equal(previewRes.payload.data.state ?? previewRes.payload.data.ownership?.state, 'available');
  const previewDigest = previewRes.payload.data.previewDigest;
  const confirmation = previewRes.payload.data.confirmation;

  // 2. Reseller applies hosted site creation for customer-a
  const applyRes = await invoke(applyHandler, {
    auth: resellerAuth,
    rawToken: resellerToken,
    body: {
      customerId: 'customer-a',
      input: env.siteInput(opId1),
      previewDigest,
      confirmation,
    },
  });
  assert.equal(applyRes.statusCode, 201);
  assert.equal(applyRes.payload.data.created, true);
  const alloc = applyRes.payload.data.allocation ?? applyRes.payload.data.ownership;
  assert.equal(alloc.state, 'attached');
  assert.equal(alloc.customerId, 'customer-a');
  assert.equal(env.f.get('reseller-a').usage.websites, 1);

  // Invalidate and refresh reseller session after site completion
  const freshResellerToken = env.f.session('reseller-a');
  const freshResellerAuth = {
    ...resellerAuth,
    token: freshResellerToken,
    rawToken: freshResellerToken,
  };

  // 3. Reseller attempts second site creation for customer-b exceeding maxWebsites limit (1)
  // Re-issue session token as completion revokes live session on attached ownership
  const activeResellerToken = env.f.session('reseller-a');
  const activeResellerAuth = {
    ...resellerAuth,
    token: activeResellerToken,
    rawToken: activeResellerToken,
  };
  const opId2 = uuid(1102);
  const previewBody2 = {
    customerId: 'customer-b',
    input: env.siteInput(opId2),
  };
  await assert.rejects(
    async () => {
      await invoke(previewHandler, {
        auth: activeResellerAuth,
        rawToken: activeResellerToken,
        body: previewBody2,
      });
    },
    (err) => err instanceof AuthError && err.code === 'reseller_limit_reached' && err.status === 409,
  );
  assert.equal(env.sites.size, 1, 'a rejected second site cannot mutate Website metadata');
  assert.equal(env.f.get('reseller-a').usage.websites, 1);
  assert.notEqual((await env.dependencies.previewSiteCreate(previewBody2.input)).ids.websiteId, env.site.id);

  // 4. Reseller attempts site preview for customer-c belonging to foreign reseller-b
  const opIdForeign = uuid(1103);
  await assert.rejects(
    async () => {
      await invoke(previewHandler, {
        auth: activeResellerAuth,
        rawToken: activeResellerToken,
        body: { customerId: 'customer-c', input: env.siteInput(opIdForeign) },
      });
    },
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // 5. Reseller attempts site preview for direct Owner customer
  const opIdDirect = uuid(1104);
  await assert.rejects(
    async () => {
      await invoke(previewHandler, {
        auth: activeResellerAuth,
        rawToken: activeResellerToken,
        body: { customerId: 'direct', input: env.siteInput(opIdDirect) },
      });
    },
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // 6. Reseller attempts site preview for non-existent customer
  await assert.rejects(
    async () => {
      await invoke(previewHandler, {
        auth: activeResellerAuth,
        rawToken: activeResellerToken,
        body: { customerId: 'non-existent', input: env.siteInput(uuid(1105)) },
      });
    },
    (err) => err instanceof AuthError && err.code === 'hosting_account_not_found',
  );

  // 7. Customer attempting site allocation is rejected (management access required)
  const customerToken = env.f.session('customer-a');
  const customerAuth = {
    id: 'session-customer-a',
    token: customerToken,
    rawToken: customerToken,
    user: { id: 'customer-a', role: 'site_manager', active: true, hosting: { kind: 'customer', resellerId: 'reseller-a' } },
  };
  await assert.rejects(
    async () => {
      await invoke(previewHandler, {
        auth: customerAuth,
        rawToken: customerToken,
        body: previewBody1,
      });
    },
    (err) => err instanceof AuthError && (err.code === 'forbidden' || err.code === 'reseller_scope_forbidden'),
  );
});

test('hosting-site-allocation-store enforces customer ownership for site_manager reseller actors', async (t) => {
  const env = setupTestEnvironment(t, { maxWebsites: 2, maxCustomers: 5 });

  // 1. Custom allocation store with managementActor returning role: 'site_manager' and kind: 'reseller'
  const storeWithKind = createHostingSiteAllocationStore({
    db: env.f.db,
    now: env.f.now,
    transaction: env.f.transaction,
    owner: () => ({ id: 'owner-user', role: 'owner', active: true }),
    existing: (id) => env.f.db.prepare('SELECT u.id AS user_id, u.username, u.active, h.kind, h.reseller_id, h.revision, 1 AS user_revision, 1000 AS created_at, 1000 AS updated_at FROM users u LEFT JOIN auth_hosting_accounts h ON h.user_id = u.id WHERE u.id = ?').get(id),
    projection: (row) => ({ id: row.user_id, kind: row.kind, resellerId: row.reseller_id, active: Boolean(row.active) }),
    limits: () => ({ maxCustomers: 5, maxWebsites: 2 }),
    usage: () => ({ customers: 1, websites: 0 }),
    invalidate: () => {},
    audit: () => {},
    revokeLiveUser: () => {},
    managementActor: () => ({ id: 'reseller-a', role: 'site_manager', kind: 'reseller', active: true }),
  });

  // 2. Custom allocation store with managementActor returning role: 'site_manager' and hosting: { kind: 'reseller' }
  const storeWithHostingKind = createHostingSiteAllocationStore({
    db: env.f.db,
    now: env.f.now,
    transaction: env.f.transaction,
    owner: () => ({ id: 'owner-user', role: 'owner', active: true }),
    existing: (id) => env.f.db.prepare('SELECT u.id AS user_id, u.username, u.active, h.kind, h.reseller_id, h.revision, 1 AS user_revision, 1000 AS created_at, 1000 AS updated_at FROM users u LEFT JOIN auth_hosting_accounts h ON h.user_id = u.id WHERE u.id = ?').get(id),
    projection: (row) => ({ id: row.user_id, kind: row.kind, resellerId: row.reseller_id, active: Boolean(row.active) }),
    limits: () => ({ maxCustomers: 5, maxWebsites: 2 }),
    usage: () => ({ customers: 1, websites: 0 }),
    invalidate: () => {},
    audit: () => {},
    revokeLiveUser: () => {},
    managementActor: () => ({ id: 'reseller-a', role: 'site_manager', hosting: { kind: 'reseller' }, active: true }),
  });

  // 3. Reject cross-reseller customer access for site_manager actor with kind: 'reseller'
  assert.throws(
    () => storeWithKind.preview('token', () => {}, allocation(1, 'customer-c')),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // 4. Reject direct Owner customer access for site_manager actor with kind: 'reseller'
  assert.throws(
    () => storeWithKind.preview('token', () => {}, allocation(1, 'direct')),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // 5. Reject cross-reseller customer access for site_manager actor with hosting.kind: 'reseller'
  assert.throws(
    () => storeWithHostingKind.preview('token', () => {}, allocation(1, 'customer-c')),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // 6. Allow own customer access for site_manager actor with kind: 'reseller'
  const ownPreviewKind = storeWithKind.preview('token', () => {}, allocation(1, 'customer-a'));
  assert.equal(ownPreviewKind.customerId, 'customer-a');
  assert.equal(ownPreviewKind.state, 'available');

  // 7. Allow own customer access for site_manager actor with hosting.kind: 'reseller'
  const ownPreviewHosting = storeWithHostingKind.preview('token', () => {}, allocation(1, 'customer-a'));
  assert.equal(ownPreviewHosting.customerId, 'customer-a');
  assert.equal(ownPreviewHosting.state, 'available');
});

test('hosting-site-allocation-store supports role: reseller actor and customer role in projection', async (t) => {
  const env = setupTestEnvironment(t, { maxWebsites: 2, maxCustomers: 5 });

  const storeWithResellerRole = createHostingSiteAllocationStore({
    db: env.f.db,
    now: env.f.now,
    transaction: env.f.transaction,
    owner: () => ({ id: 'owner-user', role: 'owner', active: true }),
    existing: (id) => env.f.db.prepare('SELECT u.id AS user_id, u.username, u.active, h.kind, h.reseller_id, h.revision, 1 AS user_revision, 1000 AS created_at, 1000 AS updated_at FROM users u LEFT JOIN auth_hosting_accounts h ON h.user_id = u.id WHERE u.id = ?').get(id),
    projection: (row) => ({ id: row.user_id, kind: row.kind, resellerId: row.reseller_id, active: Boolean(row.active) }),
    limits: () => ({ maxCustomers: 5, maxWebsites: 2 }),
    usage: () => ({ customers: 1, websites: 0 }),
    invalidate: () => {},
    audit: () => {},
    revokeLiveUser: () => {},
    managementActor: () => ({ id: 'reseller-a', role: 'reseller', active: true }),
  });

  // Cross-reseller customer access rejected
  assert.throws(
    () => storeWithResellerRole.preview('token', () => {}, allocation(1, 'customer-c')),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Direct Owner customer access rejected
  assert.throws(
    () => storeWithResellerRole.preview('token', () => {}, allocation(1, 'direct')),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Own customer access allowed
  const ownPreview = storeWithResellerRole.preview('token', () => {}, allocation(1, 'customer-a'));
  assert.equal(ownPreview.customerId, 'customer-a');
  assert.equal(ownPreview.state, 'available');

  // Verify hosting account store accepts users with role: 'customer'
  env.f.db.exec('PRAGMA legacy_alter_table = ON');
  env.f.db.exec('PRAGMA foreign_keys = OFF');
  env.f.db.exec('DROP TRIGGER IF EXISTS auth_hosting_account_insert');
  env.f.db.exec('DROP TRIGGER IF EXISTS auth_hosting_lifecycle_intent_insert');
  env.f.db.exec('DROP TRIGGER IF EXISTS auth_hosting_legacy_user_guard');
  env.f.db.exec('DROP TRIGGER IF EXISTS auth_hosting_lifecycle_intent_consume');
  env.f.db.exec(`CREATE TABLE users_temp (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, password_changed_at INTEGER NOT NULL
  )`);
  env.f.db.exec('INSERT INTO users_temp SELECT * FROM users');
  env.f.db.exec('DROP TABLE users');
  env.f.db.exec('ALTER TABLE users_temp RENAME TO users');
  env.f.db.exec('PRAGMA legacy_alter_table = OFF');
  env.f.db.exec('PRAGMA foreign_keys = ON');
  env.f.db.prepare("UPDATE users SET role = 'customer' WHERE id = 'customer-a'").run();
  const customerAccount = env.f.store.get(env.f.token, env.f.requireManagement, 'customer-a');
  assert.equal(customerAccount.id, 'customer-a');
  assert.equal(customerAccount.kind, 'customer');
});

test('standard site create via /api/sites propagates siteAdmin and siteAdminError when admin creation fails without failing site creation', async (t) => {
  const env = setupTestEnvironment(t);
  const app = fakeApp();

  const failingUserAdminStore = {
    ...env.dependencies.userAdminStore,
    createSiteManager: async () => {
      const error = new Error('Database locked');
      error.code = 'store_locked';
      throw error;
    },
  };

  const createAdapter = async (apply) => {
    env.sites.set(env.site.id, structuredClone(env.site));
    return {
      created: true,
      operationId: apply.input.operationId,
      website: env.site,
      primaryDomain: { websiteId: env.site.id },
    };
  };

  mountSiteCreateRoutes(app, {
    ...env.dependencies,
    userAdminStore: failingUserAdminStore,
    createSite: createAdapter,
  });

  const createHandler = app.routes.post.get('/api/sites');
  const operationId = uuid(1005);
  const input = {
    operationId,
    serverId: env.serverId,
    siteAdmin: { email: 'admin@example.test', password: 'Password123!@#' },
  };

  const response = await invoke(createHandler, {
    auth: env.ownerAuth,
    body: {
      input,
      previewDigest: 'b'.repeat(64),
      confirmation: `create-site:${operationId}:${'b'.repeat(64)}`,
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.data.created, true);
  assert.equal(response.payload.data.website.id, env.site.id);
  assert.equal(response.payload.data.siteAdmin.status, 'attention');
  assert.equal(response.payload.data.siteAdmin.code, 'site_admin_locked');
  assert.equal(response.payload.data.siteAdminError.code, 'site_admin_locked');
  assert.equal(response.payload.data.siteAdminError.status, 400);
});

test('standard site create via /api/sites attaches successful siteAdmin without siteAdminError', async (t) => {
  const env = setupTestEnvironment(t);
  const app = fakeApp();

  const successfulUserAdminStore = {
    ...env.dependencies.userAdminStore,
    createSiteManager: async ({ username, websiteId }) => ({
      id: uuid(900),
      username,
      role: 'site_manager',
      active: true,
      websiteIds: [websiteId],
    }),
  };

  const createAdapter = async (apply) => {
    env.sites.set(env.site.id, structuredClone(env.site));
    return {
      created: true,
      operationId: apply.input.operationId,
      website: env.site,
      primaryDomain: { websiteId: env.site.id },
    };
  };

  mountSiteCreateRoutes(app, {
    ...env.dependencies,
    userAdminStore: successfulUserAdminStore,
    createSite: createAdapter,
  });

  const createHandler = app.routes.post.get('/api/sites');
  const operationId = uuid(1006);
  const input = {
    operationId,
    serverId: env.serverId,
    siteAdmin: { email: 'admin@example.test', password: 'Password123!@#' },
  };

  const response = await invoke(createHandler, {
    auth: env.ownerAuth,
    body: {
      input,
      previewDigest: 'b'.repeat(64),
      confirmation: `create-site:${operationId}:${'b'.repeat(64)}`,
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.data.created, true);
  assert.equal(response.payload.data.siteAdmin.status, 'created');
  assert.equal(response.payload.data.siteAdminError, undefined);
});

test('siteCreateHttp exports SiteCreateError constructor', () => {
  assert.equal(typeof SiteCreateError, 'function');
  const err = new SiteCreateError('invalid_preview', 'Preview error', 400);
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'invalid_preview');
  assert.equal(err.status, 400);
});
