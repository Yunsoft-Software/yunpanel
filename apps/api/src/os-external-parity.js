import { AuthError } from './auth-error.js';
import { TenantBoundaryError, extractActorTenant } from './tenant-boundary.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

// ============================================================================
// PAR-05: OS Equivalence & External Parity Error Hierarchy
// ============================================================================

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

export function listOsEquivalenceAdapters() {
  return Object.values(OS_EQUIVALENCE_INVENTORY);
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

export function mountOsExternalParityRoutes(app) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express application is required');
  }

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

  // 3. OS equivalence lines are a separate track: execution is never supported on this Linux host.
  app.post('/api/system/parity/os/:id/execute', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!extractActorTenant(auth).isOwner) {
        return res.status(403).json({ error: { code: 'forbidden', message: 'Only the Owner can execute parity adapters.' } });
      }
      assertPreserveLinuxTenantIsolation({
        actor: auth,
        siteId: req.body?.siteId ?? null,
      });

      const id = req.params.id?.toUpperCase();
      const meta = OS_EQUIVALENCE_INVENTORY[id];
      if (!meta) {
        return res.status(404).json({
          error: { code: 'os_adapter_not_found', message: `OS adapter for line ${id} not found.` },
        });
      }

      const methodName = req.body?.method || 'getServiceStatus';
      if (!meta.methods.includes(methodName)) {
        return res.status(400).json({
          error: { code: 'invalid_method', message: `Method '${methodName}' does not exist on adapter '${id}'.` },
        });
      }

      return res.status(501).json({
        error: {
          code: 'windows_platform_unsupported',
          message: `OS Equivalence Line '${id}' (${meta.name}) is a separate track and is not supported on this Linux host.`,
        },
      });
    } catch (err) {
      if (err instanceof LinuxIsolationViolationError || err instanceof TenantBoundaryError) {
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

  // 6. External integrations have no configured provider: execution always fails closed.
  app.post('/api/system/parity/external/:id/execute', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!extractActorTenant(auth).isOwner) {
        return res.status(403).json({ error: { code: 'forbidden', message: 'Only the Owner can execute parity adapters.' } });
      }
      assertPreserveLinuxTenantIsolation({
        actor: auth,
        siteId: req.body?.siteId ?? null,
      });

      const id = req.params.id?.toUpperCase();
      const meta = EXTERNAL_PARITY_INVENTORY[id];
      if (!meta) {
        return res.status(404).json({
          error: { code: 'external_adapter_not_found', message: `External adapter ${id} not found.` },
        });
      }

      const methodName = req.body?.method || 'checkOrderStatus';
      if (!meta.methods.includes(methodName)) {
        return res.status(400).json({
          error: { code: 'invalid_method', message: `Method '${methodName}' does not exist on adapter '${id}'.` },
        });
      }

      return res.status(501).json({
        error: {
          code: `${meta.category}_unconfigured`,
          message: `External Parity Line '${id}' (${meta.name}): no external provider is configured. Integration fails closed safely.`,
        },
      });
    } catch (err) {
      if (err instanceof LinuxIsolationViolationError || err instanceof TenantBoundaryError) {
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
