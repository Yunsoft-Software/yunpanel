import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import express from 'express';
import {
  OS_EQUIVALENCE_INVENTORY,
  EXTERNAL_PARITY_INVENTORY,
  DEFERRED_BILLING_INVENTORY,
  FORBIDDEN_BILLING_KEYS,
  assertNoResellerBillingPollution,
  assertResellerBillingDeferred,
  assertPreserveLinuxTenantIsolation,
  OsEquivalenceError,
  ExternalIntegrationError,
  ResellerBillingDeferredError,
  LinuxIsolationViolationError,
  WindowsPlatformAdapter,
  IisWebAdapter,
  DotNetRuntimeAdapter,
  MssqlDatabaseAdapter,
  NtfsPermissionAdapter,
  WindowsMailDnsAdapter,
  CommercialCertificateAdapter,
  SitejetBuilderAdapter,
  PremiumSecurityAdapter,
  PremiumBackupAdapter,
  PremiumToolkitAdapter,
  DomainRegistrarAdapter,
  createDefaultOsAdapters,
  createDefaultExternalAdapters,
  getOsEquivalenceAdapter,
  listOsEquivalenceAdapters,
  getExternalParityAdapter,
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

  // Verify adapter classes instantiate and fail-closed when called on Linux/Ubuntu
  const adapters = createDefaultOsAdapters();

  // WIN-01: WindowsPlatformAdapter
  const win01 = adapters['WIN-01'];
  assert.ok(win01 instanceof WindowsPlatformAdapter);
  await assert.rejects(
    () => win01.getServiceStatus('W3SVC'),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported' && err.status === 501,
  );
  await assert.rejects(
    () => win01.startService('MSSQLSERVER'),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported',
  );
  await assert.rejects(
    () => win01.stopService('W3SVC'),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported',
  );
  await assert.rejects(
    () => win01.getSystemMetrics(),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported',
  );

  // WIN-02: IisWebAdapter
  const win02 = adapters['WIN-02'];
  assert.ok(win02 instanceof IisWebAdapter);
  await assert.rejects(
    () => win02.createSite({ siteName: 'win-site.com', docroot: 'C:\\inetpub\\wwwroot' }),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported' && err.message.includes('IIS'),
  );
  await assert.rejects(
    () => win02.createAppPool('DefaultAppPool', { managedRuntimeVersion: 'v4.0' }),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => win02.createVirtualDirectory('win-site.com', { path: '/api', physicalPath: 'C:\\inetpub\\api' }),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => win02.bindCertificate('win-site.com', 'AB:CD:EF'),
    (err) => err instanceof OsEquivalenceError,
  );

  // WIN-03: DotNetRuntimeAdapter
  const win03 = adapters['WIN-03'];
  assert.ok(win03 instanceof DotNetRuntimeAdapter);
  await assert.rejects(
    () => win03.configureRuntime('site-win', 'net8.0', { enableKestrel: true }),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported',
  );
  await assert.rejects(
    () => win03.recycleAppPool('site-win-pool'),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => win03.listClrVersions(),
    (err) => err instanceof OsEquivalenceError,
  );

  // WIN-04: MssqlDatabaseAdapter
  const win04 = adapters['WIN-04'];
  assert.ok(win04 instanceof MssqlDatabaseAdapter);
  await assert.rejects(
    () => win04.createDatabase('production_db', 'SQL_Latin1_General_CP1_CI_AS'),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported',
  );
  await assert.rejects(
    () => win04.createUser('db_user', 'SecurePass123!', 'production_db'),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => win04.grantPermissions('production_db', 'db_user', ['db_owner']),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => win04.createBackup('production_db', 'C:\\backups\\db.bak'),
    (err) => err instanceof OsEquivalenceError,
  );

  // WIN-05: NtfsPermissionAdapter
  const win05 = adapters['WIN-05'];
  assert.ok(win05 instanceof NtfsPermissionAdapter);
  await assert.rejects(
    () => win05.setAcl('C:\\vhosts\\site1', 'IIS_IUSRS', 'ReadAndExecute', 'ContainerInherit'),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported',
  );
  await assert.rejects(
    () => win05.getAcl('C:\\vhosts\\site1'),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => win05.isolateTenantFolder('C:\\vhosts\\site1', 'S-1-5-21-tenant-sid'),
    (err) => err instanceof OsEquivalenceError,
  );

  // WIN-06: WindowsMailDnsAdapter
  const win06 = adapters['WIN-06'];
  assert.ok(win06 instanceof WindowsMailDnsAdapter);
  await assert.rejects(
    () => win06.createMailbox('domain.com', 'info', 1024),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported',
  );
  await assert.rejects(
    () => win06.createDnsZone('domain.com'),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => win06.getServiceHealth(),
    (err) => err instanceof OsEquivalenceError,
  );
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

test('PAR-05 Acceptance 3: External lifecycle contracts fail-closed when unconfigured', async () => {
  const unconfiguredAdapters = createDefaultExternalAdapters();

  // Commercial certificates
  const certAdapter = unconfiguredAdapters['EXT-CERT-01'];
  assert.equal(certAdapter.isConfigured(), false);
  await assert.rejects(
    () => certAdapter.requestOrder({ domain: 'example.com' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'commercial_certificate_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => certAdapter.checkOrderStatus('order-1'),
    (err) => err instanceof ExternalIntegrationError && err.code === 'commercial_certificate_unconfigured',
  );

  // Sitejet / Site-builder
  const builderAdapter = unconfiguredAdapters['EXT-BUILD-01'];
  assert.equal(builderAdapter.isConfigured(), false);
  await assert.rejects(
    () => builderAdapter.createBuilderSession({ siteId: 'site-1', domain: 'site1.com' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'sitebuilder_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => builderAdapter.handlePublishWebhook({}, 'sig'),
    (err) => err instanceof ExternalIntegrationError && err.code === 'sitebuilder_unconfigured',
  );

  // Premium security
  const secAdapter = unconfiguredAdapters['EXT-SEC-01'];
  assert.equal(secAdapter.isConfigured(), false);
  await assert.rejects(
    () => secAdapter.scheduleMalwareScan({ siteId: 'site-1' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'premium_security_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => secAdapter.quarantineFile({ filePath: '/tmp/bad.php' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'premium_security_unconfigured',
  );

  // Premium backup
  const bakAdapter = unconfiguredAdapters['EXT-BAK-01'];
  assert.equal(bakAdapter.isConfigured(), false);
  await assert.rejects(
    () => bakAdapter.registerRemoteVault({ provider: 'acronis', vaultName: 'Vault1' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'premium_backup_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => bakAdapter.scheduleVaultReplication({ snapshotId: 'snap-1', vaultId: 'v1' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'premium_backup_unconfigured',
  );

  // Premium toolkit
  const toolAdapter = unconfiguredAdapters['EXT-TOOL-01'];
  assert.equal(toolAdapter.isConfigured(), false);
  await assert.rejects(
    () => toolAdapter.prepareSmartUpdate({ siteId: 'site-1' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'premium_toolkit_unconfigured' && err.status === 501,
  );

  // Domain registrar
  const regAdapter = unconfiguredAdapters['EXT-REG-01'];
  assert.equal(regAdapter.isConfigured(), false);
  await assert.rejects(
    () => regAdapter.checkDomainAvailability('example.com'),
    (err) => err instanceof ExternalIntegrationError && err.code === 'registrar_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => regAdapter.registerDomain({ domain: 'example.com', contactInfo: {} }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'registrar_unconfigured',
  );
});

test('PAR-05 Acceptance 3: Configured external lifecycle adapters execute complete deterministic lifecycle contracts', async () => {
  const configuredAdapters = createDefaultExternalAdapters({
    'EXT-CERT-01': { apiKey: 'test-digicert-key', partnerId: 'partner-99' },
    'EXT-BUILD-01': { webhookSecret: 'secret-hmac-123', vendorApi: 'https://builder.example.com' },
    'EXT-SEC-01': { licenseKey: 'imunify-lic-key-abc' },
    'EXT-BAK-01': { vaultToken: 'acronis-vault-token-xyz' },
    'EXT-TOOL-01': { aiApiKey: 'smart-updates-token-555' },
    'EXT-REG-01': { registrarUser: 'opensrs-user', registrarKey: 'opensrs-key' },
  });

  // 1. Commercial Certificate Lifecycle
  const certAdapter = configuredAdapters['EXT-CERT-01'];
  assert.equal(certAdapter.isConfigured(), true);
  const order = await certAdapter.requestOrder({
    domain: 'shop.example.com',
    sans: ['www.shop.example.com'],
    validationMethod: 'dns-01',
    certType: 'ov_commercial',
  });
  assert.ok(order.orderId);
  assert.equal(order.status, 'pending_validation');
  assert.equal(order.dcvRequirements.method, 'dns-01');

  const check = await certAdapter.checkOrderStatus(order.orderId);
  assert.equal(check.orderId, order.orderId);

  const cancelResult = await certAdapter.cancelOrder(order.orderId);
  assert.equal(cancelResult.status, 'cancelled');

  const revokeResult = await certAdapter.revokeCertificate({ serialNumber: '11:22:33:44:55', reason: 'key_compromise' });
  assert.equal(revokeResult.status, 'revoked');
  assert.equal(revokeResult.reason, 'key_compromise');

  // 2. Sitejet / Site-Builder Lifecycle
  const builderAdapter = configuredAdapters['EXT-BUILD-01'];
  assert.equal(builderAdapter.isConfigured(), true);
  const session = await builderAdapter.createBuilderSession({
    siteId: 'site-100',
    domain: 'site100.com',
    userEmail: 'client@site100.com',
  });
  assert.ok(session.sessionId);
  assert.ok(session.editorUrl.includes(session.sessionId));

  // Valid webhook publication with matching signature
  const publish = await builderAdapter.handlePublishWebhook(
    { siteId: 'site-100', files: ['index.html', 'style.css'] },
    'secret-hmac-123',
  );
  assert.equal(publish.succeeded, true);
  assert.equal(publish.siteId, 'site-100');
  assert.equal(publish.publishedArtifactsCount, 2);

  // Invalid webhook signature fails closed (403)
  await assert.rejects(
    () => builderAdapter.handlePublishWebhook({ siteId: 'site-100' }, 'bad-signature'),
    (err) => err instanceof ExternalIntegrationError && err.code === 'invalid_signature' && err.status === 403,
  );

  // 3. Premium Security Lifecycle
  const secAdapter = configuredAdapters['EXT-SEC-01'];
  const scan = await secAdapter.scheduleMalwareScan({ siteId: 'site-100', deepScan: true });
  assert.ok(scan.scanId);
  assert.equal(scan.deepScan, true);

  const scanCheck = await secAdapter.getScanResults(scan.scanId);
  assert.equal(scanCheck.scanId, scan.scanId);

  const quarantine = await secAdapter.quarantineFile({ filePath: '/var/www/vhosts/site-100/bad.php' });
  assert.equal(quarantine.quarantined, true);
  assert.equal(quarantine.quarantineVault, '/var/lib/yunpanel/security-quarantine');

  const defs = await secAdapter.updateDefinitions();
  assert.equal(defs.definitionsUpdated, true);

  // 4. Premium Backup Vaults Lifecycle
  const bakAdapter = configuredAdapters['EXT-BAK-01'];
  const vault = await bakAdapter.registerRemoteVault({ provider: 'acronis', vaultName: 'EU-Vault-1' });
  assert.ok(vault.vaultId);
  assert.equal(vault.status, 'active');

  const repl = await bakAdapter.scheduleVaultReplication({ snapshotId: 'snap-100', vaultId: vault.vaultId, retentionDays: 60 });
  assert.ok(repl.replicationJobId);
  assert.equal(repl.retentionDays, 60);

  const integrity = await bakAdapter.verifyVaultIntegrity({ vaultId: vault.vaultId, snapshotId: 'snap-100' });
  assert.equal(integrity.checksumMatches, true);

  const restore = await bakAdapter.restoreFromVault({ snapshotId: 'snap-100', vaultId: vault.vaultId, targetSiteId: 'site-100' });
  assert.ok(restore.restoreJobId);

  // 5. Premium Toolkit & Smart Updates Lifecycle
  const toolAdapter = configuredAdapters['EXT-TOOL-01'];
  const smartPrep = await toolAdapter.prepareSmartUpdate({ siteId: 'site-100', plugins: ['woocommerce'], dryRun: false });
  assert.ok(smartPrep.updateReceiptId);
  assert.equal(smartPrep.readyForPromotion, true);

  const regression = await toolAdapter.analyzeVisualRegression({ siteId: 'site-100', baselineSnapshotId: 'base-1', updatedSnapshotId: 'up-1' });
  assert.equal(regression.regressionDetected, false);

  const promo = await toolAdapter.promoteStagingToProduction({ siteId: 'site-100', updateReceiptId: smartPrep.updateReceiptId });
  assert.equal(promo.promoted, true);
  assert.equal(promo.rollbackCheckpointCreated, true);

  // 6. Domain Registrar Lifecycle
  const regAdapter = configuredAdapters['EXT-REG-01'];
  const avail = await regAdapter.checkDomainAvailability('mynewbrand.net');
  assert.equal(avail.available, true);

  const reg = await regAdapter.registerDomain({
    domain: 'mynewbrand.net',
    years: 2,
    contactInfo: { registrant: 'Alice' },
    nameservers: ['ns1.yunpanel.internal', 'ns2.yunpanel.internal'],
  });
  assert.equal(reg.domain, 'mynewbrand.net');
  assert.equal(reg.locked, true);

  const renew = await regAdapter.renewDomain({ domain: 'mynewbrand.net', years: 1 });
  assert.ok(renew.expiresAt);

  const nsUpdate = await regAdapter.updateNameservers({ domain: 'mynewbrand.net', nameservers: ['ns3.yunpanel.internal'] });
  assert.equal(nsUpdate.updated, true);

  const dsSync = await regAdapter.setDnssecDsData('mynewbrand.net', [{ keyTag: 12345, algorithm: 13, digestType: 2, digest: 'ABCDEF' }]);
  assert.equal(dsSync.synced, true);

  const authCode = await regAdapter.getAuthCode('mynewbrand.net');
  assert.ok(authCode.authCode.startsWith('EPP-'));
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
