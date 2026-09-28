import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import {
  mountSiteCreateRoutes,
  SiteCreateError,
  siteCreateHttpInternals,
} from '../src/site-create-http.js';
import { siteFixture, website, uuid } from '../test-support/hosting-site-fixture.js';
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

  const basePlan = (operationId = uuid(1001)) => ({
    operationId,
    ids: {
      websiteId: site.id,
      applicationId: site.applicationId,
      primaryDomainId: uuid(2),
      wwwDomainId: null,
      mailDomainId: null,
    },
    previewDigest: 'b'.repeat(64),
    confirmation: 'original-confirmation',
    blockers: [],
    steps: { websiteReady: sites.has(site.id) },
    source: { kind: 'external_proxy' },
    plan: { website: site, application: null },
  });

  const previewAdapter = async (input) => basePlan(input.operationId);
  const createAdapter = async (apply) => {
    sites.set(site.id, structuredClone(site));
    return { created: true, website: site };
  };

  const siteMutationLock = {
    withSiteLock: async (identity, action) => {
      lockCalls.push(structuredClone(identity));
      return action();
    },
  };

  const websiteRegistry = {
    getWebsite: async (id) => sites.get(id) ?? null,
  };
  const applicationRegistry = {
    getApplication: async (id) => applications.get(id) ?? null,
  };
  const domainRegistry = {
    getDomain: async (id) => domains.get(id) ?? null,
  };
  const mailDomainRegistry = {
    getMailDomain: async (id) => mailDomains.get(id) ?? null,
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

  const dependencies = {
    localServerId: serverId,
    siteMutationLock,
    websiteRegistry,
    applicationRegistry,
    domainRegistry,
    mailDomainRegistry,
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
    input: { operationId: uuid(1001), serverId: env.serverId },
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
      input: { operationId: uuid(1001), serverId: env.serverId },
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
      input: { operationId: uuid(1001), serverId: env.serverId },
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
      input: { operationId: uuid(1001), serverId: env.serverId },
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
      input: { operationId: uuid(1002), serverId: env.serverId },
    },
  });
  const preview = previewRes.payload.data;

  // 2. Reserve quota directly
  env.f.reserve({
    operationId: uuid(1002),
    websiteId: env.site.id,
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
      input: { operationId: uuid(1002), serverId: env.serverId },
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

  // Deactivate customer-a in SQLite DB
  env.f.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run('customer-a');

  const previewHandler = app.routes.post.get('/api/sites/hosted/create-preview');
  await assert.rejects(
    invoke(previewHandler, {
      auth: env.ownerAuth,
      rawToken: env.ownerAuth.rawToken,
      body: {
        customerId: 'customer-a',
        input: { operationId: uuid(1003), serverId: env.serverId },
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
    (error) => error.code === 'invalid_hosting_site_request' && error.status === 400,
  );

  // Stale preview on create
  const createHandler = app.routes.post.get('/api/sites/hosted');
  await assert.rejects(
    invoke(createHandler, {
      auth: env.ownerAuth,
      rawToken: env.ownerAuth.rawToken,
      body: {
        customerId: 'customer-a',
        input: { operationId: uuid(1004), serverId: env.serverId },
        previewDigest: '0'.repeat(64),
        confirmation: 'invalid-confirmation',
      },
    }),
    (error) => (error.code === 'hosting_site_preview_stale' || error.code === 'site_create_confirmation_required'),
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
    websiteDigest: 'e'.repeat(64),
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
