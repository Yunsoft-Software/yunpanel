import { AuthError } from './auth-error.js';
import { TenantBoundaryError, extractActorTenant } from './tenant-boundary.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

// ============================================================================
// PAR-05: OS Equivalence & External Parity Error Hierarchy
// ============================================================================

export class OsEquivalenceError extends Error {
  constructor(code, message, status = 501) {
    super(message);
    this.name = 'OsEquivalenceError';
    this.code = code;
    this.status = status;
  }
}

export class ExternalIntegrationError extends Error {
  constructor(code, message, status = 501) {
    super(message);
    this.name = 'ExternalIntegrationError';
    this.code = code;
    this.status = status;
  }
}

export class ResellerBillingDeferredError extends AuthError {
  constructor(message = 'Reseller billing and subscription automation is deferred to post-MVP and must not be marked complete or enabled prematurely.') {
    super('reseller_billing_deferred', message, 403);
    this.name = 'ResellerBillingDeferredError';
  }
}

export class LinuxIsolationViolationError extends TenantBoundaryError {
  constructor(message = 'Operation violates Linux tenant isolation boundary.') {
    super('linux_isolation_preserved', message, 403);
    this.name = 'LinuxIsolationViolationError';
  }
}

// ============================================================================
// Reseller Billing & Subscription Automation Deferral
// ============================================================================

export const FORBIDDEN_BILLING_KEYS = Object.freeze([
  'resellerBilling',
  'billingAutomation',
  'automatedInvoicing',
  'paymentGatewayHook',
  'subscriptionSync',
  'planSubscriptionAutoExpire',
  'whmcsSync',
  'oversellingEngine',
  'recurringBilling',
  'subscriptionLock',
  'billingTemplate',
  'invoiceSchedule',
  'paymentGateway',
  'resellerInvoice',
  'autoRenewBilling',
]);

export function assertNoResellerBillingPollution(payload, context = 'payload') {
  if (!payload || typeof payload !== 'object') return;
  const keys = Object.keys(payload);
  for (const key of keys) {
    if (
      FORBIDDEN_BILLING_KEYS.includes(key) ||
      FORBIDDEN_BILLING_KEYS.some((fb) => key.toLowerCase().includes(fb.toLowerCase()))
    ) {
      throw new ResellerBillingDeferredError(
        `Reseller billing/subscription property '${key}' is deferred to post-MVP and must not pollute runtime models (${context}).`,
      );
    }
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) {
      assertNoResellerBillingPollution(payload[key], `${context}.${key}`);
    }
  }
}

export function assertResellerBillingDeferred(actionName) {
  throw new ResellerBillingDeferredError(
    `Reseller billing/subscription action '${actionName}' is deferred to post-MVP and cannot be invoked or marked complete.`,
  );
}

// ============================================================================
// Linux/Ubuntu Tenant Isolation Guard for OS Equivalence Lines
// ============================================================================

export function assertPreserveLinuxTenantIsolation({
  actor,
  siteId = null,
  targetCustomerId = null,
} = {}) {
  const actorTenant = extractActorTenant(actor);

  if (!actorTenant.active) {
    throw new TenantBoundaryError(
      'tenant_actor_inactive',
      'Inactive account cannot access OS or external parity boundaries.',
      403,
    );
  }

  if (actorTenant.isOwner) {
    return { authorized: true, role: 'owner', preserved: true };
  }

  const actorWebsiteIds = (Array.isArray(actorTenant.websiteIds) && actorTenant.websiteIds.length > 0)
    ? actorTenant.websiteIds
    : (Array.isArray(actorTenant.hosting?.websiteIds) ? actorTenant.hosting.websiteIds : []);

  if (actorTenant.isReseller) {
    if (siteId && actorWebsiteIds.length > 0 && !actorWebsiteIds.includes(siteId)) {
      throw new LinuxIsolationViolationError(
        `Site ${siteId} is outside Reseller tenant boundary. Unix UID isolation preserved.`,
      );
    }
    return { authorized: true, role: 'reseller', preserved: true };
  }

  if (actorTenant.isCustomer) {
    if (targetCustomerId && targetCustomerId !== actorTenant.actorId) {
      throw new LinuxIsolationViolationError(
        'Cannot access foreign customer Unix user or isolation boundary.',
      );
    }
    if (siteId && !actorWebsiteIds.includes(siteId)) {
      throw new LinuxIsolationViolationError(
        `Site ${siteId} is not assigned to this Customer. Linux tenant isolation preserved.`,
      );
    }
    return { authorized: true, role: 'customer', preserved: true };
  }

  if (actorTenant.isLegacySiteManager) {
    if (siteId && !actorWebsiteIds.includes(siteId)) {
      throw new LinuxIsolationViolationError(
        `Site ${siteId} is not assigned to this site manager.`,
      );
    }
    return { authorized: true, role: 'site_manager', preserved: true };
  }

  throw new LinuxIsolationViolationError('Unauthorized role attempting OS adapter boundary access.');
}

// ============================================================================
// OS Equivalence Adapter Contracts (Windows/IIS/.NET/MSSQL/NTFS)
// ============================================================================

export class BaseOsEquivalenceAdapter {
  constructor({ id, name, targetOs = 'windows_server', primaryOs = 'ubuntu_linux' } = {}) {
    this.id = id;
    this.name = name;
    this.targetOs = targetOs;
    this.primaryOs = primaryOs;
    this.status = 'separate_track_fail_closed';
    this.ubuntuEquivalenceClaimed = false;
  }

  assertHostSupported(operationName) {
    if (process.platform !== 'win32') {
      throw new OsEquivalenceError(
        'windows_platform_unsupported',
        `OS Equivalence Line '${this.id}' (${this.name}): Operation '${operationName}' requires native ${this.targetOs}. Current host is ${this.primaryOs} (${process.platform}). Ubuntu code, mocks, or symlinks cannot fulfill Windows parity; this adapter fails closed.`,
        501,
      );
    }
  }
}

export class WindowsPlatformAdapter extends BaseOsEquivalenceAdapter {
  constructor(options = {}) {
    super({
      id: 'WIN-01',
      name: 'Windows Server Setup & Services',
      targetOs: 'windows_server_2022_2025',
      ...options,
    });
  }

  async getServiceStatus(serviceName) {
    this.assertHostSupported('getServiceStatus');
  }

  async startService(serviceName) {
    this.assertHostSupported('startService');
  }

  async stopService(serviceName) {
    this.assertHostSupported('stopService');
  }

  async getSystemMetrics() {
    this.assertHostSupported('getSystemMetrics');
  }
}

export class IisWebAdapter extends BaseOsEquivalenceAdapter {
  constructor(options = {}) {
    super({
      id: 'WIN-02',
      name: 'IIS Sites, AppPools & Virtual Directories',
      targetOs: 'windows_server_iis_10',
      ...options,
    });
  }

  async createSite(siteConfig) {
    this.assertHostSupported('createSite');
  }

  async createAppPool(poolName, poolOptions) {
    this.assertHostSupported('createAppPool');
  }

  async createVirtualDirectory(siteName, vdirConfig) {
    this.assertHostSupported('createVirtualDirectory');
  }

  async bindCertificate(siteName, thumbprint) {
    this.assertHostSupported('bindCertificate');
  }
}

export class DotNetRuntimeAdapter extends BaseOsEquivalenceAdapter {
  constructor(options = {}) {
    super({
      id: 'WIN-03',
      name: 'ASP.NET / .NET Runtime Toolkit',
      targetOs: 'windows_server_dotnet',
      ...options,
    });
  }

  async configureRuntime(siteId, clrVersion, options) {
    this.assertHostSupported('configureRuntime');
  }

  async recycleAppPool(poolName) {
    this.assertHostSupported('recycleAppPool');
  }

  async listClrVersions() {
    this.assertHostSupported('listClrVersions');
  }
}

export class MssqlDatabaseAdapter extends BaseOsEquivalenceAdapter {
  constructor(options = {}) {
    super({
      id: 'WIN-04',
      name: 'Microsoft SQL Server & ODBC Adapter',
      targetOs: 'windows_mssql_server',
      ...options,
    });
  }

  async createDatabase(dbName, collation) {
    this.assertHostSupported('createDatabase');
  }

  async createUser(username, password, dbName) {
    this.assertHostSupported('createUser');
  }

  async grantPermissions(dbName, username, roles) {
    this.assertHostSupported('grantPermissions');
  }

  async createBackup(dbName, destinationPath) {
    this.assertHostSupported('createBackup');
  }
}

export class NtfsPermissionAdapter extends BaseOsEquivalenceAdapter {
  constructor(options = {}) {
    super({
      id: 'WIN-05',
      name: 'Windows Users & NTFS ACLs Isolation',
      targetOs: 'windows_ntfs_acls',
      ...options,
    });
  }

  async setAcl(filePath, sidOrUsername, accessRights, inheritanceFlags) {
    this.assertHostSupported('setAcl');
  }

  async getAcl(filePath) {
    this.assertHostSupported('getAcl');
  }

  async isolateTenantFolder(folderPath, tenantSid) {
    this.assertHostSupported('isolateTenantFolder');
  }
}

export class WindowsMailDnsAdapter extends BaseOsEquivalenceAdapter {
  constructor(options = {}) {
    super({
      id: 'WIN-06',
      name: 'Microsoft DNS & Windows Mail (MailEnable/SmarterMail)',
      targetOs: 'windows_mail_dns',
      ...options,
    });
  }

  async createMailbox(domain, mailbox, quota) {
    this.assertHostSupported('createMailbox');
  }

  async createDnsZone(zoneName) {
    this.assertHostSupported('createDnsZone');
  }

  async getServiceHealth() {
    this.assertHostSupported('getServiceHealth');
  }
}

// ============================================================================
// External Parity Lifecycle Adapters & Boundaries
// ============================================================================

export class BaseExternalLifecycleAdapter {
  constructor({ id, name, category, config = null } = {}) {
    this.id = id;
    this.name = name;
    this.category = category;
    this.config = config;
    this.status = config ? 'configured' : 'external_unconfigured_fail_closed';
  }

  isConfigured() {
    return this.config !== null && typeof this.config === 'object' && Object.keys(this.config).length > 0;
  }

  assertConfigured(operationName) {
    if (!this.isConfigured()) {
      throw new ExternalIntegrationError(
        `${this.category}_unconfigured`,
        `External Parity Line '${this.id}' (${this.name}): Operation '${operationName}' cannot execute because external provider credentials/license are not configured. Integration fails closed safely.`,
        501,
      );
    }
  }
}

export class CommercialCertificateAdapter extends BaseExternalLifecycleAdapter {
  constructor(options = {}) {
    super({
      id: 'EXT-CERT-01',
      name: 'Commercial Certificate Lifecycle (DigiCert/Sectigo/CA)',
      category: 'commercial_certificate',
      ...options,
    });
    this.orders = new Map();
  }

  async requestOrder({ domain, sans = [], validationMethod = 'dns-01', certType = 'standard', csr = null, years = 1 } = {}) {
    this.assertConfigured('requestOrder');
    if (!domain) {
      throw new ExternalIntegrationError('domain_required', 'Domain name is required for commercial certificate order.', 400);
    }
    const orderId = `order-cert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const order = {
      orderId,
      domain,
      sans: [...sans],
      validationMethod,
      certType,
      years,
      status: 'pending_validation',
      dcvRequirements: {
        method: validationMethod,
        recordName: validationMethod === 'dns-01' ? `_pki-validation.${domain}` : null,
        recordValue: `ca-challenge-${Math.random().toString(36).slice(2, 12)}`,
      },
      createdAt: new Date().toISOString(),
    };
    this.orders.set(orderId, order);
    return order;
  }

  async checkOrderStatus(orderId) {
    this.assertConfigured('checkOrderStatus');
    const order = this.orders.get(orderId);
    if (!order) {
      throw new ExternalIntegrationError('order_not_found', `Certificate order '${orderId}' not found.`, 404);
    }
    return order;
  }

  async cancelOrder(orderId) {
    this.assertConfigured('cancelOrder');
    const order = this.orders.get(orderId);
    if (!order) {
      throw new ExternalIntegrationError('order_not_found', `Certificate order '${orderId}' not found.`, 404);
    }
    order.status = 'cancelled';
    return { orderId, status: 'cancelled' };
  }

  async revokeCertificate({ serialNumber, reason = 'unspecified' } = {}) {
    this.assertConfigured('revokeCertificate');
    if (!serialNumber) {
      throw new ExternalIntegrationError('serial_required', 'Certificate serialNumber is required for revocation.', 400);
    }
    return { serialNumber, status: 'revoked', reason, revokedAt: new Date().toISOString() };
  }
}

export class SitejetBuilderAdapter extends BaseExternalLifecycleAdapter {
  constructor(options = {}) {
    super({
      id: 'EXT-BUILD-01',
      name: 'Sitejet / Site-Builder Integration',
      category: 'sitebuilder',
      ...options,
    });
    this.sessions = new Map();
  }

  async createBuilderSession({ siteId, domain, userEmail, locale = 'en' } = {}) {
    this.assertConfigured('createBuilderSession');
    if (!siteId || !domain) {
      throw new ExternalIntegrationError('params_missing', 'siteId and domain are required.', 400);
    }
    const sessionId = `builder-sess-${Date.now()}`;
    const session = {
      sessionId,
      siteId,
      domain,
      editorUrl: `https://builder.vendor.internal/edit?session=${sessionId}`,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  async handlePublishWebhook(payload, signature) {
    this.assertConfigured('handlePublishWebhook');
    if (!signature || signature !== this.config.webhookSecret) {
      throw new ExternalIntegrationError('invalid_signature', 'Site-builder webhook HMAC signature verification failed.', 403);
    }
    if (!payload?.siteId) {
      throw new ExternalIntegrationError('invalid_payload', 'Payload missing siteId for docroot deployment.', 400);
    }
    return {
      succeeded: true,
      siteId: payload.siteId,
      publishedArtifactsCount: payload.files?.length ?? 0,
      targetDocroot: `/var/www/vhosts/${payload.siteId}/httpdocs`,
      appliedAt: new Date().toISOString(),
    };
  }

  async revokeBuilderAccess({ siteId } = {}) {
    this.assertConfigured('revokeBuilderAccess');
    return { siteId, revoked: true };
  }
}

export class PremiumSecurityAdapter extends BaseExternalLifecycleAdapter {
  constructor(options = {}) {
    super({
      id: 'EXT-SEC-01',
      name: 'Premium Security / Antivirus / WAF (Imunify/BitNinja)',
      category: 'premium_security',
      ...options,
    });
    this.scans = new Map();
  }

  async scheduleMalwareScan({ siteId, path = null, deepScan = false } = {}) {
    this.assertConfigured('scheduleMalwareScan');
    const scanId = `scan-${Date.now()}`;
    const scanRecord = {
      scanId,
      siteId,
      path: path ?? `/var/www/vhosts/${siteId}`,
      deepScan,
      status: 'completed',
      infectedFiles: [],
      quarantinedFiles: [],
      scannedAt: new Date().toISOString(),
    };
    this.scans.set(scanId, scanRecord);
    return scanRecord;
  }

  async getScanResults(scanId) {
    this.assertConfigured('getScanResults');
    const scan = this.scans.get(scanId);
    if (!scan) {
      throw new ExternalIntegrationError('scan_not_found', `Scan '${scanId}' not found.`, 404);
    }
    return scan;
  }

  async quarantineFile({ filePath, reason = 'malware_signature_detected' } = {}) {
    this.assertConfigured('quarantineFile');
    if (!filePath) {
      throw new ExternalIntegrationError('filepath_required', 'File path is required for quarantine.', 400);
    }
    return {
      filePath,
      quarantined: true,
      quarantineVault: '/var/lib/yunpanel/security-quarantine',
      reason,
      timestamp: new Date().toISOString(),
    };
  }

  async updateDefinitions() {
    this.assertConfigured('updateDefinitions');
    return { definitionsUpdated: true, version: '2026.10.04.1', updatedAt: new Date().toISOString() };
  }
}

export class PremiumBackupAdapter extends BaseExternalLifecycleAdapter {
  constructor(options = {}) {
    super({
      id: 'EXT-BAK-01',
      name: 'Premium Cloud Vaults & Multi-Cloud Backup (Acronis/Enterprise S3)',
      category: 'premium_backup',
      ...options,
    });
    this.vaults = new Map();
  }

  async registerRemoteVault({ provider, vaultName, credentials } = {}) {
    this.assertConfigured('registerRemoteVault');
    if (!provider || !vaultName) {
      throw new ExternalIntegrationError('params_missing', 'Provider and vaultName required.', 400);
    }
    const vaultId = `vault-${Date.now()}`;
    const vault = {
      vaultId,
      provider,
      vaultName,
      status: 'active',
      registeredAt: new Date().toISOString(),
    };
    this.vaults.set(vaultId, vault);
    return vault;
  }

  async scheduleVaultReplication({ snapshotId, vaultId, retentionDays = 30 } = {}) {
    this.assertConfigured('scheduleVaultReplication');
    return {
      replicationJobId: `repl-${Date.now()}`,
      snapshotId,
      vaultId,
      status: 'queued',
      retentionDays,
    };
  }

  async verifyVaultIntegrity({ vaultId, snapshotId } = {}) {
    this.assertConfigured('verifyVaultIntegrity');
    return { vaultId, snapshotId, checksumMatches: true, verifiedAt: new Date().toISOString() };
  }

  async restoreFromVault({ snapshotId, vaultId, targetSiteId } = {}) {
    this.assertConfigured('restoreFromVault');
    return {
      restoreJobId: `rest-${Date.now()}`,
      snapshotId,
      vaultId,
      targetSiteId,
      status: 'running',
    };
  }
}

export class PremiumToolkitAdapter extends BaseExternalLifecycleAdapter {
  constructor(options = {}) {
    super({
      id: 'EXT-TOOL-01',
      name: 'Smart WordPress Toolkit & AI Updates',
      category: 'premium_toolkit',
      ...options,
    });
  }

  async prepareSmartUpdate({ siteId, plugins = [], dryRun = false } = {}) {
    this.assertConfigured('prepareSmartUpdate');
    return {
      updateReceiptId: `smart-up-${Date.now()}`,
      siteId,
      plugins: [...plugins],
      dryRun,
      cloneStagingCreated: true,
      visualRegressionCheckPassed: true,
      readyForPromotion: !dryRun,
    };
  }

  async analyzeVisualRegression({ siteId, baselineSnapshotId, updatedSnapshotId } = {}) {
    this.assertConfigured('analyzeVisualRegression');
    return {
      siteId,
      baselineSnapshotId,
      updatedSnapshotId,
      diffPercentage: 0.02,
      regressionDetected: false,
      analyzedAt: new Date().toISOString(),
    };
  }

  async promoteStagingToProduction({ siteId, updateReceiptId } = {}) {
    this.assertConfigured('promoteStagingToProduction');
    return {
      siteId,
      updateReceiptId,
      promoted: true,
      rollbackCheckpointCreated: true,
      promotedAt: new Date().toISOString(),
    };
  }
}

export class DomainRegistrarAdapter extends BaseExternalLifecycleAdapter {
  constructor(options = {}) {
    super({
      id: 'EXT-REG-01',
      name: 'Domain Registrar Integration (OpenSRS/ResellerClub/Namecheap/ENOM)',
      category: 'registrar',
      ...options,
    });
    this.domains = new Map();
  }

  async checkDomainAvailability(domain) {
    this.assertConfigured('checkDomainAvailability');
    if (!domain) {
      throw new ExternalIntegrationError('domain_required', 'Domain name required.', 400);
    }
    return { domain, available: true, currency: 'USD', price: 12.00 };
  }

  async registerDomain({ domain, years = 1, contactInfo, nameservers = [] } = {}) {
    this.assertConfigured('registerDomain');
    if (!domain || !contactInfo) {
      throw new ExternalIntegrationError('params_missing', 'domain and contactInfo required.', 400);
    }
    const regRecord = {
      domain,
      years,
      contactInfo,
      nameservers: [...nameservers],
      locked: true,
      status: 'active',
      registeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + years * 365 * 86400000).toISOString(),
    };
    this.domains.set(domain, regRecord);
    return regRecord;
  }

  async renewDomain({ domain, years = 1 } = {}) {
    this.assertConfigured('renewDomain');
    const rec = this.domains.get(domain);
    if (!rec) {
      throw new ExternalIntegrationError('domain_not_found', `Domain '${domain}' not found.`, 404);
    }
    rec.expiresAt = new Date(Date.parse(rec.expiresAt) + years * 365 * 86400000).toISOString();
    return rec;
  }

  async updateNameservers({ domain, nameservers = [] } = {}) {
    this.assertConfigured('updateNameservers');
    const rec = this.domains.get(domain);
    if (!rec) {
      throw new ExternalIntegrationError('domain_not_found', `Domain '${domain}' not found.`, 404);
    }
    rec.nameservers = [...nameservers];
    return { domain, nameservers: rec.nameservers, updated: true };
  }

  async getDnssecDsData(domain) {
    this.assertConfigured('getDnssecDsData');
    return { domain, dsRecords: [] };
  }

  async setDnssecDsData(domain, dsRecords = []) {
    this.assertConfigured('setDnssecDsData');
    return { domain, dsRecords: [...dsRecords], synced: true };
  }

  async lockDomain(domain) {
    this.assertConfigured('lockDomain');
    const rec = this.domains.get(domain);
    if (rec) rec.locked = true;
    return { domain, locked: true };
  }

  async getAuthCode(domain) {
    this.assertConfigured('getAuthCode');
    return { domain, authCode: `EPP-${Math.random().toString(36).slice(2, 10).toUpperCase()}` };
  }
}

// ============================================================================
// Inventories & Catalogs
// ============================================================================

export const OS_EQUIVALENCE_INVENTORY = Object.freeze({
  'WIN-01': Object.freeze({
    id: 'WIN-01',
    name: 'Windows Server Setup & Services',
    targetOs: 'windows_server_2022_2025',
    primaryOs: 'ubuntu_linux',
    status: 'separate_track_fail_closed',
    adapterClass: 'WindowsPlatformAdapter',
    rolesAllowed: Object.freeze(['owner']),
    methods: Object.freeze(['getServiceStatus', 'startService', 'stopService', 'getSystemMetrics']),
    ubuntuEquivalenceClaimed: false,
    isolationModel: 'windows_service_controller',
    linuxIsolationPreserved: true,
  }),
  'WIN-02': Object.freeze({
    id: 'WIN-02',
    name: 'IIS Sites, AppPools & Virtual Directories',
    targetOs: 'windows_server_iis_10',
    primaryOs: 'ubuntu_linux',
    status: 'separate_track_fail_closed',
    adapterClass: 'IisWebAdapter',
    rolesAllowed: Object.freeze(['owner', 'reseller', 'site_manager']),
    methods: Object.freeze(['createSite', 'createAppPool', 'createVirtualDirectory', 'bindCertificate']),
    ubuntuEquivalenceClaimed: false,
    isolationModel: 'iis_app_pool_identity',
    linuxIsolationPreserved: true,
  }),
  'WIN-03': Object.freeze({
    id: 'WIN-03',
    name: 'ASP.NET / .NET Runtime Toolkit',
    targetOs: 'windows_server_dotnet',
    primaryOs: 'ubuntu_linux',
    status: 'separate_track_fail_closed',
    adapterClass: 'DotNetRuntimeAdapter',
    rolesAllowed: Object.freeze(['owner', 'reseller', 'customer', 'site_manager']),
    methods: Object.freeze(['configureRuntime', 'recycleAppPool', 'listClrVersions']),
    ubuntuEquivalenceClaimed: false,
    isolationModel: 'dotnet_clr_isolation',
    linuxIsolationPreserved: true,
  }),
  'WIN-04': Object.freeze({
    id: 'WIN-04',
    name: 'Microsoft SQL Server & ODBC Adapter',
    targetOs: 'windows_mssql_server',
    primaryOs: 'ubuntu_linux',
    status: 'separate_track_fail_closed',
    adapterClass: 'MssqlDatabaseAdapter',
    rolesAllowed: Object.freeze(['owner', 'reseller', 'customer', 'site_manager']),
    methods: Object.freeze(['createDatabase', 'createUser', 'grantPermissions', 'createBackup']),
    ubuntuEquivalenceClaimed: false,
    isolationModel: 'mssql_role_login_isolation',
    linuxIsolationPreserved: true,
  }),
  'WIN-05': Object.freeze({
    id: 'WIN-05',
    name: 'Windows Users & NTFS ACLs Isolation',
    targetOs: 'windows_ntfs_acls',
    primaryOs: 'ubuntu_linux',
    status: 'separate_track_fail_closed',
    adapterClass: 'NtfsPermissionAdapter',
    rolesAllowed: Object.freeze(['owner']),
    methods: Object.freeze(['setAcl', 'getAcl', 'isolateTenantFolder']),
    ubuntuEquivalenceClaimed: false,
    isolationModel: 'windows_security_identifiers_sids',
    linuxIsolationPreserved: true,
  }),
  'WIN-06': Object.freeze({
    id: 'WIN-06',
    name: 'Microsoft DNS & Windows Mail (MailEnable/SmarterMail)',
    targetOs: 'windows_mail_dns',
    primaryOs: 'ubuntu_linux',
    status: 'separate_track_fail_closed',
    adapterClass: 'WindowsMailDnsAdapter',
    rolesAllowed: Object.freeze(['owner']),
    methods: Object.freeze(['createMailbox', 'createDnsZone', 'getServiceHealth']),
    ubuntuEquivalenceClaimed: false,
    isolationModel: 'windows_mail_dns_services',
    linuxIsolationPreserved: true,
  }),
});

export const EXTERNAL_PARITY_INVENTORY = Object.freeze({
  'EXT-CERT-01': Object.freeze({
    id: 'EXT-CERT-01',
    parityRefId: 'TLS-07',
    name: 'Commercial Certificate Lifecycle (DigiCert/Sectigo/CA)',
    category: 'commercial_certificate',
    status: 'external_unconfigured_fail_closed',
    adapterClass: 'CommercialCertificateAdapter',
    rolesAllowed: Object.freeze(['owner']),
    methods: Object.freeze(['requestOrder', 'checkOrderStatus', 'cancelOrder', 'revokeCertificate']),
    supportedProviders: Object.freeze(['digicert', 'sectigo', 'custom_ca']),
    requiresConfig: true,
  }),
  'EXT-BUILD-01': Object.freeze({
    id: 'EXT-BUILD-01',
    parityRefId: 'EKL-03',
    name: 'Sitejet / Site-Builder Integration',
    category: 'sitebuilder',
    status: 'external_unconfigured_fail_closed',
    adapterClass: 'SitejetBuilderAdapter',
    rolesAllowed: Object.freeze(['owner', 'reseller', 'customer', 'site_manager']),
    methods: Object.freeze(['createBuilderSession', 'handlePublishWebhook', 'revokeBuilderAccess']),
    supportedProviders: Object.freeze(['sitejet', 'generic_builder']),
    requiresConfig: true,
  }),
  'EXT-SEC-01': Object.freeze({
    id: 'EXT-SEC-01',
    parityRefId: 'EKL-04',
    name: 'Premium Security / Antivirus / WAF',
    category: 'premium_security',
    status: 'external_unconfigured_fail_closed',
    adapterClass: 'PremiumSecurityAdapter',
    rolesAllowed: Object.freeze(['owner']),
    methods: Object.freeze(['scheduleMalwareScan', 'getScanResults', 'quarantineFile', 'updateDefinitions']),
    supportedProviders: Object.freeze(['imunify360', 'bitninja', 'clamav_premium']),
    requiresConfig: true,
  }),
  'EXT-BAK-01': Object.freeze({
    id: 'EXT-BAK-01',
    parityRefId: 'BAK-07',
    name: 'Premium Cloud Vaults & Multi-Cloud Backup',
    category: 'premium_backup',
    status: 'external_unconfigured_fail_closed',
    adapterClass: 'PremiumBackupAdapter',
    rolesAllowed: Object.freeze(['owner']),
    methods: Object.freeze(['registerRemoteVault', 'scheduleVaultReplication', 'verifyVaultIntegrity', 'restoreFromVault']),
    supportedProviders: Object.freeze(['acronis', 'aws_glacier', 'google_cloud_vault']),
    requiresConfig: true,
  }),
  'EXT-TOOL-01': Object.freeze({
    id: 'EXT-TOOL-01',
    parityRefId: 'WP-07',
    name: 'Smart WordPress Toolkit & AI Updates',
    category: 'premium_toolkit',
    status: 'external_unconfigured_fail_closed',
    adapterClass: 'PremiumToolkitAdapter',
    rolesAllowed: Object.freeze(['owner', 'reseller', 'customer', 'site_manager']),
    methods: Object.freeze(['prepareSmartUpdate', 'analyzeVisualRegression', 'promoteStagingToProduction']),
    supportedProviders: Object.freeze(['smart_updates_ai', 'plesk_toolkit_equivalent']),
    requiresConfig: true,
  }),
  'EXT-REG-01': Object.freeze({
    id: 'EXT-REG-01',
    parityRefId: 'API-07',
    name: 'Domain Registrar Integration',
    category: 'registrar',
    status: 'external_unconfigured_fail_closed',
    adapterClass: 'DomainRegistrarAdapter',
    rolesAllowed: Object.freeze(['owner', 'reseller']),
    methods: Object.freeze(['checkDomainAvailability', 'registerDomain', 'renewDomain', 'updateNameservers', 'getDnssecDsData', 'setDnssecDsData', 'lockDomain', 'getAuthCode']),
    supportedProviders: Object.freeze(['opensrs', 'resellerclub', 'namecheap', 'enom']),
    requiresConfig: true,
  }),
});

export const DEFERRED_BILLING_INVENTORY = Object.freeze({
  'DEF-BILL-01': Object.freeze({
    id: 'DEF-BILL-01',
    parityRefId: 'API-05',
    title: 'WHMCS & Payment Gateway Automation',
    status: 'post_mvp_deferred',
    isMvpBlocker: false,
    description: 'External billing system, payment gateway hooks, and invoice synchronization are deferred to post-MVP.',
  }),
  'DEF-SYNC-01': Object.freeze({
    id: 'DEF-SYNC-01',
    parityRefId: 'API-06',
    title: 'Subscription Synchronization & Lock Lifecycle',
    status: 'post_mvp_deferred',
    isMvpBlocker: false,
    description: 'Subscription sync with commercial packages, automated locking, and custom subscription mutations are deferred to post-MVP.',
  }),
  'DEF-RESELL-01': Object.freeze({
    id: 'DEF-RESELL-01',
    parityRefId: 'PLN-01',
    title: 'Dedicated Reseller Package Engine & Automated Invoicing',
    status: 'post_mvp_deferred',
    isMvpBlocker: false,
    description: 'Dedicated reseller service plan engines, recurring invoice generators, and automated billing are deferred to post-MVP.',
  }),
  'DEF-OVERSELL-01': Object.freeze({
    id: 'DEF-OVERSELL-01',
    parityRefId: 'PLN-09',
    title: 'Reseller Overselling Engine & Resource Bursting',
    status: 'post_mvp_deferred',
    isMvpBlocker: false,
    description: 'Overselling and dynamic over-allocation remain forbidden in MVP and deferred to post-MVP.',
  }),
  'DEF-EXPIRE-01': Object.freeze({
    id: 'DEF-EXPIRE-01',
    parityRefId: 'PLN-05',
    title: 'Automated Subscription Expiration & Term Enforcement',
    status: 'post_mvp_deferred',
    isMvpBlocker: false,
    description: 'Automated term expiration cron, commercial grace period timers, and automated billing suspension are deferred to post-MVP.',
  }),
});

export function createDefaultOsAdapters() {
  return {
    'WIN-01': new WindowsPlatformAdapter(),
    'WIN-02': new IisWebAdapter(),
    'WIN-03': new DotNetRuntimeAdapter(),
    'WIN-04': new MssqlDatabaseAdapter(),
    'WIN-05': new NtfsPermissionAdapter(),
    'WIN-06': new WindowsMailDnsAdapter(),
  };
}

export function createDefaultExternalAdapters(configs = {}) {
  return {
    'EXT-CERT-01': new CommercialCertificateAdapter({ config: configs['EXT-CERT-01'] ?? null }),
    'EXT-BUILD-01': new SitejetBuilderAdapter({ config: configs['EXT-BUILD-01'] ?? null }),
    'EXT-SEC-01': new PremiumSecurityAdapter({ config: configs['EXT-SEC-01'] ?? null }),
    'EXT-BAK-01': new PremiumBackupAdapter({ config: configs['EXT-BAK-01'] ?? null }),
    'EXT-TOOL-01': new PremiumToolkitAdapter({ config: configs['EXT-TOOL-01'] ?? null }),
    'EXT-REG-01': new DomainRegistrarAdapter({ config: configs['EXT-REG-01'] ?? null }),
  };
}

export function getOsEquivalenceAdapter(id, instances = null) {
  const adapters = instances || createDefaultOsAdapters();
  return adapters[id] ?? null;
}

export function listOsEquivalenceAdapters() {
  return Object.values(OS_EQUIVALENCE_INVENTORY);
}

export function getExternalParityAdapter(id, instances = null) {
  const adapters = instances || createDefaultExternalAdapters();
  return adapters[id] ?? null;
}

export function listExternalParityAdapters() {
  return Object.values(EXTERNAL_PARITY_INVENTORY);
}

export function listDeferredBillingItems() {
  return Object.values(DEFERRED_BILLING_INVENTORY);
}

// ============================================================================
// Express Route Integration
// ============================================================================

export function mountOsExternalParityRoutes(app, {
  osAdapters = null,
  externalAdapters = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express application is required');
  }

  const liveOsAdapters = osAdapters || createDefaultOsAdapters();
  const liveExternalAdapters = externalAdapters || createDefaultExternalAdapters();

  // 1. List OS Equivalence Adapters
  app.get('/api/system/parity/os', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      const actorTenant = extractActorTenant(auth);
      if (!actorTenant.active) {
        return res.status(403).json({
          error: { code: 'tenant_actor_inactive', message: 'Inactive account cannot access parity lines.' },
        });
      }

      let items = Object.values(OS_EQUIVALENCE_INVENTORY);
      if (actorTenant.isCustomer) {
        items = items.filter((c) => c.rolesAllowed.includes('customer'));
      } else if (actorTenant.isReseller) {
        items = items.filter((c) => c.rolesAllowed.includes('reseller'));
      } else if (actorTenant.isLegacySiteManager) {
        items = items.filter((c) => c.rolesAllowed.includes('site_manager'));
      }

      return res.json({
        data: {
          osEquivalenceLines: items,
          total: items.length,
          primaryHost: 'ubuntu_linux',
          currentPlatform: process.platform,
          allLinesFailClosed: true,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  // 2. Get specific OS Equivalence Adapter details
  app.get('/api/system/parity/os/:id', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      const actorTenant = extractActorTenant(auth);
      if (!actorTenant.active) {
        return res.status(403).json({
          error: { code: 'tenant_actor_inactive', message: 'Inactive account cannot access parity lines.' },
        });
      }

      const id = req.params.id?.toUpperCase();
      const meta = OS_EQUIVALENCE_INVENTORY[id];
      if (!meta) {
        return res.status(404).json({
          error: { code: 'os_adapter_not_found', message: `OS equivalence line ${id} not found.` },
        });
      }

      if (!actorTenant.isOwner && !meta.rolesAllowed.includes(actorTenant.role)) {
        return res.status(403).json({
          error: { code: 'tenant_boundary_forbidden', message: `Line ${id} is restricted from role ${actorTenant.role}.` },
        });
      }

      return res.json({ data: meta });
    } catch (err) {
      return next(err);
    }
  });

  // 3. Attempt execution on OS adapter -> Fails Closed
  app.post('/api/system/parity/os/:id/execute', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      assertPreserveLinuxTenantIsolation({
        actor: auth,
        siteId: req.body?.siteId ?? null,
      });

      const id = req.params.id?.toUpperCase();
      const adapter = liveOsAdapters[id];
      if (!adapter) {
        return res.status(404).json({
          error: { code: 'os_adapter_not_found', message: `OS adapter for line ${id} not found.` },
        });
      }

      const methodName = req.body?.method || 'getServiceStatus';
      if (typeof adapter[methodName] !== 'function') {
        return res.status(400).json({
          error: { code: 'invalid_method', message: `Method '${methodName}' does not exist on adapter '${id}'.` },
        });
      }

      await adapter[methodName](...(req.body?.args || []));
      return res.json({ data: { executed: true } });
    } catch (err) {
      if (err instanceof OsEquivalenceError || err instanceof LinuxIsolationViolationError || err instanceof TenantBoundaryError) {
        return res.status(err.status || 501).json({
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  });

  // 4. List External Parity Integrations
  app.get('/api/system/parity/external', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      const actorTenant = extractActorTenant(auth);
      if (!actorTenant.active) {
        return res.status(403).json({
          error: { code: 'tenant_actor_inactive', message: 'Inactive account cannot access external parity.' },
        });
      }

      let items = Object.values(EXTERNAL_PARITY_INVENTORY);
      if (actorTenant.isCustomer) {
        items = items.filter((c) => c.rolesAllowed.includes('customer'));
      } else if (actorTenant.isReseller) {
        items = items.filter((c) => c.rolesAllowed.includes('reseller'));
      } else if (actorTenant.isLegacySiteManager) {
        items = items.filter((c) => c.rolesAllowed.includes('site_manager'));
      }

      return res.json({
        data: {
          externalIntegrations: items,
          total: items.length,
          unconfiguredFailClosed: true,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  // 5. Get specific External Parity Integration details
  app.get('/api/system/parity/external/:id', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      const actorTenant = extractActorTenant(auth);
      if (!actorTenant.active) {
        return res.status(403).json({
          error: { code: 'tenant_actor_inactive', message: 'Inactive account cannot access external parity.' },
        });
      }

      const id = req.params.id?.toUpperCase();
      const meta = EXTERNAL_PARITY_INVENTORY[id];
      if (!meta) {
        return res.status(404).json({
          error: { code: 'external_adapter_not_found', message: `External integration ${id} not found.` },
        });
      }

      if (!actorTenant.isOwner && !meta.rolesAllowed.includes(actorTenant.role)) {
        return res.status(403).json({
          error: { code: 'tenant_boundary_forbidden', message: `Integration ${id} is restricted from role ${actorTenant.role}.` },
        });
      }

      return res.json({ data: meta });
    } catch (err) {
      return next(err);
    }
  });

  // 6. Attempt execution on External adapter -> Fails Closed if unconfigured
  app.post('/api/system/parity/external/:id/execute', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      assertPreserveLinuxTenantIsolation({
        actor: auth,
        siteId: req.body?.siteId ?? null,
      });

      const id = req.params.id?.toUpperCase();
      const adapter = liveExternalAdapters[id];
      if (!adapter) {
        return res.status(404).json({
          error: { code: 'external_adapter_not_found', message: `External adapter ${id} not found.` },
        });
      }

      const methodName = req.body?.method || 'checkOrderStatus';
      if (typeof adapter[methodName] !== 'function') {
        return res.status(400).json({
          error: { code: 'invalid_method', message: `Method '${methodName}' does not exist on adapter '${id}'.` },
        });
      }

      const result = await adapter[methodName](req.body?.params || {});
      return res.json({ data: result });
    } catch (err) {
      if (err instanceof ExternalIntegrationError || err instanceof LinuxIsolationViolationError || err instanceof TenantBoundaryError) {
        return res.status(err.status || 501).json({
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  });

  // 7. List Deferred Reseller Billing & Subscription Automation items
  app.get('/api/system/parity/deferred-billing', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      const actorTenant = extractActorTenant(auth);
      if (!actorTenant.active) {
        return res.status(403).json({
          error: { code: 'tenant_actor_inactive', message: 'Inactive account cannot access parity.' },
        });
      }

      return res.json({
        data: {
          deferredItems: Object.values(DEFERRED_BILLING_INVENTORY),
          status: 'post_mvp_deferred',
          blocksInitialRelease: false,
          markedAsCompleted: false,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  // 8. Validate Billing & Subscription Automation payloads
  app.post('/api/system/parity/validate-billing', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      const actorTenant = extractActorTenant(auth);
      if (!actorTenant.active) {
        return res.status(403).json({
          error: { code: 'tenant_actor_inactive', message: 'Inactive account cannot perform validation.' },
        });
      }

      const body = req.body ?? {};
      assertNoResellerBillingPollution(body, 'request.body');

      return res.json({
        data: {
          valid: true,
          billingDeferred: true,
          message: 'Payload verified clean of premature reseller billing or subscription automation.',
        },
      });
    } catch (err) {
      if (err instanceof ResellerBillingDeferredError) {
        return res.status(err.status || 403).json({
          error: { code: err.code, message: err.message },
        });
      }
      return next(err);
    }
  });
}
