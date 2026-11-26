import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import express from 'express';
import {
  OS_EQUIVALENCE_INVENTORY,
  EXTERNAL_PARITY_INVENTORY,
  FORBIDDEN_BILLING_KEYS,
  assertNoResellerBillingPollution,
  assertResellerBillingDeferred,
  assertPreserveLinuxTenantIsolation,
  ResellerBillingDeferredError,
  LinuxIsolationViolationError,
  listOsEquivalenceAdapters,
  listExternalParityAdapters,
  listDeferredBillingItems,
  mountOsExternalParityRoutes,
} from '../src/os-external-parity.js';
import { TenantBoundaryError } from '../src/tenant-boundary.js';

// ============================================================================
// 1. OS EQUIVALENCE BOUNDARIES & ADAPTER CONTRACTS (WIN-01 .. WIN-06)
// ============================================================================

test('PAR-05 Acceptance 1 & 2: Windows OS equivalence lines fail-closed and enforce strict separation from Ubuntu', async () => {
  const osLines = listOsEquivalenceAdapters();
  assert.equal(osLines.length, 6, 'Must contain exactly 6 Windows OS equivalence lines');

  const expectedIds = ['WIN-01', 'WIN-02', 'WIN-03', 'WIN-04', 'WIN-05', 'WIN-06'];
  for (const id of expectedIds) {
    const line = OS_EQUIVALENCE_INVENTORY[id];
    assert.ok(line, `OS line ${id} must exist in inventory`);
    assert.equal(line.status, 'separate_track_fail_closed');
    assert.equal(line.primaryOs, 'ubuntu_linux');
    assert.equal(line.ubuntuEquivalenceClaimed, false, 'Ubuntu code must not be claimed as Windows equivalent');
    assert.equal(line.linuxIsolationPreserved, true);
    assert.ok(line.methods.length > 0);
  }
});

// ============================================================================
// 2. LINUX TENANT ISOLATION PRESERVATION
// ============================================================================

test('PAR-05 Acceptance 2: Linux tenant isolation is preserved without weakening Unix UID/GID boundaries', () => {
  const inactiveActor = { user: { id: 'user-inactive', role: 'owner', active: false } };
  assert.throws(
    () => assertPreserveLinuxTenantIsolation({ actor: inactiveActor }),
    (err) => err instanceof TenantBoundaryError && err.code === 'tenant_actor_inactive',
  );

  const ownerActor = { user: { id: 'owner-1', role: 'owner', active: true } };
  const ownerResult = assertPreserveLinuxTenantIsolation({ actor: ownerActor, siteId: 'any-site' });
  assert.equal(ownerResult.authorized, true);
  assert.equal(ownerResult.preserved, true);

  const resellerActor = {
    user: {
      id: 'reseller-1',
      role: 'reseller',
      active: true,
      websiteIds: ['site-r1', 'site-r2'],
      hosting: { kind: 'reseller', resellerId: 'reseller-1', websiteIds: ['site-r1', 'site-r2'] },
    },
  };
  // Reseller accessing owned site succeeds
  const resSuccess = assertPreserveLinuxTenantIsolation({ actor: resellerActor, siteId: 'site-r1' });
  assert.equal(resSuccess.authorized, true);
  // Reseller attempting cross-tenant access to foreign site fails closed
  assert.throws(
    () => assertPreserveLinuxTenantIsolation({ actor: resellerActor, siteId: 'foreign-site' }),
    (err) => err instanceof LinuxIsolationViolationError && err.status === 403,
  );

  const customerActor = {
    user: {
      id: 'customer-1',
      role: 'customer',
      active: true,
      websiteIds: ['site-c1'],
      hosting: { kind: 'customer', customerId: 'customer-1', resellerId: 'reseller-1', websiteIds: ['site-c1'] },
    },
  };
  // Customer accessing owned site succeeds
  const custSuccess = assertPreserveLinuxTenantIsolation({ actor: customerActor, siteId: 'site-c1' });
  assert.equal(custSuccess.authorized, true);
  // Customer attempting access to foreign customer or unassigned site fails closed
  assert.throws(
    () => assertPreserveLinuxTenantIsolation({ actor: customerActor, siteId: 'site-foreign' }),
    (err) => err instanceof LinuxIsolationViolationError && err.status === 403,
  );
  assert.throws(
    () => assertPreserveLinuxTenantIsolation({ actor: customerActor, targetCustomerId: 'other-customer' }),
    (err) => err instanceof LinuxIsolationViolationError && err.status === 403,
  );
});

// ============================================================================
// 3. EXTERNAL LIFECYCLE CONTRACTS (CERT, BUILDER, SEC, BAK, TOOLKIT, REG)
// ============================================================================

test('PAR-05 Acceptance 3: External lifecycle lines are listed as unconfigured and fail closed', () => {
  const externalLines = listExternalParityAdapters();
  assert.deepEqual(
    externalLines.map((line) => line.id),
    ['EXT-CERT-01', 'EXT-BUILD-01', 'EXT-SEC-01', 'EXT-BAK-01', 'EXT-TOOL-01', 'EXT-REG-01'],
  );
  for (const line of externalLines) {
    assert.equal(line.status, 'external_unconfigured_fail_closed');
    assert.equal(typeof line.category, 'string');
    assert.ok(line.methods.length > 0);
  }
});

// ============================================================================
// 4. RESELLER BILLING & SUBSCRIPTION AUTOMATION DEFERRAL
// ============================================================================

test('PAR-05 Acceptance 4: Reseller billing and subscription automation remains explicitly deferred to post-MVP', () => {
  const deferredItems = listDeferredBillingItems();
  assert.equal(deferredItems.length, 5, 'Must catalog all 5 deferred billing and subscription automation lines');

  for (const item of deferredItems) {
    assert.equal(item.status, 'post_mvp_deferred');
    assert.equal(item.isMvpBlocker, false, 'Must not be treated as an MVP blocker');
  }

  // Reject all forbidden billing keys with ResellerBillingDeferredError (403)
  for (const forbiddenKey of FORBIDDEN_BILLING_KEYS) {
    assert.throws(
      () => assertNoResellerBillingPollution({ [forbiddenKey]: true }),
      (err) => err instanceof ResellerBillingDeferredError && err.status === 403,
      `Should throw ResellerBillingDeferredError for forbidden key ${forbiddenKey}`,
    );
  }

  // Reject nested billing keys
  assert.throws(
    () => assertNoResellerBillingPollution({
      tenant: { config: { automatedInvoicing: { enabled: true, schedule: 'monthly' } } },
    }),
    (err) => err instanceof ResellerBillingDeferredError && err.status === 403,
  );

  // Clean payload passes without error
  assert.doesNotThrow(() => {
    assertNoResellerBillingPollution({ maxWebsites: 10, maxDiskMb: 5000, company: 'Yunsoft' });
  });

  // assertResellerBillingDeferred always throws
  assert.throws(
    () => assertResellerBillingDeferred('generateRecurringInvoices'),
    (err) => err instanceof ResellerBillingDeferredError && err.status === 403,
  );
});

// ============================================================================
// 5. EXPRESS HTTP ROUTE INTEGRATION ON REAL HTTP LISTENER
// ============================================================================

test('PAR-05 Acceptance 5: Express routes enforce authentication, tenant role filtering, and fail-closed parity execution', async (t) => {
  const app = express();
  app.use(express.json());

  let currentAuth = null;
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });

  mountOsExternalParityRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const request = async (method, path, body = null) => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode, body: data });
            }
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  };

  // 1. Unauthenticated requests are rejected with 401
  currentAuth = null;
  const unauthRes = await request('GET', '/api/system/parity/os');
  assert.equal(unauthRes.status, 401);

  // 2. Authenticated Owner sees full OS equivalence and external parity catalog
  currentAuth = {
    user: { id: 'owner-1', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };

  const ownerOsRes = await request('GET', '/api/system/parity/os');
  assert.equal(ownerOsRes.status, 200);
  assert.equal(ownerOsRes.body.data.total, 6);
  assert.equal(ownerOsRes.body.data.allLinesFailClosed, true);

  const ownerExtRes = await request('GET', '/api/system/parity/external');
  assert.equal(ownerExtRes.status, 200);
  assert.equal(ownerExtRes.body.data.total, 6);
  assert.equal(ownerExtRes.body.data.unconfiguredFailClosed, true);

  const ownerDefRes = await request('GET', '/api/system/parity/deferred-billing');
  assert.equal(ownerDefRes.status, 200);
  assert.equal(ownerDefRes.body.data.status, 'post_mvp_deferred');
  assert.equal(ownerDefRes.body.data.blocksInitialRelease, false);

  // 3. Customer sees only customer-allowed parity lines
  currentAuth = {
    user: { id: 'customer-1', role: 'customer', active: true, websiteIds: ['site-c1'] },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  };

  const custOsRes = await request('GET', '/api/system/parity/os');
  assert.equal(custOsRes.status, 200);
  assert.ok(custOsRes.body.data.total < 6, 'Customer sees fewer OS lines than Owner');
  for (const line of custOsRes.body.data.osEquivalenceLines) {
    assert.ok(line.rolesAllowed.includes('customer'));
  }

  // Customer querying owner-only OS line WIN-01 returns 403
  const custForbiddenRes = await request('GET', '/api/system/parity/os/WIN-01');
  assert.equal(custForbiddenRes.status, 403);
  assert.equal(custForbiddenRes.body.error.code, 'tenant_boundary_forbidden');

  // 4. Executing OS adapter method fails closed with 501 windows_platform_unsupported
  currentAuth = {
    user: { id: 'owner-1', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  const execOsRes = await request('POST', '/api/system/parity/os/WIN-02/execute', {
    method: 'createSite',
    args: [{ siteName: 'my-win-site.local' }],
  });
  assert.equal(execOsRes.status, 501);
  assert.equal(execOsRes.body.error.code, 'windows_platform_unsupported');

  // 5. Executing unconfigured external adapter method fails closed with 501
  const execExtRes = await request('POST', '/api/system/parity/external/EXT-CERT-01/execute', {
    method: 'requestOrder',
    params: { domain: 'test.com' },
  });
  assert.equal(execExtRes.status, 501);
  assert.equal(execExtRes.body.error.code, 'commercial_certificate_unconfigured');

  // Every listed OS method and external method answers with the fixed fail-closed response
  for (const line of Object.values(OS_EQUIVALENCE_INVENTORY)) {
    for (const method of line.methods) {
      const res = await request('POST', `/api/system/parity/os/${line.id}/execute`, { method, args: [] });
      assert.equal(res.status, 501, `${line.id}.${method}`);
      assert.equal(res.body.error.code, 'windows_platform_unsupported');
    }
  }
  for (const line of Object.values(EXTERNAL_PARITY_INVENTORY)) {
    for (const method of line.methods) {
      const res = await request('POST', `/api/system/parity/external/${line.id}/execute`, { method, params: {} });
      assert.equal(res.status, 501, `${line.id}.${method}`);
      assert.equal(res.body.error.code, `${line.category}_unconfigured`);
    }
  }
  const unknownMethodRes = await request('POST', '/api/system/parity/os/WIN-02/execute', { method: 'constructor' });
  assert.equal(unknownMethodRes.status, 400);
  assert.equal(unknownMethodRes.body.error.code, 'invalid_method');
  const unknownExternalMethodRes = await request('POST', '/api/system/parity/external/EXT-REG-01/execute', { method: 'isConfigured' });
  assert.equal(unknownExternalMethodRes.status, 400);
  assert.equal(unknownExternalMethodRes.body.error.code, 'invalid_method');
  const unknownLineRes = await request('POST', '/api/system/parity/external/EXT-NOPE-01/execute', { method: 'requestOrder' });
  assert.equal(unknownLineRes.status, 404);
  assert.equal(unknownLineRes.body.error.code, 'external_adapter_not_found');

  // 6. Validate billing endpoint rejects forbidden billing keys with 403
  const badBillingRes = await request('POST', '/api/system/parity/validate-billing', {
    resellerBilling: { automatedInvoicing: true },
  });
  assert.equal(badBillingRes.status, 403);
  assert.equal(badBillingRes.body.error.code, 'reseller_billing_deferred');

  const cleanBillingRes = await request('POST', '/api/system/parity/validate-billing', {
    planName: 'Basic Site Plan',
  });
  assert.equal(cleanBillingRes.status, 200);
  assert.equal(cleanBillingRes.body.data.valid, true);
  assert.equal(cleanBillingRes.body.data.billingDeferred, true);
});
