import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  NON_RESELLER_INVENTORY,
  TASK_GROUPS,
  FORBIDDEN_BRANDING_KEYS,
  assertNoResellerBrandingPollution,
  assertTenantBoundaryForCapability,
  getCapabilityById,
  listCapabilities,
  ResellerBrandingDeferredError,
  CapabilityRegistryError,
  mountNonResellerCapabilitiesRoutes,
} from '../src/non-reseller-capabilities.js';
import { TenantBoundaryError } from '../src/tenant-boundary.js';

test('PAR-04 Acceptance 1 & 2: Established inventory IDs completeness and source inspection across all domains', () => {
  const inventory = NON_RESELLER_INVENTORY;
  assert.ok(inventory && typeof inventory === 'object', 'Inventory catalog must exist');

  // Verify core domains are represented with established inventory IDs
  const domains = ['dns', 'mail', 'database', 'runtime', 'docker', 'git', 'wordpress', 'backup', 'security', 'api', 'migration', 'monitoring', 'extensions'];
  for (const domain of domains) {
    const items = listCapabilities({ category: domain });
    assert.ok(items.length > 0, `Domain '${domain}' must contain capabilities with established inventory IDs`);
  }

  // 1. DNS capabilities: DNS-01 .. DNS-06
  for (let i = 1; i <= 6; i++) {
    const id = `DNS-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'dns');
    assert.equal(cap.reimplementationPrevented, true);
    assert.ok(cap.groupCrossConnects.length > 0);
  }

  // 2. Mail capabilities: EML-01 .. EML-11
  for (let i = 1; i <= 11; i++) {
    const id = `EML-${String(i).padStart(2, '0')}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'mail');
    assert.equal(cap.reimplementationPrevented, true);
  }

  // 3. Database capabilities: DB-01 .. DB-09
  for (let i = 1; i <= 9; i++) {
    const id = `DB-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'database');
    assert.equal(cap.reimplementationPrevented, true);
  }

  // 4. Runtime capabilities: RUN-01 .. RUN-08
  for (let i = 1; i <= 8; i++) {
    const id = `RUN-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'runtime');
    assert.equal(cap.reimplementationPrevented, true);
  }

  // 5. Docker capabilities: DKR-01 .. DKR-06
  for (let i = 1; i <= 6; i++) {
    const id = `DKR-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'docker');
    assert.equal(cap.reimplementationPrevented, true);
  }

  // 6. Git capabilities: DEV-01 .. DEV-06
  for (let i = 1; i <= 6; i++) {
    const id = `DEV-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'git');
    assert.equal(cap.reimplementationPrevented, true);
  }

  // 7. WordPress capabilities: WP-01 .. WP-07
  for (let i = 1; i <= 7; i++) {
    const id = `WP-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'wordpress');
    assert.equal(cap.reimplementationPrevented, true);
  }

  // 8. Backup capabilities: BAK-01 .. BAK-08
  for (let i = 1; i <= 8; i++) {
    const id = `BAK-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'backup');
    assert.equal(cap.reimplementationPrevented, true);
  }

  // 9. Security & System capabilities: SEC-01 .. SEC-04, SYS-01 .. SYS-06
  for (let i = 1; i <= 4; i++) {
    const id = `SEC-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'security');
    assert.equal(cap.reimplementationPrevented, true);
  }
  for (let i = 1; i <= 6; i++) {
    const id = `SYS-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'security');
    assert.equal(cap.reimplementationPrevented, true);
  }

  // 10. API & CLI capabilities: API-01 .. API-07
  for (let i = 1; i <= 7; i++) {
    const id = `API-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'api');
  }

  // 11. Migration capabilities: MIG-01 .. MIG-06
  for (let i = 1; i <= 6; i++) {
    const id = `MIG-0${i}`;
    const cap = getCapabilityById(id);
    assert.ok(cap, `Capability ${id} must exist in inventory`);
    assert.equal(cap.category, 'migration');
  }

  // Verify that all completed and partial capabilities point to real, existing source files
  const cwd = process.cwd();
  for (const cap of Object.values(inventory)) {
    if (cap.status === 'completed' || cap.status === 'partial') {
      assert.ok(cap.sourceModules.length > 0, `Capability ${cap.id} must declare sourceModules`);
      for (const mod of cap.sourceModules) {
        // Resolve relative to repo root or apps/api
        const candidates = [
          path.resolve(cwd, mod),
          path.resolve(cwd, '../../', mod),
          path.resolve(cwd, mod.replace(/^apps\/api\//, '')),
        ];
        const exists = candidates.some((p) => fs.existsSync(p));
        assert.ok(exists, `Source module '${mod}' for capability ${cap.id} must exist on disk`);
      }
    }
  }
});

test('PAR-04 Acceptance 3: Cross-connection to groups B-E without duplicating work', () => {
  // Cross-connections to task groups B, C, D, E
  const allCaps = Object.values(NON_RESELLER_INVENTORY);

  const groupBCaps = allCaps.filter((c) => c.groupCrossConnects.includes(TASK_GROUPS.GROUP_B));
  const groupCCaps = allCaps.filter((c) => c.groupCrossConnects.includes(TASK_GROUPS.GROUP_C));
  const groupDCaps = allCaps.filter((c) => c.groupCrossConnects.includes(TASK_GROUPS.GROUP_D));
  const groupECaps = allCaps.filter((c) => c.groupCrossConnects.includes(TASK_GROUPS.GROUP_E));

  assert.ok(groupBCaps.length >= 20, 'Group B (Plesk UX / Navigation) must cross-connect to at least 20 capabilities');
  assert.ok(groupCCaps.length >= 35, 'Group C (Security & Integrity) must cross-connect to at least 35 capabilities');
  assert.ok(groupDCaps.length >= 40, 'Group D (Feature Depth) must cross-connect to at least 40 capabilities');
  assert.ok(groupECaps.length >= 8, 'Group E (Staging & Live Evidence) must cross-connect to key staging capabilities');

  // Verify non-duplication rule: all items have reimplementationPrevented: true
  for (const c of allCaps) {
    assert.equal(c.reimplementationPrevented, true, `Capability ${c.id} must enforce non-duplication`);
  }

  // Filtering by group returns correct subset
  const filteredB = listCapabilities({ group: 'B' });
  assert.equal(filteredB.length, groupBCaps.length);
  for (const item of filteredB) {
    assert.ok(item.groupCrossConnects.includes('B'));
  }
});

test('PAR-04 Acceptance 4: Reseller branding remains deferred to next phase fail-closed', () => {
  // Clean payload passes
  const cleanPayload = {
    username: 'test-reseller',
    limits: { maxCustomers: 5, maxWebsites: 10 },
    quotas: { maxWebsites: 2, maxDiskMb: 1024 },
  };
  assert.doesNotThrow(() => assertNoResellerBrandingPollution(cleanPayload));

  // Premature branding keys are rejected fail-closed
  for (const key of FORBIDDEN_BRANDING_KEYS) {
    const dirtyPayload = {
      username: 'branding-violator',
      [key]: 'custom-branding-value',
    };
    assert.throws(
      () => assertNoResellerBrandingPollution(dirtyPayload),
      (err) => {
        assert.ok(err instanceof ResellerBrandingDeferredError);
        assert.equal(err.code, 'reseller_branding_deferred');
        assert.equal(err.status, 403);
        assert.ok(err.message.includes('deferred to the next phase'));
        return true;
      },
      `Key '${key}' must be rejected as deferred branding`
    );
  }

  // Nested branding pollution is detected and rejected
  const nestedDirty = {
    account: {
      profile: {
        customLogo: 'https://example.com/logo.png',
      },
    },
  };
  assert.throws(
    () => assertNoResellerBrandingPollution(nestedDirty),
    (err) => {
      assert.ok(err instanceof ResellerBrandingDeferredError);
      assert.equal(err.code, 'reseller_branding_deferred');
      return true;
    }
  );
});

test('PAR-04 Acceptance 5: Tenant boundaries and role enforcement fail-closed across Owner, Reseller, Customer, Website', () => {
  const ownerActor = { id: 'owner-1', role: 'owner', active: true };
  const resellerActor = { id: 'reseller-1', role: 'reseller', active: true, websiteIds: ['site-1', 'site-2'] };
  const customerActor = { id: 'cust-1', role: 'customer', active: true, websiteIds: ['site-1'] };
  const legacySiteManager = { id: 'sm-1', role: 'site_manager', active: true, websiteIds: ['site-1'] };
  const readOnlyActor = { id: 'ro-1', role: 'read_only', active: true };
  const inactiveActor = { id: 'owner-inactive', role: 'owner', active: false };

  // Inactive actor fails closed for any capability
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: inactiveActor, capabilityId: 'DNS-01' }),
    (err) => {
      assert.ok(err instanceof TenantBoundaryError);
      assert.equal(err.code, 'tenant_actor_inactive');
      assert.equal(err.status, 403);
      return true;
    }
  );

  // Non-existent capability throws 404
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: ownerActor, capabilityId: 'UNKNOWN-99' }),
    (err) => {
      assert.ok(err instanceof CapabilityRegistryError);
      assert.equal(err.code, 'capability_not_found');
      assert.equal(err.status, 404);
      return true;
    }
  );

  // 1. Owner has global access to owner-only, management-scoped, and site-scoped capabilities
  const ownerSec = assertTenantBoundaryForCapability({ actor: ownerActor, capabilityId: 'SEC-01' });
  assert.equal(ownerSec.authorized, true);
  assert.equal(ownerSec.role, 'owner');

  const ownerDns = assertTenantBoundaryForCapability({ actor: ownerActor, capabilityId: 'DNS-01' });
  assert.equal(ownerDns.authorized, true);

  // 2. Reseller cannot access owner-only capabilities (SEC-01, SYS-02, DKR-02, MIG-01)
  const ownerOnlyCaps = ['SEC-01', 'SEC-02', 'SYS-02', 'SYS-04', 'SYS-05', 'DKR-02', 'DKR-05', 'MIG-01'];
  for (const capId of ownerOnlyCaps) {
    assert.throws(
      () => assertTenantBoundaryForCapability({ actor: resellerActor, capabilityId: capId }),
      (err) => {
        assert.ok(err instanceof TenantBoundaryError);
        assert.equal(err.code, 'tenant_boundary_forbidden');
        assert.equal(err.status, 403);
        return true;
      },
      `Reseller must be blocked from owner-only capability ${capId}`
    );
  }

  // Reseller can access site-scoped capabilities within their assigned sites
  const resDns = assertTenantBoundaryForCapability({ actor: resellerActor, capabilityId: 'DNS-01', targetSiteId: 'site-1' });
  assert.equal(resDns.authorized, true);

  // Reseller accessing foreign site is blocked
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: resellerActor, capabilityId: 'DNS-01', targetSiteId: 'foreign-site' }),
    (err) => {
      assert.ok(err instanceof TenantBoundaryError);
      assert.equal(err.code, 'tenant_boundary_forbidden');
      return true;
    }
  );

  // 3. Customer cannot access owner-only or management-scoped capabilities
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: customerActor, capabilityId: 'SEC-01' }),
    (err) => {
      assert.ok(err instanceof TenantBoundaryError);
      assert.equal(err.code, 'tenant_boundary_forbidden');
      return true;
    }
  );
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: customerActor, capabilityId: 'DNS-02' }), // management_scoped
    (err) => {
      assert.ok(err instanceof TenantBoundaryError);
      assert.equal(err.code, 'tenant_boundary_forbidden');
      return true;
    }
  );

  // Customer can access site-scoped capability on assigned site
  const custDns = assertTenantBoundaryForCapability({ actor: customerActor, capabilityId: 'DNS-01', targetSiteId: 'site-1' });
  assert.equal(custDns.authorized, true);

  // Customer accessing unassigned site fails closed with site_scope_forbidden
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: customerActor, capabilityId: 'DNS-01', targetSiteId: 'site-2' }),
    (err) => {
      assert.ok(err instanceof TenantBoundaryError);
      assert.equal(err.code, 'site_scope_forbidden');
      return true;
    }
  );

  // Customer accessing foreign customer ID fails closed
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: customerActor, capabilityId: 'DNS-01', targetCustomerId: 'cust-foreign' }),
    (err) => {
      assert.ok(err instanceof TenantBoundaryError);
      assert.equal(err.code, 'tenant_boundary_forbidden');
      return true;
    }
  );

  // 4. Legacy site manager works within site scope
  const smDns = assertTenantBoundaryForCapability({ actor: legacySiteManager, capabilityId: 'DNS-01', targetSiteId: 'site-1' });
  assert.equal(smDns.authorized, true);

  // 5. Read-only role is restricted to read-only capabilities (API-01, EKL-07)
  const roApi = assertTenantBoundaryForCapability({ actor: readOnlyActor, capabilityId: 'API-01' });
  assert.equal(roApi.authorized, true);
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: readOnlyActor, capabilityId: 'DNS-01' }),
    (err) => {
      assert.ok(err instanceof TenantBoundaryError);
      assert.equal(err.code, 'tenant_boundary_forbidden');
      return true;
    }
  );
});

test('PAR-04 Acceptance 5 & 6: HTTP routes role enforcement and capability queries', async () => {
  const routes = [];
  const mockApp = {
    get: (path, ...handlers) => routes.push({ method: 'GET', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'POST', path, handlers }),
  };

  mountNonResellerCapabilitiesRoutes(mockApp);

  const callRoute = async (method, path, user, body = {}) => {
    let statusCode = 200;
    let responseBody = null;
    const req = {
      method,
      url: path,
      originalUrl: path,
      params: {},
      query: {},
      auth: user ? {
        user,
        access: { mode: user.role === 'owner' ? 'management' : 'site_management', permissions: ['*'] },
        security: { managementAllowed: true },
      } : null,
      body,
    };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() { return this; },
      json(b) { responseBody = b; return this; },
    };

    const basePath = path.split('?')[0];
    const queryString = path.split('?')[1];
    if (queryString) {
      req.query = Object.fromEntries(new URLSearchParams(queryString));
    }

    let matchedRoute = routes.find((r) => r.method === method && r.path === basePath);
    if (!matchedRoute) {
      const singleMatch = basePath.match(/^\/api\/system\/capabilities\/([^/?]+)$/);
      if (singleMatch) {
        req.params.id = singleMatch[1];
        matchedRoute = routes.find((r) => r.method === method && r.path === '/api/system/capabilities/:id');
      }
    }

    if (!matchedRoute) throw new Error(`Route not found: ${method} ${path}`);

    let idx = 0;
    const next = async (err) => {
      if (err) {
        statusCode = err.status || 500;
        responseBody = { error: { code: err.code, message: err.message } };
        return;
      }
      idx++;
      if (idx < matchedRoute.handlers.length) {
        await matchedRoute.handlers[idx](req, res, next);
      }
    };
    await matchedRoute.handlers[0](req, res, next);
    return { statusCode, responseBody };
  };

  // 1. Unauthenticated request returns 401
  const unauth = await callRoute('GET', '/api/system/capabilities', null);
  assert.equal(unauth.statusCode, 401);

  // 2. Inactive user returns 403
  const inactive = await callRoute('GET', '/api/system/capabilities', { id: 'u1', role: 'owner', active: false });
  assert.equal(inactive.statusCode, 403);
  assert.equal(inactive.responseBody.error.code, 'tenant_actor_inactive');

  // 3. Owner gets all capabilities
  const owner = await callRoute('GET', '/api/system/capabilities', { id: 'owner-1', role: 'owner', active: true });
  assert.equal(owner.statusCode, 200);
  assert.ok(owner.responseBody.data.total >= 60);
  assert.equal(owner.responseBody.data.resellerBrandingStatus, 'deferred_to_next_phase');

  // 4. Customer gets only customer-accessible capabilities
  const customer = await callRoute('GET', '/api/system/capabilities', { id: 'cust-1', role: 'customer', active: true });
  assert.equal(customer.statusCode, 200);
  assert.ok(customer.responseBody.data.total < owner.responseBody.data.total);
  // Ensure no owner-only capability leaked to customer list
  for (const cap of customer.responseBody.data.capabilities) {
    assert.notEqual(cap.scopeLevel, 'owner_only');
    assert.ok(cap.rolesAllowed.includes('customer'));
  }

  // 5. Query filter by category works
  const dnsOnly = await callRoute('GET', '/api/system/capabilities?category=dns', { id: 'owner-1', role: 'owner', active: true });
  assert.equal(dnsOnly.statusCode, 200);
  assert.equal(dnsOnly.responseBody.data.capabilities.length, 6);
  for (const c of dnsOnly.responseBody.data.capabilities) {
    assert.equal(c.category, 'dns');
  }

  // 6. Single capability lookup
  const singleDns = await callRoute('GET', '/api/system/capabilities/DNS-01', { id: 'owner-1', role: 'owner', active: true });
  assert.equal(singleDns.statusCode, 200);
  assert.equal(singleDns.responseBody.data.id, 'DNS-01');

  // 7. Non-existent capability lookup returns 404
  const notFound = await callRoute('GET', '/api/system/capabilities/XYZ-99', { id: 'owner-1', role: 'owner', active: true });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.responseBody.error.code, 'capability_not_found');

  // 8. Invalid ID format returns 400
  const invalidId = await callRoute('GET', '/api/system/capabilities/invalid--id', { id: 'owner-1', role: 'owner', active: true });
  assert.equal(invalidId.statusCode, 400);
  assert.equal(invalidId.responseBody.error.code, 'invalid_capability_id');

  // 9. Customer accessing Owner-only single capability returns 403 fail-closed
  const custForbidden = await callRoute('GET', '/api/system/capabilities/SEC-01', { id: 'cust-1', role: 'customer', active: true });
  assert.equal(custForbidden.statusCode, 403);
  assert.equal(custForbidden.responseBody.error.code, 'tenant_boundary_forbidden');

  // 10. Branding validation endpoint
  const cleanValidation = await callRoute('POST', '/api/system/capabilities/validate-branding', { id: 'reseller-1', role: 'reseller', active: true }, {
    planName: 'standard-hosting',
    maxWebsites: 5,
  });
  assert.equal(cleanValidation.statusCode, 200);
  assert.equal(cleanValidation.responseBody.data.valid, true);
  assert.equal(cleanValidation.responseBody.data.brandingDeferred, true);

  const dirtyValidation = await callRoute('POST', '/api/system/capabilities/validate-branding', { id: 'reseller-1', role: 'reseller', active: true }, {
    whiteLabel: true,
    customLogo: 'https://logo.test/image.png',
  });
  assert.equal(dirtyValidation.statusCode, 403);
  assert.equal(dirtyValidation.responseBody.error.code, 'reseller_branding_deferred');
});
