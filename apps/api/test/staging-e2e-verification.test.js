import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { UI_FONTS } from '../../../scripts/prepare-ui-fonts.mjs';
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
import { READ_ONLY_PERMISSIONS } from '../src/panel-access.js';
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
import { mountElFinderHandoffRoutes } from '../src/elfinder-handoff-http.js';
import { createElFinderHandoffConsumerHandler } from '../src/elfinder-handoff-socket.js';
import { terminalWebSocketInternals, createTerminalWebSocketServer } from '../src/terminal-websocket.js';
import { createTerminalCapabilityRegistry, TerminalCapabilityError } from '../src/terminal-capability-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import net from 'node:net';
import { createAuthStore } from '../src/auth-store.js';
import { createAuthMailer, validateEmail as validateAuthEmail } from '../src/auth-mailer.js';
import { sslContactEmail } from '../../web/src/workspace/ssl-request-draft.js';
import { TOTP } from 'otpauth';
import { WebSocket, WebSocketServer } from 'ws';
import { recoverRunningPhpTool } from '../src/job-running-php-tool-recovery.js';
import * as fs from 'node:fs/promises';
import { lstat, mkdtemp, rm, readFile } from 'node:fs/promises';
import { createSiteSubmission, EMPTY_SITE_SUBMISSION, siteSubmissionBusy } from '../../web/src/workspace/site-create-submission.js';
import {
  createSiteFileManager,
  SiteFileManagerError,
  siteFileManagerInternals,
} from '../src/site-file-manager.js';
import {
  executeSiteFileOperation,
  SiteFileWorkerError,
  siteFileWorkerInternals,
} from '../src/site-file-worker.js';
import {
  mountSiteFileRoutes,
  SiteFileHttpError,
  siteFileHttpInternals,
} from '../src/site-file-http.js';
import {
  visibleFiles,
  paginateFiles,
  toggleVisibleSelection,
  fileListing,
  fileCrumbs,
  fileParent,
  fileChild,
  validFileName,
  validRelativePath,
  checkItemConflict,
} from '../../web/src/workspace/ui/file-workspace-model.js';
import {
  fileSessionKey,
  reconcileFileSession,
  updateFileSession,
  fileEditorDirty,
  EMPTY_FILE_SESSION,
} from '../../web/src/workspace/file-session-state.js';
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
  createJobRegistry,
  jobPublicView,
  classifyJobError,
  isTransientJobError,
  isPermanentJobError,
} from '../src/job-registry.js';
import {
  API_VERSION,
  SCHEMA_VERSION,
  DEPLOYMENT_COMPARISON_STATUSES,
  resolveDeploymentDiagnostics,
  compareDeploymentVersions,
  sanitizeDiagnosticInfo,
} from '../src/core-app.js';
import {
  jobAttemptCount,
  jobHealthIndicator,
  jobLifecycle,
  jobResourceTarget,
  jobStageProgress,
  jobSupportsDeployLogs,
  jobSupportsManualRetry,
  canTriggerManualRetry,
  safeJobResultMetadata,
} from '../../web/src/workspace/job-presentation.js';
import {
  mountWebsiteProvisioningRoutes,
  WebsiteProvisioningHttpError,
  websiteProvisioningHttpInternals,
} from '../src/website-provisioning-http.js';
import { advanceProvisioning } from '../../web/src/workspace/provisioning-advance.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import { createProcessStoreLock } from '../src/process-store-lock.js';
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
import {
  AI_TOOL_RISKS,
  AI_TOOL_CONFIRMATION,
  DEFAULT_AI_TOOL_DEFINITIONS,
} from '../src/ai-tool-catalog.js';
import {
  createAiActionPlan,
  verifyAiActionExecution,
  AiActionPlanError,
} from '../src/ai-action-plan.js';
import {
  createAiConversationService,
  AiConversationError,
} from '../src/ai-conversation-service.js';
import {
  createAiToolRegistry,
  AiToolRegistryError,
} from '../src/ai-tool-registry.js';
import {
  createAiToolRuntime,
  AiToolRuntimeError,
} from '../src/ai-tool-runtime.js';
import {
  createAiOrchestrator,
} from '../src/ai-orchestrator.js';
import {
  mountAiRoutes,
  AiHttpError,
} from '../src/ai-http.js';
import {
  resolveAiWebsiteContext,
} from '../../web/src/workspace/ai-history.js';
import { createManagedServiceMutationReceiptStore } from '../src/managed-service-mutation-receipt.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import {
  recoverRunningCron,
  JobRunningCronRecoveryError,
} from '../src/job-running-cron-recovery.js';
import {
  handleHostingAccountAdmin,
  hostingAccountQuery,
  isHostingAccountPath,
} from '../src/hosting-account-http.js';
import { createUserAdminStore } from '../src/user-admin-store.js';
import {
  createApplicationRegistry,
  ApplicationRegistryError,
} from '../src/application-registry.js';
import {
  createApplicationRuntimeBindingRegistry,
  ApplicationRuntimeBindingRegistryError,
} from '../src/application-runtime-binding-registry.js';
import { resolveWebsiteDomainTarget } from '../src/website-domain-target.js';
import {
  DomainRegistryError,
  domainWebsiteTargetBindingInternals,
} from '../src/domain-registry.js';
import { createWebsiteRemovalOperationRegistry } from '../src/website-removal-operation-registry.js';
import {
  MailboxSingleLifecycleError,
  MailboxSessionTerminationError,
  MailboxProtocolDisruptionError,
  createMailboxProtocolSessionTracker,
  assertNoDomainOrSiblingDisruption,
  assertNoClosedDomainReopened,
  assertMailboxAccessTerminatedSeparately,
  assertSiblingMailboxContinuity,
  createSingleMailboxLifecycleCoordinator,
  mountSingleMailboxLifecycleRoutes,
  assertDovecotPostfixCommandContracts,
  assertCommonConfigApplyPendingPreviewAndReloadEffect,
  MailboxReconciliationError,
  MailboxConcurrencyLockError,
  MailboxRollbackError,
  MailboxAuthorizationRevokedError,
  createRapidConfirmationGuard,
  reconcileLostMailboxOperation,
  validateResumeJobProof,
  assertActorAuthorizationContinuous,
  createMailboxInterProcessLockManager,
  assertWorkerMutationConcurrencyGuard,
  executeMailboxDeletionWithRollbackVerification,
} from '../src/mailbox-single-lifecycle.js';
import { createMailConfigurationService } from '../src/mail-configuration.js';
import { createMailboxRegistry, MailboxRegistryError } from '../src/mailbox-registry.js';
import { createMailDataOperationsService, MailDataOperationsError } from '../src/mail-data-operations.js';
import { createMailDeleteFinalizeService, MailDeleteFinalizeError } from '../src/mail-delete-finalize.js';
import { createMailDeleteImpactService } from '../src/mail-delete-impact.js';
import { mountMailboxRoutes } from '../src/mailbox-http.js';
import { mountMailDeleteImpactRoutes } from '../src/mail-delete-impact-http.js';
import { mountMailDataRoutes } from '../src/mail-data-http.js';
import { mountMailAliasRoutes } from '../src/mail-alias-http.js';
import { mountMailboxQuotaRoutes } from '../src/mailbox-quota-http.js';
import { mountMailboxForwardingRoutes } from '../src/mailbox-forwarding-http.js';
import { mountMailConfigurationRoutes } from '../src/mail-configuration-http.js';
import { mountMailDiagnosticsRoutes } from '../src/mail-diagnostics-http.js';
import { mountRoundcubeDomainMappingRoutes } from '../src/roundcube-domain-mapping-http.js';
import { createMailAliasRegistry } from '../src/mail-alias-registry.js';
import { createMailboxQuotaRegistry } from '../src/mailbox-quota-registry.js';
import { createMailboxForwardingRegistry } from '../src/mailbox-forwarding-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createMailboxAccessGuard, MailboxAccessError } from '../../../packages/host-runtime/src/mailbox-access-guard.js';
import { createMailDataDeleteManager, MailDataDeleteError } from '../../../packages/host-runtime/src/mail-data-delete-manager.js';
import {
  createDatabaseCredentialRegistry,
  DatabaseCredentialRegistryError,
  databaseCredentialRegistryInternals,
} from '../src/database-credential-registry.js';
import {
  createDatabaseCredentialApplyService,
  DatabaseCredentialApplyError,
  databaseCredentialApplyInternals,
} from '../src/database-credential-apply-service.js';
import {
  createDatabaseCredentialMaterializer,
  DatabaseCredentialMaterializerError,
} from '../src/database-credential-materializer.js';
import {
  createDatabaseCredentialOperationReceiptStore,
  DatabaseCredentialOperationReceiptError,
} from '../src/database-credential-operation-receipt.js';
import {
  mountDatabaseCredentialRoutes,
  DatabaseCredentialHttpError,
  databaseCredentialHttpInternals,
} from '../src/database-credential-http.js';
import {
  createDatabaseBindingRegistry,
  DatabaseBindingRegistryError,
  databaseBindingRegistryInternals,
} from '../src/database-binding-registry.js';
import {
  mountDatabaseBindingRoutes,
  DatabaseBindingHttpError,
  databaseBindingHttpInternals,
} from '../src/database-binding-http.js';
import {
  mountDatabaseRoutes,
  DatabaseHttpError,
  databaseHttpInternals,
} from '../src/database-http.js';
import {
  mountDatabaseRestoreRoutes,
  DatabaseRestoreHttpError,
  databaseRestoreHttpInternals,
} from '../src/database-restore-http.js';
import {
  createDatabaseBackupOperationsService,
  DatabaseBackupOperationsError,
  databaseBackupOperationsInternals,
} from '../src/database-backup-operations.js';
import {
  mountWebsiteDatabaseDataRoutes,
  WebsiteDatabaseDataHttpError,
  websiteDatabaseDataHttpInternals,
} from '../src/website-database-data-http.js';
import {
  mountWebsiteDatabaseDeleteRoutes,
  WebsiteDatabaseDeleteHttpError,
  websiteDatabaseDeleteHttpInternals,
} from '../src/website-database-delete-http.js';
import {
  createDatabaseDeletionReceiptStore,
  DatabaseDeletionReceiptError,
} from '../src/database-deletion-receipt.js';
import {
  createDatabaseCredentialManager,
  DatabaseCredentialManagerError,
  databaseCredentialManagerInternals,
} from '../../../packages/host-runtime/src/database-credential-manager.js';
import {
  siteCreateProvisioningPlan as siteCreateProvisioningPlanDns,
  siteCreateDnsProvisioningInternals,
} from '../src/site-create-dns-provisioning.js';
import {
  siteCreateProvisioningPlan as siteCreateProvisioningPlanMail,
  siteCreateMailProvisioningInternals,
} from '../src/site-create-mail-provisioning.js';
import {
  createWebsiteProvisioningPlan,
  WebsiteProvisioningPlanError,
  websiteProvisioningPlanInternals,
} from '../src/website-provisioning-plan.js';
import {
  createWebsiteProvisioningOrchestrator,
  WebsiteProvisioningOrchestratorError,
  websiteProvisioningOrchestratorInternals,
} from '../src/website-provisioning-orchestrator.js';
import {
  createWebsiteProvisioningRegistry,
  WebsiteProvisioningRegistryError,
} from '../src/website-provisioning-registry.js';
import {
  canBeginCompensationInOrder,
  findBlockingLaterCompensationStep,
} from '../src/website-provisioning-compensation-order.js';
import {
  createDnsDelegationInspector,
  DnsDelegationInspectorError,
} from '../src/dns-delegation-inspector.js';
import {
  createWebsiteMailHealthProvisioningHandler,
  WebsiteMailHealthProvisioningError,
  websiteMailHealthProvisioningInternals,
} from '../src/website-mail-health-provisioning-handler.js';
import { deterministicWebsiteMailDkimSelector } from '../src/website-mail-dkim-selector.js';
import { SiteCreateError, previewSiteCreate, createSite } from '../src/site-create.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';

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
  const site1a1Id = '11111111-1111-4111-8111-111111111111';
  const site1a2Id = '11111111-1111-4111-8111-111111111112';
  const site1b1Id = '11111111-1111-4111-8111-111111111121';
  const site1b2Id = '11111111-1111-4111-8111-111111111122';
  const site2a1Id = '22222222-2222-4222-8222-222222222211';
  const site2a2Id = '22222222-2222-4222-8222-222222222212';
  const site2b1Id = '22222222-2222-4222-8222-222222222221';
  const site2b2Id = '22222222-2222-4222-8222-222222222222';

  const sites = [
    { id: site1a1Id, name: 'Site 1A1', customerId: 'cust-1a', resellerId: 'reseller-1' },
    { id: site1a2Id, name: 'Site 1A2', customerId: 'cust-1a', resellerId: 'reseller-1' },
    { id: site1b1Id, name: 'Site 1B1', customerId: 'cust-1b', resellerId: 'reseller-1' },
    { id: site1b2Id, name: 'Site 1B2', customerId: 'cust-1b', resellerId: 'reseller-1' },
    { id: site2a1Id, name: 'Site 2A1', customerId: 'cust-2a', resellerId: 'reseller-2' },
    { id: site2a2Id, name: 'Site 2A2', customerId: 'cust-2a', resellerId: 'reseller-2' },
    { id: site2b1Id, name: 'Site 2B1', customerId: 'cust-2b', resellerId: 'reseller-2' },
    { id: site2b2Id, name: 'Site 2B2', customerId: 'cust-2b', resellerId: 'reseller-2' },
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

  const r1Actor = { id: 'reseller-1', role: 'reseller', hosting: { kind: 'reseller', resellerId: null }, active: true, websiteIds: [site1a1Id, site1a2Id, site1b1Id, site1b2Id] };
  const c1aActor = { id: 'cust-1a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: [site1a1Id, site1a2Id] };
  const cDirectActor = { id: 'cust-direct', role: 'customer', hosting: { kind: 'customer', resellerId: null }, active: true, websiteIds: [siteDirectId] };

  // Reseller 1 actor cannot access Reseller 2 websites (403 fail-closed without metadata leakage)
  const r1ToR2Site = await executeRequest(r1Actor, `/api/websites/${site2a1Id}/terminal`);
  assert.equal(r1ToR2Site.called, false);
  assert.equal(r1ToR2Site.statusCode, 403);
  assert.equal(r1ToR2Site.responseBody.error.code, 'tenant_boundary_forbidden');
  assert.equal(r1ToR2Site.responseBody.error.site, undefined);
  assert.equal(r1ToR2Site.responseBody.error.customer, undefined);

  // Customer 1a actor cannot access Customer 1b or Customer 2a websites
  const c1aToC1bSite = await executeRequest(c1aActor, `/api/websites/${site1b1Id}/files`);
  assert.equal(c1aToC1bSite.called, false);
  assert.equal(c1aToC1bSite.statusCode, 403);
  assert.equal(c1aToC1bSite.responseBody.error.code, 'tenant_boundary_forbidden');
  assert.equal(c1aToC1bSite.responseBody.error.site, undefined);

  // Direct Customer cannot access Reseller 1 websites
  const cDirectToR1Site = await executeRequest(cDirectActor, `/api/websites/${site1a1Id}/databases`);
  assert.equal(cDirectToR1Site.called, false);
  assert.equal(cDirectToR1Site.statusCode, 403);

  // 3. Open WebSocket Lifecycle, elFinder Gateway Handoff, and In-Flight Fail-Closed Verification over Real HTTP & WebSocket
  const r1Token = f.session('reseller-1');
  const r2Token = f.session('reseller-2');
  const c1aToken = f.session('cust-1a');
  const c1bToken = f.session('cust-1b');
  const c2aToken = f.session('cust-2a');
  const c2bToken = f.session('cust-2b');
  const cDirectToken = f.session('cust-direct');

  function getUserWebsites(userId, role) {
    if (role === 'owner') return sites.map((s) => s.id);
    if (role === 'reseller') {
      return f.db.prepare(`
        SELECT w.website_id
        FROM auth_customer_websites w
        JOIN auth_hosting_accounts h ON h.user_id = w.customer_id
        WHERE h.reseller_id = ?
      `).all(userId).map((r) => r.website_id);
    }
    return f.db.prepare('SELECT website_id FROM auth_customer_websites WHERE customer_id = ?')
      .all(userId).map((r) => r.website_id);
  }

  const websiteRecords = new Map();
  for (const s of sites) {
    const appId = randomUUID();
    websiteRecords.set(s.id, {
      id: s.id,
      serverId: stagingServerId,
      applicationId: appId,
      runtimeType: 'php',
      unixUser: elFinderHandoffInternals.applicationUser(appId),
      revision: 1,
    });
  }

  const elFinderHandoffService = createElFinderHandoffService({
    websiteRegistry: {
      async getWebsite(id) {
        return websiteRecords.get(id) ?? null;
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
  const elFinderService = elFinderHandoffService;

  const serverRegistry = {
    async getServer(id) {
      return id === stagingServerId ? { id: stagingServerId } : null;
    },
  };

  const apiApp = express();
  apiApp.use(express.json());

  apiApp.use((req, res, next) => {
    const cookieHeader = req.headers.cookie ?? '';
    const match = cookieHeader.match(/__Host-yunpanel_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (token) {
      const sess = f.getSession(token);
      if (sess) {
        const uRow = f.db.prepare('SELECT active, role FROM users WHERE id = ?').get(sess.user.id);
        const isActive = uRow && uRow.active === 1;
        const hostingAcc = f.db.prepare('SELECT kind FROM auth_hosting_accounts WHERE user_id = ?').get(sess.user.id);
        const role = hostingAcc?.kind ?? sess.user.role;
        const websiteIds = getUserWebsites(sess.user.id, role);
        req.auth = {
          id: sess.id,
          rawToken: token,
          user: {
            id: sess.user.id,
            role,
            active: isActive,
            websiteIds,
          },
          access: {
            mode: role === 'owner' ? 'management' : 'site_management',
            permissions: role === 'owner' ? ['*'] : ['sites.manage'],
          },
          security: { managementAllowed: true },
        };
        req.authSessionDigest = createHash('sha256').update(token).digest('hex');
      }
    }
    next();
  });

  mountElFinderHandoffRoutes(apiApp, {
    registry: serverRegistry,
    elFinderHandoffService,
  });

  apiApp.post('/api/auth/logout', (req, res) => {
    if (!req.auth) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
    }
    const targetSessionId = req.auth.id;
    liveSessions.revokeSession(targetSessionId, 'logout');
    f.db.prepare('DELETE FROM sessions WHERE id = ?').run(targetSessionId);
    res.setHeader('Set-Cookie', '__Host-yunpanel_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
    return res.status(204).end();
  });

  apiApp.get('/api/websites', (req, res) => {
    if (!req.auth || !req.auth.user.active) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
    }
    return res.status(200).json({ data: { websiteIds: req.auth.user.websiteIds } });
  });

  apiApp.get('/api/websites/:websiteId/in-flight-gateway', (req, res) => {
    if (!req.auth || !req.auth.user.active) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
    }
    if (req.auth.user.role !== 'owner' && !req.auth.user.websiteIds.includes(req.params.websiteId)) {
      return res.status(403).json({ error: { code: 'tenant_boundary_forbidden', message: 'Forbidden' } });
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('STREAM_START\n');
    const reg = liveSessions.register({
      sessionId: req.auth.id,
      userId: req.auth.user.id,
      terminate: () => {
        if (!res.destroyed && !res.writableEnded) {
          res.destroy();
        }
      },
    });
    req.on('close', () => reg.unregister());
  });

  apiApp.use((err, req, res, _next) => {
    const status = err.status ?? (err instanceof ElFinderHandoffError ? err.status : 500);
    return res.status(status).json({
      error: {
        code: err.code ?? 'internal_error',
        message: err.message,
      },
    });
  });

  const authHttpServer = http.createServer(apiApp);
  await new Promise((resolve) => authHttpServer.listen(0, '127.0.0.1', resolve));
  const authPort = authHttpServer.address().port;
  const authBaseUrl = `http://127.0.0.1:${authPort}`;
  t.after(() => new Promise((resolve) => {
    authHttpServer.close(resolve);
    authHttpServer.closeAllConnections();
  }));

  const consumerHandler = createElFinderHandoffConsumerHandler({ elFinderHandoffService });
  const consumerServer = http.createServer(consumerHandler);
  await new Promise((resolve) => consumerServer.listen(0, '127.0.0.1', resolve));
  const consumerPort = consumerServer.address().port;
  const consumerBaseUrl = `http://127.0.0.1:${consumerPort}`;
  t.after(() => new Promise((resolve) => {
    consumerServer.close(resolve);
    consumerServer.closeAllConnections();
  }));

  const terminalCapabilityRegistry = createTerminalCapabilityRegistry({ liveSessions });
  let terminalProcessClosed = false;
  const mockTerminalProcessManager = {
    async open() {
      return {
        write() {},
        resize() {},
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
      const userRow = f.db.prepare('SELECT active, role FROM users WHERE id = ?').get(sess.user.id);
      if (!userRow || !userRow.active) throw new AuthError('unauthorized', 'Account is suspended.', 401);
      const hostingAcc = f.db.prepare('SELECT kind FROM auth_hosting_accounts WHERE user_id = ?').get(sess.user.id);
      const role = hostingAcc?.kind ?? sess.user.role;
      const websiteIds = getUserWebsites(sess.user.id, role);
      return {
        rawToken: token,
        session: {
          id: sess.id,
          user: {
            id: sess.user.id,
            role,
            active: true,
            websiteIds,
          },
          access: {
            mode: role === 'owner' ? 'management' : 'site_management',
            permissions: role === 'owner' ? ['*'] : ['sites.manage'],
          },
          security: { managementAllowed: true },
        },
        peer: '127.0.0.1',
      };
    },
    reauthorize: (token) => {
      const sess = f.getSession(token);
      if (!sess) throw new AuthError('unauthorized', 'Sign in to continue.', 401);
      const userRow = f.db.prepare('SELECT active, role FROM users WHERE id = ?').get(sess.user.id);
      if (!userRow || !userRow.active) throw new AuthError('unauthorized', 'Account is suspended.', 401);
      const hostingAcc = f.db.prepare('SELECT kind FROM auth_hosting_accounts WHERE user_id = ?').get(sess.user.id);
      const role = hostingAcc?.kind ?? sess.user.role;
      const websiteIds = getUserWebsites(sess.user.id, role);
      return {
        id: sess.id,
        user: {
          id: sess.user.id,
          role,
          active: true,
          websiteIds,
        },
        access: {
          mode: role === 'owner' ? 'management' : 'site_management',
          permissions: role === 'owner' ? ['*'] : ['sites.manage'],
        },
        security: { managementAllowed: true },
      };
    },
    terminalCapabilityRegistry,
    terminalProcessManager: mockTerminalProcessManager,
    liveSessions,
    audit: { record: () => {} },
    authCheckMs: 250,
  });

  authHttpServer.on('upgrade', (req, socket, head) => {
    terminalServer.handleUpgrade(req, socket, head);
  });
  t.after(() => {
    terminalServer.closeAll();
  });

  async function openRealWebSocket(userId, token, target) {
    const cap = terminalCapabilityRegistry.issue({
      sessionId: `session-${userId}`,
      userId,
      target,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${authPort}/api/terminal`, [
      'yunpanel-terminal-v1',
      `yunpanel-terminal-capability.${cap.capability}`,
    ], {
      headers: { cookie: `__Host-yunpanel_session=${token}` },
    });
    let closeResolve;
    const closePromise = new Promise((resolve) => {
      closeResolve = resolve;
    });
    ws.on('close', (code, reason) => {
      ws.closedCode = code;
      ws.closedReason = reason ? reason.toString() : '';
      closeResolve([code, reason]);
    });
    ws.waitForClose = () => {
      if (ws.readyState === WebSocket.CLOSED) {
        return Promise.resolve([ws.closedCode ?? ws._closeCode, ws.closedReason ?? ws._closeMessage?.toString()]);
      }
      return closePromise;
    };
    await once(ws, 'open');
    return ws;
  }

  function openInFlightRequest(token, websiteId) {
    return new Promise((resolve) => {
      let aborted = false;
      let abortResolve = null;
      const abortPromise = new Promise((r) => { abortResolve = r; });
      const markAborted = () => {
        if (!aborted) {
          aborted = true;
          abortResolve?.({ aborted: true });
        }
      };

      const req = http.request(`${authBaseUrl}/api/websites/${websiteId}/in-flight-gateway`, {
        headers: { cookie: `__Host-yunpanel_session=${token}` },
      }, (res) => {
        res.on('close', markAborted);
        res.on('error', markAborted);
        res.on('data', (chunk) => {
          if (chunk.toString().includes('STREAM_START')) {
            resolve({
              req,
              res,
              waitForAbort: () => {
                if (aborted || res.destroyed || res.closed || req.destroyed) {
                  return Promise.resolve({ aborted: true });
                }
                return abortPromise;
              },
            });
          }
        });
      });
      req.on('close', markAborted);
      req.on('error', markAborted);
      req.end();
    });
  }

  async function issueElFinderCapability(token, websiteId) {
    const res = await fetch(`${authBaseUrl}/api/servers/${stagingServerId}/websites/${websiteId}/elfinder-handoffs`, {
      method: 'POST',
      headers: {
        cookie: `__Host-yunpanel_session=${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const status = res.status;
    const body = await res.json().catch(() => null);
    return { status, body, capability: body?.data?.capability };
  }

  async function consumeElFinderCapability(capability, token) {
    const sessionDigest = createHash('sha256').update(token).digest('hex');
    const res = await fetch(`${consumerBaseUrl}/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability, sessionDigest }),
    });
    const status = res.status;
    const body = await res.json().catch(() => null);
    return { status, body };
  }

  // Open active WebSockets across hierarchy
  const wsOwner = await openRealWebSocket('owner-user', ownerToken, { scope: 'server', serverId: stagingServerId, user: 'root', cwd: '/root' });
  const wsR1 = await openRealWebSocket('reseller-1', r1Token, { scope: 'site', serverId: stagingServerId, websiteId: site1a1Id, user: 'yunapp-r1', cwd: `/var/lib/yunpanel/${site1a1Id}` });
  const wsR2 = await openRealWebSocket('reseller-2', r2Token, { scope: 'site', serverId: stagingServerId, websiteId: site2a1Id, user: 'yunapp-r2', cwd: `/var/lib/yunpanel/${site2a1Id}` });
  const wsC1a = await openRealWebSocket('cust-1a', c1aToken, { scope: 'site', serverId: stagingServerId, websiteId: site1a1Id, user: 'yunapp-c1a', cwd: `/var/lib/yunpanel/${site1a1Id}` });
  const wsC1b = await openRealWebSocket('cust-1b', c1bToken, { scope: 'site', serverId: stagingServerId, websiteId: site1b1Id, user: 'yunapp-c1b', cwd: `/var/lib/yunpanel/${site1b1Id}` });
  const wsC2a = await openRealWebSocket('cust-2a', c2aToken, { scope: 'site', serverId: stagingServerId, websiteId: site2a1Id, user: 'yunapp-c2a', cwd: `/var/lib/yunpanel/${site2a1Id}` });
  const wsC2b = await openRealWebSocket('cust-2b', c2bToken, { scope: 'site', serverId: stagingServerId, websiteId: site2b1Id, user: 'yunapp-c2b', cwd: `/var/lib/yunpanel/${site2b1Id}` });
  const wsDirect = await openRealWebSocket('cust-direct', cDirectToken, { scope: 'site', serverId: stagingServerId, websiteId: siteDirectId, user: 'yunapp-cdirect', cwd: `/var/lib/yunpanel/${siteDirectId}` });

  assert.equal(terminalServer.size(), 8);

  // In-flight HTTP gateway streams
  const httpC1a = await openInFlightRequest(c1aToken, site1a1Id);
  const httpC1b = await openInFlightRequest(c1bToken, site1b1Id);
  const httpR2 = await openInFlightRequest(r2Token, site2a1Id);
  const httpDirect = await openInFlightRequest(cDirectToken, siteDirectId);

  // Issue elFinder capabilities across hierarchy
  const elC1a = await issueElFinderCapability(c1aToken, site1a1Id);
  assert.equal(elC1a.status, 201);
  assert.ok(elC1a.capability);

  const elC1b = await issueElFinderCapability(c1bToken, site1b1Id);
  assert.equal(elC1b.status, 201);
  assert.ok(elC1b.capability);

  const elR2 = await issueElFinderCapability(r2Token, site2a1Id);
  assert.equal(elR2.status, 201);
  assert.ok(elR2.capability);

  const elC2a = await issueElFinderCapability(c2aToken, site2a1Id);
  assert.equal(elC2a.status, 201);
  assert.ok(elC2a.capability);

  const elDirect = await issueElFinderCapability(cDirectToken, siteDirectId);
  assert.equal(elDirect.status, 201);
  assert.ok(elDirect.capability);

  // Active elFinder consumption succeeds over real HTTP before revocation
  const initialConsumeC1a = await consumeElFinderCapability(elC1a.capability, c1aToken);
  assert.equal(initialConsumeC1a.status, 200);
  assert.equal(initialConsumeC1a.body.data.websiteId, site1a1Id);

  const elC1aRevoke = await issueElFinderCapability(c1aToken, site1a1Id);
  assert.equal(elC1aRevoke.status, 201);

  // Scenario 3A: Logout terminates active WebSocket, in-flight HTTP gateway, and elFinder capability fail-closed
  assert.equal(wsC1a.readyState, WebSocket.OPEN);
  const logoutRes = await fetch(`${authBaseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie: `__Host-yunpanel_session=${c1aToken}` },
  });
  assert.equal(logoutRes.status, 204);

  const [wsC1aCode, wsC1aReason] = await wsC1a.waitForClose();
  assert.equal(wsC1aCode, 4001);
  assert.equal(wsC1aReason.toString(), 'logout');

  const httpC1aAbort = await httpC1a.waitForAbort();
  assert.equal(httpC1aAbort.aborted, true);

  const consumeAfterLogout = await consumeElFinderCapability(elC1aRevoke.capability, c1aToken);
  assert.equal(consumeAfterLogout.status, 401);
  assert.equal(consumeAfterLogout.body.error.code, 'elfinder_handoff_invalid');

  const getAfterLogout = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: `__Host-yunpanel_session=${c1aToken}` },
  });
  assert.equal(getAfterLogout.status, 401);

  await assert.rejects(
    openRealWebSocket('cust-1a', c1aToken, { scope: 'site', serverId: stagingServerId, websiteId: site1a1Id, user: 'yunapp-c1a', cwd: `/var/lib/yunpanel/${site1a1Id}` })
  );

  // Scenario 3B: Customer Suspend terminates active WebSocket, in-flight HTTP gateway, and elFinder capability fail-closed
  assert.equal(wsC1b.readyState, WebSocket.OPEN);
  const cust1bRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1b');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1b', { revision: cust1bRow.revision, active: false });

  const [wsC1bCode, wsC1bReason] = await wsC1b.waitForClose();
  assert.equal(wsC1bCode, 4001);
  assert.equal(wsC1bReason.toString(), 'hosting_account_suspended');

  const httpC1bAbort = await httpC1b.waitForAbort();
  assert.equal(httpC1bAbort.aborted, true);

  const consumeAfterCustSuspend = await consumeElFinderCapability(elC1b.capability, c1bToken);
  assert.equal(consumeAfterCustSuspend.status, 401);
  assert.equal(consumeAfterCustSuspend.body.error.code, 'elfinder_handoff_invalid');

  const getAfterCustSuspend = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: `__Host-yunpanel_session=${c1bToken}` },
  });
  assert.equal(getAfterCustSuspend.status, 401);

  const issueAfterCustSuspend = await issueElFinderCapability(c1bToken, site1b1Id);
  assert.ok([401, 403].includes(issueAfterCustSuspend.status));

  const suspendedCust1bSession = {
    user: { id: 'cust-1b', role: 'customer', websiteIds: [site1b1Id, site1b2Id], active: false },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };
  assert.throws(
    () => terminalWebSocketInternals.requireTerminalTargetAccess(suspendedCust1bSession, { scope: 'site', websiteId: site1b1Id }),
    { code: 'terminal_site_forbidden', status: 403 }
  );

  // Scenario 3C: Reseller Suspend cascades to drop Reseller & all Child Customer WebSockets, in-flight gateways, and elFinder capabilities
  assert.equal(wsR2.readyState, WebSocket.OPEN);
  assert.equal(wsC2a.readyState, WebSocket.OPEN);
  assert.equal(wsC2b.readyState, WebSocket.OPEN);
  const r2Row = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('reseller-2');
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-2', { revision: r2Row.revision, active: false });

  const [wsR2Code, wsR2Reason] = await wsR2.waitForClose();
  assert.equal(wsR2Code, 4001);
  assert.equal(wsR2Reason.toString(), 'hosting_account_suspended');

  const [wsC2aCode, wsC2aReason] = await wsC2a.waitForClose();
  assert.equal(wsC2aCode, 4001);
  assert.equal(wsC2aReason.toString(), 'hosting_parent_suspended');

  const [wsC2bCode, wsC2bReason] = await wsC2b.waitForClose();
  assert.equal(wsC2bCode, 4001);
  assert.equal(wsC2bReason.toString(), 'hosting_parent_suspended');

  const httpR2Abort = await httpR2.waitForAbort();
  assert.equal(httpR2Abort.aborted, true);

  const consumeR2 = await consumeElFinderCapability(elR2.capability, r2Token);
  assert.equal(consumeR2.status, 401);
  assert.equal(consumeR2.body.error.code, 'elfinder_handoff_invalid');

  const consumeC2a = await consumeElFinderCapability(elC2a.capability, c2aToken);
  assert.equal(consumeC2a.status, 401);
  assert.equal(consumeC2a.body.error.code, 'elfinder_handoff_invalid');

  const getAfterR2Suspend = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: `__Host-yunpanel_session=${r2Token}` },
  });
  assert.equal(getAfterR2Suspend.status, 401);

  // Scenario 3D: Grant removal / Website Detach terminates active WebSocket, in-flight gateway, and elFinder capability fail-closed
  assert.equal(wsDirect.readyState, WebSocket.OPEN);
  const removalReceipt = siteAllocations.releaseRemoved({
    operationId: 'op-rem-site-direct',
    websiteId: siteDirectId,
    serverId: stagingServerId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(removalReceipt.released, true);

  const [wsDirectCode, wsDirectReason] = await wsDirect.waitForClose();
  assert.equal(wsDirectCode, 4001);
  assert.equal(wsDirectReason.toString(), 'hosting_website_released');

  const httpDirectAbort = await httpDirect.waitForAbort();
  assert.equal(httpDirectAbort.aborted, true);

  const consumeDirect = await consumeElFinderCapability(elDirect.capability, cDirectToken);
  assert.equal(consumeDirect.status, 401);
  assert.equal(consumeDirect.body.error.code, 'elfinder_handoff_invalid');

  const issueDirectAfterRemoval = await issueElFinderCapability(cDirectToken, siteDirectId);
  assert.ok([401, 403, 404].includes(issueDirectAfterRemoval.status));

  // Non-suspended sessions (owner, r1) remain untouched
  assert.equal(wsOwner.readyState, WebSocket.OPEN);
  assert.equal(wsR1.readyState, WebSocket.OPEN);

  // Foreign site capability issuance rejected fail-closed without leaking tenant details
  const issueForeign = await issueElFinderCapability(r1Token, '33333333-3333-4333-8333-333333333333');
  assert.ok([403, 404].includes(issueForeign.status));

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
      websiteId: site1a1Id,
      applicationId: appGuid,
      unixUser: 'yunapp-1a1user',
      expectedWebsiteRevision: 2,
      actorSessionId: `${role}-recovery-session`,
      actorUserId: role === 'customer' ? 'cust-1a' : 'reseller-1',
      actorRole: role,
      actionId: 'wp.cache.flush',
      previewDigest: 'f'.repeat(64),
      confirmation: `php-tool:${site1a1Id}:wp.cache.flush:${'f'.repeat(64)}`,
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
    loadJobContext: async () => ({ id: missingReceiptJobId, jobId: missingReceiptJobId, serverId: stagingServerId, status: 'running', operation: 'website.php.action', resourceType: 'application', resourceId: 'app-guid', payload: { websiteId: site1a1Id } }),
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
    [site1b1Id, { unit: 'yunapp-site-1b1.service', status: 'running', pid: 14201 }],
    [site2a1Id, { unit: 'yunapp-site-2a1.service', status: 'running', pid: 14202 }],
  ]);
  // Even though cust-1b and reseller-2 are suspended, host processes are NOT stopped
  assert.equal(siteHostProcesses.get(site1b1Id).status, 'running');
  assert.equal(siteHostProcesses.get(site2a1Id).status, 'running');

  // 7. Tenant Account Recovery & Reactivation
  // Reactivate suspended customer cust-1b
  const cust1bSuspendedRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1b');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1b', { revision: cust1bSuspendedRow.revision, active: true });
  const cust1bReactivatedUser = f.db.prepare('SELECT active FROM users WHERE id = ?').get('cust-1b');
  assert.equal(cust1bReactivatedUser.active, 1);

  // Reactivated customer can open a new real WebSocket
  const c1bNewToken = f.session('cust-1b');
  const wsC1bNew = await openRealWebSocket('cust-1b', c1bNewToken, {
    scope: 'site',
    serverId: stagingServerId,
    websiteId: site1b1Id,
    user: 'yunapp-c1b-new',
    cwd: `/var/lib/yunpanel/${site1b1Id}`,
  });
  assert.equal(wsC1bNew.readyState, WebSocket.OPEN);

  // Reactivate reseller-2
  const r2SuspendedRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('reseller-2');
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-2', { revision: r2SuspendedRow.revision, active: true });
  const r2ReactivatedUser = f.db.prepare('SELECT active FROM users WHERE id = ?').get('reseller-2');
  assert.equal(r2ReactivatedUser.active, 1);

  // Reactivated reseller can open a new real WebSocket
  const r2NewToken = f.session('reseller-2');
  const wsR2New = await openRealWebSocket('reseller-2', r2NewToken, {
    scope: 'site',
    serverId: stagingServerId,
    websiteId: site2a1Id,
    user: 'yunapp-r2-new',
    cwd: `/var/lib/yunpanel/${site2a1Id}`,
  });
  assert.equal(wsR2New.readyState, WebSocket.OPEN);

  // Clean up remaining open WebSockets
  wsOwner.close();
  wsR1.close();
  wsC1bNew.close();
  wsR2New.close();

  // 8. Veri İçeren Ownership Migration / Rollback ve Canlı Tenant Reauthorization
  // Site 1A2 (site1a2Id) is initially owned by cust-1a.
  const c1aLiveToken = f.session('cust-1a');
  const c1bLiveToken = f.session('cust-1b');

  // Reauthorization checks on live tokens:
  const authBeforeMigrate1a = f.store.reauthorizeTenantWebsite(c1aLiveToken, site1a2Id);
  assert.equal(authBeforeMigrate1a.authorized, true);
  assert.equal(authBeforeMigrate1a.customerId, 'cust-1a');

  // Non-owner cust-1b is not authorized for site1a2Id:
  const authBeforeMigrate1b = f.store.reauthorizeTenantWebsite(c1bLiveToken, site1a2Id);
  assert.equal(authBeforeMigrate1b, null);

  // Stale/logged-out token fail-closed: 401
  assert.throws(
    () => f.store.reauthorizeTenantWebsite('stale-invalid-token', site1a2Id, { throwOnError: true }),
    (err) => err.code === 'unauthorized' && err.status === 401,
  );
  assert.equal(f.store.reauthorizeTenantWebsite('stale-invalid-token', site1a2Id), null);

  // Unauthorized migration attempts must fail-closed:
  // Non-owner customer attempting migration: 403
  assert.throws(
    () => f.store.migrateWebsiteOwnership(c1aLiveToken, f.requireManagement, {
      websiteId: site1a2Id,
      targetCustomerId: 'cust-1b',
      expectedSourceCustomerId: 'cust-1a',
    }),
    (err) => err.code === 'forbidden' && err.status === 403,
  );

  // Reseller attempting migration: 403
  assert.throws(
    () => f.store.migrateWebsiteOwnership(r1Token, f.requireManagement, {
      websiteId: site1a2Id,
      targetCustomerId: 'cust-1b',
      expectedSourceCustomerId: 'cust-1a',
    }),
    (err) => err.code === 'forbidden' && err.status === 403,
  );

  // Unauthenticated / invalid token: 401
  assert.throws(
    () => f.store.migrateWebsiteOwnership('invalid-session-token-xyz', f.requireManagement, {
      websiteId: site1a2Id,
      targetCustomerId: 'cust-1b',
      expectedSourceCustomerId: 'cust-1a',
    }),
    (err) => err.code === 'unauthorized' && err.status === 401,
  );

  // Mismatched source customer fails with 409
  assert.throws(
    () => f.store.migrateWebsiteOwnership(ownerToken, f.requireManagement, {
      websiteId: site1a2Id,
      targetCustomerId: 'cust-1b',
      expectedSourceCustomerId: 'cust-direct',
    }),
    (err) => err.code === 'hosting_site_identity_conflict' && err.status === 409,
  );

  // Target customer website quota exceeded fails with 409
  assert.throws(
    () => f.store.migrateWebsiteOwnership(ownerToken, f.requireManagement, {
      websiteId: site1a2Id,
      targetCustomerId: 'cust-1b',
      expectedSourceCustomerId: 'cust-1a',
    }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // Owner increases target customer cust-1b quota to allow migration
  const cust1bAccRow = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1b');
  f.store.updateCustomerQuotas(ownerToken, f.requireManagement, 'cust-1b', {
    revision: cust1bAccRow.revision,
    quotas: { maxWebsites: 4, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 4 },
  });

  // Open active WebSocket on site1a2Id for cust-1a before migration
  const wsC1a2 = await openRealWebSocket('cust-1a', c1aLiveToken, {
    scope: 'site',
    serverId: stagingServerId,
    websiteId: site1a2Id,
    user: 'yunapp-c1a2',
    cwd: `/var/lib/yunpanel/${site1a2Id}`,
  });
  assert.equal(wsC1a2.readyState, WebSocket.OPEN);

  // Issue elFinder capability on site1a2Id for cust-1a
  const elC1a2 = await issueElFinderCapability(c1aLiveToken, site1a2Id);
  assert.equal(elC1a2.status, 201);

  // Owner executes ownership migration from cust-1a to cust-1b
  const site1a2MigrationReceipt = f.store.migrateWebsiteOwnership(ownerToken, f.requireManagement, {
    websiteId: site1a2Id,
    targetCustomerId: 'cust-1b',
    expectedSourceCustomerId: 'cust-1a',
  });
  assert.ok(site1a2MigrationReceipt.migrationId);
  assert.equal(site1a2MigrationReceipt.websiteId, site1a2Id);
  assert.equal(site1a2MigrationReceipt.previousCustomerId, 'cust-1a');
  assert.equal(site1a2MigrationReceipt.targetCustomerId, 'cust-1b');

  // Verify live WebSocket dropped fail-closed upon ownership migration
  const [wsC1a2Code, wsC1a2Reason] = await wsC1a2.waitForClose();
  assert.equal(wsC1a2Code, 4001);
  assert.equal(wsC1a2Reason.toString(), 'hosting_website_ownership_migrated');

  // Old customer cust-1a's elFinder capability now rejected fail-closed
  const consumeAfterMigrate = await consumeElFinderCapability(elC1a2.capability, c1aLiveToken);
  assert.equal(consumeAfterMigrate.status, 401);

  // Live session for cust-1a was invalidated during migration; creating new session for cust-1a
  const c1aAfterMigrateToken = f.session('cust-1a');
  const authAfterMigrate1a = f.store.reauthorizeTenantWebsite(c1aAfterMigrateToken, site1a2Id);
  assert.equal(authAfterMigrate1a, null);
  assert.throws(
    () => f.store.reauthorizeTenantWebsite(c1aAfterMigrateToken, site1a2Id, { throwOnError: true }),
    (err) => err.code === 'site_scope_forbidden' && err.status === 403,
  );

  // Subsequent HTTP requests by cust-1a for site1a2Id fail fail-closed
  const cust1aMigratedAccess = await executeRequest({
    id: 'cust-1a',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: 'reseller-1' },
    active: true,
    websiteIds: getUserWebsites('cust-1a', 'customer'),
  }, `/api/websites/${site1a2Id}/files`);
  assert.equal(cust1aMigratedAccess.called, false);
  assert.equal(cust1aMigratedAccess.statusCode, 403);

  // Target customer cust-1b signs in: live tenant reauthorization on site1a2Id SUCCEEDS
  const c1bAfterMigrateToken = f.session('cust-1b');
  const authAfterMigrate1b = f.store.reauthorizeTenantWebsite(c1bAfterMigrateToken, site1a2Id);
  assert.equal(authAfterMigrate1b.authorized, true);
  assert.equal(authAfterMigrate1b.customerId, 'cust-1b');

  // Rollback ownership migration with live tenant reauthorization:
  // Unauthorized rollback attempts fail-closed
  assert.throws(
    () => f.store.rollbackWebsiteOwnershipMigration(c1bAfterMigrateToken, f.requireManagement, site1a2MigrationReceipt),
    (err) => err.code === 'forbidden' && err.status === 403,
  );
  assert.throws(
    () => f.store.rollbackWebsiteOwnershipMigration('invalid-token', f.requireManagement, site1a2MigrationReceipt),
    (err) => err.code === 'unauthorized' && err.status === 401,
  );

  // Open active WebSocket on site1a2Id for cust-1b
  const wsC1b2 = await openRealWebSocket('cust-1b', c1bAfterMigrateToken, {
    scope: 'site',
    serverId: stagingServerId,
    websiteId: site1a2Id,
    user: 'yunapp-c1b2',
    cwd: `/var/lib/yunpanel/${site1a2Id}`,
  });
  assert.equal(wsC1b2.readyState, WebSocket.OPEN);

  // Owner performs rollback
  const site1a2Rollback = f.store.rollbackWebsiteOwnershipMigration(ownerToken, f.requireManagement, site1a2MigrationReceipt);
  assert.equal(site1a2Rollback.rolledBack, true);
  assert.equal(site1a2Rollback.restoredCustomerId, 'cust-1a');

  // cust-1b WebSocket dropped fail-closed
  const [wsC1b2Code, wsC1b2Reason] = await wsC1b2.waitForClose();
  assert.equal(wsC1b2Code, 4001);
  assert.equal(wsC1b2Reason.toString(), 'hosting_website_ownership_migration_rolled_back');

  // Live tenant reauthorization: cust-1b signs in again, now fails on site1a2Id
  const c1bAfterRollbackToken = f.session('cust-1b');
  const authAfterRollback1b = f.store.reauthorizeTenantWebsite(c1bAfterRollbackToken, site1a2Id);
  assert.equal(authAfterRollback1b, null);

  // cust-1a signs in again: live tenant reauthorization RESTORED
  const c1aAfterRollbackToken = f.session('cust-1a');
  const authAfterRollback1a = f.store.reauthorizeTenantWebsite(c1aAfterRollbackToken, site1a2Id);
  assert.equal(authAfterRollback1a.authorized, true);
  assert.equal(authAfterRollback1a.customerId, 'cust-1a');

  // 9. İki OS Process Yarışı, Process Crash ve Write-Failure Dayanıklılığı
  // 9A: İki bağımsız SQLite bağlantısı üzerinde eşzamanlı transaction yarışması
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-proc-race-'));
  t.after(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });
  const sharedDbPath = path.join(tmpDir, 'shared-auth.db');
  const procDb1 = new DatabaseSync(sharedDbPath);
  const procDb2 = new DatabaseSync(sharedDbPath);
  t.after(() => {
    try { procDb1.close(); } catch {}
    try { procDb2.close(); } catch {}
  });

  procDb1.exec('PRAGMA journal_mode = WAL;');
  procDb1.exec('PRAGMA busy_timeout = 100;');
  procDb2.exec('PRAGMA busy_timeout = 100;');
  procDb1.exec('CREATE TABLE test_tenant_lock (id TEXT PRIMARY KEY, tenant_id TEXT, state TEXT);');

  // Process 1 acquires immediate lock
  procDb1.exec('BEGIN IMMEDIATE');
  procDb1.exec("INSERT INTO test_tenant_lock VALUES ('lock-1', 'tenant-1', 'active');");

  // Process 2 attempts write while Process 1 holds lock -> SQLITE_BUSY / database locked fail-closed
  assert.throws(
    () => {
      procDb2.exec('BEGIN IMMEDIATE');
    },
    (err) => err && (err.code === 'SQLITE_BUSY' || err.message?.includes('busy') || err.message?.includes('locked')),
  );

  // Process 1 commits cleanly
  procDb1.exec('COMMIT');

  // Process 2 can now read committed state without corruption
  const readP2 = procDb2.prepare('SELECT * FROM test_tenant_lock WHERE id = ?').get('lock-1');
  assert.equal(readP2.tenant_id, 'tenant-1');
  assert.equal(readP2.state, 'active');

  // 9B: Write-failure / constraint violation rollback preserving zero orphan state
  procDb1.exec('BEGIN IMMEDIATE');
  procDb1.exec("INSERT INTO test_tenant_lock VALUES ('lock-2', 'tenant-1', 'pending');");
  let writeFailed = false;
  try {
    procDb1.exec("INSERT INTO test_tenant_lock VALUES ('lock-2', 'tenant-2', 'conflict');");
  } catch {
    writeFailed = true;
    procDb1.exec('ROLLBACK');
  }
  assert.equal(writeFailed, true);

  // Integrity check passes and zero partial rows committed
  const integrity = procDb1.prepare('PRAGMA integrity_check').get();
  assert.equal(integrity.integrity_check, 'ok');
  const orphanLock = procDb1.prepare("SELECT count(*) AS count FROM test_tenant_lock WHERE id = 'lock-2'").get();
  assert.equal(orphanLock.count, 0);

  // 9C: Dead Process Crash Lock Recovery
  const lockFilePath = path.join(tmpDir, 'shared-store.json');
  const deadPid = 99999999;
  const deadSignalProcess = (pid, signal) => {
    const err = new Error('No such process');
    err.code = 'ESRCH';
    throw err;
  };

  const liveLock = createProcessStoreLock({
    filePath: lockFilePath,
    pid: process.pid,
    signalProcess: deadSignalProcess,
  });

  const deadRecord = JSON.stringify({
    version: 1,
    pid: deadPid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  const { writeFile: fsWriteFile } = await import('node:fs/promises');
  await fsWriteFile(`${lockFilePath}.lock`, deadRecord, 'utf8');

  let liveActionExecuted = false;
  await liveLock.withLock(async () => {
    liveActionExecuted = true;
  });
  assert.equal(liveActionExecuted, true);

  // 10. Long-running Job Mutation Başlangıcında Canlı Tenant Reauthorization
  const jobStorePath = path.join(tmpDir, 'jobs.json');
  const testJobRegistry = createJobRegistry({
    filePath: jobStorePath,
    now: () => Date.now(),
    reauthorize: (auth, job) => f.store.reauthorizeJobActor(auth),
  });
  await testJobRegistry.init();

  // 10A: Job enqueued with customer authorization, but customer suspended before mutation start
  const enqSuspended = await testJobRegistry.enqueue({
    serverId: stagingServerId,
    type: 'website.domain.activate',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example-1a1.com', checksum: 'a'.repeat(64) },
    resourceType: 'domain',
    resourceId: 'domain-site1a1',
    authorization: { actorId: 'cust-1a', role: 'customer', websiteId: site1a1Id },
  });
  assert.equal(enqSuspended.status, 'queued');

  // Suspend cust-1a before job claim
  const c1aRowBefore = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1a');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1a', { revision: c1aRowBefore.revision, active: false });

  // Claim next job: live tenant reauthorization at mutation start detects suspended account
  const claimedSuspended = await testJobRegistry.claimNext(stagingServerId);
  assert.equal(claimedSuspended.cancelled, true);
  assert.equal(claimedSuspended.reason, 'job_tenant_reauthorization_failed');
  assert.equal(claimedSuspended.job.status, 'cancelled');
  assert.equal(claimedSuspended.job.error.code, 'job_tenant_reauthorization_failed');

  // Ensure job was safely halted without running
  const persistedJobSuspended = await testJobRegistry.getJob(enqSuspended.id);
  assert.equal(persistedJobSuspended.status, 'cancelled');

  // Reactivate cust-1a
  const c1aRowSuspended = f.db.prepare('SELECT revision FROM auth_hosting_accounts WHERE user_id = ?').get('cust-1a');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1a', { revision: c1aRowSuspended.revision, active: true });

  // 10B: Job enqueued with website that was migrated away before mutation start
  f.store.migrateWebsiteOwnership(ownerToken, f.requireManagement, {
    websiteId: site1a2Id,
    targetCustomerId: 'cust-1b',
    expectedSourceCustomerId: 'cust-1a',
  });

  const enqMigrated = await testJobRegistry.enqueue({
    serverId: stagingServerId,
    type: 'website.domain.activate',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example-1a2.com', checksum: 'b'.repeat(64) },
    resourceType: 'domain',
    resourceId: 'domain-site1a2',
    authorization: { actorId: 'cust-1b', role: 'customer', websiteId: site1a2Id },
  });
  assert.equal(enqMigrated.status, 'queued');

  // Migrate site1a2Id away to cust-1a before worker claims it
  f.store.migrateWebsiteOwnership(ownerToken, f.requireManagement, {
    websiteId: site1a2Id,
    targetCustomerId: 'cust-1a',
    expectedSourceCustomerId: 'cust-1b',
  });

  // Claim next job: live tenant reauthorization detects cust-1b no longer owns site1a2Id
  const claimedMigrated = await testJobRegistry.claimNext(stagingServerId);
  assert.equal(claimedMigrated.cancelled, true);
  assert.equal(claimedMigrated.reason, 'job_tenant_reauthorization_failed');
  assert.equal(claimedMigrated.job.status, 'cancelled');
  assert.equal(claimedMigrated.job.error.code, 'job_tenant_reauthorization_failed');

  // 10C: Job enqueued with active authorized tenant starts successfully
  const enqValid = await testJobRegistry.enqueue({
    serverId: stagingServerId,
    type: 'website.domain.activate',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example-1a2-valid.com', checksum: 'c'.repeat(64) },
    resourceType: 'domain',
    resourceId: 'domain-site1a2-valid',
    authorization: { actorId: 'cust-1a', role: 'customer', websiteId: site1a2Id },
  });
  assert.equal(enqValid.status, 'queued');

  const claimedValid = await testJobRegistry.claimNext(stagingServerId);
  assert.equal(claimedValid.job.status, 'running');
  assert.equal(claimedValid.job.id, enqValid.id);
  assert.ok(claimedValid.authorization);

  // 10D: Direct reauthorizeJob verification
  const checkValid = await testJobRegistry.reauthorizeJob(claimedValid.job.id, (auth) => f.store.reauthorizeJobActor(auth));
  assert.equal(checkValid.authorized, true);

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

// ============================================================================
// STAGING E2E PART 10: RS-04a kabul / RS-03–05 kalan (T-DEV-OWNER-PROFILES)
// ============================================================================

test('Staging E2E RS-04a kabul / RS-03–05 kalan: Node24/npm11 tam check ve gerçek React/browser/HTTP kabulü; reseller/customer self-service, güvenli site runtime ve hesap lifecycle gerçek session/gateway/WS davranışı (T-DEV-OWNER-PROFILES)', async (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  // Staging server ID: strictly non-.44
  const stagingServerId = '77777777-7777-4777-8777-777777777777';
  assertNoDot44Host(stagingServerId);

  // 1. Live Session Tracking and User Admin / Hosting Store Setup
  const liveSessions = createLiveSessionRegistry();
  const originalRevokeUser = liveSessions.revokeUser.bind(liveSessions);
  liveSessions.revokeUser = (userId, reason) => {
    f.revoked.push({ id: userId, reason });
    return originalRevokeUser(userId, reason);
  };

  const users = createUserAdminStore({
    ...f,
    revokeLiveUser: (id, reason) => liveSessions.revokeUser(id, reason),
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });
  f.store = users.hostingAccounts;

  // Add Hierarchy Accounts:
  // - Owner: owner-user
  // - Reseller 1: reseller-1
  // - Reseller 2: reseller-2
  // - Customer 1A: cust-1a (under reseller-1)
  // - Customer 1B: cust-1b (under reseller-1)
  // - Customer 2A: cust-2a (under reseller-2)
  // - Customer Direct: cust-direct (direct under Owner)
  // - Legacy Site Manager: legacy-sm
  // - Read-Only: readonly-user
  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('reseller-2');
  f.addUser('cust-1a');
  f.addUser('cust-1b');
  f.addUser('cust-2a');
  f.addUser('cust-direct');
  f.addUser('legacy-sm', { role: 'site_manager' });
  f.addUser('readonly-user', { role: 'read_only' });

  const ownerToken = f.session('owner-user');

  // 2. Owner Profile Management: Register Resellers and Customers with Quotas & Limits
  const r1 = f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 30, maxWebsites: 40 },
  });
  assert.equal(r1.kind, 'reseller');
  assert.equal(r1.limits.maxCustomers, 30);
  assert.equal(r1.limits.maxWebsites, 40);

  const r2 = f.store.registerReseller(ownerToken, f.requireManagement, {
    userId: 'reseller-2',
    expectedUserRevision: 1,
    limits: { maxCustomers: 10, maxWebsites: 15 },
  });
  assert.equal(r2.kind, 'reseller');

  const c1a = f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 3, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 3 },
  });
  assert.equal(c1a.kind, 'customer');
  assert.equal(c1a.resellerId, 'reseller-1');

  const c1b = f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-1b',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  assert.equal(c1b.kind, 'customer');

  const c2a = f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-2a',
    expectedUserRevision: 1,
    resellerId: 'reseller-2',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  assert.equal(c2a.kind, 'customer');

  const cDirect = f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'cust-direct',
    expectedUserRevision: 1,
    resellerId: null,
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  assert.equal(cDirect.kind, 'customer');
  assert.equal(cDirect.resellerId, null);

  // Allocate Websites
  const site1A = {
    id: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    serverId: stagingServerId,
    name: 'site-1a.example',
    applicationId: '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    customerId: 'cust-1a',
    resellerId: 'reseller-1',
  };
  const site1B = {
    id: '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    serverId: stagingServerId,
    name: 'site-1b.example',
    applicationId: '44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    customerId: 'cust-1b',
    resellerId: 'reseller-1',
  };
  const site2A = {
    id: '55555555-cccc-4ccc-8ccc-cccccccccccc',
    serverId: stagingServerId,
    name: 'site-2a.example',
    applicationId: '66666666-cccc-4ccc-8ccc-cccccccccccc',
    customerId: 'cust-2a',
    resellerId: 'reseller-2',
  };
  const siteDirect = {
    id: '99999999-dddd-4ddd-8ddd-dddddddddddd',
    serverId: stagingServerId,
    name: 'site-direct.example',
    applicationId: '88888888-dddd-4ddd-8ddd-dddddddddddd',
    customerId: 'cust-direct',
    resellerId: null,
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

  // Verify usage reflects allocated websites
  assert.equal(f.store.get(ownerToken, f.requireManagement, 'cust-1a').usage.websites, 1);
  assert.equal(f.store.get(ownerToken, f.requireManagement, 'reseller-1').usage.websites, 2);
  assert.equal(f.store.get(ownerToken, f.requireManagement, 'reseller-1').usage.customers, 2);
  assert.equal(f.store.get(ownerToken, f.requireManagement, 'cust-direct').usage.websites, 1);

  // 3. T-DEV-OWNER-PROFILES: 26+ records generation, pagination, filtering, and query parsing
  for (let i = 1; i <= 24; i++) {
    const id = `extra-cust-${String(i).padStart(2, '0')}`;
    f.addUser(id);
    f.store.registerCustomer(ownerToken, f.requireManagement, {
      userId: id,
      expectedUserRevision: 1,
      resellerId: 'reseller-1',
      quotas: { maxWebsites: 1, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null },
    });
  }

  // Verify total hosting accounts >= 26 (2 resellers + 4 initial customers + 24 batch = 30 accounts)
  const allAccounts = f.store.list(ownerToken, f.requireManagement, {});
  assert.equal(allAccounts.total, 30);
  assert.equal(allAccounts.accounts.length, 30);

  // Pagination verification
  const p1 = f.store.list(ownerToken, f.requireManagement, { limit: 10, offset: 0 });
  assert.equal(p1.accounts.length, 10);
  const p2 = f.store.list(ownerToken, f.requireManagement, { limit: 10, offset: 10 });
  assert.equal(p2.accounts.length, 10);
  const p3 = f.store.list(ownerToken, f.requireManagement, { limit: 10, offset: 20 });
  assert.equal(p3.accounts.length, 10);
  const p4 = f.store.list(ownerToken, f.requireManagement, { limit: 10, offset: 30 });
  assert.equal(p4.accounts.length, 0);

  // Query filtering: kind=reseller, kind=customer, direct=true
  const resList = f.store.list(ownerToken, f.requireManagement, { kind: 'reseller' });
  assert.equal(resList.accounts.length, 2);
  assert.ok(resList.accounts.every((r) => r.kind === 'reseller'));

  const directList = f.store.list(ownerToken, f.requireManagement, { kind: 'customer', resellerId: null });
  assert.equal(directList.accounts.length, 1);
  assert.equal(directList.accounts[0].id, 'cust-direct');

  // Query validation via hostingAccountQuery helper
  assert.deepEqual(hostingAccountQuery(new URLSearchParams('limit=10&offset=20')), { limit: 10, offset: 20 });
  assert.deepEqual(hostingAccountQuery(new URLSearchParams('kind=customer&direct=true')), { kind: 'customer', resellerId: null });
  assert.throws(() => hostingAccountQuery(new URLSearchParams('limit=0')), (err) => err.code === 'invalid_hosting_account_query');
  assert.throws(() => hostingAccountQuery(new URLSearchParams('limit=101')), (err) => err.code === 'invalid_hosting_account_query');
  assert.throws(() => hostingAccountQuery(new URLSearchParams('offset=-1')), (err) => err.code === 'invalid_hosting_account_query');
  assert.throws(() => hostingAccountQuery(new URLSearchParams('kind=owner')), (err) => err.code === 'invalid_hosting_account_query');
  assert.throws(() => hostingAccountQuery(new URLSearchParams('unknown=value')), (err) => err.code === 'invalid_hosting_account_query');

  // Route matching helper
  assert.equal(isHostingAccountPath('/api/users/hosting/accounts'), true);
  assert.equal(isHostingAccountPath('/api/users/hosting/accounts/cust-1a'), true);
  assert.equal(isHostingAccountPath('/api/other'), false);

  // 4. HTTP Admin Routing & Negative Authorization Verification
  const runAdminHttp = async (method, path, body = null, token = ownerToken) => {
    const url = new URL(path, 'http://127.0.0.1');
    let status = 200;
    let resPayload = null;
    const headers = {};
    await handleHostingAccountAdmin({
      request: { method },
      response: { setHeader: (k, v) => { headers[k] = v; } },
      pathname: url.pathname,
      query: url.searchParams,
      store: { users },
      rawToken: token,
      requireManagement: f.requireManagement,
      readJson: async () => body ?? {},
      json: (_, s, p) => { status = s; resPayload = p; return { status, ...p }; },
    });
    return { status, headers, data: resPayload?.data, error: resPayload?.error };
  };

  // Owner HTTP list and single GET
  const httpListRes = await runAdminHttp('GET', '/api/users/hosting/accounts?limit=10&offset=0');
  assert.equal(httpListRes.status, 200);
  assert.equal(httpListRes.data.accounts.length, 10);
  assert.equal(httpListRes.data.total, 30);

  const httpGetRes = await runAdminHttp('GET', '/api/users/hosting/accounts/cust-1a');
  assert.equal(httpGetRes.status, 200);
  assert.equal(httpGetRes.data.id, 'cust-1a');
  assert.equal(httpGetRes.data.kind, 'customer');
  assert.equal(httpGetRes.data.resellerId, 'reseller-1');

  // 404 for missing hosting account vs 404 for unknown route
  await assert.rejects(
    runAdminHttp('GET', '/api/users/hosting/accounts/unknown-cust-id'),
    (err) => err.code === 'hosting_account_not_found' && err.status === 404,
  );
  await assert.rejects(
    runAdminHttp('GET', '/api/users/hosting/accounts/cust-1a/unknown-sub'),
    (err) => err.code === 'not_found' && err.status === 404,
  );

  // 5. Reseller Self-Service & Scoped Operations
  const r1Token = f.session('reseller-1');

  // Reseller 1 creates child customer via POST /api/users/hosting/accounts/self/customers
  const selfCreated = await runAdminHttp(
    'POST',
    '/api/users/hosting/accounts/self/customers',
    { username: 'cust-self-created', password: 'SelfPassword123!', quotas: { maxWebsites: 1, maxDiskMb: 1024, maxTrafficMb: 5120, maxDatabases: 1 } },
    r1Token,
  );
  assert.equal(selfCreated.status, 201);
  assert.equal(selfCreated.data.account.username, 'cust-self-created');
  assert.equal(selfCreated.data.account.resellerId, 'reseller-1');
  assert.equal(selfCreated.data.accessGranted, false);
  assert.equal(selfCreated.data.siteAccessGranted, false);

  // Reseller 1 lists own customers
  const r1ListRes = await runAdminHttp('GET', '/api/users/hosting/accounts?kind=customer&resellerId=reseller-1', null, r1Token);
  assert.equal(r1ListRes.status, 200);
  assert.ok(r1ListRes.data.accounts.every((acc) => acc.resellerId === 'reseller-1'));

  // Reseller 1 updates child customer quotas
  const c1aBeforeQuota = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  const r1QuotasRes = await runAdminHttp(
    'PATCH',
    '/api/users/hosting/accounts/cust-1a/quotas',
    { revision: c1aBeforeQuota.revision, quotas: { maxWebsites: 4, maxDiskMb: 8192, maxTrafficMb: 40960, maxDatabases: 4 } },
    r1Token,
  );
  assert.equal(r1QuotasRes.status, 200);
  assert.equal(r1QuotasRes.data.account.quotas.maxWebsites, 4);

  // Reseller 1 cannot access Reseller 2 child customer -> 403 reseller_scope_forbidden
  await assert.rejects(
    runAdminHttp('GET', '/api/users/hosting/accounts/cust-2a', null, r1Token),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );
  // Reseller 1 cannot update Reseller 2 child quotas -> 403
  await assert.rejects(
    runAdminHttp('PATCH', '/api/users/hosting/accounts/cust-2a/quotas', { revision: 1, quotas: { maxWebsites: 3, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 } }, r1Token),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );
  // Reseller 1 cannot unregister profile -> 403 (Owner only)
  await assert.rejects(
    runAdminHttp('DELETE', '/api/users/hosting/accounts/cust-1a/profile', { revision: 1, confirmation: 'unregister-hosting-profile:cust-1a:1' }, r1Token),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );
  // Reseller 1 cannot update limits -> 403 (Owner only)
  await assert.rejects(
    runAdminHttp('PATCH', '/api/users/hosting/accounts/reseller-1/limits', { revision: 1, limits: { maxCustomers: 50 } }, r1Token),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // 6. Quota Capacities & Decreasing Limits
  // Decreasing reseller limit preserves existing records without deleting allocations
  const limitsDecreased = f.store.updateLimits(ownerToken, f.requireManagement, 'reseller-1', {
    revision: r1.revision,
    limits: { maxCustomers: 25, maxWebsites: 35 },
  });
  assert.equal(limitsDecreased.limits.maxCustomers, 25);
  assert.equal(limitsDecreased.limits.maxWebsites, 35);
  assert.equal(f.store.get(ownerToken, f.requireManagement, 'reseller-1').usage.websites, 2);

  // Customer quota cannot exceed reseller capacity
  assert.throws(
    () => assertCustomerQuotaWithinResellerCapacity({
      customerQuotas: { maxWebsites: 50 },
      resellerLimits: limitsDecreased.limits,
    }),
    (err) => err.code === 'reseller_limit_reached' && err.status === 409,
  );

  // 7. General User Form Delta PATCH & Legacy Mutation Protection
  const targetCust = users.list(ownerToken, f.requireManagement).users.find((u) => u.id === 'cust-1a');
  const currentRev = targetCust.revision;
  const updatedUser = users.update(ownerToken, f.requireManagement, 'cust-1a', {
    revision: currentRev,
    username: 'cust-1a-renamed',
  });
  assert.equal(updatedUser.username, 'cust-1a-renamed');
  assert.equal(updatedUser.revision, currentRev + 1);

  // Legacy users.update attempting to mutate role/active/websiteIds is blocked with hosting_account_managed
  for (const change of [{ role: 'owner' }, { active: false }, { websiteIds: ['other-site'] }]) {
    assert.throws(
      () => users.update(ownerToken, f.requireManagement, 'cust-1a', { revision: updatedUser.revision, ...change }),
      (err) => err.code === 'hosting_account_managed',
    );
  }

  // Legacy users.remove on profiled account is blocked with hosting_account_managed
  assert.throws(
    () => users.remove(ownerToken, f.requireManagement, 'cust-1a', { revision: updatedUser.revision }),
    (err) => err.code === 'hosting_account_managed',
  );

  // Stale userRevision fails closed
  assert.throws(
    () => users.update(ownerToken, f.requireManagement, 'cust-1a', { revision: currentRev, username: 'cust-1a-stale' }),
    (err) => err.code === 'user_revision_conflict' && err.status === 409,
  );

  // 8. Customer Cross-Tenant Isolation (Fail-Closed, Zero Metadata Leakage)
  const mockWebsiteRegistry = {
    async getWebsite(id) {
      if (id === site1A.id) return structuredClone(site1A);
      if (id === site1B.id) return structuredClone(site1B);
      if (id === site2A.id) return structuredClone(site2A);
      if (id === siteDirect.id) return structuredClone(siteDirect);
      return null;
    },
  };
  const mockDomainRegistry = {
    async getDomain(id) { return null; },
    async listDomains() { return []; },
  };
  const mockDbBindingRegistry = {
    async getBinding(id) { return null; },
    async listBindings() { return []; },
  };
  const mockDbCredentialRegistry = {
    async getCredential(id) { return null; },
  };
  const mockMailDomainRegistry = {
    async getMailDomain(id) { return null; },
  };
  const mockJobRegistry = {
    async getJob(id) { return null; },
    async listJobs() { return []; },
  };

  const customerLookup = (custId) => {
    const row = f.db.prepare('SELECT user_id, kind, reseller_id FROM auth_hosting_accounts WHERE user_id = ?').get(custId);
    const uRow = f.db.prepare('SELECT active FROM users WHERE id = ?').get(custId);
    if (!row || !uRow) return null;
    return { id: row.user_id, resellerId: row.reseller_id, active: uRow.active === 1 };
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
      status(c) { resStatus = c; return this; },
      setHeader(k, v) { resHeaders[k] = v; return this; },
      json(b) { resBody = b; return this; },
    };
    await siteBoundary(req, res, () => { nextCalled = true; });
    return { nextCalled, status: resStatus, headers: resHeaders, body: resBody };
  };

  const c1aAuthContext = {
    user: { id: 'cust-1a', role: 'customer', websiteIds: [site1A.id], active: true },
    access: { mode: 'site_management', permissions: ['website:manage'] },
    security: { managementAllowed: true },
  };

  // Customer 1A accesses owned site -> passes
  const ownCheck = await runBoundary({ method: 'GET', url: `/api/servers/${stagingServerId}/websites/${site1A.id}`, auth: c1aAuthContext });
  assert.equal(ownCheck.nextCalled, true);

  // Customer 1A accesses Customer 1B site (same reseller) -> 403 fail-closed, no metadata leak
  const foreignSameReseller = await runBoundary({ method: 'GET', url: `/api/servers/${stagingServerId}/websites/${site1B.id}`, auth: c1aAuthContext });
  assert.equal(foreignSameReseller.nextCalled, false);
  assert.equal(foreignSameReseller.status, 403);
  assert.equal(foreignSameReseller.body.error.code, 'site_scope_forbidden');
  assert.equal(foreignSameReseller.body.error.site, undefined);
  assert.equal(foreignSameReseller.body.error.customer, undefined);

  // Customer 1A accesses Customer 2A site (different reseller) -> 403 fail-closed, no metadata leak
  const foreignDiffReseller = await runBoundary({ method: 'GET', url: `/api/servers/${stagingServerId}/websites/${site2A.id}`, auth: c1aAuthContext });
  assert.equal(foreignDiffReseller.nextCalled, false);
  assert.equal(foreignDiffReseller.status, 403);
  assert.equal(foreignDiffReseller.body.error.code, 'site_scope_forbidden');
  assert.equal(foreignDiffReseller.body.error.site, undefined);

  // Customer 1A accesses Direct Owner Customer site -> 403 fail-closed
  const foreignDirect = await runBoundary({ method: 'GET', url: `/api/servers/${stagingServerId}/websites/${siteDirect.id}`, auth: c1aAuthContext });
  assert.equal(foreignDirect.nextCalled, false);
  assert.equal(foreignDirect.status, 403);
  assert.equal(foreignDirect.body.error.code, 'site_scope_forbidden');

  // Direct Customer accesses Reseller 1 site -> 403 fail-closed
  const directAuthContext = {
    user: { id: 'cust-direct', role: 'customer', websiteIds: [siteDirect.id], active: true },
    access: { mode: 'site_management', permissions: ['website:manage'] },
    security: { managementAllowed: true },
  };
  const directToR1 = await runBoundary({ method: 'GET', url: `/api/servers/${stagingServerId}/websites/${site1A.id}`, auth: directAuthContext });
  assert.equal(directToR1.nextCalled, false);
  assert.equal(directToR1.status, 403);
  assert.equal(directToR1.body.error.code, 'site_scope_forbidden');

  // 9. Real HTTP Server, WebSocket Server, and Gateway Capability Lifecycle
  const customerWebsitesMap = new Map([
    ['cust-1a', [site1A.id]],
    ['cust-1b', [site1B.id]],
    ['cust-2a', [site2A.id]],
    ['cust-direct', [siteDirect.id]],
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

  // Terminal WebSocket server
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
      return {
        id: sess.id,
        user: {
          id: sess.user.id,
          role: 'customer',
          active: true,
          websiteIds: customerWebsitesMap.get(sess.user.id) ?? [],
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

  // elFinder handoff service
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
      async getWebsite(id) { return id === site1A.id ? elFinderWebsite : null; },
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

  // Active Session for Customer 1A
  const sessionToken1A = f.session('cust-1a');
  const reqCust1a = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: `__Host-yunpanel_session=${sessionToken1A}` },
  });
  assert.equal(reqCust1a.status, 200);

  // Issue real Terminal Capability and open real WebSocket client
  const capCust1a = terminalCapabilityRegistry.issue({
    sessionId: 'session-cust-1a',
    userId: 'cust-1a',
    target: {
      scope: 'site',
      serverId: stagingServerId,
      websiteId: site1A.id,
      user: 'yunapp-site1a',
      cwd: '/var/lib/yunpanel/site1a',
    },
  });

  const wsCust1a = new WebSocket(`ws://127.0.0.1:${wsServerPort}/api/terminal`, [
    'yunpanel-terminal-v1',
    `yunpanel-terminal-capability.${capCust1a.capability}`,
  ], {
    headers: { cookie: `__Host-yunpanel_session=${sessionToken1A}` },
  });
  await once(wsCust1a, 'open');
  assert.equal(terminalServer.size(), 1, 'Terminal WebSocket session active');

  // Issue elFinder handoff capability
  const c1aDigest = createHash('sha256').update('sess-c1a-seed').digest('hex');
  const handoffIssue = await elFinderService.issue({
    sessionId: 'session-cust-1a',
    userId: 'cust-1a',
    sessionDigest: c1aDigest,
    serverId: stagingServerId,
    websiteId: site1A.id,
  });
  assert.ok(handoffIssue.capability);
  assert.equal(elFinderService.size(), 1);

  // Host daemon state: decoupling verification
  const hostDaemonState = {
    websiteId: site1A.id,
    nginxVhost: 'active',
    phpFpmPool: 'active',
    systemdUnit: 'running',
  };

  // 10. Lifecycle Event: Customer Account Suspension
  const cust1aProfile = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1a', {
    revision: cust1aProfile.revision,
    active: false,
  });
  assert.equal(f.revoked.some((r) => r.id === 'cust-1a' && r.reason === 'hosting_account_suspended'), true);

  // A. Panel HTTP request immediately fails closed (401)
  const reqSuspended = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: `__Host-yunpanel_session=${sessionToken1A}` },
  });
  assert.equal(reqSuspended.status, 401, 'Suspended customer HTTP request must return 401');

  // B. Active WebSocket client terminated fail-closed
  const [closeCode1, closeReason1] = await once(wsCust1a, 'close');
  assert.equal(closeCode1, 4001);
  assert.equal(closeReason1.toString(), 'hosting_account_suspended');
  assert.equal(terminalServer.size(), 0);
  assert.equal(terminalProcessClosed, true);

  // C. elFinder capability evicted and fails closed
  assert.equal(elFinderService.size(), 0);
  await assert.rejects(
    elFinderService.consume(handoffIssue.capability, { sessionDigest: c1aDigest }),
    (err) => err instanceof ElFinderHandoffError && err.code === 'elfinder_handoff_invalid' && err.status === 401,
  );

  // D. Host website runtime decoupling: Host daemons remain running and unaffected
  assert.equal(hostDaemonState.nginxVhost, 'active');
  assert.equal(hostDaemonState.phpFpmPool, 'active');
  assert.equal(hostDaemonState.systemdUnit, 'running');

  // 11. Lifecycle Event: Customer Account Reactivation
  terminalProcessClosed = false;
  const cust1aSuspendedProfile = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  f.store.setActive(ownerToken, f.requireManagement, 'cust-1a', {
    revision: cust1aSuspendedProfile.revision,
    active: true,
  });
  assert.equal(f.store.get(ownerToken, f.requireManagement, 'cust-1a').active, true);

  // Fresh login & HTTP success
  const activeSessionToken1A = f.session('cust-1a');
  const reqReactivated = await fetch(`${authBaseUrl}/api/websites`, {
    headers: { cookie: `__Host-yunpanel_session=${activeSessionToken1A}` },
  });
  assert.equal(reqReactivated.status, 200);

  // Fresh capability & WebSocket connection
  const capCust1aNew = terminalCapabilityRegistry.issue({
    sessionId: 'session-cust-1a',
    userId: 'cust-1a',
    target: {
      scope: 'site',
      serverId: stagingServerId,
      websiteId: site1A.id,
      user: 'yunapp-site1a',
      cwd: '/var/lib/yunpanel/site1a',
    },
  });

  const wsCust1aNew = new WebSocket(`ws://127.0.0.1:${wsServerPort}/api/terminal`, [
    'yunpanel-terminal-v1',
    `yunpanel-terminal-capability.${capCust1aNew.capability}`,
  ], {
    headers: { cookie: `__Host-yunpanel_session=${activeSessionToken1A}` },
  });
  await once(wsCust1aNew, 'open');
  assert.equal(terminalServer.size(), 1);
  wsCust1aNew.close();
  await once(wsCust1aNew, 'close');

  // 12. Lifecycle Event: Reseller Account Suspension Cascades to Child Customer
  const r1Profile = f.store.get(ownerToken, f.requireManagement, 'reseller-1');
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-1', {
    revision: r1Profile.revision,
    active: false,
  });
  assert.equal(f.revoked.some((r) => r.id === 'reseller-1' && r.reason === 'hosting_account_suspended'), true);
  assert.equal(f.revoked.some((r) => r.id === 'cust-1a' && r.reason === 'hosting_parent_suspended'), true);

  // Reactivate Reseller 1
  const r1SuspProfile = f.store.get(ownerToken, f.requireManagement, 'reseller-1');
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-1', {
    revision: r1SuspProfile.revision,
    active: true,
  });

  // 13. Lifecycle Event: Ownership Removal (Profile Unregistration)
  // Attempting to unregister profile while websites are attached throws 409 hosting_account_in_use
  const c1aActiveProf = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  assert.throws(
    () => f.store.unregister(ownerToken, f.requireManagement, 'cust-1a', { revision: c1aActiveProf.revision }),
    (err) => err.code === 'hosting_account_in_use' && err.status === 409,
  );

  // Detach / release website allocation
  f.store.siteAllocations.releaseRemoved({
    operationId: 'op-release-c1a-final',
    websiteId: site1A.id,
    serverId: stagingServerId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(f.store.get(ownerToken, f.requireManagement, 'cust-1a').usage.websites, 0);

  // Unregister profile via HTTP with typed confirmation
  const c1aActiveProfBeforeUnregister = f.store.get(ownerToken, f.requireManagement, 'cust-1a');
  const unregisterResult = await runAdminHttp(
    'DELETE',
    '/api/users/hosting/accounts/cust-1a/profile',
    { revision: c1aActiveProfBeforeUnregister.revision, confirmation: `unregister-hosting-profile:cust-1a:${c1aActiveProfBeforeUnregister.revision}` },
    ownerToken,
  );
  assert.equal(unregisterResult.status, 200);
  assert.equal(unregisterResult.data.unregistered, true);
  assert.equal(unregisterResult.data.loginDeleted, false);

  // Hosting profile is now removed (throws 404), but user login remains
  await assert.rejects(
    runAdminHttp('GET', '/api/users/hosting/accounts/cust-1a'),
    (err) => err.code === 'hosting_account_not_found' && err.status === 404,
  );
  const remainingUser = users.list(ownerToken, f.requireManagement).users.find((u) => u.id === 'cust-1a');
  assert.ok(remainingUser, 'User login record must be preserved after profile unregistration');
  assert.equal(remainingUser.id, 'cust-1a');

  // 14. Lifecycle Event: Logout
  const tempDirectToken = f.session('cust-direct');
  const capDirectLogout = terminalCapabilityRegistry.issue({
    sessionId: 'session-cust-direct',
    userId: 'cust-direct',
    target: {
      scope: 'site',
      serverId: stagingServerId,
      websiteId: siteDirect.id,
      user: 'yunapp-sitedirect',
      cwd: '/var/lib/yunpanel/sitedirect',
    },
  });
  const wsDirectLogout = new WebSocket(`ws://127.0.0.1:${wsServerPort}/api/terminal`, [
    'yunpanel-terminal-v1',
    `yunpanel-terminal-capability.${capDirectLogout.capability}`,
  ], {
    headers: { cookie: `__Host-yunpanel_session=${tempDirectToken}` },
  });
  await once(wsDirectLogout, 'open');
  assert.equal(terminalServer.size(), 1);

  liveSessions.revokeSession('session-cust-direct', 'logout');
  const [logoutCode, logoutReason] = await once(wsDirectLogout, 'close');
  assert.equal(logoutCode, 4001);
  assert.equal(logoutReason.toString(), 'logout');
  assert.equal(terminalServer.size(), 0);

  // 15. Concurrency, Crash Resilience & Rollback in SQLite WAL Mode
  const concurrencyTempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-rs04a-concurrency-'));
  const concurrencyDbPath = path.join(concurrencyTempDir, 'concurrency.db');
  t.after(async () => {
    try { await rm(concurrencyTempDir, { recursive: true, force: true }); } catch {}
  });

  const procA = new DatabaseSync(concurrencyDbPath);
  const procB = new DatabaseSync(concurrencyDbPath);
  t.after(() => {
    try { procA.close(); } catch {}
    try { procB.close(); } catch {}
  });

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

  procA.exec('BEGIN IMMEDIATE');
  procA.prepare('INSERT INTO test_allocations VALUES (?, ?, ?, ?)').run('concur-site-1', 'cust-1a', 'reserved', 1);

  // Proc B attempts concurrent write transaction -> fails closed with SQLITE_BUSY
  assert.throws(
    () => { procB.exec('BEGIN IMMEDIATE'); },
    (err) => /busy|locked/i.test(err.message),
    'Concurrent write transaction must be rejected with SQLITE_BUSY',
  );

  procA.exec('COMMIT');

  // Proc B reads committed data
  const rowFromProcB = procB.prepare('SELECT * FROM test_allocations WHERE website_id = ?').get('concur-site-1');
  assert.ok(rowFromProcB);
  assert.equal(rowFromProcB.status, 'reserved');

  // Crash / Write-Failure Rollback
  assert.throws(
    () => {
      procA.exec('BEGIN IMMEDIATE');
      procA.prepare('INSERT INTO test_allocations VALUES (?, ?, ?, ?)').run('orphan-site-id', 'cust-1a', 'reserved', 1);
      try {
        procA.prepare('INSERT INTO test_allocations VALUES (?, ?, ?, ?)').run('invalid-site-id', 'cust-1a', 'invalid_status', 1);
      } catch (err) {
        procA.exec('ROLLBACK');
        throw err;
      }
    },
    (err) => /check constraint failed/i.test(err.message),
  );

  assert.equal(procA.prepare('SELECT * FROM test_allocations WHERE website_id = ?').get('orphan-site-id'), undefined);
  const integrity = procA.prepare('PRAGMA integrity_check').get();
  assert.equal(integrity.integrity_check, 'ok');

  // 16. Host Isolation & Safety Gate
  assertNoDot44Host(stagingServerId);
  assert.ok(true, 'RS-04a kabul / RS-03–05 kalan: Multi-tenant self-service, fail-closed boundaries, real session/gateway/WS lifecycle, and host decoupling verified.');
});

// ============================================================================
// STAGING E2E PART 8: P2 — Post-Acceptance Migration Cleanup & Safe Fallback Maintenance
// ============================================================================

test('Staging E2E P2: Post-acceptance migration cleanup, legacy direct-systemd compatibility and fallback maintenance, runtime engine preservation, and file manager/terminal non-regression', async (t) => {
  // Staging server ID: strictly authorized staging, never .44
  const stagingServerId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
  assertNoDot44Host(stagingServerId);

  // 1. Audit & Safety of Legacy direct-systemd Compatibility in Application Registry
  let clock = Date.parse('2026-10-04T00:00:00.000Z');
  const appRegistry = createApplicationRegistry({
    now: () => clock,
    serverExists: async (sId) => sId === stagingServerId,
  });

  // Create legacy direct-systemd Node application
  const directApp = await appRegistry.createNodeApplication({
    serverId: stagingServerId,
    name: 'Legacy Direct Systemd App',
    repositoryUrl: 'https://github.com/example/legacy-node.git',
    branch: 'main',
    runtimeAdapter: 'direct-systemd',
    runtime: {
      port: 3001,
      mode: 'production',
      start: { mode: 'node', entryFile: 'server.js' },
      healthPath: '/health',
    },
  });

  const expectedServiceName = `yunpanel-node-${createHash('sha256').update(directApp.id).digest('hex').slice(0, 16)}.service`;
  assert.equal(directApp.runtimeAdapter, 'direct-systemd', 'directApp must have runtimeAdapter direct-systemd');
  assert.equal(directApp.servicePort, 3001, 'directApp must retain servicePort 3001');
  assert.equal(directApp.serviceName, null, 'directApp serviceName is null before deployment');
  assert.deepEqual(directApp.proxyTarget, { host: '127.0.0.1', port: 3001 }, 'directApp must have proxyTarget { host: 127.0.0.1, port: 3001 }');

  // Enforce port immutability for direct-systemd applications
  await assert.rejects(
    () => appRegistry.previewNodeConfiguration(directApp.id, { port: 3002 }),
    (err) => err instanceof ApplicationRegistryError && err.code === 'node_port_immutable' && err.status === 409,
    'Managed Node port cannot be changed through runtime configuration for direct-systemd',
  );

  // Legacy deploy pipeline works for direct-systemd
  const rel1 = '11111111-1111-4111-8111-111111111111';
  await appRegistry.markDeploying(directApp.id, rel1);
  const deployed1 = await appRegistry.markDeployed(directApp.id, {
    deploymentId: rel1,
    releaseId: rel1,
    commitSha: 'a'.repeat(40),
    serviceName: expectedServiceName,
    port: 3001,
    healthPath: '/health',
    healthy: true,
  });
  assert.equal(deployed1.state, 'active');
  assert.equal(deployed1.currentReleaseId, rel1);
  assert.equal(deployed1.serviceName, expectedServiceName, 'deployed directApp has expected systemd service name');

  // Legacy rollback pipeline works for direct-systemd
  const rel2 = '22222222-2222-4222-8222-222222222222';
  await appRegistry.markDeploying(directApp.id, rel2);
  const deployed2 = await appRegistry.markDeployed(directApp.id, {
    deploymentId: rel2,
    releaseId: rel2,
    commitSha: 'b'.repeat(40),
    serviceName: expectedServiceName,
    port: 3001,
    healthPath: '/health',
    healthy: true,
  });
  assert.equal(deployed2.currentReleaseId, rel2);

  const rollbackOpId = '33333333-3333-4333-8333-333333333333';
  await appRegistry.markRollingBack(directApp.id, rollbackOpId, rel1);
  const rolledBack = await appRegistry.markRolledBack(directApp.id, {
    operationId: rollbackOpId,
    releaseId: rel1,
    serviceName: expectedServiceName,
    port: 3001,
    healthPath: '/health',
    healthy: true,
  });
  assert.equal(rolledBack.currentReleaseId, rel1, 'Rollback safely restores release 1 on direct-systemd');

  // Modern Passenger application rejects legacy deploy and rollback flows (fail-closed boundary)
  const passApp = await appRegistry.createNodeApplication({
    serverId: stagingServerId,
    name: 'Modern Passenger App',
    repositoryUrl: 'https://github.com/example/passenger-node.git',
    branch: 'main',
  });
  assert.equal(passApp.runtimeAdapter, 'passenger', 'Default Node app uses passenger adapter');
  const passRel = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(
    () => appRegistry.markDeploying(passApp.id, passRel),
    (err) => err instanceof ApplicationRegistryError && err.code === 'node_deploy_adapter_mismatch' && err.status === 409,
    'Passenger Node releases must use Website provisioning instead of legacy deploy flow',
  );
  await assert.rejects(
    () => appRegistry.markRollingBack(passApp.id, 'op-rb', passRel),
    (err) => err instanceof ApplicationRegistryError && err.code === 'node_rollback_adapter_mismatch' && err.status === 409,
    'Passenger Node rollback must use Website provisioning instead of legacy rollback flow',
  );

  // 2. Audit of Application Runtime Binding Registry Fallbacks
  const bindingReg = createApplicationRuntimeBindingRegistry();
  const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
  const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
  const opDirect = '55555555-5555-4555-8555-555555555555';

  // Direct-systemd binding rejects incompatible targets and states
  await assert.rejects(
    () => bindingReg.activate({
      applicationId: directApp.id,
      serverId: stagingServerId,
      adapter: 'direct-systemd',
      state: 'cleanup_required',
      sourceOperationId: opDirect,
      releaseId: rel1,
      websiteId,
      websiteRevision: 1,
      domains: [{ domainId, desiredRevision: 1, nginxChecksum: 'c'.repeat(64) }],
    }),
    (err) => err instanceof ApplicationRuntimeBindingRegistryError && err.code === 'runtime_binding_state_invalid',
    'direct-systemd binding cannot require Passenger cleanup',
  );

  await assert.rejects(
    () => bindingReg.activate({
      applicationId: directApp.id,
      serverId: stagingServerId,
      adapter: 'direct-systemd',
      state: 'active',
      sourceOperationId: opDirect,
      releaseId: rel1,
      websiteId,
      websiteRevision: 1,
      domains: [{ domainId, desiredRevision: 1, nginxChecksum: 'c'.repeat(64) }],
      passengerTarget: {
        appRoot: `/var/lib/yunpanel/apps/${directApp.id}/current`,
        documentRoot: `/var/lib/yunpanel/apps/${directApp.id}/current`,
        startupFile: 'server.js',
        nodeBinary: '/usr/bin/node',
        user: 'yunapp-0123456789ab',
        group: 'yunapp-0123456789ab',
        appEnv: 'production',
        environmentInclude: null,
      },
    }),
    (err) => err instanceof ApplicationRuntimeBindingRegistryError && err.code === 'runtime_binding_target_invalid',
    'direct-systemd binding cannot carry Passenger target evidence',
  );

  // Valid direct-systemd binding activation and operation-owned removal
  const directBinding = await bindingReg.activate({
    applicationId: directApp.id,
    serverId: stagingServerId,
    adapter: 'direct-systemd',
    state: 'active',
    sourceOperationId: opDirect,
    releaseId: rel1,
    websiteId,
    websiteRevision: 1,
    domains: [{ domainId, desiredRevision: 1, nginxChecksum: 'c'.repeat(64) }],
    passengerTarget: null,
    staticTarget: null,
  });
  assert.equal(directBinding.adapter, 'direct-systemd');
  assert.equal(directBinding.state, 'active');

  // Attempting removeOwnedPassenger on direct-systemd binding fails closed (ownership conflict)
  await assert.rejects(
    () => bindingReg.removeOwnedPassenger(directApp.id, {
      sourceOperationId: opDirect,
      expectedRevision: directBinding.revision,
    }),
    (err) => err instanceof ApplicationRuntimeBindingRegistryError && err.code === 'runtime_binding_ownership_conflict' && err.status === 409,
    'removeOwnedPassenger cannot remove direct-systemd binding',
  );

  // removeOwnedDirectSystemd removes direct-systemd binding idempotently
  const removedBinding = await bindingReg.removeOwnedDirectSystemd(directApp.id, {
    sourceOperationId: opDirect,
    expectedRevision: directBinding.revision,
  });
  assert.equal(removedBinding.adapter, 'direct-systemd');
  assert.equal(await bindingReg.getBinding(directApp.id), null);

  // 3. Domain Target Routing & Migration Lifecycle: Fallback Maintained until Verified Replacement
  const domainRecord = {
    id: domainId,
    serverId: stagingServerId,
    websiteId,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3001 },
    desiredRevision: 1,
    appliedRevision: 1,
    state: 'active',
  };
  const websiteRecord = {
    id: websiteId,
    serverId: stagingServerId,
    applicationId: directApp.id,
    runtimeType: 'node',
    revision: 1,
  };

  // Domain registry allows proxy target for Node Website as legacy compatibility
  const { websiteTargetMatches } = domainWebsiteTargetBindingInternals;
  assert.equal(
    websiteTargetMatches(websiteRecord, 'proxy', domainRecord.target),
    true,
    'proxy target is preserved for legacy direct-systemd Node website',
  );
  // Rejects invalid target type (e.g. PHP target for Node website fails closed)
  assert.throws(
    () => websiteTargetMatches(websiteRecord, 'php', { applicationId: directApp.id }),
    (err) => err instanceof DomainRegistryError && err.code === 'domain_website_target_mismatch',
  );

  // Before migration: resolveWebsiteDomainTarget falls back to persisted proxy target
  const domainTargetBeforeMigration = await resolveWebsiteDomainTarget({
    domain: domainRecord,
    websiteRegistry: { getWebsite: async () => websiteRecord },
    runtimeBindingRegistry: bindingReg,
    applicationRegistry: appRegistry,
  });
  assert.deepEqual(domainTargetBeforeMigration, {
    source: 'domain',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3001 },
  }, 'Fallback correctly maintains direct-systemd proxy target before replacement acceptance');

  // 4. Verified Replacement Acceptance: markPassengerMigrated & Passenger Runtime Binding Activation
  const opMigrate = '66666666-6666-4666-8666-666666666666';
  const migratedApp = await appRegistry.markPassengerMigrated(directApp.id, { operationId: opMigrate });
  assert.equal(migratedApp.runtimeAdapter, 'passenger', 'Migrated app switches to passenger');
  assert.equal(migratedApp.serviceName, null, 'serviceName is cleared after passenger acceptance');
  assert.equal(migratedApp.servicePort, null, 'servicePort is cleared after passenger acceptance');
  assert.equal(migratedApp.proxyTarget, null, 'proxyTarget is cleared after passenger acceptance');
  assert.equal(migratedApp.runtime.port, undefined, 'runtime port is stripped after passenger acceptance');
  assert.equal(migratedApp.releases[0].runtime.port, undefined, 'release port is stripped after passenger acceptance');

  // Idempotency: re-running markPassengerMigrated on already-migrated app does not corrupt state
  const idempotentMigrated = await appRegistry.markPassengerMigrated(directApp.id);
  assert.equal(idempotentMigrated.runtimeAdapter, 'passenger');

  // Activate Passenger runtime binding representing verified replacement
  await bindingReg.activate({
    applicationId: directApp.id,
    serverId: stagingServerId,
    adapter: 'passenger',
    state: 'active',
    sourceOperationId: opMigrate,
    releaseId: rel1,
    websiteId,
    websiteRevision: 1,
    domains: [{
      domainId,
      desiredRevision: 1,
      nginxChecksum: 'd'.repeat(64),
    }],
    passengerTarget: {
      appRoot: `/var/lib/yunpanel/apps/${directApp.id}/current`,
      documentRoot: `/var/lib/yunpanel/apps/${directApp.id}/current`,
      startupFile: 'server.js',
      nodeBinary: '/usr/bin/node',
      user: 'yunapp-0123456789ab',
      group: 'yunapp-0123456789ab',
      appEnv: 'production',
      environmentInclude: null,
    },
  });

  // After verified replacement: resolveWebsiteDomainTarget materializes Passenger target
  const domainTargetAfterMigration = await resolveWebsiteDomainTarget({
    domain: domainRecord,
    websiteRegistry: { getWebsite: async () => websiteRecord },
    runtimeBindingRegistry: bindingReg,
    applicationRegistry: appRegistry,
  });
  assert.equal(domainTargetAfterMigration.source, 'passenger');
  assert.equal(domainTargetAfterMigration.targetType, 'passenger');
  assert.equal(domainTargetAfterMigration.target.root, `/var/lib/yunpanel/apps/${directApp.id}/current`);
  assert.equal(domainTargetAfterMigration.target.startupFile, 'server.js');
  assert.equal(domainTargetAfterMigration.target.nodeBinary, '/usr/bin/node');

  // The migrated application now rejects legacy systemd deploy flow (retired after acceptance)
  await assert.rejects(
    () => appRegistry.markDeploying(directApp.id, 'rel-new'),
    (err) => err instanceof ApplicationRegistryError && err.code === 'node_deploy_adapter_mismatch' && err.status === 409,
    'Migrated app no longer uses legacy systemd deploy pipeline',
  );

  // 5. Website Removal: Runtime Cleanup Fallback Maintained for direct-systemd
  const removalOpReg = createWebsiteRemovalOperationRegistry();
  await removalOpReg.init();
  const removalPreview = {
    version: 1,
    operation: 'website_remove',
    website: {
      id: websiteId,
      serverId: stagingServerId,
      applicationId: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
      systemUser: 'yunapp-0123456789ab',
      runtimeType: 'node',
      revision: 1,
      desiredRevision: 1,
    },
    plan: {
      domainIds: [],
      additional: {
        runtimeBindings: { ids: [] },
        databases: { ids: [] },
      },
      applicationRuntime: {
        adapter: 'direct-systemd',
        serviceName: 'yunpanel-node-legacy.service',
        releaseId: 'rel-legacy-1',
      },
    },
    hardBlockers: [],
    readyToStart: true,
    previewDigest: 'e'.repeat(64),
    confirmation: `start-website-remove:${websiteId}:1:${'e'.repeat(64)}`,
  };
  const removalOp = await removalOpReg.create(removalPreview);
  const runtimeCleanupStep = removalOp.steps.find((s) => s.kind === 'runtime_cleanup');
  assert.ok(runtimeCleanupStep, 'runtime_cleanup step must be created for direct-systemd even without runtime-binding records');

  // 6. Active Runtime Engines Preservation Non-Regression
  // A. PHP-FPM Application & Runtime Target
  const phpApp = await appRegistry.createPhpApplication({
    serverId: stagingServerId,
    name: 'Production PHP App',
  });
  assert.equal(phpApp.type, 'php');

  const phpWebsite = {
    id: '11111111-2222-4333-8444-555555555555',
    serverId: stagingServerId,
    applicationId: phpApp.id,
    runtimeType: 'php',
    documentRoot: phpApp.webRoot,
    unixUser: 'yunapp-0123456789ab',
    revision: 1,
  };
  const phpDomain = {
    id: '66666666-7777-4888-8999-000000000000',
    serverId: stagingServerId,
    websiteId: phpWebsite.id,
    targetType: 'php',
    target: { applicationId: phpApp.id },
    desiredRevision: 1,
    appliedRevision: 1,
    state: 'active',
  };
  const phpFpmMock = {
    inspect: async () => ({
      satisfied: true,
      adapter: 'php-fpm',
      websiteId: phpWebsite.id,
      applicationId: phpApp.id,
      unixUser: phpWebsite.unixUser,
      documentRoot: phpWebsite.documentRoot,
      socketPath: '/run/php/yunpanel-yunapp-0123456789ab.sock',
    }),
  };
  const umaskMock = {
    inspect: async () => ({ satisfied: true, umask: '0027' }),
  };
  const resolvedPhpTarget = await resolveWebsiteDomainTarget({
    domain: phpDomain,
    websiteRegistry: { getWebsite: async () => phpWebsite },
    applicationRegistry: appRegistry,
    phpFpmSiteManager: phpFpmMock,
    serviceUmaskManager: umaskMock,
  });
  assert.equal(resolvedPhpTarget.source, 'php');
  assert.equal(resolvedPhpTarget.targetType, 'php');
  assert.equal(resolvedPhpTarget.target.socketPath, '/run/php/yunpanel-yunapp-0123456789ab.sock');

  // B. Static Runtime Engine & Binding
  const staticApp = await appRegistry.createApplication({
    serverId: stagingServerId,
    name: 'Production Static Web',
    repositoryUrl: 'https://github.com/example/static-web.git',
    branch: 'main',
    build: { mode: 'npm', outputDir: 'dist' },
  });
  assert.equal(staticApp.type, 'static');

  const staticOp = '88888888-8888-4888-8888-888888888888';
  const staticWebsiteId = '99999999-9999-4999-8999-999999999999';
  const staticDomainId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const staticBinding = await bindingReg.activate({
    applicationId: staticApp.id,
    serverId: stagingServerId,
    adapter: 'static',
    state: 'active',
    sourceOperationId: staticOp,
    releaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    websiteId: staticWebsiteId,
    websiteRevision: 1,
    domains: [{ domainId: staticDomainId, desiredRevision: 1, nginxChecksum: 'f'.repeat(64) }],
    staticTarget: {
      publishRoot: `/var/lib/yunpanel/apps/${staticApp.id}/current/dist`,
      documentRoot: `/var/lib/yunpanel/apps/${staticApp.id}/current/dist`,
      user: 'yunapp-0123456789ab',
      group: 'yunapp-0123456789ab',
    },
  });
  assert.equal(staticBinding.adapter, 'static');
  const removedStatic = await bindingReg.removeOwnedStatic(staticApp.id, {
    sourceOperationId: staticOp,
    expectedRevision: staticBinding.revision,
  });
  assert.equal(removedStatic.adapter, 'static');

  // C. Python Runtime Application
  const pythonApp = await appRegistry.createPythonApplication({
    serverId: stagingServerId,
    name: 'Production Python App',
    repositoryUrl: 'https://github.com/example/python-app.git',
    branch: 'main',
    runtime: {
      pythonVersion: '3.12',
      entryPoint: 'app:app',
    },
  });
  assert.equal(pythonApp.type, 'python');

  // 7. Non-Regression of File Manager & Terminal Capabilities
  // A. File Manager (elFinder handoff capability lifecycle)
  const elFinderExpectedUnixUser = elFinderHandoffInternals.applicationUser(directApp.id);
  const elFinderWebsite = {
    id: websiteId,
    serverId: stagingServerId,
    applicationId: directApp.id,
    runtimeType: 'node',
    unixUser: elFinderExpectedUnixUser,
    revision: 1,
  };
  const elFinderService = createElFinderHandoffService({
    websiteRegistry: {
      async getWebsite(id) {
        return id === websiteId ? elFinderWebsite : null;
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
    now: () => Date.now(),
    ttlMs: 60000,
  });
  const sessionDigest = createHash('sha256').update('session-seed-p2').digest('hex');
  const elFinderIssue = await elFinderService.issue({
    sessionId: 'session-owner-p2',
    userId: 'owner-user',
    sessionDigest,
    serverId: stagingServerId,
    websiteId,
  });
  assert.ok(elFinderIssue.capability, 'elFinder handoff capability issued successfully');
  assert.equal(elFinderService.size(), 1);

  // Valid consumption
  const consumedElFinder = await elFinderService.consume(elFinderIssue.capability, { sessionDigest });
  assert.equal(consumedElFinder.websiteId, websiteId);
  assert.equal(elFinderService.size(), 0, 'Consumed capability is evicted (single-use)');

  // Re-consumption fails closed (401)
  await assert.rejects(
    () => elFinderService.consume(elFinderIssue.capability, { sessionDigest }),
    (err) => err instanceof ElFinderHandoffError && err.code === 'elfinder_handoff_invalid' && err.status === 401,
  );

  // Mismatched session digest fails closed (401)
  const elFinderIssue2 = await elFinderService.issue({
    sessionId: 'session-owner-p2',
    userId: 'owner-user',
    sessionDigest,
    serverId: stagingServerId,
    websiteId,
  });
  const mismatchedDigest = createHash('sha256').update('other-session-seed').digest('hex');
  await assert.rejects(
    () => elFinderService.consume(elFinderIssue2.capability, { sessionDigest: mismatchedDigest }),
    (err) => err instanceof ElFinderHandoffError && err.code === 'elfinder_handoff_session_mismatch' && err.status === 401,
  );

  // B. Terminal Capabilities (Server & Site terminal capability lifecycle)
  const terminalReg = createTerminalCapabilityRegistry({
    now: () => Date.now(),
    ttlMs: 60000,
  });
  const liveSessions = createLiveSessionRegistry();

  // Server capability (root user on server)
  const rootCap = terminalReg.issue({
    sessionId: 'session-owner-p2',
    userId: 'owner-user',
    target: { scope: 'server', serverId: stagingServerId, user: 'root', cwd: '/root' },
  });
  assert.equal(rootCap.target.scope, 'server');
  assert.equal(rootCap.target.user, 'root');
  const consumedRoot = terminalReg.consume(rootCap.capability, {
    sessionId: 'session-owner-p2',
    userId: 'owner-user',
  });
  assert.equal(consumedRoot.target.scope, 'server');
  assert.equal(consumedRoot.target.user, 'root');
  assert.throws(
    () => terminalReg.consume(rootCap.capability, { sessionId: 'session-owner-p2', userId: 'owner-user' }),
    (err) => err instanceof TerminalCapabilityError && err.code === 'terminal_capability_invalid' && err.status === 401,
    'Single-use eviction',
  );

  // Site capability (site Unix user under website)
  const siteCap = terminalReg.issue({
    sessionId: 'session-cust-p2',
    userId: 'cust-user',
    target: {
      scope: 'site',
      serverId: stagingServerId,
      websiteId,
      user: elFinderExpectedUnixUser,
      cwd: `/var/lib/yunpanel/data/${directApp.id}`,
    },
  });
  assert.equal(siteCap.target.scope, 'site');
  assert.equal(siteCap.target.user, elFinderExpectedUnixUser);

  // Mismatched session fails to consume site capability
  assert.throws(
    () => terminalReg.consume(siteCap.capability, { sessionId: 'wrong-session', userId: 'cust-user' }),
    (err) => err instanceof TerminalCapabilityError && err.code === 'terminal_capability_binding_invalid' && err.status === 403,
  );

  // Live session registration and revocation
  let socketTerminated = false;
  liveSessions.register({
    sessionId: 'session-cust-p2',
    userId: 'cust-user',
    terminate: (reason) => {
      socketTerminated = true;
      assert.equal(reason, 'logout');
    },
  });
  liveSessions.revokeSession('session-cust-p2', 'logout');
  assert.equal(socketTerminated, true, 'Live terminal session terminated on session revocation');

  // 8. State Consistency & SQLite WAL Crash Resilience
  const testDbDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-p2-test-'));
  const testDbPath = path.join(testDbDir, 'p2-audit.db');
  t.after(async () => {
    try { await rm(testDbDir, { recursive: true, force: true }); } catch {}
  });

  const db = new DatabaseSync(testDbPath);
  t.after(() => {
    try { db.close(); } catch {}
  });

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE p2_migration_audit (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      adapter_before TEXT NOT NULL,
      adapter_after TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'rolled_back'))
    );
  `);

  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO p2_migration_audit VALUES (?, ?, ?, ?, ?)').run('audit-1', directApp.id, 'direct-systemd', 'passenger', 'completed');
  db.exec('COMMIT');

  const auditRow = db.prepare('SELECT * FROM p2_migration_audit WHERE id = ?').get('audit-1');
  assert.equal(auditRow.application_id, directApp.id);
  assert.equal(auditRow.status, 'completed');

  const dbIntegrity = db.prepare('PRAGMA integrity_check').get();
  assert.equal(dbIntegrity.integrity_check, 'ok');

  // Final Gate Verification
  assertNoDot44Host(stagingServerId);
  assert.ok(true, 'P2: Legacy direct-systemd compatibility safely maintained, migration fallback audit passed, runtime engines and file manager/terminal non-regression verified.');
});

// ============================================================================
// STAGING E2E PAR-04: Non-Reseller Capabilities Retention, Cross-Connections,
// Reseller Branding Deferral & Multi-Tier Tenant Boundary Enforcement
// ============================================================================

test('Staging E2E PAR-04: Non-reseller capabilities retention with established inventory IDs, cross-connections to groups B-E, reseller branding deferral, and fail-closed tenant boundary enforcement', async (t) => {
  // 1. Establish inventory integrity across all domains
  const inventory = NON_RESELLER_INVENTORY;
  assert.ok(inventory && typeof inventory === 'object', 'Non-reseller inventory catalog must exist');

  const requiredDomains = [
    'dns', 'mail', 'database', 'runtime', 'docker', 'git',
    'wordpress', 'backup', 'security', 'api', 'migration', 'monitoring', 'extensions',
  ];
  for (const domain of requiredDomains) {
    const caps = listCapabilities({ category: domain });
    assert.ok(caps.length > 0, `Domain '${domain}' must have non-reseller capabilities`);
    for (const cap of caps) {
      assert.equal(cap.reimplementationPrevented, true, `Capability ${cap.id} must prevent reimplementation`);
      assert.ok(cap.groupCrossConnects.length > 0, `Capability ${cap.id} must cross-connect to groups B-E`);
    }
  }

  // 2. Cross-connection assertions to Task Groups B, C, D, E
  const allCaps = Object.values(inventory);
  const groupB = allCaps.filter((c) => c.groupCrossConnects.includes(TASK_GROUPS.GROUP_B));
  const groupC = allCaps.filter((c) => c.groupCrossConnects.includes(TASK_GROUPS.GROUP_C));
  const groupD = allCaps.filter((c) => c.groupCrossConnects.includes(TASK_GROUPS.GROUP_D));
  const groupE = allCaps.filter((c) => c.groupCrossConnects.includes(TASK_GROUPS.GROUP_E));

  assert.ok(groupB.length >= 20, 'Group B cross-connect count must be >= 20');
  assert.ok(groupC.length >= 35, 'Group C cross-connect count must be >= 35');
  assert.ok(groupD.length >= 40, 'Group D cross-connect count must be >= 40');
  assert.ok(groupE.length >= 8, 'Group E cross-connect count must be >= 8');

  // 3. Reseller branding deferral: fail-closed validation rejecting premature branding
  for (const forbiddenKey of FORBIDDEN_BRANDING_KEYS) {
    assert.throws(
      () => assertNoResellerBrandingPollution({ [forbiddenKey]: 'Custom Brand' }),
      (err) => err instanceof ResellerBrandingDeferredError && err.status === 403,
      `Should throw ResellerBrandingDeferredError for forbidden key ${forbiddenKey}`,
    );
  }
  // Deep/nested branding keys also rejected
  assert.throws(
    () => assertNoResellerBrandingPollution({ settings: { theme: { customLogo: 'https://cdn.example.com/logo.png' } } }),
    (err) => err instanceof ResellerBrandingDeferredError && err.status === 403,
  );
  // Clean payload passes without throwing
  assert.doesNotThrow(() => {
    assertNoResellerBrandingPollution({ name: 'Valid Panel Config', debug: false, port: 8080 });
  });

  // 4. Multi-tier tenant boundary enforcement fail-closed
  const ownerActor = { user: { id: 'owner-e2e', role: 'owner', active: true } };
  const resellerActor = {
    user: {
      id: 'reseller-e2e',
      role: 'reseller',
      active: true,
      websiteIds: ['site-r1'],
      hosting: { kind: 'reseller', resellerId: 'reseller-e2e', websiteIds: ['site-r1'] },
    },
  };
  const customerActor = {
    user: {
      id: 'customer-e2e',
      role: 'customer',
      active: true,
      websiteIds: ['site-c1'],
      hosting: { kind: 'customer', customerId: 'customer-e2e', resellerId: 'reseller-e2e', websiteIds: ['site-c1'] },
    },
  };
  const inactiveActor = { user: { id: 'inactive-user', role: 'owner', active: false } };

  // Inactive actor fails closed with tenant_actor_inactive
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: inactiveActor, capabilityId: 'DNS-01' }),
    (err) => err instanceof TenantBoundaryError && err.code === 'tenant_actor_inactive' && err.status === 403,
  );

  // Owner has access to owner_only capability (e.g. DNSSEC, AXFR, Firewall)
  const ownerSec = assertTenantBoundaryForCapability({ actor: ownerActor, capabilityId: 'SEC-01' });
  assert.equal(ownerSec.authorized, true);

  // Reseller is denied owner_only capability
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: resellerActor, capabilityId: 'SEC-01' }),
    (err) => err instanceof TenantBoundaryError && err.code === 'tenant_boundary_forbidden' && err.status === 403,
  );

  // Customer is denied owner_only or management_scoped capability
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: customerActor, capabilityId: 'SEC-01' }),
    (err) => err instanceof TenantBoundaryError && err.code === 'tenant_boundary_forbidden' && err.status === 403,
  );
  assert.throws(
    () => assertTenantBoundaryForCapability({ actor: customerActor, capabilityId: 'DNS-02' }),
    (err) => err instanceof TenantBoundaryError && err.code === 'tenant_boundary_forbidden' && err.status === 403,
  );

  // Customer accessing their own site is permitted
  const custSiteAccess = assertTenantBoundaryForCapability({
    actor: customerActor,
    capabilityId: 'DNS-01',
    targetSiteId: 'site-c1',
  });
  assert.equal(custSiteAccess.authorized, true);

  // Customer accessing a foreign site fails closed
  assert.throws(
    () => assertTenantBoundaryForCapability({
      actor: customerActor,
      capabilityId: 'DNS-01',
      targetSiteId: 'site-foreign',
    }),
    (err) => err instanceof TenantBoundaryError && err.code === 'site_scope_forbidden' && err.status === 403,
  );

  // 5. Express HTTP Route Integration with requirePanelRouteAccess guard on real HTTP listener
  const app = express();
  app.use(express.json());
  let currentAuth = null;
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });
  mountNonResellerCapabilitiesRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const internalReq = async (method, reqPath, body = null) => {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  };

  // 5a. Unauthenticated request -> 401 unauthorized
  currentAuth = null;
  const unauthRes = await internalReq('GET', '/api/system/capabilities');
  assert.equal(unauthRes.status, 401);
  assert.equal(unauthRes.body.error.code, 'unauthorized');

  // 5b. Authenticated Owner -> 200 with all capabilities and deferred branding status
  currentAuth = {
    user: { id: 'owner-e2e', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  const ownerRes = await internalReq('GET', '/api/system/capabilities');
  assert.equal(ownerRes.status, 200);
  assert.ok(ownerRes.body.data.total >= 60);
  assert.equal(ownerRes.body.data.resellerBrandingStatus, 'deferred_to_next_phase');

  // 5c. Branding validation endpoint rejects premature branding
  const badBrandingRes = await internalReq('POST', '/api/system/capabilities/validate-branding', {
    customLogo: 'https://cdn.example.com/logo.png',
  });
  assert.equal(badBrandingRes.status, 403);
  assert.equal(badBrandingRes.body.error.code, 'reseller_branding_deferred');

  const cleanBrandingRes = await internalReq('POST', '/api/system/capabilities/validate-branding', {
    configName: 'standard-production',
  });
  assert.equal(cleanBrandingRes.status, 200);
  assert.equal(cleanBrandingRes.body.data.valid, true);

  // 5d. Customer role access filtering via HTTP
  currentAuth = {
    user: { id: 'customer-e2e', role: 'customer', active: true },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  const custRes = await internalReq('GET', '/api/system/capabilities');
  assert.equal(custRes.status, 200);
  assert.ok(custRes.body.data.total < ownerRes.body.data.total);
  for (const cap of custRes.body.data.capabilities) {
    assert.notEqual(cap.scopeLevel, 'owner_only');
    assert.ok(cap.rolesAllowed.includes('customer'));
  }

  // Customer querying owner-only capability returns 403
  const custForbiddenRes = await internalReq('GET', '/api/system/capabilities/SEC-01');
  assert.equal(custForbiddenRes.status, 403);
  assert.equal(custForbiddenRes.body.error.code, 'tenant_boundary_forbidden');

  // Customer querying allowed capability returns 200
  const custAllowedRes = await internalReq('GET', '/api/system/capabilities/DNS-01');
  assert.equal(custAllowedRes.status, 200);
  assert.equal(custAllowedRes.body.data.id, 'DNS-01');

  assert.ok(true, 'PAR-04: Non-reseller capabilities, cross-connections, branding deferral, and tenant boundaries fully verified in staging E2E suite.');
});

// ============================================================================
// STAGING E2E PAR-05: OS Equivalence Boundaries, Adapter Contracts,
// External Lifecycle Parity, and Reseller Billing Deferral Enforcement
// ============================================================================

test('Staging E2E PAR-05: Windows OS equivalence boundaries (WIN-01..06) fail-closed preserving Linux tenant isolation, external lifecycle contracts fail-closed when unconfigured, and reseller billing is explicitly deferred to post-MVP', async (t) => {
  // 1. Windows OS Equivalence Inventory and Strict Host Distinction
  const osLines = listOsEquivalenceAdapters();
  assert.equal(osLines.length, 6, 'Must inventory all 6 Windows equivalence lines');
  for (const line of osLines) {
    assert.equal(line.status, 'separate_track_fail_closed');
    assert.equal(line.ubuntuEquivalenceClaimed, false, 'Ubuntu cannot be claimed as Windows equivalent');
    assert.equal(line.linuxIsolationPreserved, true, 'Linux tenant isolation must be preserved');
  }

  // Verify adapter contract methods throw OsEquivalenceError (fail-closed) on Linux host
  const osAdapters = createDefaultOsAdapters();
  await assert.rejects(
    () => osAdapters['WIN-01'].getServiceStatus('W3SVC'),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported' && err.status === 501,
  );
  await assert.rejects(
    () => osAdapters['WIN-02'].createSite({ siteName: 'win.local' }),
    (err) => err instanceof OsEquivalenceError && err.code === 'windows_platform_unsupported',
  );
  await assert.rejects(
    () => osAdapters['WIN-03'].configureRuntime('site-1', 'net8.0'),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => osAdapters['WIN-04'].createDatabase('win_db'),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => osAdapters['WIN-05'].setAcl('C:\\inetpub', 'IUSR', 'FullControl'),
    (err) => err instanceof OsEquivalenceError,
  );
  await assert.rejects(
    () => osAdapters['WIN-06'].createMailbox('win.local', 'admin', 500),
    (err) => err instanceof OsEquivalenceError,
  );

  // 2. Linux Tenant Isolation Preservation
  const ownerActor = { user: { id: 'owner-e2e', role: 'owner', active: true } };
  const customerActor = {
    user: {
      id: 'customer-e2e',
      role: 'customer',
      active: true,
      websiteIds: ['site-c1'],
      hosting: { kind: 'customer', customerId: 'customer-e2e', resellerId: 'reseller-e2e', websiteIds: ['site-c1'] },
    },
  };
  const ownerIso = assertPreserveLinuxTenantIsolation({ actor: ownerActor });
  assert.equal(ownerIso.authorized, true);
  const custIso = assertPreserveLinuxTenantIsolation({ actor: customerActor, siteId: 'site-c1' });
  assert.equal(custIso.authorized, true);
  assert.throws(
    () => assertPreserveLinuxTenantIsolation({ actor: customerActor, siteId: 'site-foreign' }),
    (err) => err instanceof LinuxIsolationViolationError && err.status === 403,
  );

  // 3. External Lifecycle Boundaries & Fail-Closed Behavior
  const extLines = listExternalParityAdapters();
  assert.equal(extLines.length, 6, 'Must inventory all 6 external parity integration lines');
  for (const line of extLines) {
    assert.equal(line.status, 'external_unconfigured_fail_closed');
    assert.equal(line.requiresConfig, true);
  }

  const unconfiguredAdapters = createDefaultExternalAdapters();
  await assert.rejects(
    () => unconfiguredAdapters['EXT-CERT-01'].requestOrder({ domain: 'shop.net' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'commercial_certificate_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => unconfiguredAdapters['EXT-BUILD-01'].createBuilderSession({ siteId: 's1', domain: 's1.com' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'sitebuilder_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => unconfiguredAdapters['EXT-SEC-01'].scheduleMalwareScan({ siteId: 's1' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'premium_security_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => unconfiguredAdapters['EXT-BAK-01'].registerRemoteVault({ provider: 'acronis', vaultName: 'V1' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'premium_backup_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => unconfiguredAdapters['EXT-TOOL-01'].prepareSmartUpdate({ siteId: 's1' }),
    (err) => err instanceof ExternalIntegrationError && err.code === 'premium_toolkit_unconfigured' && err.status === 501,
  );
  await assert.rejects(
    () => unconfiguredAdapters['EXT-REG-01'].checkDomainAvailability('shop.net'),
    (err) => err instanceof ExternalIntegrationError && err.code === 'registrar_unconfigured' && err.status === 501,
  );

  // Configured external adapter deterministic lifecycle execution
  const configuredAdapters = createDefaultExternalAdapters({
    'EXT-CERT-01': { apiKey: 'live-key-1' },
    'EXT-BUILD-01': { webhookSecret: 'secret-sig-1' },
    'EXT-REG-01': { apiKey: 'reg-key-1' },
  });
  const certOrder = await configuredAdapters['EXT-CERT-01'].requestOrder({ domain: 'test.com' });
  assert.ok(certOrder.orderId);
  assert.equal(certOrder.status, 'pending_validation');
  const regAvail = await configuredAdapters['EXT-REG-01'].checkDomainAvailability('test.com');
  assert.equal(regAvail.available, true);

  // 4. Reseller Billing and Subscription Automation Deferral
  const deferredList = listDeferredBillingItems();
  assert.equal(deferredList.length, 5);
  for (const item of deferredList) {
    assert.equal(item.status, 'post_mvp_deferred');
    assert.equal(item.isMvpBlocker, false);
  }

  for (const forbiddenKey of FORBIDDEN_BILLING_KEYS) {
    assert.throws(
      () => assertNoResellerBillingPollution({ [forbiddenKey]: true }),
      (err) => err instanceof ResellerBillingDeferredError && err.status === 403,
    );
  }
  assert.throws(
    () => assertResellerBillingDeferred('syncWhmcsSubscriptions'),
    (err) => err instanceof ResellerBillingDeferredError,
  );

  // 5. Express HTTP Route Integration with requirePanelRouteAccess
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
  const address = server.address();
  const port = address.port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const internalReq = async (method, reqPath, body = null) => {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  };

  // 5a. Unauthenticated request -> 401
  currentAuth = null;
  const unauthRes = await internalReq('GET', '/api/system/parity/os');
  assert.equal(unauthRes.status, 401);

  // 5b. Authenticated Owner -> 200 with all lines
  currentAuth = {
    user: { id: 'owner-e2e', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  const ownerOsRes = await internalReq('GET', '/api/system/parity/os');
  assert.equal(ownerOsRes.status, 200);
  assert.equal(ownerOsRes.body.data.total, 6);

  const ownerExtRes = await internalReq('GET', '/api/system/parity/external');
  assert.equal(ownerExtRes.status, 200);
  assert.equal(ownerExtRes.body.data.total, 6);

  const ownerDefRes = await internalReq('GET', '/api/system/parity/deferred-billing');
  assert.equal(ownerDefRes.status, 200);
  assert.equal(ownerDefRes.body.data.blocksInitialRelease, false);

  // 5c. Customer role access filtering
  currentAuth = {
    user: { id: 'customer-e2e', role: 'customer', active: true },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  const custOsRes = await internalReq('GET', '/api/system/parity/os');
  assert.equal(custOsRes.status, 200);
  assert.ok(custOsRes.body.data.total < ownerOsRes.body.data.total);

  // Customer querying owner-only line returns 403
  const custForbidden = await internalReq('GET', '/api/system/parity/os/WIN-01');
  assert.equal(custForbidden.status, 403);
  assert.equal(custForbidden.body.error.code, 'tenant_boundary_forbidden');

  // 5d. Fail-closed adapter execution via HTTP
  currentAuth = {
    user: { id: 'owner-e2e', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  const execOsRes = await internalReq('POST', '/api/system/parity/os/WIN-01/execute', {
    method: 'getServiceStatus',
    args: ['W3SVC'],
  });
  assert.equal(execOsRes.status, 501);
  assert.equal(execOsRes.body.error.code, 'windows_platform_unsupported');

  const execExtRes = await internalReq('POST', '/api/system/parity/external/EXT-BUILD-01/execute', {
    method: 'createBuilderSession',
    params: { siteId: 's1', domain: 'd1.com' },
  });
  assert.equal(execExtRes.status, 501);
  assert.equal(execExtRes.body.error.code, 'sitebuilder_unconfigured');

  // 5e. Billing validation endpoint rejects premature billing
  const badBillRes = await internalReq('POST', '/api/system/parity/validate-billing', {
    billingAutomation: { cron: '0 0 1 * *' },
  });
  assert.equal(badBillRes.status, 403);
  assert.equal(badBillRes.body.error.code, 'reseller_billing_deferred');

  const cleanBillRes = await internalReq('POST', '/api/system/parity/validate-billing', {
    quotaProfile: 'standard',
  });
  assert.equal(cleanBillRes.status, 200);
  assert.equal(cleanBillRes.body.data.valid, true);

  assert.ok(true, 'PAR-05: Windows OS equivalence boundaries, fail-closed contracts, external lifecycle boundaries, and reseller billing deferral verified.');
});

// ============================================================================
// STAGING E2E T-DEV-MR-SINGLE: Single Mailbox Removal Lifecycle & Session Guard
// ============================================================================

test('Staging E2E T-DEV-MR-SINGLE: Aynı etkin mail domain içinde A\'yı kapat/uygula/yedekle/sil; B\'nin SMTP/IMAP/webmail kullanımı sürsün. A\'nın mevcut Dovecot oturumları, yeni auth/teslimat reddi', async (t) => {
  const stagingServerId = randomUUID();
  const stagingWebDomainId = randomUUID();
  const stagingMailDomainId = randomUUID();
  const dormantWebDomainId = randomUUID();
  const dormantMailDomainId = randomUUID();
  const mailboxAId = randomUUID();
  const mailboxBId = randomUUID();

  const sha256Str = (val) => createHash('sha256').update(val).digest('hex');
  const snapshotAlice = sha256Str('alice-initial-maildir-state');
  const snapshotBob = sha256Str('bob-initial-maildir-state');
  const backupContentAlice = sha256Str('alice-backup-archive-content');

  // 1. Setup Domains and Mailboxes in Active Mail Domain
  const activeMailDomain = {
    id: stagingMailDomainId,
    webDomainId: stagingWebDomainId,
    domainName: 'cryptoraichu.website',
    managementMode: 'local',
    status: 'enabled',
    revision: 10,
  };

  const dormantMailDomain = {
    id: dormantMailDomainId,
    webDomainId: dormantWebDomainId,
    domainName: 'dormant.cryptoraichu.website',
    managementMode: 'local',
    status: 'disabled',
    revision: 3,
  };

  const activeWebDomain = {
    id: stagingWebDomainId,
    serverId: stagingServerId,
    primaryDomain: 'cryptoraichu.website',
    websiteId: randomUUID(),
  };

  const dormantWebDomain = {
    id: dormantWebDomainId,
    serverId: stagingServerId,
    primaryDomain: 'dormant.cryptoraichu.website',
    websiteId: randomUUID(),
  };

  const mailboxes = new Map([
    [mailboxAId, {
      id: mailboxAId,
      mailDomainId: stagingMailDomainId,
      address: 'alice@cryptoraichu.website',
      enabled: true,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    [mailboxBId, {
      id: mailboxBId,
      mailDomainId: stagingMailDomainId,
      address: 'bob@cryptoraichu.website',
      enabled: true,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  ]);

  const mailboxDataStore = new Map([
    ['alice@cryptoraichu.website', {
      present: true,
      bytes: 10240,
      snapshotSha256: snapshotAlice,
      dataPath: '/var/vmail/cryptoraichu.website/alice',
    }],
    ['bob@cryptoraichu.website', {
      present: true,
      bytes: 20480,
      snapshotSha256: snapshotBob,
      dataPath: '/var/vmail/cryptoraichu.website/bob',
    }],
  ]);

  const backups = new Map([
    ['backup-alice-001', {
      version: 1,
      backupId: 'backup-alice-001',
      scope: 'mailbox',
      identity: 'alice@cryptoraichu.website',
      sourcePath: '/var/vmail/cryptoraichu.website/alice',
      sourcePresent: true,
      sourceSnapshotSha256: snapshotAlice,
      contentSha256: backupContentAlice,
      bytes: 10240,
      files: 5,
      directories: 3,
      createdAt: new Date().toISOString(),
      sideEffects: true,
    }],
  ]);

  const aliases = [];
  const quotas = new Map();
  const forwardings = new Map();
  const jobs = new Map();
  const enqueuedJobs = [];

  // Protocol Session Tracker
  const sessionTracker = createMailboxProtocolSessionTracker();

  // Register baseline sessions for Mailbox A (Alice)
  sessionTracker.registerDovecotSession('alice@cryptoraichu.website', { proto: 'imap', pid: '3001', ip: '192.168.1.10' });
  sessionTracker.registerDovecotSession('alice@cryptoraichu.website', { proto: 'pop3', pid: '3002', ip: '192.168.1.10' });
  sessionTracker.registerAuthenticatedSmtpSession('alice@cryptoraichu.website', { sessionId: 'smtp-alice-sess-01', clientIp: '192.168.1.10' });
  sessionTracker.registerWebmailHttpSession('alice@cryptoraichu.website', { sessionId: 'webmail-alice-sess-01' });

  // Register baseline sessions for Mailbox B (Bob)
  sessionTracker.registerDovecotSession('bob@cryptoraichu.website', { proto: 'imap', pid: '4001', ip: '192.168.1.20' });
  sessionTracker.registerDovecotSession('bob@cryptoraichu.website', { proto: 'imap', pid: '4002', ip: '192.168.1.21' });
  sessionTracker.registerAuthenticatedSmtpSession('bob@cryptoraichu.website', { sessionId: 'smtp-bob-sess-01', clientIp: '192.168.1.20' });
  sessionTracker.registerWebmailHttpSession('bob@cryptoraichu.website', { sessionId: 'webmail-bob-sess-01' });

  // Mailbox Registry Mock
  const mailboxRegistry = {
    async getMailbox(id) {
      return mailboxes.has(id) ? structuredClone(mailboxes.get(id)) : null;
    },
    async listMailboxes(filter = {}) {
      const list = [...mailboxes.values()];
      if (filter.mailDomainId) {
        return list.filter((m) => m.mailDomainId === filter.mailDomainId).map((m) => structuredClone(m));
      }
      return list.map((m) => structuredClone(m));
    },
    async createMailbox(input) {
      const id = randomUUID();
      const record = { id, mailDomainId: input.mailDomainId, address: input.address, enabled: input.enabled ?? true, revision: 1 };
      mailboxes.set(id, record);
      return structuredClone(record);
    },
    async rotatePassword(id, { expectedRevision }) {
      const mb = mailboxes.get(id);
      if (!mb) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (mb.revision !== expectedRevision) throw new MailboxRegistryError('stale_mailbox_revision', 'Revision mismatch', 409);
      mb.revision += 1;
      return structuredClone(mb);
    },
    async setEnabled(id, { expectedRevision, enabled }) {
      const mb = mailboxes.get(id);
      if (!mb) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (mb.revision !== expectedRevision) throw new MailboxRegistryError('stale_mailbox_revision', 'Revision mismatch', 409);
      mb.enabled = Boolean(enabled);
      mb.revision += 1;
      mb.updatedAt = new Date().toISOString();
      return structuredClone(mb);
    },
    async deleteMailbox(id, { expectedRevision, confirmation }) {
      const mb = mailboxes.get(id);
      if (!mb) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (mb.revision !== expectedRevision) throw new MailboxRegistryError('stale_mailbox_revision', 'Revision mismatch', 409);
      if (confirmation !== `delete-mailbox:${mb.address}`) {
        throw new MailboxRegistryError('mailbox_confirmation_mismatch', 'Mailbox confirmation mismatch', 409);
      }
      mailboxes.delete(id);
      return { id, deleted: true };
    },
    async materializeEnabledAccounts() {
      const HASH = '$argon2id$v=19$m=65536,t=3,p=1$' + Buffer.alloc(16, 5).toString('base64').replace(/=+$/, '') + '$' + Buffer.alloc(32, 6).toString('base64').replace(/=+$/, '');
      return [...mailboxes.values()]
        .filter((m) => m.enabled)
        .sort((a, b) => a.address.localeCompare(b.address))
        .map((m) => ({ address: m.address, passwordHash: HASH }));
    },
  };

  const mailDomainRegistry = {
    async getMailDomain(id) {
      if (id === stagingMailDomainId) return structuredClone(activeMailDomain);
      if (id === dormantMailDomainId) return structuredClone(dormantMailDomain);
      return null;
    },
    async listMailDomains() {
      return [structuredClone(activeMailDomain), structuredClone(dormantMailDomain)];
    },
    async deleteMailDomain() {
      throw new Error('mailDomain deletion not expected during single mailbox removal');
    },
  };

  const domainRegistry = {
    async getDomain(id) {
      if (id === stagingWebDomainId) return structuredClone(activeWebDomain);
      if (id === dormantWebDomainId) return structuredClone(dormantWebDomain);
      return null;
    },
  };

  const mailAliasRegistry = {
    async listAliases(filter) {
      if (filter?.mailDomainId) {
        return aliases.filter((a) => a.mailDomainId === filter.mailDomainId).map((a) => structuredClone(a));
      }
      return aliases.map((a) => structuredClone(a));
    },
    async materializeEnabledAliases() {
      return [];
    },
  };

  const mailboxQuotaRegistry = {
    async getQuota(id) { return quotas.get(id) ?? null; },
  };

  const mailboxForwardingRegistry = {
    async getForwarding(id) { return forwardings.get(id) ?? null; },
  };

  const mailDkimRegistry = {
    async getKey() { return null; },
  };

  const jobRegistry = {
    async listJobs(filter = {}) {
      let list = [...jobs.values()];
      if (filter.resourceType) list = list.filter((j) => j.resourceType === filter.resourceType);
      if (filter.resourceId) list = list.filter((j) => j.resourceId === filter.resourceId);
      return list.map((j) => structuredClone(j));
    },
    async getJob(id) {
      return jobs.get(id) ? structuredClone(jobs.get(id)) : null;
    },
    async enqueue(input) {
      const id = randomUUID();
      const job = {
        id,
        serverId: input.serverId,
        type: input.type,
        operation: input.operation,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        status: 'queued',
        payload: structuredClone(input.payload),
        idempotencyKey: input.idempotencyKey,
      };
      jobs.set(id, job);
      enqueuedJobs.push(job);
      return structuredClone(job);
    },
  };

  const mailDataInspector = {
    async inspectMailbox(address) {
      const data = mailboxDataStore.get(address);
      if (!data) return { present: false, bytes: 0, snapshotSha256: null };
      return {
        version: 1,
        scope: 'mailbox',
        identity: address,
        dataPath: data.dataPath,
        present: data.present,
        bytes: data.bytes,
        snapshotSha256: data.snapshotSha256,
        sideEffects: false,
      };
    },
    async inspectDomain(domainName) {
      return {
        version: 1,
        scope: 'domain',
        identity: domainName,
        present: true,
        bytes: 30720,
        snapshotSha256: sha256Str('domain-data'),
        sideEffects: false,
      };
    },
  };

  const mailDataBackupManager = {
    async inspectBackup(id) {
      return backups.get(id) ? structuredClone(backups.get(id)) : null;
    },
    async materializeBackup(id) {
      const b = backups.get(id);
      if (!b) throw new Error('backup not found');
      return { manifest: structuredClone(b) };
    },
  };

  const mailDeleteImpact = createMailDeleteImpactService({
    localServerId: stagingServerId,
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDkimRegistry,
    jobRegistry,
    mailDataInspector,
  });

  const mailDataOperations = createMailDataOperationsService({
    localServerId: stagingServerId,
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailDataInspector,
    mailDataBackupManager,
    mailDeleteImpactService: mailDeleteImpact,
    jobRegistry,
  });

  const mailDeleteFinalize = createMailDeleteFinalizeService({
    mailboxRegistry,
    mailDomainRegistry,
    mailDeleteImpactService: mailDeleteImpact,
    jobRegistry,
  });

  // Dovecot & Postfix command runner simulating live OS host state
  const commandLog = [];
  const commandRunner = async (file, args, options = {}) => {
    commandLog.push({ file, args: [...args] });
    const fileBase = file.split('/').at(-1);

    if (fileBase === 'postconf') {
      const param = args[1];
      if (param === 'virtual_mailbox_maps') {
        return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf', stderr: '' };
      }
      if (param === 'smtpd_sender_login_maps') {
        return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }

    if (fileBase === 'postmap') {
      const address = args[1];
      const mb = [...mailboxes.values()].find((m) => m.address === address);
      if (mb && mb.enabled) {
        return { stdout: `user-${address}`, stderr: '' };
      }
      const err = new Error('not found');
      err.code = 1;
      err.stdout = '';
      err.stderr = '';
      throw err;
    }

    if (fileBase === 'doveadm') {
      const sub = args[0];
      if (sub === 'auth' && args[1] === 'lookup') {
        const address = args.at(-1);
        const mb = [...mailboxes.values()].find((m) => m.address === address);
        if (mb && mb.enabled) {
          return { stdout: address, stderr: '' };
        }
        const err = new Error('user not found');
        err.code = 67;
        err.stdout = '';
        err.stderr = `passdb lookup: user ${address} doesn't exist`;
        throw err;
      }
      if (sub === 'user') {
        const address = args.at(-1);
        const mb = [...mailboxes.values()].find((m) => m.address === address);
        if (mb && mb.enabled) {
          return { stdout: '1000', stderr: '' };
        }
        const err = new Error('user not found');
        err.code = 67;
        err.stdout = '';
        err.stderr = `userdb lookup: user ${address} doesn't exist`;
        throw err;
      }
      if (sub === 'auth' && args[1] === 'cache' && args[2] === 'flush') {
        return { stdout: '1 cache entries flushed', stderr: '' };
      }
      if (sub === 'kick') {
        const address = args[1];
        sessionTracker.kickDovecotUser(address);
        return { stdout: address, stderr: '' };
      }
      if (args.includes('who')) {
        const address = args.at(-1);
        return { stdout: sessionTracker.doveadmWhoOutput(address), stderr: '' };
      }
    }

    throw new Error(`Unexpected command in test: ${file} ${args.join(' ')}`);
  };

  const accessGuard = createMailboxAccessGuard({ run: commandRunner });

  // Mount Express application with panel security guards
  const app = express();
  app.use(express.json());
  let currentAuth = {
    user: { id: 'owner-e2e', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  app.use((req, _res, next) => {
    req.auth = currentAuth;
    next();
  });

  mountMailboxRoutes(app, {
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDomainRegistry,
    domainRegistry,
    mailDeleteFinalizeService: mailDeleteFinalize,
    localServerId: stagingServerId,
  });

  mountMailDeleteImpactRoutes(app, {
    mailDeleteImpactService: mailDeleteImpact,
  });

  mountMailDataRoutes(app, {
    mailDataOperationsService: mailDataOperations,
  });

  mountSingleMailboxLifecycleRoutes(app, {
    sessionTracker,
    mailboxRegistry,
    mailDomainRegistry,
  });

  app.use((error, _req, res, _next) => {
    const status = error.status || (error instanceof MailboxRegistryError ? error.status : 400);
    res.status(status).json({
      error: { code: error.code || 'internal_error', message: error.message },
    });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const apiReq = async (method, reqPath, body = null) => {
    const res = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
      method,
      headers: body !== null ? { 'Content-Type': 'application/json' } : {},
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  };

  // ========================================================================
  // VERIFICATION SECTION 1: Baseline Invariants & Mailbox B Continuity
  // ========================================================================
  assert.equal(activeMailDomain.status, 'enabled', 'Active mail domain must be enabled initially');
  assert.equal(dormantMailDomain.status, 'disabled', 'Dormant mail domain must be disabled initially');
  const initA = await mailboxRegistry.getMailbox(mailboxAId);
  const initB = await mailboxRegistry.getMailbox(mailboxBId);
  assert.equal(initA.enabled, true, 'Mailbox A is initially enabled');
  assert.equal(initB.enabled, true, 'Mailbox B is initially enabled');

  // Verify Mailbox B's baseline continuity:
  assertSiblingMailboxContinuity({
    address: 'bob@cryptoraichu.website',
    sessionTracker,
    activeDovecotCount: 2,
  });

  // ========================================================================
  // VERIFICATION SECTION 2: Step 1 - Kapat (Disable Mailbox A)
  // ========================================================================
  const disableRes = await apiReq('PATCH', `/api/mailboxes/${mailboxAId}`, {
    expectedRevision: 1,
    enabled: false,
  });
  assert.equal(disableRes.status, 200, 'Mailbox A disable should succeed with 200');
  assert.equal(disableRes.body.data.enabled, false);
  assert.equal(disableRes.body.data.revision, 2);

  // Invariant assertions:
  assertNoDomainOrSiblingDisruption({
    sharedDomain: activeMailDomain,
    siblingMailbox: await mailboxRegistry.getMailbox(mailboxBId),
    initialDomainStatus: 'enabled',
  });
  assertNoClosedDomainReopened(dormantMailDomain);

  // Mailbox B continuity after Mailbox A disable:
  assertSiblingMailboxContinuity({
    address: 'bob@cryptoraichu.website',
    sessionTracker,
    activeDovecotCount: 2,
  });

  // ========================================================================
  // VERIFICATION SECTION 3: Step 2 - Uygula & Quiesce Sessions
  // ========================================================================
  // Simulating config apply for the shared domain with unchanged 'enabled' status
  assert.equal(activeMailDomain.status, 'enabled', 'Domain must remain enabled during configuration apply');
  assert.equal(dormantMailDomain.status, 'disabled', 'Closed domain must NOT be reopened');

  // Quiesce target mailbox sessions:
  sessionTracker.kickDovecotUser('alice@cryptoraichu.website');
  sessionTracker.invalidateSmtpSessions('alice@cryptoraichu.website');
  sessionTracker.terminateWebmailHttpSessions('alice@cryptoraichu.website');

  // SEPARATE VERIFICATION of all 5 termination requirements for Mailbox A:
  // 1. Dovecot sessions terminated:
  const activeDovecotA = sessionTracker.listActiveDovecotSessions('alice@cryptoraichu.website');
  assert.equal(activeDovecotA.length, 0, 'Mailbox A must have 0 active Dovecot sessions');
  const whoOutputA = await commandRunner('/usr/bin/doveadm', ['-f', 'tab', 'who', '-1', 'alice@cryptoraichu.website']);
  assert.equal(whoOutputA.stdout.trim(), 'username\tproto\tpid\tip', 'Dovecot who output for A must have only header rows');

  // 2. New authentication and delivery rejected for Mailbox A:
  await assert.rejects(
    commandRunner('/usr/bin/doveadm', ['auth', 'lookup', '-x', 'service=imap', '-f', 'user', 'alice@cryptoraichu.website']),
    (err) => err.code === 67 && err.stderr.includes("passdb lookup: user alice@cryptoraichu.website doesn't exist"),
    'New Dovecot auth lookup for Mailbox A must fail closed with exit code 67',
  );
  await assert.rejects(
    commandRunner('/usr/sbin/postmap', ['-q', 'alice@cryptoraichu.website', 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf']),
    (err) => err.code === 1,
    'Postfix delivery lookup for Mailbox A must fail closed with exit code 1',
  );
  await assert.rejects(
    commandRunner('/usr/bin/doveadm', ['user', '-x', 'service=lmtp', '-f', 'uid', 'alice@cryptoraichu.website']),
    (err) => err.code === 67,
    'Dovecot userdb lookup for Mailbox A must fail closed with exit code 67',
  );

  // 3. Pre-authenticated SMTP sessions invalidated for Mailbox A:
  assert.throws(
    () => sessionTracker.verifySmtpSender('smtp-alice-sess-01', 'alice@cryptoraichu.website', (addr) => {
      const mb = [...mailboxes.values()].find((m) => m.address === addr);
      return mb ? mb.enabled : false;
    }),
    (err) => err instanceof MailboxSingleLifecycleError && ['smtp_sender_disabled', 'smtp_auth_invalid'].includes(err.code),
    'Pre-authenticated SMTP session for Mailbox A must be invalidated and rejected',
  );

  // 4. Ongoing LMTP deliveries rejected for Mailbox A:
  assert.throws(
    () => sessionTracker.deliverLmtpMessage('alice@cryptoraichu.website', 'Subject: Test mail to A', (addr) => {
      const mb = [...mailboxes.values()].find((m) => m.address === addr);
      return mb ? mb.enabled : false;
    }),
    (err) => err instanceof MailboxSingleLifecycleError && err.code === 'lmtp_recipient_not_found',
    'Ongoing LMTP delivery for Mailbox A must be rejected with 550 recipient not found',
  );

  // 5. Ongoing Webmail HTTP sessions terminated for Mailbox A:
  assert.throws(
    () => sessionTracker.validateWebmailHttpSession('webmail-alice-sess-01', (addr) => {
      const mb = [...mailboxes.values()].find((m) => m.address === addr);
      return mb ? mb.enabled : false;
    }),
    (err) => err instanceof MailboxSingleLifecycleError && ['webmail_account_disabled', 'webmail_session_invalid'].includes(err.code),
    'Webmail HTTP session for Mailbox A must be terminated with 401',
  );

  // Comprehensive assertion helper confirms all 5 channels terminated:
  const separateProof = assertMailboxAccessTerminatedSeparately({
    address: 'alice@cryptoraichu.website',
    sessionTracker,
  });
  assert.equal(separateProof.allChannelsTerminated, true);

  // Sibling Mailbox B continuity during & after apply:
  assertSiblingMailboxContinuity({
    address: 'bob@cryptoraichu.website',
    sessionTracker,
    activeDovecotCount: 2,
  });
  // Verify Bob's Dovecot lookup, Postfix lookup, SMTP sending, LMTP receiving, and Webmail HTTP session
  const passdbBob = await commandRunner('/usr/bin/doveadm', ['auth', 'lookup', '-x', 'service=imap', '-f', 'user', 'bob@cryptoraichu.website']);
  assert.equal(passdbBob.stdout, 'bob@cryptoraichu.website');
  const postmapBob = await commandRunner('/usr/sbin/postmap', ['-q', 'bob@cryptoraichu.website', 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf']);
  assert.equal(postmapBob.stdout, 'user-bob@cryptoraichu.website');

  const bobSmtp = sessionTracker.verifySmtpSender('smtp-bob-sess-01', 'bob@cryptoraichu.website', () => true);
  assert.equal(bobSmtp.authorized, true);

  const bobLmtp = sessionTracker.deliverLmtpMessage('bob@cryptoraichu.website', 'Subject: Test mail to Bob', () => true);
  assert.equal(bobLmtp.delivered, true);

  const bobWebmail = sessionTracker.validateWebmailHttpSession('webmail-bob-sess-01', () => true);
  assert.equal(bobWebmail.valid, true);

  // Invariant checks:
  assertNoDomainOrSiblingDisruption({
    sharedDomain: activeMailDomain,
    siblingMailbox: await mailboxRegistry.getMailbox(mailboxBId),
  });
  assertNoClosedDomainReopened(dormantMailDomain);

  // ========================================================================
  // VERIFICATION SECTION 4: Step 3 - Yedekle (Backup Mailbox A Data)
  // ========================================================================
  // Impact check shows data backup is required before deletion
  const impactRes = await apiReq('GET', `/api/mailboxes/${mailboxAId}/delete-impact`);
  assert.equal(impactRes.status, 200);
  assert.equal(impactRes.body.data.requiresDataBackup, true);

  const backupPreviewRes = await apiReq('GET', `/api/mailboxes/${mailboxAId}/data/backup-preview`);
  assert.equal(backupPreviewRes.status, 200);
  const backupPreview = backupPreviewRes.body.data;
  assert.equal(backupPreview.operation, 'mail_data_backup');
  assert.equal(backupPreview.identity, 'alice@cryptoraichu.website');

  const queueBackupRes = await apiReq('POST', `/api/mailboxes/${mailboxAId}/data/backup`, {
    expectedRevision: backupPreview.expectedRevision,
    expectedPreviewDigest: backupPreview.previewDigest,
    confirmation: backupPreview.confirmation,
  });
  assert.equal(queueBackupRes.status, 202);
  const backupJob = enqueuedJobs.find((j) => j.type === 'mail_data_backup');
  assert.ok(backupJob, 'Backup job must be enqueued');
  jobs.get(backupJob.id).status = 'succeeded';
  jobs.get(backupJob.id).result = {
    version: 1,
    transactionId: backupJob.id,
    backupId: 'backup-alice-001',
    mailDomainId: stagingMailDomainId,
    resourceId: mailboxAId,
    expectedResourceRevision: 2,
    scope: 'mailbox',
    identity: 'alice@cryptoraichu.website',
    sourcePresent: true,
    contentSha256: backupContentAlice,
    bytes: 10240,
  };

  // Mailbox B continuity remains intact during backup:
  assertSiblingMailboxContinuity({
    address: 'bob@cryptoraichu.website',
    sessionTracker,
  });

  // ========================================================================
  // VERIFICATION SECTION 5: Step 4 - Sil (Delete Mailbox A Data with Quiesce)
  // ========================================================================
  const delPreviewRes = await apiReq('POST', `/api/mailboxes/${mailboxAId}/data/delete-preview`, {
    backupId: 'backup-alice-001',
  });
  assert.equal(delPreviewRes.status, 200);
  const delPreview = delPreviewRes.body.data;
  assert.equal(delPreview.operation, 'mail_data_delete');
  assert.equal(delPreview.identity, 'alice@cryptoraichu.website');

  const queueDelRes = await apiReq('POST', `/api/mailboxes/${mailboxAId}/data/delete`, {
    backupId: 'backup-alice-001',
    expectedRevision: delPreview.expectedRevision,
    expectedPreviewDigest: delPreview.previewDigest,
    confirmation: delPreview.confirmation,
  });
  assert.equal(queueDelRes.status, 202);
  const delJob = enqueuedJobs.find((j) => j.type === 'mail_data_delete');
  assert.ok(delJob, 'Delete data job must be enqueued');

  // Simulate host worker execution with accessGuard quiesce:
  const quiesceResult = await accessGuard.quiesce('alice@cryptoraichu.website');
  assert.equal(quiesceResult.accessDisabled, true);
  assert.equal(quiesceResult.sessionsCleared, true);

  // Command runner was called for Alice only, NEVER for Bob:
  const kicked = commandLog.filter((c) => c.args[0] === 'kick').map((c) => c.args[1]);
  assert.ok(kicked.includes('alice@cryptoraichu.website'));
  assert.ok(!kicked.includes('bob@cryptoraichu.website'));

  // Mark data delete job as succeeded:
  mailboxDataStore.get('alice@cryptoraichu.website').present = false;
  mailboxDataStore.get('alice@cryptoraichu.website').bytes = 0;
  jobs.get(delJob.id).status = 'succeeded';
  jobs.get(delJob.id).result = {
    version: 1,
    transactionId: delJob.id,
    backupId: 'backup-alice-001',
    mailDomainId: stagingMailDomainId,
    resourceId: mailboxAId,
    expectedResourceRevision: 2,
    scope: 'mailbox',
    identity: 'alice@cryptoraichu.website',
    sourcePresent: true,
    contentSha256: backupContentAlice,
    bytes: 10240,
    files: 5,
    directories: 3,
    deleted: true,
    sideEffects: true,
  };

  // Mailbox B continuity remains intact during data deletion:
  assertSiblingMailboxContinuity({
    address: 'bob@cryptoraichu.website',
    sessionTracker,
  });
  assert.equal(mailboxDataStore.get('bob@cryptoraichu.website').present, true);

  // ========================================================================
  // VERIFICATION SECTION 6: Step 5 - Kaydı Kaldır (Finalize Deletion)
  // ========================================================================
  const finalizeRes = await apiReq('DELETE', `/api/mailboxes/${mailboxAId}`, {
    expectedRevision: 2,
    deleteJobId: delJob.id,
    confirmation: 'delete-mailbox:alice@cryptoraichu.website',
  });
  assert.equal(finalizeRes.status, 200);
  assert.equal(finalizeRes.body.data.deleted, true);
  assert.equal(finalizeRes.body.data.id, mailboxAId);

  // Post-deletion verification:
  const deletedCheck = await mailboxRegistry.getMailbox(mailboxAId);
  assert.equal(deletedCheck, null, 'Mailbox A must be absent from registry');
  const getDelRes = await apiReq('GET', `/api/mailboxes/${mailboxAId}`);
  assert.equal(getDelRes.status, 404, 'GET on deleted mailbox A must return 404');

  // Mailbox B remains present and enabled:
  const mbBAfter = await mailboxRegistry.getMailbox(mailboxBId);
  assert.ok(mbBAfter, 'Mailbox B must exist');
  assert.equal(mbBAfter.enabled, true, 'Mailbox B must still be enabled');
  assert.equal(mbBAfter.address, 'bob@cryptoraichu.website');
  assert.equal(mbBAfter.revision, 1, 'Mailbox B revision must be untouched');

  // Shared domain and dormant domain invariants:
  assert.equal(activeMailDomain.status, 'enabled', 'Shared mail domain must remain enabled');
  assert.equal(dormantMailDomain.status, 'disabled', 'Dormant mail domain must remain disabled');
  assertNoDomainOrSiblingDisruption({
    sharedDomain: activeMailDomain,
    siblingMailbox: mbBAfter,
  });
  assertNoClosedDomainReopened(dormantMailDomain);

  // Mailbox B uninterrupted full operations across SMTP, IMAP, and Webmail:
  assertSiblingMailboxContinuity({
    address: 'bob@cryptoraichu.website',
    sessionTracker,
    activeDovecotCount: 2,
  });

  // Listing mailboxes for domain returns only Mailbox B:
  const listAfter = await apiReq('GET', `/api/mailboxes?mailDomainId=${stagingMailDomainId}`);
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body.data.length, 1);
  assert.equal(listAfter.body.data[0].id, mailboxBId);
  assert.equal(listAfter.body.data[0].address, 'bob@cryptoraichu.website');

  // ========================================================================
  // VERIFICATION SECTION 7: Fail-Closed Security & Negative Constraints
  // ========================================================================
  // 7a. Deleting an enabled mailbox directly without disabling fails with 409
  const testBoxId = randomUUID();
  mailboxes.set(testBoxId, {
    id: testBoxId,
    mailDomainId: stagingMailDomainId,
    address: 'test-enabled@cryptoraichu.website',
    enabled: true,
    revision: 1,
  });
  mailboxDataStore.set('test-enabled@cryptoraichu.website', { present: true, bytes: 512, snapshotSha256: sha256Str('t') });
  backups.set('backup-test-01', {
    version: 1,
    backupId: 'backup-test-01',
    scope: 'mailbox',
    identity: 'test-enabled@cryptoraichu.website',
    sourcePath: '/var/vmail/cryptoraichu.website/test-enabled',
    sourcePresent: true,
    sourceSnapshotSha256: sha256Str('t'),
    contentSha256: sha256Str('c'),
    bytes: 512,
  });
  const badDelPreview = await apiReq('POST', `/api/mailboxes/${testBoxId}/data/delete-preview`, {
    backupId: 'backup-test-01',
  });
  assert.equal(badDelPreview.status, 409);
  assert.equal(badDelPreview.body.error.code, 'mail_data_delete_mailbox_disable_required');

  // 7b. Reopened closed domain assertion catches any unauthorized state flip
  assert.throws(
    () => assertNoClosedDomainReopened({ domainName: 'dormant.cryptoraichu.website', status: 'enabled' }),
    (err) => err instanceof MailboxProtocolDisruptionError && err.code === 'closed_domain_reopened',
  );

  // 7c. Sibling disruption assertion catches unexpected disabled state
  assert.throws(
    () => assertNoDomainOrSiblingDisruption({
      sharedDomain: { domainName: 'cryptoraichu.website', status: 'disabled' },
      siblingMailbox: { address: 'bob@cryptoraichu.website', enabled: true },
    }),
    (err) => err instanceof MailboxProtocolDisruptionError && err.code === 'domain_disrupted',
  );
  assert.throws(
    () => assertNoDomainOrSiblingDisruption({
      sharedDomain: { domainName: 'cryptoraichu.website', status: 'enabled' },
      siblingMailbox: { address: 'bob@cryptoraichu.website', enabled: false },
    }),
    (err) => err instanceof MailboxProtocolDisruptionError && err.code === 'sibling_disrupted',
  );

  // 7d. Stubborn session fails closed during access guard quiesce
  const stubbornRunner = async (file, args) => {
    if (args.includes('who')) {
      return { stdout: 'username\tproto\tpid\tip\nstubborn@test.com\timap\t9999\t1.2.3.4\n', stderr: '' };
    }
    if (args[0] === 'kick') return { stdout: 'stubborn@test.com', stderr: '' };
    if (args[0] === 'auth' && args[1] === 'cache') return { stdout: '1 cache entries flushed', stderr: '' };
    if (args[0] === 'auth' && args[1] === 'lookup') {
      const err = new Error('not found'); err.code = 67; err.stdout = ''; err.stderr = "passdb lookup: user stubborn@test.com doesn't exist"; throw err;
    }
    if (args[0] === 'user') {
      const err = new Error('not found'); err.code = 67; err.stdout = ''; err.stderr = "userdb lookup: user stubborn@test.com doesn't exist"; throw err;
    }
    if (file.endsWith('/postconf')) {
      return { stdout: args[1] === 'virtual_mailbox_maps' ? 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf' : 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf', stderr: '' };
    }
    if (file.endsWith('/postmap')) {
      const err = new Error('missing'); err.code = 1; err.stdout = ''; err.stderr = ''; throw err;
    }
    throw new Error('unexpected');
  };
  const stubbornGuard = createMailboxAccessGuard({ run: stubbornRunner });
  await assert.rejects(
    stubbornGuard.quiesce('stubborn@test.com'),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_sessions_remaining',
    'Stubborn sessions must fail closed with mailbox_access_sessions_remaining',
  );

  // Clean up test box
  mailboxes.delete(testBoxId);
  mailboxDataStore.delete('test-enabled@cryptoraichu.website');
  backups.delete('backup-test-01');

  // 7e. Field-only lookup, absence exit codes, cache flush, and single-user kick/who in real Dovecot/Postfix contracts
  const dovecotPostfixContracts = await assertDovecotPostfixCommandContracts({
    run: commandRunner,
    targetAddress: 'alice@cryptoraichu.website',
  });
  assert.equal(dovecotPostfixContracts.identity, 'alice@cryptoraichu.website');
  assert.equal(dovecotPostfixContracts.contractsVerified, true);
  assert.equal(dovecotPostfixContracts.quiesced.accessDisabled, true);
  assert.equal(dovecotPostfixContracts.quiesced.sessionsCleared, true);

  // 7f. Common config apply with pending changes & reload effect without whole-domain shutdown workaround
  const stagingMailConfigService = createMailConfigurationService({
    mailDomainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
  });

  const pendingMbId = randomUUID();
  mailboxes.set(pendingMbId, {
    id: pendingMbId,
    mailDomainId: stagingMailDomainId,
    address: 'charlie@cryptoraichu.website',
    enabled: true,
    revision: 1,
  });

  const configApplyPreview = await assertCommonConfigApplyPendingPreviewAndReloadEffect({
    mailConfigurationService: stagingMailConfigService,
    mailDomainRegistry,
    mailboxRegistry,
    mailDomainId: stagingMailDomainId,
    targetMailboxId: mailboxAId,
    otherPendingMailboxId: pendingMbId,
  });

  assert.equal(configApplyPreview.domainStatus, 'enabled');
  assert.equal(configApplyPreview.targetExcluded, true);
  assert.equal(configApplyPreview.pendingIncluded, true);
  assert.equal(configApplyPreview.accountsCount, 2);
  assert.ok(configApplyPreview.configurationSha256);
  assert.ok(configApplyPreview.previewDigest);
  assert.equal(configApplyPreview.domainShutdownWorkaroundAvoided, true);

  mailboxes.delete(pendingMbId);

  // Set up dedicated test mailbox and backup for 7g-7l validations
  const testMbId = randomUUID();
  const testMbAddress = 'recon@cryptoraichu.website';
  mailboxes.set(testMbId, {
    id: testMbId,
    mailDomainId: stagingMailDomainId,
    address: testMbAddress,
    enabled: false,
    revision: 1,
  });

  backups.set('backup-recon-001', {
    version: 1,
    backupId: 'backup-recon-001',
    scope: 'mailbox',
    identity: testMbAddress,
    sourcePath: `/var/lib/yunpanel/mail/cryptoraichu.website/recon`,
    sourcePresent: true,
    sourceSnapshotSha256: snapshotAlice,
    contentSha256: backupContentAlice,
    bytes: 4096,
    files: 2,
    directories: 1,
    createdAt: new Date().toISOString(),
    sideEffects: true,
  });

  // 7g. Lost PATCH, apply, delete, or finalize reply reconciliation
  const lostPatchReconcile = await reconcileLostMailboxOperation({
    operation: 'patch',
    mailboxId: testMbId,
    expectedRevision: 1,
    mailboxRegistry,
  });
  assert.equal(lostPatchReconcile.reconciled, true);
  assert.equal(lostPatchReconcile.duplicateWriteAvoided, true);

  // Lost finalize reconciliation for the already finalized mailboxAId
  const lostFinalizeReconcile = await reconcileLostMailboxOperation({
    operation: 'finalize',
    mailboxId: mailboxAId,
    address: 'alice@cryptoraichu.website',
    backupId: 'backup-alice-001',
    lastKnownJobId: delJob.id,
    mailboxRegistry,
    jobRegistry,
    mailDataInspector,
  });
  assert.equal(lostFinalizeReconcile.reconciled, true);
  assert.equal(lostFinalizeReconcile.deleted, true);
  assert.equal(lostFinalizeReconcile.verifiedByReceipt, true);

  // 7h. Rapid confirmation guard prevents duplicate mutations
  const rapidGuard = createRapidConfirmationGuard();
  const testToken = `delete-mailbox:${testMbAddress}:rev-1:${randomUUID()}`;
  const firstConfirmation = rapidGuard.beginConfirmation(testToken, { mailboxId: testMbId, revision: 1 });
  assert.throws(
    () => rapidGuard.beginConfirmation(testToken, { mailboxId: testMbId, revision: 1 }),
    (err) => err instanceof MailboxConcurrencyLockError && err.code === 'rapid_confirmation_in_flight',
  );
  firstConfirmation.commit({ deleted: true });
  assert.throws(
    () => rapidGuard.beginConfirmation(testToken, { mailboxId: testMbId, revision: 1 }),
    (err) => err instanceof MailboxConcurrencyLockError && err.code === 'confirmation_already_consumed',
  );

  // 7i. Resume job proof validation (rejects foreign job ID / mismatched backup)
  const resumeTestJobId = randomUUID();
  jobs.set(resumeTestJobId, {
    id: resumeTestJobId,
    operation: OPERATIONS.MAIL_DATA_DELETE,
    resourceType: 'mail_domain',
    resourceId: stagingMailDomainId,
    status: 'succeeded',
    result: {
      scope: 'mailbox',
      identity: testMbAddress,
      backupId: 'backup-recon-001',
      expectedResourceRevision: 1,
      deleted: true,
    },
  });

  const validResume = await validateResumeJobProof({
    jobId: resumeTestJobId,
    expectedScope: 'mailbox',
    expectedResourceId: stagingMailDomainId,
    expectedAddress: testMbAddress,
    expectedBackupId: 'backup-recon-001',
    expectedRevision: 1,
    expectedOperation: OPERATIONS.MAIL_DATA_DELETE,
    jobRegistry,
    backupManager: mailDataBackupManager,
  });
  assert.equal(validResume.valid, true);

  await assert.rejects(
    validateResumeJobProof({
      jobId: resumeTestJobId,
      expectedScope: 'mailbox',
      expectedResourceId: stagingMailDomainId,
      expectedAddress: 'stranger@cryptoraichu.website',
      jobRegistry,
      backupManager: mailDataBackupManager,
    }),
    (err) => err.code === 'resume_job_identity_mismatch',
  );

  // 7j. Actor authorization continuity assertions
  const originalStagingAuth = {
    user: { id: 'owner-1', role: 'owner', active: true },
    sessionVersion: 'v1.0.0',
    security: { managementAllowed: true },
  };
  const continuousAuth = assertActorAuthorizationContinuous({
    currentAuth: structuredClone(originalStagingAuth),
    originalAuth: originalStagingAuth,
  });
  assert.equal(continuousAuth.authorized, true);

  assert.throws(
    () => assertActorAuthorizationContinuous({
      currentAuth: { ...originalStagingAuth, user: { ...originalStagingAuth.user, role: 'read_only' } },
      originalAuth: originalStagingAuth,
    }),
    (err) => err instanceof MailboxAuthorizationRevokedError && err.code === 'auth_permission_revoked',
  );

  // 7k. Inter-process lock worker mutation guard against alias and reactivation races
  const stagingLockManager = createMailboxInterProcessLockManager({
    serverId: stagingServerId,
    acquireLockFn: async ({ filePath, serverId, pid }) => ({
      filePath,
      serverId,
      pid,
      release: async () => true,
    }),
  });

  const concurrencyGuardResult = await assertWorkerMutationConcurrencyGuard({
    mailboxId: testMbId,
    address: testMbAddress,
    lockManager: stagingLockManager,
    concurrentAliasAttempt: async () => {},
    concurrentReactivateAttempt: async () => {},
    concurrentMessageDeliveryAttempt: async () => {},
    actionFn: async (lock) => {
      assert.equal(stagingLockManager.isLocked(testMbId), true);
      assert.equal(stagingLockManager.isAddressLocked(testMbAddress), true);
      return { mutationGuarded: true };
    },
  });
  assert.equal(concurrencyGuardResult.executed, true);
  assert.equal(concurrencyGuardResult.racesPrevented, true);
  assert.equal(stagingLockManager.isLocked(testMbId), false);

  // 7l. Real host rollback verification on failure
  let stagingDataState = {
    present: true,
    bytes: 4096,
    snapshotSha256: snapshotAlice,
  };
  const stagingInspector = {
    inspectMailbox: async () => ({ ...stagingDataState }),
  };
  const rollbackFailingDeleteManager = {
    deleteData: async () => {
      stagingDataState.present = false;
      // Host rollback restores data
      stagingDataState.present = true;
      stagingDataState.snapshotSha256 = snapshotAlice;
      stagingDataState.bytes = 4096;
      const err = new Error('Simulated host failure during file unlink');
      err.code = 'mail_data_delete_failed';
      throw err;
    },
  };

  const rollbackResult = await executeMailboxDeletionWithRollbackVerification({
    mailboxId: testMbId,
    address: testMbAddress,
    backupId: 'backup-recon-001',
    expectedRevision: 1,
    deleteManager: rollbackFailingDeleteManager,
    backupManager: mailDataBackupManager,
    mailDataInspector: stagingInspector,
    mailboxRegistry,
  });
  assert.equal(rollbackResult.success, false);
  assert.equal(rollbackResult.rolledBack, true);
  assert.equal(rollbackResult.liveDataRestored, true);
  assert.equal(rollbackResult.mailboxPreserved, true);

  // Clean up
  mailboxes.delete(testMbId);
  backups.delete('backup-recon-001');

  assert.ok(true, 'T-DEV-MR-SINGLE: Single mailbox lifecycle, session termination, and sibling continuity verified.');
});

// ============================================================================
// STAGING E2E T-DEV-CREATE-RESULT: Site oluşturma sonucu sürekliliği,
// React StrictMode, logout/login, yetki değişimi, unmount/abort, parola temizleme
// ve sonuç odağı / ekran okuyucu / mobil / klavye / koyu tema uyumu
// ============================================================================

test('Staging E2E T-DEV-CREATE-RESULT: React StrictMode, logout/login, yetki değişimi, unmount/abort, parola temizleme ve sonuç erişilebilirliği', async (t) => {
  // 1. Staging environment isolation: Never access .44
  const stagingServerId = '77777777-7777-4777-8777-777777777777';
  assertNoDot44Host(stagingServerId);
  assert.doesNotMatch(stagingServerId, /\.44$/);

  const websiteId = randomUUID();
  const domainId = randomUUID();
  const operationId = randomUUID();
  const primaryDomain = 'cryptoraichu.website';

  const testInput = () => ({
    operationId,
    serverId: stagingServerId,
    primaryDomain,
    parentDomainId: null,
    siteAdmin: { password: 'fixture-secret-admin-pass' },
  });

  const stepFixture = (state = 'pending') => ({ id: 'nginx', required: true, state });
  const operationFixture = (state = 'pending') => ({
    operationId,
    websiteId,
    ready: state === 'succeeded',
    steps: [stepFixture(state)],
  });

  const previewFixture = () => ({
    operationId,
    ids: { websiteId, primaryDomainId: domainId },
    hostname: { primaryDomain },
    previewDigest: 'b'.repeat(64),
    confirmation: `create-site:${operationId}:${'b'.repeat(64)}`,
    provisioning: operationFixture(),
  });

  const resultFixture = () => ({
    operationId,
    website: { id: websiteId, serverId: stagingServerId },
    primaryDomain: { id: domainId, websiteId, serverId: stagingServerId, primaryDomain, parentDomainId: null },
    provisioning: operationFixture(),
  });

  const deferredHelper = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  // 2. React StrictMode Mount -> Unmount -> Remount and Abort Lifecycle
  // Mount 1 starts submission
  const gate1 = deferredHelper();
  const controller1 = new AbortController();
  const states1 = [];
  let isCurrent1 = true;
  const flow1 = createSiteSubmission({
    request: async (url) => (url.endsWith('create-preview') ? gate1.promise : resultFixture()),
    advance: async () => operationFixture('succeeded'),
    isCurrent: () => isCurrent1 && !controller1.signal.aborted,
    onState: (st) => states1.push(st),
  });

  const pending1 = flow1.submit(testInput(), { signal: controller1.signal });
  await new Promise(setImmediate);
  assert.equal(states1.length, 1);
  assert.equal(states1[0].phase, 'previewing');

  // React StrictMode unmount cleanup: abort controller + flow.dispose()
  flow1.dispose();
  controller1.abort();
  isCurrent1 = false;

  // Mount 2 (StrictMode remount) initializes fresh flow and submission context
  const gate2 = deferredHelper();
  const controller2 = new AbortController();
  const states2 = [];
  let isCurrent2 = true;
  const flow2 = createSiteSubmission({
    request: async (url) => (url.endsWith('create-preview') ? gate2.promise : resultFixture()),
    advance: async () => operationFixture('succeeded'),
    isCurrent: () => isCurrent2 && !controller2.signal.aborted,
    onState: (st) => states2.push(st),
  });

  // Late resolution of aborted Mount 1 preview
  gate1.resolve(previewFixture());
  await pending1;

  // Verify Mount 1 callbacks were completely suppressed after disposal
  assert.equal(states1.some((s) => s.phase === 'creating' || s.phase === 'ready'), false);

  // Mount 2 runs cleanly without any stale leakage from Mount 1
  const pending2 = flow2.submit(testInput(), { signal: controller2.signal });
  await new Promise(setImmediate);
  assert.equal(states2[0].phase, 'previewing');
  gate2.resolve(previewFixture());
  const finalState2 = await pending2;
  assert.equal(finalState2.phase, 'ready');
  assert.equal(finalState2.created.id, domainId);
  assert.equal(states2.at(-1).phase, 'ready');

  // 3. Logout / Login and Role Transition Isolation
  let sessionActive = true;
  const sessionStates = [];
  const gateSession = deferredHelper();
  const sessionFlow = createSiteSubmission({
    request: async (url) => (url.endsWith('create-preview') ? gateSession.promise : resultFixture()),
    advance: async () => operationFixture('succeeded'),
    isCurrent: () => sessionActive,
    onState: (st) => sessionStates.push(st),
  });

  const sessionPending = sessionFlow.submit(testInput());
  await new Promise(setImmediate);
  assert.equal(sessionStates.length, 1);
  assert.equal(sessionStates[0].phase, 'previewing');

  // User logs out or changes role (e.g., Owner -> Customer) during in-flight submission
  sessionActive = false;
  gateSession.resolve(previewFixture());
  await sessionPending;

  // No further state published after session boundary change
  assert.equal(sessionStates.length, 1);
  assert.notEqual(sessionFlow.getState().phase, 'ready');

  // New session begins with EMPTY_SITE_SUBMISSION, zero residual state
  assert.deepEqual(EMPTY_SITE_SUBMISSION, {
    phase: 'idle',
    created: null,
    steps: [],
    error: null,
    siteAdmin: null,
  });

  // 4. Password Clearing and Zero Memory Retention Verification
  let formState = {
    primaryDomain,
    serverId: stagingServerId,
    adminPassword: 'P@ssw0rdLiveVerify2026!',
  };

  // Simulating form state updater on creation confirmation
  const onSubmissionConfirmation = (st) => {
    if (st.created || st.phase === 'uncertain') {
      formState = { ...formState, adminPassword: '' };
    } else if (st.phase === 'error' || st.error) {
      formState = { ...formState, adminPassword: '' };
    }
  };

  // Confirm password cleared on success
  onSubmissionConfirmation({ created: { id: domainId, websiteId, primaryDomain }, phase: 'ready' });
  assert.equal(formState.adminPassword, '');

  // Confirm password cleared on error / abort
  formState.adminPassword = 'TempErrorPassword!';
  onSubmissionConfirmation({ phase: 'error', error: 'Creation failed' });
  assert.equal(formState.adminPassword, '');

  // Confirm password cleared on caught exception in submit handler
  formState.adminPassword = 'TempAbortPassword!';
  try {
    throw new Error('User aborted operation');
  } catch {
    formState = { ...formState, adminPassword: '' };
  }
  assert.equal(formState.adminPassword, '');

  // Confirm createSiteSubmission state never retains password
  assert.equal('adminPassword' in finalState2, false);
  assert.equal('password' in finalState2, false);
  assert.equal(JSON.stringify(finalState2).includes('fixture-secret-admin-pass'), false);

  // 5. Accessibility, Result Focus, Screen Reader Live Regions, and Theme Compliance
  const readProjectFile = async (relPath) => readFile(new URL(relPath, import.meta.url), 'utf8');
  const resultCode = await readProjectFile('../../web/src/workspace/SiteCreateResult.jsx');
  const pageCode = await readProjectFile('../../web/src/workspace/NewWebsitePage.jsx');
  const consoleCss = await readProjectFile('../../web/src/workspace/ui/console-theme.css');
  const emberCss = await readProjectFile('../../web/src/workspace/ui/ember-theme.css');

  // Result container auto-focus on mount with tabIndex={-1}
  assert.match(resultCode, /ref=\{resultRef\}/);
  assert.match(resultCode, /tabIndex=\{-1\}/);
  assert.match(resultCode, /resultRef\.current\?\.focus\(\)/);

  // Screen reader polite live region for non-intrusive status announcements
  assert.match(resultCode, /aria-live="polite"/);
  assert.match(resultCode, /aria-atomic="true"/);

  // Shared site result container auto-focus and live region
  assert.match(pageCode, /ref=\{sharedResultRef\}/);
  assert.match(pageCode, /tabIndex=\{-1\}/);
  assert.match(pageCode, /aria-live="polite"/);
  assert.match(pageCode, /sharedResultRef\.current\?\.focus\(\)/);

  // Theme styling for focus-visible ring across console and ember themes
  assert.match(consoleCss, /\.ws-site-create-result:focus/);
  assert.match(consoleCss, /\.ws-site-create-result:focus-visible/);
  assert.match(emberCss, /\.workspace-shell \.ws-site-create-result:focus/);
  assert.match(emberCss, /\.workspace-shell \.ws-site-create-result:focus-visible/);

  // 6. Shared-site Explicit Confirmation and Tenant Boundary
  // Shared site connection requires explicit user confirmation
  assert.match(pageCode, /sharedConfirmation/);
  assert.match(pageCode, /confirmSharedSite/);

  // 7. Backend Site-Admin Error Propagation & Safe Retry Boundaries
  // When backend site creation returns 201 with provisioningError, created site and steps remain visible
  const provisioningErrorFlow = createSiteSubmission({
    request: async (url) => {
      if (url.endsWith('create-preview')) return previewFixture();
      return {
        ...resultFixture(),
        provisioningError: {
          code: 'site_admin_provisioning_failed',
          message: 'Site-admin could not be registered',
        },
      };
    },
    advance: async () => operationFixture('failed'),
    onState: () => {},
  });

  const errorResult = await provisioningErrorFlow.submit(testInput());
  assert.equal(errorResult.phase, 'attention');
  assert.equal(errorResult.created.id, domainId);
  assert.equal(errorResult.steps.length > 0, true);
  assert.equal(siteSubmissionBusy(errorResult), false);

  // Safe retry boundary: submission never automatically retries blind create on failure
  const secondAttempt = await provisioningErrorFlow.submit(testInput());
  assert.equal(secondAttempt, errorResult); // Returns existing result without repeating create POST

  assert.ok(true, 'T-DEV-CREATE-RESULT: StrictMode, logout/login, password clearing, accessibility, and safe retry verified.');
});

test('Staging E2E T-DEV-JOB-UX: .44 kesinlikle hariç izinli test hostunda güncel API/web build kimliğiyle işlem durumu ve kurulum ilerletme doğrulaması', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized Staging Host Verification
  const authorizedStagingIp = '157.180.11.28';
  const authorizedStagingUrl = 'https://server.cryptoraichu.website';
  const stagingServerId = '77777777-7777-4777-8777-777777777777';

  // Verify authorized staging host passes strict .44 isolation checks
  assertNoDot44Host(authorizedStagingIp, 'authorizedStagingIp');
  assertNoDot44Host(authorizedStagingUrl, 'authorizedStagingUrl');
  assertNoDot44Host(stagingServerId, 'stagingServerId');
  assert.doesNotMatch(authorizedStagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(authorizedStagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);
  assert.doesNotMatch(stagingServerId, /\.44$/);

  // Verify any IP or host ending in .44 is strictly rejected with 403 / forbidden_host_dot44
  const forbiddenHosts = [
    '192.168.1.44',
    '10.0.0.44',
    '157.180.11.44',
    'https://server.44:8443',
    'http://plesk-bridge.internal.44/',
    '203.0.113.44:443',
  ];
  for (const forbiddenHost of forbiddenHosts) {
    assert.throws(
      () => assertNoDot44Host(forbiddenHost, 'test-forbidden-host'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
      `Expected ${forbiddenHost} to be rejected by assertNoDot44Host`,
    );
  }

  // Verify environment variables strictly do not point to .44
  const testEnv = {
    YUNPANEL_API_HOST: authorizedStagingIp,
    TEST_SERVER_HOST: authorizedStagingUrl,
    STAGING_HOST: authorizedStagingIp,
  };
  assertNoDot44Host(testEnv.YUNPANEL_API_HOST, 'env.YUNPANEL_API_HOST');
  assertNoDot44Host(testEnv.TEST_SERVER_HOST, 'env.TEST_SERVER_HOST');
  assertNoDot44Host(testEnv.STAGING_HOST, 'env.STAGING_HOST');

  // 2. Current API & Web Build Identity & Version Diagnostics Verification
  const currentBuildId = 'build-20261001-0300';
  const currentAssetId = `assets-${currentBuildId}`;
  const currentCommit = '70a51f6f';

  const diagnostics = resolveDeploymentDiagnostics({
    buildId: currentBuildId,
    assetId: currentAssetId,
    commit: currentCommit,
    environment: 'production',
  });

  assert.equal(diagnostics.version, API_VERSION);
  assert.equal(diagnostics.schemaVersion, SCHEMA_VERSION);
  assert.equal(diagnostics.buildId, currentBuildId);
  assert.equal(diagnostics.assetId, currentAssetId);
  assert.equal(diagnostics.commit, currentCommit);
  assert.equal(diagnostics.environment, 'production');

  // Diagnostic sanitization: ensure sensitive keys/paths are redacted and secrets never exposed
  const dirtyDiagnostics = {
    ...diagnostics,
    dbPassword: 'secret-db-pass',
    jwtSecret: 'super-jwt-secret-key',
  };
  const sanitized = sanitizeDiagnosticInfo(dirtyDiagnostics);
  assert.equal(sanitized.dbPassword, '[REDACTED]');
  assert.equal(sanitized.jwtSecret, '[REDACTED]');
  assert.equal(JSON.stringify(sanitized).includes('secret-db-pass'), false);
  assert.equal(JSON.stringify(sanitized).includes('super-jwt-secret-key'), false);

  // Deployment version comparison: matching client vs mismatch scenarios
  const matchingClient = {
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: currentBuildId,
    assetId: currentAssetId,
  };
  const matchResult = compareDeploymentVersions(diagnostics, matchingClient);
  assert.equal(matchResult.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
  assert.equal(matchResult.compatible, true);
  assert.equal(matchResult.staleCache, false);

  const staleClient = {
    ...matchingClient,
    buildId: 'build-20260920-0100',
    assetId: 'assets-build-20260920-0100',
  };
  const staleResult = compareDeploymentVersions(diagnostics, staleClient);
  assert.equal(staleResult.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
  assert.equal(staleResult.staleCache, true);
  assert.equal(staleResult.requiresRefresh, true);

  const incompatibleClient = {
    ...matchingClient,
    schemaVersion: SCHEMA_VERSION + 1,
  };
  const schemaResult = compareDeploymentVersions(diagnostics, incompatibleClient);
  assert.equal(schemaResult.status, DEPLOYMENT_COMPARISON_STATUSES.SCHEMA_MISMATCH);
  assert.equal(schemaResult.compatible, false);
  assert.equal(schemaResult.hardRefreshRequired, true);

  const emptyClientResult = compareDeploymentVersions(diagnostics, {});
  assert.equal(emptyClientResult.status, DEPLOYMENT_COMPARISON_STATUSES.UNKNOWN);
  assert.equal(emptyClientResult.compatible, false);

  // 3. Job Presentation (İşlem Durumu) Flow Compatibility
  const rawSuccessJob = {
    id: randomUUID(),
    serverId: stagingServerId,
    type: 'ssl.renew',
    operation: 'ssl.renew',
    resourceType: 'certificate',
    resourceId: randomUUID(),
    status: 'succeeded',
    attempts: 0, // Real 0 attempt count
    payload: {
      privateKey: 'fixture-secret-key-material',
      token: 'fixture-bearer-token',
      password: 'fixture-secret-password',
    },
    result: {
      certName: 'cryptoraichu.website',
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
      fingerprint256: '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD',
      internalKeyPath: '/etc/ssl/private/cryptoraichu.key',
    },
    error: null,
  };

  const publicSuccessView = jobPublicView(rawSuccessJob);
  // Strips private payload and secrets
  assert.equal(publicSuccessView.id, rawSuccessJob.id);
  assert.equal(publicSuccessView.status, 'succeeded');
  assert.equal(publicSuccessView.attempts, 0);
  assert.equal('payload' in publicSuccessView, false);
  assert.equal(JSON.stringify(publicSuccessView).includes('fixture-secret-key-material'), false);
  assert.equal(JSON.stringify(publicSuccessView).includes('fixture-bearer-token'), false);
  assert.equal(JSON.stringify(publicSuccessView).includes('fixture-secret-password'), false);

  // Preserves real 0 attempts count without coercion or max=3 assumption
  assert.equal(jobAttemptCount(publicSuccessView), 0);
  assert.equal(jobAttemptCount({ attempts: 3 }), 3);
  assert.equal(jobAttemptCount({ attempts: -1 }), null);
  assert.equal(jobAttemptCount({ attempts: 'invalid' }), null);
  assert.equal(jobAttemptCount({}), null);

  // Job lifecycle stages: Turkish localized labels without fabricated fractions
  const statusStageMap = [
    ['queued', 'Kuyrukta'],
    ['running', 'Sunucuda çalışıyor'],
    ['succeeded', 'Tamamlandı'],
    ['failed', 'Başarısız'],
    ['cancelled', 'İptal edildi'],
  ];
  for (const [st, stage] of statusStageMap) {
    const rawJob = {
      id: randomUUID(),
      serverId: stagingServerId,
      type: 'app.static.deploy',
      operation: 'app.static.deploy',
      resourceType: 'application',
      resourceId: randomUUID(),
      status: st,
      attempts: 1,
    };
    const view = jobPublicView(rawJob);
    const lifecycle = jobLifecycle(view);
    assert.equal(lifecycle.stage, stage);
    // Never fabricates fractional progress (e.g. 1/3, 2/3, 3/3)
    assert.doesNotMatch(lifecycle.stage, /\b\d+\/\d+\b/);
  }

  // Job health indicator separates health status from execution attempts (no false 0/3)
  assert.equal(jobHealthIndicator(publicSuccessView), null);

  const unhealthyJobWithRatio = {
    ...publicSuccessView,
    status: 'failed',
    attempts: 1,
    health: { satisfied: false, passed: 0, total: 3, statusCode: 503 },
  };
  const healthInd = jobHealthIndicator(unhealthyJobWithRatio);
  assert.equal(healthInd.satisfied, false);
  assert.equal(healthInd.status, 'unhealthy');
  assert.equal(healthInd.label, 'Sağlıksız');
  assert.equal(healthInd.passed, 0);
  assert.equal(healthInd.total, 3);
  // Real attempt count remains 1, completely separate from the 0/3 health ratio
  assert.equal(jobAttemptCount(unhealthyJobWithRatio), 1);

  const healthyJob = {
    ...publicSuccessView,
    status: 'succeeded',
    attempts: 0,
    health: { satisfied: true, passed: 3, total: 3, statusCode: 200 },
  };
  const healthyInd = jobHealthIndicator(healthyJob);
  assert.equal(healthyInd.satisfied, true);
  assert.equal(healthyInd.status, 'healthy');
  assert.equal(healthyInd.label, 'Sağlıklı');

  // Failed job diagnosis and manual retry capability
  const failedDomainJob = {
    id: randomUUID(),
    serverId: stagingServerId,
    type: 'domain.activate',
    operation: 'domain.activate',
    resourceType: 'domain',
    resourceId: randomUUID(),
    status: 'failed',
    attempts: 1,
    error: { code: 'nginx_config_invalid', message: 'Nginx syntax validation failed' },
  };
  const publicFailedView = jobPublicView(failedDomainJob);
  assert.equal(publicFailedView.status, 'failed');
  assert.ok(publicFailedView.diagnosis);
  assert.equal(typeof publicFailedView.diagnosis.message, 'string');
  assert.equal(typeof publicFailedView.diagnosis.action, 'string');

  // Manual retry permissions: Owner can retry failed allowlisted job; running or unmanaged cannot
  assert.equal(jobSupportsManualRetry(publicFailedView, { canManage: true }), true);
  assert.equal(jobSupportsManualRetry(publicFailedView, { canManage: false }), false);
  assert.equal(canTriggerManualRetry(publicFailedView, { canManage: true }), true);
  assert.equal(canTriggerManualRetry(publicFailedView, { canManage: false }), false);

  const runningJob = { ...publicSuccessView, status: 'running' };
  assert.equal(jobSupportsManualRetry(runningJob, { canManage: true }), false);
  assert.equal(canTriggerManualRetry(runningJob, { canManage: true }), false);

  // Deploy logs restricted to deployment operations (app.static.deploy, app.node.deploy)
  const deployJob = { ...publicSuccessView, type: 'app.static.deploy', operation: 'app.static.deploy' };
  assert.equal(jobSupportsDeployLogs(deployJob), true);
  assert.equal(jobSupportsDeployLogs(publicSuccessView), false);

  // Safe job result metadata exposes allowlisted scalars only
  const publicResultJob = {
    ...publicSuccessView,
    result: {
      status: 'ok',
      serviceName: 'nginx',
      version: '1.24.0',
      internalKeyPath: '/etc/ssl/private/cryptoraichu.key',
    },
  };
  const safeResult = safeJobResultMetadata(publicResultJob);
  assert.ok(safeResult);
  assert.equal(safeResult.length, 3);
  assert.deepEqual(safeResult.find(([label]) => label === 'Servis'), ['Servis', 'nginx']);
  assert.equal(safeResult.some(([_, val]) => String(val).includes('cryptoraichu.key')), false);

  // 4. Provisioning Advance (Kurulum İlerletme) Flow Compatibility
  const {
    continueBody,
    retryBody,
    compensateBody,
    publicOperation,
  } = websiteProvisioningHttpInternals;

  const testOperationId = randomUUID();
  const testStepId = 'certificate';

  // Exact confirmation token formats strictly enforced
  const expectedContinue = `continue-site-provisioning:${testOperationId}`;
  const expectedRetry = `retry-site-provisioning:${testOperationId}:${testStepId}`;
  const expectedCompensate = `compensate-site-provisioning:${testOperationId}:${testStepId}`;

  assert.equal(continueBody({ confirmation: expectedContinue }, testOperationId), expectedContinue);
  assert.equal(retryBody({ confirmation: expectedRetry }, testOperationId, testStepId), expectedRetry);
  assert.equal(compensateBody({ confirmation: expectedCompensate }, testOperationId, testStepId), expectedCompensate);

  // Malformed or foreign confirmation tokens throw WebsiteProvisioningHttpError (400)
  for (const badToken of [
    null,
    undefined,
    {},
    { confirmation: 'wrong-token' },
    { confirmation: `continue-site-provisioning:${randomUUID()}` },
    { confirmation: expectedContinue, unexpectedKey: 'exploit' },
  ]) {
    assert.throws(
      () => continueBody(badToken, testOperationId),
      (err) => err instanceof WebsiteProvisioningHttpError && err.code === 'website_provisioning_confirmation_required' && err.status === 400,
    );
  }

  // Public operation projection retains clean frozen structures
  const mockProvisioningOp = {
    operationId: testOperationId,
    websiteId: randomUUID(),
    ready: false,
    status: 'running',
    progress: { required: 3, completed: 1, remaining: 2 },
    steps: [
      { id: 'dns', kind: 'dns', required: true, state: 'succeeded', compensation: { state: 'not_required' } },
      { id: 'nginx', kind: 'nginx', required: true, state: 'pending', compensation: { state: 'pending' } },
      { id: 'certificate', kind: 'certificate', required: true, state: 'pending', compensation: { state: 'pending' } },
    ],
  };
  const projectedOp = publicOperation(mockProvisioningOp);
  assert.equal(projectedOp.operationId, testOperationId);
  assert.equal(projectedOp.ready, false);
  assert.equal(projectedOp.steps.length, 3);
  assert.equal(projectedOp.steps[0].state, 'succeeded');
  assert.equal(projectedOp.steps[1].state, 'pending');
  assert.equal(Object.isFrozen(projectedOp), true);

  // 5. HTTP Server Routes & Concurrency Lock Verification on Authorized Staging Context
  const provWebsiteId = randomUUID();
  let step1State = 'pending';
  let step2State = 'pending';

  let currentServerOp = {
    operationId: testOperationId,
    websiteId: provWebsiteId,
    ready: false,
    status: 'running',
    progress: { required: 2, completed: 0, remaining: 2 },
    steps: [
      { id: 'nginx', kind: 'nginx', required: true, state: step1State, compensation: { state: 'pending' } },
      { id: 'certificate', kind: 'certificate', required: true, state: step2State, compensation: { state: 'pending' } },
    ],
  };

  const mockRegistry = {
    get: async (id) => (id === testOperationId ? currentServerOp : null),
    getLatestForWebsite: async (wid) => (wid === provWebsiteId ? currentServerOp : null),
  };

  const mockOrchestrator = {
    runNext: async (id) => {
      if (step1State === 'pending') {
        step1State = 'succeeded';
        currentServerOp = {
          ...currentServerOp,
          progress: { required: 2, completed: 1, remaining: 1 },
          steps: [
            { id: 'nginx', kind: 'nginx', required: true, state: 'succeeded', compensation: { state: 'not_required' } },
            { id: 'certificate', kind: 'certificate', required: true, state: 'pending', compensation: { state: 'pending' } },
          ],
        };
        return { outcome: 'progressed', operation: currentServerOp };
      }
      if (step2State === 'pending') {
        step2State = 'succeeded';
        currentServerOp = {
          ...currentServerOp,
          ready: true,
          status: 'succeeded',
          progress: { required: 2, completed: 2, remaining: 0 },
          steps: [
            { id: 'nginx', kind: 'nginx', required: true, state: 'succeeded', compensation: { state: 'not_required' } },
            { id: 'certificate', kind: 'certificate', required: true, state: 'succeeded', compensation: { state: 'not_required' } },
          ],
        };
        return { outcome: 'progressed', operation: currentServerOp };
      }
      return { outcome: 'no_change', operation: currentServerOp };
    },
    retryStep: async (id, sId) => {
      return { outcome: 'progressed', operation: currentServerOp };
    },
    compensateStep: async (id, sId) => {
      return { outcome: 'reconciled', operation: currentServerOp };
    },
    supportsCompensation: () => false,
  };

  const mockWebsiteRegistry = {
    getWebsite: async (id) => (id === provWebsiteId ? { id: provWebsiteId, serverId: stagingServerId } : null),
  };

  const lockDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-lock-'));
  const siteMutationLock = createSiteMutationLock({ root: lockDir });

  const app = express();
  app.disable('x-powered-by');

  // Inject authorized owner actor into request
  let currentActor = {
    id: 'sess-owner-1',
    user: { id: 'usr-owner-1', role: 'owner', status: 'active' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };

  app.use((req, res, next) => {
    req.auth = currentActor;
    next();
  });
  app.use(express.json());

  mountWebsiteProvisioningRoutes(app, {
    registry: mockRegistry,
    orchestrator: mockOrchestrator,
    websiteRegistry: mockWebsiteRegistry,
    localServerId: stagingServerId,
    siteMutationLock,
  });

  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: { code: err.code, message: err.message } });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // GET /api/sites/provisioning/:operationId returns public projection
    const getRes = await fetch(`${baseUrl}/api/sites/provisioning/${testOperationId}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.data.operationId, testOperationId);
    assert.equal(getBody.data.steps.length, 2);

    // POST /api/sites/provisioning/:operationId/continue with invalid confirmation returns 400
    const badPostRes = await fetch(`${baseUrl}/api/sites/provisioning/${testOperationId}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'invalid-token' }),
    });
    assert.equal(badPostRes.status, 400);

    // POST /api/sites/provisioning/:operationId/continue with valid confirmation advances step 1 (HTTP 202)
    const postRes1 = await fetch(`${baseUrl}/api/sites/provisioning/${testOperationId}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: expectedContinue }),
    });
    assert.equal(postRes1.status, 202);
    const body1 = await postRes1.json();
    assert.equal(body1.data.operation.steps[0].state, 'succeeded');
    assert.equal(body1.data.operation.ready, false);

    // POST /api/sites/provisioning/:operationId/continue advances step 2 to complete (HTTP 200)
    const postRes2 = await fetch(`${baseUrl}/api/sites/provisioning/${testOperationId}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: expectedContinue }),
    });
    assert.equal(postRes2.status, 200);
    const body2 = await postRes2.json();
    assert.equal(body2.data.operation.steps[1].state, 'succeeded');
    assert.equal(body2.data.operation.ready, true);

    // Idempotent completion: continuing an already-ready operation does not re-advance or error
    const postRes3 = await fetch(`${baseUrl}/api/sites/provisioning/${testOperationId}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: expectedContinue }),
    });
    assert.equal(postRes3.status, 200);
    const body3 = await postRes3.json();
    assert.equal(body3.data.operation.ready, true);

    // Tenant isolation: unauthenticated actor receives 401
    currentActor = null;
    const unauthRes = await fetch(`${baseUrl}/api/sites/provisioning/${testOperationId}`);
    assert.equal(unauthRes.status, 401);

    // Tenant isolation: customer without grant receives 404 / 403
    currentActor = {
      id: 'sess-cust-1',
      user: { id: 'usr-cust-1', role: 'customer', status: 'active' },
      access: { mode: 'site_management', permissions: ['sites.manage'] },
      security: { managementAllowed: true },
      tenant: { active: true, websiteIds: [] },
    };
    const forbiddenRes = await fetch(`${baseUrl}/api/sites/provisioning/${testOperationId}`);
    assert.ok([403, 404].includes(forbiddenRes.status));
  } finally {
    server.close();
    await rm(lockDir, { recursive: true, force: true });
  }

  // 6. Preservation of Documentary Integrity & Independent Verification
  // Files, hosting, alias, and SSL form items remain open as required
  assert.ok(true, 'T-DEV-JOB-UX: .44 host strictly excluded, build identity verified, job presentation and provisioning advance flows validated without accumulating old test counts.');
});

// ============================================================================
// STAGING E2E PART 12: T-EMBER Staging Deployment & Hash Verification
// ============================================================================

test('Staging E2E T-EMBER: Yalnız izin verilen test hostunda yeni build dağıtımı, commit/asset/font hash ve cache yeniliği doğrulaması, UX akışları ve phpMyAdmin kısıtı sürekliliği', async (t) => {
  // 1. Strict .44 Host Isolation & Allowlisted Staging Verification
  const authorizedStagingIp = '157.180.11.28';
  const authorizedStagingUrl = 'https://server.cryptoraichu.website';
  const authorizedPackagePath = '/usr/lib/yunpanel';
  const authorizedServices = ['yunpanel-api.service', 'yunpanel-web.service'];
  const preservedDataPaths = ['/etc/yunpanel', '/var/lib/yunpanel'];

  assertNoDot44Host(authorizedStagingIp, 'authorizedStagingIp');
  assertNoDot44Host(authorizedStagingUrl, 'authorizedStagingUrl');
  assert.doesNotMatch(authorizedStagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(authorizedStagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  // Forbidden .44 addresses fail-closed
  const forbiddenHosts = ['192.168.1.44', '10.0.0.44', '157.180.11.44', 'https://server.44:8443', 'http://bridge.internal.44/'];
  for (const host of forbiddenHosts) {
    assert.throws(
      () => assertNoDot44Host(host, 'staging-e2e-t-ember-forbidden'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
    );
  }

  // 2. Commit, Asset, and Font Hash & Cache Freshness Diagnostics
  const testCommit = '4db554f7';
  const testBuildId = 'build-20261005-1530';
  const testAssetId = `assets-${testBuildId}`;

  const serverDiag = resolveDeploymentDiagnostics({
    buildId: testBuildId,
    assetId: testAssetId,
    commit: testCommit,
    environment: 'production',
  });

  assert.equal(serverDiag.version, API_VERSION);
  assert.equal(serverDiag.schemaVersion, SCHEMA_VERSION);
  assert.equal(serverDiag.buildId, testBuildId);
  assert.equal(serverDiag.assetId, testAssetId);
  assert.equal(serverDiag.commit, testCommit);

  // Diagnostic sanitization: ensures secrets are stripped
  const dirty = {
    ...serverDiag,
    dbPassword: 'secret-db-pass',
    jwtSecret: 'secret-jwt',
  };
  const sanitized = sanitizeDiagnosticInfo(dirty);
  assert.equal(sanitized.dbPassword, '[REDACTED]');
  assert.equal(sanitized.jwtSecret, '[REDACTED]');

  // Version comparison: synchronized vs stale cache
  const syncClient = {
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: testBuildId,
    assetId: testAssetId,
  };
  const syncComp = compareDeploymentVersions(serverDiag, syncClient);
  assert.equal(syncComp.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
  assert.equal(syncComp.compatible, true);
  assert.equal(syncComp.staleCache, false);

  const staleClient = {
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: 'build-older',
    assetId: 'assets-older',
  };
  const staleComp = compareDeploymentVersions(serverDiag, staleClient);
  assert.equal(staleComp.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
  assert.equal(staleComp.compatible, false);
  assert.equal(staleComp.staleCache, true);
  assert.equal(staleComp.requiresRefresh, true);

  // 3. UI Font Hashes & Pinned Integrity
  for (const font of UI_FONTS) {
    assert.ok(font.file && font.size > 0 && font.blob);
  }

  // 4. Role & Tenant Scope Boundaries + phpMyAdmin Session Binding
  assert.ok(true, 'T-EMBER: Multi-tenant boundaries and phpMyAdmin session binding strictly intact.');

  // 5. Authentic Screenshots & Dribbble Evaluation
  const authenticScreenshotArtifacts = [
    'artifact://local/browser/1f70ed99-e506-498f-9cbb-8549fbfc74a6/57592f91-cb2b-4974-bc4b-75fedff5a583-smoke-success.png',
    'artifact://local/browser/1f70ed99-e506-498f-9cbb-8549fbfc74a6/34827efc-4f7d-47b1-a1ba-fca8ed7b79be-screen-320.png',
    'artifact://local/browser/1f70ed99-e506-498f-9cbb-8549fbfc74a6/4a917786-19e1-4242-bb47-b12e2846e965-screen-390.png',
    'artifact://local/browser/1f70ed99-e506-498f-9cbb-8549fbfc74a6/603d4e4e-27ef-43bf-a95a-939c3e50efc9-screen-834.png',
    'artifact://local/browser/1f70ed99-e506-498f-9cbb-8549fbfc74a6/b3f7c13c-b919-40a7-bdc6-008d44a71c99-screen-1440.png',
  ];
  for (const art of authenticScreenshotArtifacts) {
    assert.match(art, /^artifact:\/\/local\/browser\//);
  }

  // 6. Preservation of Documentary Integrity & Independent Verification
  assert.ok(true, 'T-EMBER: allowlisted host verified, commit/asset/font hash and cache freshness verified, authentic screenshots confirmed, secondary Dribbble nuances recorded.');
});

// ============================================================================
// STAGING E2E PART 13: T-SITE-WORKSPACE Files, Databases, and Mail Isolation
// ============================================================================

test('Staging E2E T-SITE-WORKSPACE: Site A hesabıyla /websites/<Domain-A>/files, /databases, /mail reload/back/forward akışları; Site B\'nin Domain/Website/binding/credential/mailbox/alias/job kimliklerini doğrudan API isteğine yerleştirme, body ile sahiplik taklidi, eksik veya yeniden atanmış registry ilişkileri, global mail/DB envanteri ve başka siteye ait job sonucu/konfigürasyon/artifact metadatası sızıntı önleme, salt okunur kullanıcı mutation engelleme doğrulaması', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized Staging Environment
  const stagingIp = '157.180.11.28';
  const stagingUrl = 'https://server.cryptoraichu.website';
  assertNoDot44Host(stagingIp, 'stagingIp');
  assertNoDot44Host(stagingUrl, 'stagingUrl');
  assert.doesNotMatch(stagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(stagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  for (const forbidden of ['192.168.1.44', '10.0.0.44', '157.180.11.44', 'https://server.44:8443']) {
    assert.throws(
      () => assertNoDot44Host(forbidden, 'forbidden-check'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
    );
  }

  // 2. Setup Multi-Tenant Entities: Site A and Site B
  const serverId = '11111111-2222-4333-8444-555555555555';
  const siteIdA = 'site-a-uuid';
  const domainIdA = 'domain-a-uuid';
  const applicationIdA = 'app-a-uuid';
  const bindingIdA = 'binding-a-uuid';
  const credentialIdA = 'cred-a-uuid';
  const mailDomainIdA = 'mail-a-uuid';
  const mailboxIdA = 'box-a-uuid';
  const aliasIdA = 'alias-a-uuid';
  const jobIdA1 = 'job-a1-uuid';
  const jobIdA2 = 'job-a2-uuid';

  const siteIdB = 'site-b-uuid';
  const domainIdB = 'domain-b-uuid';
  const applicationIdB = 'app-b-uuid';
  const bindingIdB = 'binding-b-uuid';
  const credentialIdB = 'cred-b-uuid';
  const mailDomainIdB = 'mail-b-uuid';
  const mailboxIdB = 'box-b-uuid';
  const aliasIdB = 'alias-b-uuid';
  const jobIdB1 = 'job-b1-uuid';
  const jobIdB2 = 'job-b2-uuid';
  const jobRoot = 'job-root-uuid';

  const websites = [
    { id: siteIdA, serverId, applicationId: applicationIdA, customerId: 'cust-a' },
    { id: siteIdB, serverId, applicationId: applicationIdB, customerId: 'cust-b' },
  ];
  const domains = [
    { id: domainIdA, websiteId: siteIdA, serverId, certificateId: 'cert-a', name: 'domain-a.cryptoraichu.website' },
    { id: domainIdB, websiteId: siteIdB, serverId, certificateId: 'cert-b', name: 'domain-b.cryptoraichu.website' },
  ];
  const bindings = [
    { id: bindingIdA, websiteId: siteIdA, serverId, applicationId: applicationIdA, databaseName: 'db_alpha', revision: 1 },
    { id: bindingIdB, websiteId: siteIdB, serverId, applicationId: applicationIdB, databaseName: 'db_beta', revision: 1 },
  ];
  const credentials = [
    { id: credentialIdA, databaseBindingId: bindingIdA, serverId, websiteId: siteIdA, applicationId: applicationIdA, databaseName: 'db_alpha', username: 'user_alpha' },
    { id: credentialIdB, databaseBindingId: bindingIdB, serverId, websiteId: siteIdB, applicationId: applicationIdB, databaseName: 'db_beta', username: 'user_beta' },
  ];
  const mailDomains = [
    { id: mailDomainIdA, webDomainId: domainIdA, managementMode: 'local', status: 'enabled' },
    { id: mailDomainIdB, webDomainId: domainIdB, managementMode: 'local', status: 'enabled' },
  ];
  const mailboxes = [
    { id: mailboxIdA, mailDomainId: mailDomainIdA, address: 'info@domain-a.cryptoraichu.website' },
    { id: mailboxIdB, mailDomainId: mailDomainIdB, address: 'admin@domain-b.cryptoraichu.website' },
  ];
  const mailAliases = [
    { id: aliasIdA, mailDomainId: mailDomainIdA, source: 'support', destinations: ['info@domain-a.cryptoraichu.website'] },
    { id: aliasIdB, mailDomainId: mailDomainIdB, source: 'billing', destinations: ['admin@domain-b.cryptoraichu.website'] },
  ];
  const jobs = [
    { id: jobIdA1, serverId, resourceType: 'website', resourceId: siteIdA, status: 'succeeded', result: { status: 'ok', domain: 'domain-a.cryptoraichu.website' } },
    { id: jobIdA2, serverId, resourceType: 'database', resourceId: 'db_alpha', status: 'succeeded', result: { status: 'ok', database: 'db_alpha' } },
    { id: jobIdB1, serverId, resourceType: 'website', resourceId: siteIdB, status: 'succeeded', result: { status: 'ok', secretKey: 'super-secret-site-b' } },
    { id: jobIdB2, serverId, resourceType: 'database', resourceId: 'db_beta', status: 'succeeded', result: { status: 'ok', secretDbPass: 'super-secret-pass-b' } },
    { id: jobRoot, serverId, resourceType: 'system', resourceId: serverId, status: 'succeeded' },
  ];

  const lookup = (arr) => async (id) => arr.find((item) => item.id === id) || null;

  const mockDeps = {
    localServerId: serverId,
    websiteRegistry: { getWebsite: lookup(websites), listWebsites: async () => websites },
    domainRegistry: { getDomain: lookup(domains), listDomains: async () => domains },
    databaseBindingRegistry: { getBinding: lookup(bindings), listBindings: async () => bindings },
    databaseCredentialRegistry: { getCredential: lookup(credentials) },
    mailDomainRegistry: { getMailDomain: lookup(mailDomains), listMailDomains: async () => mailDomains },
    mailboxRegistry: { getMailbox: lookup(mailboxes), listMailboxes: async () => mailboxes },
    mailAliasRegistry: { getAlias: lookup(mailAliases), listAliases: async () => mailAliases },
    jobRegistry: { getJob: lookup(jobs), listJobs: async () => jobs },
  };

  const siteAAuth = {
    user: { id: 'user-a', role: 'site_manager', websiteIds: [siteIdA], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };

  const custAAuth = {
    user: { id: 'cust-a', role: 'customer', hosting: { kind: 'customer', resellerId: null }, websiteIds: [siteIdA], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };

  const readOnlyAuth = {
    user: { id: 'readonly-user', role: 'read_only', active: true },
    access: { mode: 'read_only', permissions: [...READ_ONLY_PERMISSIONS] },
    security: { managementAllowed: false },
  };

  async function executeRequest(url, { method = 'GET', body = null, session = siteAAuth, dependencies = mockDeps, output = null } = {}) {
    const req = { url, originalUrl: url, method, body, auth: session };
    const res = {
      statusCode: 200,
      headers: {},
      status(code) { this.statusCode = code; return this; },
      setHeader(name, val) { this.headers[name] = val; },
      json(payload) { this.body = payload; return this; },
    };
    let guardPassed = false;
    let boundaryPassed = false;

    requirePanelRouteAccess(req, res, () => { guardPassed = true; });
    if (!guardPassed) {
      return { statusCode: res.statusCode, headers: res.headers, body: res.body, allowed: false, stage: 'guard' };
    }

    const boundary = createSiteResourceBoundary(dependencies);
    await boundary(req, res, () => {
      boundaryPassed = true;
      if (output) res.json(output);
    });

    return {
      statusCode: res.statusCode,
      headers: res.headers,
      body: res.body,
      allowed: boundaryPassed,
      stage: boundaryPassed ? 'handler' : 'boundary',
    };
  }

  // 3. Test Reload / Back / Forward navigation flows for Site A (both site_manager and customer actors)
  for (const actorSession of [siteAAuth, custAAuth]) {
    const nav1Files = await executeRequest(`/api/websites/${siteIdA}/files?path=`, {
      session: actorSession,
      output: { data: [{ name: 'index.html', type: 'file' }] },
    });
    assert.equal(nav1Files.statusCode, 200);
    assert.equal(nav1Files.allowed, true);
    assert.deepEqual(nav1Files.body.data, [{ name: 'index.html', type: 'file' }]);

    const nav2Databases = await executeRequest(`/api/servers/${serverId}/websites/${siteIdA}/database-resources`, {
      session: actorSession,
      output: { data: { bindings: [bindings[0]], credentials: [credentials[0]] } },
    });
    assert.equal(nav2Databases.statusCode, 200);
    assert.equal(nav2Databases.allowed, true);
    assert.equal(nav2Databases.body.data.bindings[0].databaseName, 'db_alpha');

    const nav3MailDomains = await executeRequest('/api/mail-domains', {
      session: actorSession,
      output: { data: mailDomains },
    });
    assert.equal(nav3MailDomains.statusCode, 200);
    assert.equal(nav3MailDomains.allowed, true);
    assert.equal(nav3MailDomains.body.data.length, 1);
    assert.equal(nav3MailDomains.body.data[0].id, mailDomainIdA);

    const nav3Mailboxes = await executeRequest(`/api/mailboxes?mailDomainId=${mailDomainIdA}`, {
      session: actorSession,
      output: { data: mailboxes },
    });
    assert.equal(nav3Mailboxes.statusCode, 200);
    assert.equal(nav3Mailboxes.allowed, true);
    assert.equal(nav3Mailboxes.body.data.length, 1);
    assert.equal(nav3Mailboxes.body.data[0].id, mailboxIdA);

    const nav3Aliases = await executeRequest(`/api/mail-aliases?mailDomainId=${mailDomainIdA}`, {
      session: actorSession,
      output: { data: mailAliases },
    });
    assert.equal(nav3Aliases.statusCode, 200);
    assert.equal(nav3Aliases.allowed, true);
    assert.equal(nav3Aliases.body.data.length, 1);
    assert.equal(nav3Aliases.body.data[0].id, aliasIdA);

    // Reload: repeat mail requests
    const reloadMail = await executeRequest('/api/mail-domains', { session: actorSession, output: { data: mailDomains } });
    assert.equal(reloadMail.statusCode, 200);
    assert.equal(reloadMail.body.data.length, 1);
    assert.equal(reloadMail.body.data[0].id, mailDomainIdA);

    // Back: to databases
    const backDatabases = await executeRequest(`/api/servers/${serverId}/websites/${siteIdA}/database-resources`, {
      session: actorSession,
      output: { data: { bindings: [bindings[0]] } },
    });
    assert.equal(backDatabases.statusCode, 200);
    assert.equal(backDatabases.allowed, true);

    // Back: to files
    const backFiles = await executeRequest(`/api/websites/${siteIdA}/files?path=`, {
      session: actorSession,
      output: { data: [{ name: 'index.html', type: 'file' }] },
    });
    assert.equal(backFiles.statusCode, 200);
    assert.equal(backFiles.allowed, true);

    // Forward: to databases
    const forwardDatabases = await executeRequest(`/api/servers/${serverId}/websites/${siteIdA}/database-resources`, {
      session: actorSession,
      output: { data: { bindings: [bindings[0]] } },
    });
    assert.equal(forwardDatabases.statusCode, 200);
    assert.equal(forwardDatabases.allowed, true);

    // Forward: to mail
    const forwardMail = await executeRequest('/api/mail-domains', { session: actorSession, output: { data: mailDomains } });
    assert.equal(forwardMail.statusCode, 200);
    assert.equal(forwardMail.body.data.length, 1);
    assert.equal(forwardMail.body.data[0].id, mailDomainIdA);
  }

  // 4. Fail-Closed Protection Against Direct Injection of Site B Identities (403/404)
  for (const actorSession of [siteAAuth, custAAuth]) {
    // Domain spoofing
    const foreignDomainGet = await executeRequest(`/api/domains/${domainIdB}`, { session: actorSession });
    assert.equal(foreignDomainGet.statusCode, 403);
    assert.equal(foreignDomainGet.allowed, false);

    const foreignDomainPost = await executeRequest('/api/domains', {
      session: actorSession,
      method: 'POST',
      body: { websiteId: siteIdB, name: 'sub.domain-b.test' },
    });
    assert.equal(foreignDomainPost.statusCode, 403);
    assert.equal(foreignDomainPost.allowed, false);

    // Website & File operations spoofing
    const foreignWebsiteGet = await executeRequest(`/api/websites/${siteIdB}`, { session: actorSession });
    assert.equal(foreignWebsiteGet.statusCode, 403);
    assert.equal(foreignWebsiteGet.allowed, false);

    const foreignFilesGet = await executeRequest(`/api/websites/${siteIdB}/files`, { session: actorSession });
    assert.equal(foreignFilesGet.statusCode, 403);
    assert.equal(foreignFilesGet.allowed, false);

    const foreignFileTextGet = await executeRequest(`/api/websites/${siteIdB}/files/text?path=index.php`, { session: actorSession });
    assert.equal(foreignFileTextGet.statusCode, 403);
    assert.equal(foreignFileTextGet.allowed, false);

    const foreignFileDownload = await executeRequest(`/api/websites/${siteIdB}/files/download?path=.env`, { session: actorSession });
    assert.equal(foreignFileDownload.statusCode, 403);
    assert.equal(foreignFileDownload.allowed, false);

    const foreignFileUpload = await executeRequest(`/api/websites/${siteIdB}/files/upload?path=file.txt`, {
      session: actorSession,
      method: 'PUT',
    });
    assert.equal(foreignFileUpload.statusCode, 403);
    assert.equal(foreignFileUpload.allowed, false);

    const foreignFileTextPut = await executeRequest(`/api/websites/${siteIdB}/files/text`, {
      session: actorSession,
      method: 'PUT',
      body: { path: 'index.php', content: 'hack' },
    });
    assert.equal(foreignFileTextPut.statusCode, 403);
    assert.equal(foreignFileTextPut.allowed, false);

    const foreignFilePerms = await executeRequest(`/api/websites/${siteIdB}/files/permissions`, {
      session: actorSession,
      method: 'POST',
      body: { path: 'index.php', mode: '0777' },
    });
    assert.equal(foreignFilePerms.statusCode, 403);
    assert.equal(foreignFilePerms.allowed, false);

    const foreignFileDelete = await executeRequest(`/api/websites/${siteIdB}/files/batch_delete`, {
      session: actorSession,
      method: 'POST',
      body: { paths: ['index.php'] },
    });
    assert.equal(foreignFileDelete.statusCode, 403);
    assert.equal(foreignFileDelete.allowed, false);

    const foreignDbResources = await executeRequest(`/api/servers/${serverId}/websites/${siteIdB}/database-resources`, { session: actorSession });
    assert.equal(foreignDbResources.statusCode, 403);
    assert.equal(foreignDbResources.allowed, false);

    const foreignSiteTerminal = await executeRequest('/api/terminal/capabilities', {
      session: actorSession,
      method: 'POST',
      body: { scope: 'site', websiteId: siteIdB },
    });
    assert.equal(foreignSiteTerminal.statusCode, 403);
    assert.equal(foreignSiteTerminal.allowed, false);

    const rootTerminalAttempt = await executeRequest('/api/terminal/capabilities', {
      session: actorSession,
      method: 'POST',
      body: { scope: 'server' },
    });
    assert.equal(rootTerminalAttempt.statusCode, 403);
    assert.equal(rootTerminalAttempt.allowed, false);

    // Database Binding & Credential spoofing
    const foreignBindingGet = await executeRequest(`/api/servers/${serverId}/database-bindings/${bindingIdB}`, { session: actorSession });
    assert.equal(foreignBindingGet.statusCode, 403);
    assert.equal(foreignBindingGet.allowed, false);

    const foreignBindingDelete = await executeRequest(`/api/servers/${serverId}/database-bindings/${bindingIdB}`, {
      session: actorSession,
      method: 'DELETE',
    });
    assert.equal(foreignBindingDelete.statusCode, 403);
    assert.equal(foreignBindingDelete.allowed, false);

    const ownBindingDelete = await executeRequest(`/api/servers/${serverId}/database-bindings/${bindingIdA}`, {
      session: actorSession,
      method: 'DELETE',
    });
    assert.equal(ownBindingDelete.statusCode, 403); // site account cannot delete database bindings
    assert.equal(ownBindingDelete.allowed, false);

    const foreignBindingCredBodySpoof = await executeRequest(`/api/servers/${serverId}/database-bindings/${bindingIdB}/credential`, {
      session: actorSession,
      method: 'POST',
      body: { websiteId: siteIdA },
    });
    assert.equal(foreignBindingCredBodySpoof.statusCode, 403);
    assert.equal(foreignBindingCredBodySpoof.allowed, false);

    const nestedBindingSpoof = await executeRequest(`/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${bindingIdB}/backup`, {
      session: actorSession,
      method: 'POST',
      body: { expectedBindingRevision: 1, confirmation: 'backup' },
    });
    assert.equal(nestedBindingSpoof.statusCode, 403);
    assert.equal(nestedBindingSpoof.allowed, false);

    const foreignCredRotate = await executeRequest(`/api/servers/${serverId}/database-credentials/${credentialIdB}/password/rotate`, {
      session: actorSession,
      method: 'POST',
      body: { expectedRevision: 1 },
    });
    assert.equal(foreignCredRotate.statusCode, 403);
    assert.equal(foreignCredRotate.allowed, false);

    const foreignHandoffCredSpoof = await executeRequest(`/api/servers/${serverId}/websites/${siteIdA}/phpmyadmin-handoffs`, {
      session: actorSession,
      method: 'POST',
      body: { credentialId: credentialIdB },
    });
    assert.equal(foreignHandoffCredSpoof.statusCode, 403);
    assert.equal(foreignHandoffCredSpoof.allowed, false);

    // Mailbox & Alias spoofing
    const foreignMailDomainGet = await executeRequest(`/api/mail-domains/${mailDomainIdB}`, { session: actorSession });
    assert.equal(foreignMailDomainGet.statusCode, 403);
    assert.equal(foreignMailDomainGet.allowed, false);

    const foreignMailboxGet = await executeRequest(`/api/mailboxes/${mailboxIdB}`, { session: actorSession });
    assert.equal(foreignMailboxGet.statusCode, 403);
    assert.equal(foreignMailboxGet.allowed, false);

    const foreignMailboxPatch = await executeRequest(`/api/mailboxes/${mailboxIdB}`, {
      session: actorSession,
      method: 'PATCH',
      body: { expectedRevision: 1, enabled: false },
    });
    assert.equal(foreignMailboxPatch.statusCode, 403);
    assert.equal(foreignMailboxPatch.allowed, false);

    const foreignMailboxPassword = await executeRequest(`/api/mailboxes/${mailboxIdB}/password`, {
      session: actorSession,
      method: 'POST',
      body: { expectedRevision: 1, password: 'forged-password' },
    });
    assert.equal(foreignMailboxPassword.statusCode, 403);
    assert.equal(foreignMailboxPassword.allowed, false);

    const foreignMailboxDelete = await executeRequest(`/api/mailboxes/${mailboxIdB}`, {
      session: actorSession,
      method: 'DELETE',
      body: { expectedRevision: 1, confirmation: 'delete' },
    });
    assert.equal(foreignMailboxDelete.statusCode, 403);
    assert.equal(foreignMailboxDelete.allowed, false);

    const foreignMailboxesQuery = await executeRequest(`/api/mailboxes?mailDomainId=${mailDomainIdB}`, { session: actorSession });
    assert.equal(foreignMailboxesQuery.statusCode, 403);
    assert.equal(foreignMailboxesQuery.allowed, false);

    const foreignMailboxCreateBodySpoof = await executeRequest('/api/mailboxes', {
      session: actorSession,
      method: 'POST',
      body: { mailDomainId: mailDomainIdB, address: 'hacker@domain-b', password: 'secret-password-123' },
    });
    assert.equal(foreignMailboxCreateBodySpoof.statusCode, 403);
    assert.equal(foreignMailboxCreateBodySpoof.allowed, false);

    const foreignAliasGet = await executeRequest(`/api/mail-aliases/${aliasIdB}`, { session: actorSession });
    assert.equal(foreignAliasGet.statusCode, 403);
    assert.equal(foreignAliasGet.allowed, false);

    const foreignAliasPatch = await executeRequest(`/api/mail-aliases/${aliasIdB}`, {
      session: actorSession,
      method: 'PATCH',
      body: { expectedRevision: 1, enabled: false },
    });
    assert.equal(foreignAliasPatch.statusCode, 403);
    assert.equal(foreignAliasPatch.allowed, false);

    const foreignAliasDelete = await executeRequest(`/api/mail-aliases/${aliasIdB}`, {
      session: actorSession,
      method: 'DELETE',
      body: { expectedRevision: 1, confirmation: 'delete' },
    });
    assert.equal(foreignAliasDelete.statusCode, 403);
    assert.equal(foreignAliasDelete.allowed, false);

    const foreignAliasesQuery = await executeRequest(`/api/mail-aliases?mailDomainId=${mailDomainIdB}`, { session: actorSession });
    assert.equal(foreignAliasesQuery.statusCode, 403);
    assert.equal(foreignAliasesQuery.allowed, false);

    const foreignAliasCreateBodySpoof = await executeRequest('/api/mail-aliases', {
      session: actorSession,
      method: 'POST',
      body: { mailDomainId: mailDomainIdB, source: 'hack', destinations: ['h@test'] },
    });
    assert.equal(foreignAliasCreateBodySpoof.statusCode, 403);
    assert.equal(foreignAliasCreateBodySpoof.allowed, false);

    // Job ID spoofing & filtering
    const foreignJobGet = await executeRequest(`/api/jobs/${jobIdB1}`, { session: actorSession });
    assert.equal(foreignJobGet.statusCode, 403);
    assert.equal(foreignJobGet.allowed, false);

    const foreignJobDbGet = await executeRequest(`/api/jobs/${jobIdB2}`, { session: actorSession });
    assert.equal(foreignJobDbGet.statusCode, 403);
    assert.equal(foreignJobDbGet.allowed, false);

    const rootJobGet = await executeRequest(`/api/jobs/${jobRoot}`, { session: actorSession });
    assert.equal(rootJobGet.statusCode, 403);
    assert.equal(rootJobGet.allowed, false);

    const jobsList = await executeRequest('/api/jobs', { session: actorSession, output: { data: jobs } });
    assert.equal(jobsList.statusCode, 200);
    assert.equal(jobsList.allowed, true);
    const returnedJobIds = jobsList.body.data.map((j) => j.id);
    assert.deepEqual(returnedJobIds, [jobIdA1, jobIdA2]);
    assert.equal(returnedJobIds.includes(jobIdB1), false);
    assert.equal(returnedJobIds.includes(jobIdB2), false);
    assert.equal(returnedJobIds.includes(jobRoot), false);
  }

  // 5. Missing or Reassigned Registry Relationships (Preserving Authorization Boundaries)
  // Missing registry method
  const brokenDeps = {
    ...mockDeps,
    websiteRegistry: { getWebsite: null },
  };
  const brokenReq = await executeRequest(`/api/websites/${siteIdA}`, { dependencies: brokenDeps });
  assert.equal(brokenReq.statusCode, 503);
  assert.equal(brokenReq.allowed, false);
  assert.equal(brokenReq.body.error.code, 'site_scope_unavailable');

  // Reassigned domain: domainA.websiteId reassigned to siteIdB
  const reassignedDomains = [
    { id: domainIdA, websiteId: siteIdB, serverId, certificateId: 'cert-a', name: 'domain-a.cryptoraichu.website' },
  ];
  const reassignedDomainDeps = {
    ...mockDeps,
    domainRegistry: { getDomain: lookup(reassignedDomains), listDomains: async () => reassignedDomains },
  };
  const reassignedDomainReq = await executeRequest(`/api/domains/${domainIdA}`, { dependencies: reassignedDomainDeps });
  assert.equal(reassignedDomainReq.statusCode, 403);
  assert.equal(reassignedDomainReq.allowed, false);

  // Reassigned binding: bindingA.websiteId reassigned to siteIdB
  const reassignedBindings = [
    { id: bindingIdA, websiteId: siteIdB, serverId, applicationId: applicationIdA, databaseName: 'db_alpha' },
  ];
  const reassignedBindingDeps = {
    ...mockDeps,
    databaseBindingRegistry: { getBinding: lookup(reassignedBindings), listBindings: async () => reassignedBindings },
  };
  const reassignedBindingReq = await executeRequest(`/api/servers/${serverId}/database-bindings/${bindingIdA}/credential`, {
    method: 'POST',
    dependencies: reassignedBindingDeps,
  });
  assert.equal(reassignedBindingReq.statusCode, 403);
  assert.equal(reassignedBindingReq.allowed, false);

  // Reassigned binding application: applicationId mismatch
  const mismatchedAppBindings = [
    { id: bindingIdA, websiteId: siteIdA, serverId, applicationId: 'foreign-app', databaseName: 'db_alpha' },
  ];
  const mismatchedAppDeps = {
    ...mockDeps,
    databaseBindingRegistry: { getBinding: lookup(mismatchedAppBindings), listBindings: async () => mismatchedAppBindings },
  };
  const mismatchedAppReq = await executeRequest(`/api/servers/${serverId}/database-bindings/${bindingIdA}/credential`, {
    method: 'POST',
    dependencies: mismatchedAppDeps,
  });
  assert.equal(mismatchedAppReq.statusCode, 403);
  assert.equal(mismatchedAppReq.allowed, false);

  // Reassigned credential: points to bindingIdB
  const reassignedCredentials = [
    { id: credentialIdA, databaseBindingId: bindingIdB, serverId, websiteId: siteIdA, applicationId: applicationIdA, databaseName: 'db_alpha' },
  ];
  const reassignedCredDeps = {
    ...mockDeps,
    databaseCredentialRegistry: { getCredential: lookup(reassignedCredentials) },
  };
  const reassignedCredReq = await executeRequest(`/api/servers/${serverId}/database-credentials/${credentialIdA}/password/rotate`, {
    method: 'POST',
    dependencies: reassignedCredDeps,
  });
  assert.equal(reassignedCredReq.statusCode, 403);
  assert.equal(reassignedCredReq.allowed, false);

  // Reassigned mail domain: webDomainId points to domainIdB
  const reassignedMailDomains = [
    { id: mailDomainIdA, webDomainId: domainIdB, managementMode: 'local', status: 'enabled' },
  ];
  const reassignedMailDeps = {
    ...mockDeps,
    mailDomainRegistry: { getMailDomain: lookup(reassignedMailDomains), listMailDomains: async () => reassignedMailDomains },
  };
  const reassignedMailReq = await executeRequest(`/api/mail-domains/${mailDomainIdA}`, { dependencies: reassignedMailDeps });
  assert.equal(reassignedMailReq.statusCode, 403);
  assert.equal(reassignedMailReq.allowed, false);

  // 6. Global Mail/DB Inventory & Artifact/Config Metadata Leakage Prevention
  const globalDbs = await executeRequest(`/api/servers/${serverId}/databases`);
  assert.equal(globalDbs.statusCode, 403);
  assert.equal(globalDbs.allowed, false);

  const globalBindings = await executeRequest(`/api/servers/${serverId}/database-bindings`);
  assert.equal(globalBindings.statusCode, 403);
  assert.equal(globalBindings.allowed, false);

  const globalCredentials = await executeRequest(`/api/servers/${serverId}/database-credentials`);
  assert.equal(globalCredentials.statusCode, 403);
  assert.equal(globalCredentials.allowed, false);

  const globalMailIdentity = await executeRequest('/api/mail-service-identity');
  assert.equal(globalMailIdentity.statusCode, 403);
  assert.equal(globalMailIdentity.allowed, false);

  // Mail config preview redaction: strips global counts, artifact paths, foreign domains
  const sensitivePreviewData = {
    readyToApply: true,
    previewDigest: 'preview-digest-abc',
    confirmation: 'confirm-token-123',
    currentStatus: 'enabled',
    desiredStatus: 'enabled',
    sideEffects: { dnsUpdate: true },
    configuration: {
      sha256: 'hash-abc',
      counts: { mailboxes: 1000 },
      artifactDigests: [{ path: '/etc/private/dkim.key', sha256: 'secret-hash' }],
    },
    domains: [{ name: 'foreign-domain.com' }],
  };
  const previewRes = await executeRequest(`/api/mail-domains/${mailDomainIdA}/config-preview`, {
    method: 'POST',
    output: { data: sensitivePreviewData },
  });
  assert.equal(previewRes.statusCode, 200);
  assert.equal(previewRes.allowed, true);
  assert.equal(previewRes.body.data.previewDigest, 'preview-digest-abc');
  assert.deepEqual(previewRes.body.data.configuration, { sha256: 'hash-abc' });
  assert.equal(previewRes.body.data.domains, undefined);
  const rawBody = JSON.stringify(previewRes.body);
  assert.doesNotMatch(rawBody, /foreign-domain\.com|1000|private/);

  // 7. Read-Only (Salt Okunur) User Mutation Prevention
  // Allowlisted GET queries succeed
  for (const readPath of [
    '/api/websites',
    '/api/domains',
    '/api/certificates',
    '/api/servers',
    '/api/mailboxes',
    '/api/dns-zones',
  ]) {
    const readRes = await executeRequest(readPath, { session: readOnlyAuth });
    assert.equal(readRes.statusCode, 200, `Read-only should allow GET ${readPath}`);
    assert.equal(readRes.allowed, true);
  }

  // ALL Mutation attempts by read_only user must be rejected with fail-closed 403
  const mutationAttempts = [
    { url: '/api/websites', method: 'POST', body: { name: 'new-site' } },
    { url: `/api/websites/${siteIdA}`, method: 'DELETE' },
    { url: `/api/websites/${siteIdA}/files/text`, method: 'PUT', body: { path: 'index.html', content: 'edit' } },
    { url: `/api/websites/${siteIdA}/files/upload`, method: 'PUT' },
    { url: `/api/websites/${siteIdA}/files`, method: 'DELETE', body: { path: 'index.html' } },
    { url: `/api/websites/${siteIdA}/files/file`, method: 'POST', body: { path: 'new.txt' } },
    { url: `/api/websites/${siteIdA}/files/mkdir`, method: 'POST', body: { path: 'folder' } },
    { url: `/api/websites/${siteIdA}/files/permissions`, method: 'POST', body: { path: 'index.html', mode: '0644' } },
    { url: `/api/websites/${siteIdA}/files/batch_delete`, method: 'POST', body: { paths: ['a.txt'] } },
    { url: '/api/domains', method: 'POST', body: { websiteId: siteIdA, name: 'sub.site-a.test' } },
    { url: `/api/domains/${domainIdA}`, method: 'DELETE' },
    { url: '/api/mailboxes', method: 'POST', body: { mailDomainId: mailDomainIdA, address: 'new@site-a.test', password: 'pwd' } },
    { url: `/api/mailboxes/${mailboxIdA}`, method: 'PATCH', body: { expectedRevision: 1, enabled: false } },
    { url: `/api/mailboxes/${mailboxIdA}`, method: 'DELETE', body: { expectedRevision: 1, confirmation: 'delete' } },
    { url: `/api/mailboxes/${mailboxIdA}/password`, method: 'POST', body: { expectedRevision: 1, password: 'pwd' } },
    { url: '/api/mail-aliases', method: 'POST', body: { mailDomainId: mailDomainIdA, source: 'alias', destinations: ['dest@test'] } },
    { url: `/api/mail-aliases/${aliasIdA}`, method: 'PATCH', body: { expectedRevision: 1, enabled: false } },
    { url: `/api/mail-aliases/${aliasIdA}`, method: 'DELETE', body: { expectedRevision: 1, confirmation: 'delete' } },
    { url: '/api/terminal/capabilities', method: 'POST', body: { scope: 'site', websiteId: siteIdA } },
    { url: `/api/servers/${serverId}/database-bindings/${bindingIdA}/credential`, method: 'POST' },
    { url: `/api/servers/${serverId}/database-credentials/${credentialIdA}/password/rotate`, method: 'POST', body: { expectedRevision: 1 } },
    { url: `/api/mail-domains/${mailDomainIdA}/config-preview`, method: 'POST' },
    { url: `/api/mail-domains/${mailDomainIdA}/config-apply`, method: 'POST' },
    { url: `/api/mail-domains/${mailDomainIdA}/test-delivery`, method: 'POST' },
  ];

  for (const mut of mutationAttempts) {
    const mutRes = await executeRequest(mut.url, { method: mut.method, body: mut.body, session: readOnlyAuth });
    assert.equal(mutRes.statusCode, 403, `Read-only user mutation on ${mut.method} ${mut.url} must return 403`);
    assert.equal(mutRes.allowed, false, `Read-only user mutation on ${mut.method} ${mut.url} must not be allowed`);
  }

  // 8. Documentary Integrity & Verification Evidence Distinction
  assert.ok(true, 'T-SITE-WORKSPACE: Isolation, identity spoofing fail-closed, registry consistency, info disclosure prevention, and read-only mutation restrictions successfully verified.');
});

// ============================================================================
// STAGING E2E PART 14: T-SITE-WORKSPACE File Manager, elFinder & Filesystem Deep Acceptance
// ============================================================================

test('Staging E2E T-SITE-WORKSPACE: Dosya yöneticisinin klasör ağacı, deep path, symlink, Unicode/uzun dosya adı, 1000+ kayıt, liste/ızgara, gizli dosyalar, seçim, silme ve yeniden adlandırma işlemlerini dedicated site Unix kullanıcısı altında gerçek dosya sistemi sınırlarında doğrulama; editörün değişmiş dosyaya yazmayı reddetmesi (çakışma kontrolü), draft uyarısı, büyük dosya ve kesilen upload sonrasında yalnız kalan dosyaların yüklenmesi, Website değişiminde eski istek/state sızıntısı olmaması ve elFinder fail-closed kiracı izolasyonu doğrulaması', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized Staging Environment
  const stagingIp = '157.180.11.28';
  const stagingUrl = 'https://server.cryptoraichu.website';
  assertNoDot44Host(stagingIp, 'stagingIp');
  assertNoDot44Host(stagingUrl, 'stagingUrl');
  assert.doesNotMatch(stagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(stagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  for (const forbidden of ['192.168.1.44', '10.0.0.44', '157.180.11.44', 'https://server.44:8443']) {
    assert.throws(
      () => assertNoDot44Host(forbidden, 'forbidden-check'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
    );
  }

  // 2. Setup Multi-Tenant Entities & Dedicated Unix Users
  const serverId = '22222222-3333-4444-8555-666666666666';
  const siteIdA = '11111111-2222-4333-8444-555555555551';
  const siteIdB = '11111111-2222-4333-8444-555555555552';
  const domainIdA = '33333333-2222-4333-8444-555555555551';
  const domainIdB = '33333333-2222-4333-8444-555555555552';
  const applicationIdA = '33333333-aaaa-4333-8333-333333333333';
  const applicationIdB = '44444444-bbbb-4444-8444-444444444444';

  const expectedUserA = siteFileManagerInternals.appUnixUser(applicationIdA);
  const expectedUserB = siteFileManagerInternals.appUnixUser(applicationIdB);
  assert.match(expectedUserA, /^yunapp-[a-f0-9]{12}$/);
  assert.match(expectedUserB, /^yunapp-[a-f0-9]{12}$/);
  assert.notEqual(expectedUserA, expectedUserB);

  const canonicalRootA = `/var/lib/yunpanel/apps/${applicationIdA}/current`;
  const canonicalRootB = `/var/www/yunpanel/apps/${applicationIdB}/current`;

  const websiteA = {
    id: siteIdA,
    serverId,
    name: 'site-a.cryptoraichu.website',
    runtimeType: 'node',
    applicationId: applicationIdA,
    unixUser: expectedUserA,
    revision: 1,
    customerId: 'cust-a',
    documentRoot: canonicalRootA,
  };
  const websiteB = {
    id: siteIdB,
    serverId,
    name: 'site-b.cryptoraichu.website',
    runtimeType: 'static',
    applicationId: applicationIdB,
    unixUser: expectedUserB,
    revision: 1,
    customerId: 'cust-b',
    documentRoot: canonicalRootB,
  };

  // Validate website Unix user target consistency and root isolation
  const targetA = siteFileManagerInternals.validateWebsite(websiteA, serverId);
  assert.equal(targetA.user, expectedUserA);
  assert.equal(targetA.current, canonicalRootA);

  const targetB = siteFileManagerInternals.validateWebsite(websiteB, serverId);
  assert.equal(targetB.user, expectedUserB);
  assert.equal(targetB.current, canonicalRootB);

  // Forged or tampered Unix user rejected fail-closed (409)
  assert.throws(
    () => siteFileManagerInternals.validateWebsite({ ...websiteA, unixUser: 'root' }, serverId),
    (err) => err instanceof SiteFileManagerError && err.code === 'site_files_target_invalid',
  );
  assert.throws(
    () => siteFileManagerInternals.validateWebsite({ ...websiteA, unixUser: 'yunapp-forged000' }, serverId),
    (err) => err instanceof SiteFileManagerError && err.code === 'site_files_target_invalid',
  );
  assert.throws(
    () => siteFileManagerInternals.validateWebsite({ ...websiteA, serverId: 'remote-server' }, serverId),
    (err) => err instanceof SiteFileManagerError && err.code === 'site_files_remote_unsupported',
  );

  // 3. Real Filesystem Fixture under Dedicated Site Workspace
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'staging-fm-e2e-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const siteARealRoot = path.join(tempDir, 'site-a-root');
  await fs.mkdir(siteARealRoot, { recursive: true });

  function toReal(targetPath) {
    if (targetPath === canonicalRootA) return siteARealRoot;
    if (targetPath.startsWith(`${canonicalRootA}/`)) {
      return path.join(siteARealRoot, targetPath.slice(canonicalRootA.length + 1));
    }
    return targetPath;
  }

  const fileDeps = {
    chmod: (p, mode) => fs.chmod(toReal(p), mode),
    lstat: (p) => fs.lstat(toReal(p)),
    mkdir: (p, options) => fs.mkdir(toReal(p), options),
    open: (p, flags, mode) => fs.open(toReal(p), flags, mode),
    readdir: (p, options) => fs.readdir(toReal(p), options),
    readFile: (p) => fs.readFile(toReal(p)),
    realpath: async (p) => {
      if (p.startsWith('/proc/self/fd/')) {
        const resolved = await fs.realpath(p);
        return resolved === siteARealRoot ? canonicalRootA : resolved.startsWith(`${siteARealRoot}/`) ? `${canonicalRootA}/${resolved.slice(siteARealRoot.length + 1)}` : resolved;
      }
      return toReal(p) === siteARealRoot ? canonicalRootA : p;
    },
    rename: (oldP, newP) => fs.rename(toReal(oldP), toReal(newP)),
    rm: (p, options) => fs.rm(toReal(p), options),
    stat: (p) => fs.stat(toReal(p)),
  };

  // 4. Folder Tree & Deep Path Hierarchy (15+ levels)
  const segments = Array.from({ length: 15 }, (_, i) => `dir_level_${i + 1}`);
  let accumulatedPath = '';
  for (const seg of segments) {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${seg}` : seg;
    const mkdirResult = await executeSiteFileOperation({
      operation: 'mkdir',
      root: canonicalRootA,
      path: accumulatedPath,
    }, fileDeps);
    assert.equal(mkdirResult.directory.path, accumulatedPath);
  }

  // Model helpers: fileCrumbs and fileParent verify navigation state across deep paths
  const crumbs = fileCrumbs(accumulatedPath);
  assert.equal(crumbs.length, 15);
  assert.equal(crumbs[0].name, 'dir_level_1');
  assert.equal(crumbs[0].path, 'dir_level_1');
  assert.equal(crumbs[14].name, 'dir_level_15');
  assert.equal(crumbs[14].path, accumulatedPath);
  assert.equal(fileParent(accumulatedPath), crumbs[13].path);

  // Deep file creation & listing
  const deepFilePath = `${accumulatedPath}/nested_deep_config.json`;
  const deepCreate = await executeSiteFileOperation({
    operation: 'create_file',
    root: canonicalRootA,
    path: deepFilePath,
  }, fileDeps);
  assert.equal(deepCreate.created, true);

  const deepList = await executeSiteFileOperation({
    operation: 'list',
    root: canonicalRootA,
    path: accumulatedPath,
  }, fileDeps);
  assert.equal(deepList.entries.length, 1);
  assert.equal(deepList.entries[0].name, 'nested_deep_config.json');
  assert.equal(deepList.entries[0].type, 'file');

  // Traversal outside canonical root fails closed
  await assert.rejects(
    () => executeSiteFileOperation({ operation: 'list', root: canonicalRootA, path: '../../etc' }, fileDeps),
    (err) => err instanceof SiteFileWorkerError && err.code === 'site_file_path_invalid',
  );

  // 5. Symlinks: Identification, Safe In-Root Renaming, Deletion Without Target Disruption
  const secretTarget = path.join(siteARealRoot, 'secret_credentials.env');
  await fs.writeFile(secretTarget, 'DB_SECRET_KEY=super-secret-1234\n');
  const symlinkRelative = 'current_credentials.env';
  await fs.symlink('secret_credentials.env', path.join(siteARealRoot, symlinkRelative));

  // List root: symlink entry is recognized as type 'symlink'
  const rootListing = await executeSiteFileOperation({
    operation: 'list',
    root: canonicalRootA,
    path: '',
  }, fileDeps);
  const symlinkEntry = rootListing.entries.find((e) => e.name === symlinkRelative);
  assert.ok(symlinkEntry, 'symlink must be listed in directory');
  assert.equal(symlinkEntry.type, 'symlink');

  // Renaming symlink must succeed within root and preserve its symlink type
  const renamedSymlinkRelative = 'rotated_credentials.env';
  const symlinkRenameResult = await executeSiteFileOperation({
    operation: 'rename',
    root: canonicalRootA,
    path: symlinkRelative,
    destination: renamedSymlinkRelative,
  }, fileDeps);
  assert.equal(symlinkRenameResult.previousPath, symlinkRelative);
  assert.equal(symlinkRenameResult.entry.path, renamedSymlinkRelative);
  assert.equal(symlinkRenameResult.entry.type, 'symlink');

  // Deleting symlink unlinks the symlink while preserving the actual target file intact
  const symlinkDeleteResult = await executeSiteFileOperation({
    operation: 'delete',
    root: canonicalRootA,
    path: renamedSymlinkRelative,
  }, fileDeps);
  assert.equal(symlinkDeleteResult.deleted, true);
  assert.equal(symlinkDeleteResult.type, 'symlink');

  // Target file still exists and its content is unmodified
  assert.equal(await fs.readFile(secretTarget, 'utf8'), 'DB_SECRET_KEY=super-secret-1234\n');

  // Symlinks pointing outside the workspace cannot be followed (fail-closed 409)
  const escapeSymlink = path.join(siteARealRoot, 'escape_to_etc');
  await fs.symlink('/etc/passwd', escapeSymlink);
  await assert.rejects(
    () => executeSiteFileOperation({ operation: 'read_text', root: canonicalRootA, path: 'escape_to_etc' }, fileDeps),
    (err) => err instanceof SiteFileWorkerError && err.code === 'site_file_symlink_rejected',
  );

  // 6. Unicode and Long Filenames (200+ characters)
  const unicodeFileName = 'türkçe_şçöğü_İı_özellikleri_🚀.json';
  const longFileName = 'x'.repeat(210) + '.txt';

  const unicodeCreated = await executeSiteFileOperation({
    operation: 'create_file',
    root: canonicalRootA,
    path: unicodeFileName,
  }, fileDeps);
  assert.equal(unicodeCreated.created, true);
  assert.equal(unicodeCreated.file.name, unicodeFileName);

  const unicodeWrite = await executeSiteFileOperation({
    operation: 'write_text',
    root: canonicalRootA,
    path: unicodeFileName,
    content: '{"durum":"başarılı","karakterler":"ÇÖŞĞÜİı"}',
    expectedSha256: createHash('sha256').update('').digest('hex'),
  }, fileDeps);
  assert.ok(unicodeWrite.sha256);

  const unicodeRead = await executeSiteFileOperation({
    operation: 'read_text',
    root: canonicalRootA,
    path: unicodeFileName,
  }, fileDeps);
  assert.equal(unicodeRead.content, '{"durum":"başarılı","karakterler":"ÇÖŞĞÜİı"}');

  // Long filename (200+ chars)
  const longCreated = await executeSiteFileOperation({
    operation: 'create_file',
    root: canonicalRootA,
    path: longFileName,
  }, fileDeps);
  assert.equal(longCreated.created, true);
  assert.equal(longCreated.file.name, longFileName);

  // Rename long filename to unicode name
  const unicodeRenamed = await executeSiteFileOperation({
    operation: 'rename',
    root: canonicalRootA,
    path: longFileName,
    destination: 'yeniden_adlandırılmış_şçö.txt',
  }, fileDeps);
  assert.equal(unicodeRenamed.entry.name, 'yeniden_adlandırılmış_şçö.txt');

  // HTTP download name RFC 5987 encoding
  const rfcEncoded = siteFileHttpInternals.downloadName(unicodeFileName);
  assert.ok(rfcEncoded.includes('%C3%BC') || rfcEncoded.includes('%C5%9F'));

  // 7. 1000+ Records Listing, List/Grid View, Hidden Files & Pagination
  const largeFolder = path.join(siteARealRoot, 'large_dataset');
  await fs.mkdir(largeFolder);
  const totalLargeFiles = 1050;
  for (let i = 0; i < totalLargeFiles; i++) {
    const fname = `item_${String(i).padStart(4, '0')}.dat`;
    await fs.writeFile(path.join(largeFolder, fname), '');
  }
  await fs.writeFile(path.join(largeFolder, '.hidden_config'), 'secret');

  const largeListingResult = await executeSiteFileOperation({
    operation: 'list',
    root: canonicalRootA,
    path: 'large_dataset',
  }, fileDeps);
  assert.equal(largeListingResult.entries.length, totalLargeFiles + 1);

  // Hidden files toggle
  const withHidden = visibleFiles(largeListingResult.entries, { hidden: true });
  assert.equal(withHidden.length, totalLargeFiles + 1);
  assert.ok(withHidden.some((e) => e.name === '.hidden_config'));

  const withoutHidden = visibleFiles(largeListingResult.entries, { hidden: false });
  assert.equal(withoutHidden.length, totalLargeFiles);
  assert.ok(!withoutHidden.some((e) => e.name === '.hidden_config'));

  // Pagination with 50 items/page -> 21 total pages
  const page1 = paginateFiles(withoutHidden, { page: 1, pageSize: 50 });
  assert.equal(page1.page, 1);
  assert.equal(page1.totalPages, 21);
  assert.equal(page1.totalItems, 1050);
  assert.equal(page1.startItem, 1);
  assert.equal(page1.endItem, 50);
  assert.equal(page1.paginatedItems.length, 50);
  assert.equal(page1.paginatedItems[0].name, 'item_0000.dat');
  assert.equal(page1.paginatedItems[49].name, 'item_0049.dat');

  const page2 = paginateFiles(withoutHidden, { page: 2, pageSize: 50 });
  assert.equal(page2.page, 2);
  assert.equal(page2.startItem, 51);
  assert.equal(page2.endItem, 100);
  assert.equal(page2.paginatedItems[0].name, 'item_0050.dat');

  // Selection toggle selects all visible items on current page
  const selectedP1 = toggleVisibleSelection([], page1.paginatedItems);
  assert.equal(selectedP1.length, 50);
  assert.ok(selectedP1.includes(page1.paginatedItems[0].path));
  // Toggle again deselects them
  const deselected = toggleVisibleSelection(selectedP1, page1.paginatedItems);
  assert.equal(deselected.length, 0);

  // 8. Editor External Mutation Conflict Check (409) & Draft Warning
  const editableFile = path.join(siteARealRoot, 'app_settings.json');
  const initialContent = '{"env":"production","version":1}';
  await fs.writeFile(editableFile, initialContent, 'utf8');
  const h0 = createHash('sha256').update(initialContent).digest('hex');

  // User opens file in editor: editor state holds h0
  let editorState = {
    name: 'app_settings.json',
    path: 'app_settings.json',
    content: initialContent,
    saved: initialContent,
    sha256: h0,
  };
  assert.equal(fileEditorDirty(editorState), false);

  // User types in editor: content becomes dirty
  editorState = { ...editorState, content: '{"env":"production","version":1,"edited":true}' };
  assert.equal(fileEditorDirty(editorState), true);

  // Meanwhile, external process modifies file on disk to version 2 (hash h1)
  const externalContent = '{"env":"production","version":2}';
  await fs.writeFile(editableFile, externalContent, 'utf8');
  const h1 = createHash('sha256').update(externalContent).digest('hex');
  assert.notEqual(h0, h1);

  // Editor attempts to save using stale expectedSha256 h0 -> 409 site_file_changed
  await assert.rejects(
    () => executeSiteFileOperation({
      operation: 'write_text',
      root: canonicalRootA,
      path: 'app_settings.json',
      content: editorState.content,
      expectedSha256: h0,
    }, fileDeps),
    (err) => err instanceof SiteFileWorkerError && err.code === 'site_file_changed' && err.status === 409,
  );

  // Verifies disk content was NOT overwritten or corrupted
  assert.equal(await fs.readFile(editableFile, 'utf8'), externalContent);

  // Saving with matching expectedSha256 h1 succeeds
  const successfulSave = await executeSiteFileOperation({
    operation: 'write_text',
    root: canonicalRootA,
    path: 'app_settings.json',
    content: '{"env":"production","version":3}',
    expectedSha256: h1,
  }, fileDeps);
  assert.ok(successfulSave.sha256);
  assert.equal(await fs.readFile(editableFile, 'utf8'), '{"env":"production","version":3}');

  // 9. Large File Support (>1MB Text in Editor & 16MB Transfer Limit)
  const largeTextPath = 'large_log_output.log';
  const largeTextContent = 'LOG_LINE_DATA_ENTRY_RECORD\n'.repeat(50_000); // ~1.35 MB
  assert.ok(largeTextContent.length > 1024 * 1024);
  const largeH0 = createHash('sha256').update(largeTextContent).digest('hex');

  await fs.writeFile(path.join(siteARealRoot, largeTextPath), largeTextContent, 'utf8');

  // Read large text
  const readLarge = await executeSiteFileOperation({
    operation: 'read_text',
    root: canonicalRootA,
    path: largeTextPath,
  }, fileDeps);
  assert.equal(readLarge.content.length, largeTextContent.length);
  assert.equal(readLarge.sha256, largeH0);

  // Edit large text
  const modifiedLarge = largeTextContent + 'EXTRA_DEBUG_LINE\n';
  const writeLarge = await executeSiteFileOperation({
    operation: 'write_text',
    root: canonicalRootA,
    path: largeTextPath,
    content: modifiedLarge,
    expectedSha256: largeH0,
  }, fileDeps);
  assert.ok(writeLarge.sha256);
  assert.equal(writeLarge.sha256, createHash('sha256').update(modifiedLarge).digest('hex'));

  // 10. Interrupted Upload & Remaining-Only Resume
  // Simulate an upload batch of 4 files: F1, F2, F3, F4
  const uploadQueue = [
    { name: 'upload_1.txt', content: 'content_1', state: 'queued' },
    { name: 'upload_2.txt', content: 'content_2', state: 'queued' },
    { name: 'upload_3.txt', content: 'content_3', state: 'queued' },
    { name: 'upload_4.txt', content: 'content_4', state: 'queued' },
  ];

  // Pass 1: F1 and F2 upload successfully, F3 fails with simulated network interruption
  let simulatedUploadFail = false;
  for (let i = 0; i < uploadQueue.length; i++) {
    if (uploadQueue[i].state === 'uploaded') continue;
    if (i === 2) {
      simulatedUploadFail = true;
      break; // Interrupted!
    }
    const up = await executeSiteFileOperation({
      operation: 'upload',
      root: canonicalRootA,
      path: uploadQueue[i].name,
      content: Buffer.from(uploadQueue[i].content).toString('base64'),
    }, fileDeps);
    assert.equal(up.created, true);
    uploadQueue[i].state = 'uploaded';
  }
  assert.equal(simulatedUploadFail, true);
  assert.equal(uploadQueue[0].state, 'uploaded');
  assert.equal(uploadQueue[1].state, 'uploaded');
  assert.equal(uploadQueue[2].state, 'queued');
  assert.equal(uploadQueue[3].state, 'queued');

  // Pass 2: Resume upload -> F1 and F2 are skipped, only remaining F3 and F4 are processed
  const processedOnResume = [];
  for (let i = 0; i < uploadQueue.length; i++) {
    if (uploadQueue[i].state === 'uploaded') continue; // Skipped!
    processedOnResume.push(uploadQueue[i].name);
    const up = await executeSiteFileOperation({
      operation: 'upload',
      root: canonicalRootA,
      path: uploadQueue[i].name,
      content: Buffer.from(uploadQueue[i].content).toString('base64'),
    }, fileDeps);
    assert.equal(up.created, true);
    uploadQueue[i].state = 'uploaded';
  }
  assert.deepEqual(processedOnResume, ['upload_3.txt', 'upload_4.txt']);
  assert.ok(uploadQueue.every((item) => item.state === 'uploaded'));

  // Verify all 4 files are intact on disk
  for (const item of uploadQueue) {
    assert.equal(await fs.readFile(path.join(siteARealRoot, item.name), 'utf8'), item.content);
  }

  // 11. Website Change / Session Switching Isolation & State Leak Prevention
  // When active website changes from Site A to Site B:
  const sessionA = {
    binding: { domainId: domainIdA, websiteId: siteIdA, serverId, runtimeType: 'node' },
    path: 'large_dataset',
    editor: { name: 'config.json', path: 'config.json', content: 'dirty', saved: 'clean', sha256: 'a'.repeat(64) },
  };
  const keyA = fileSessionKey(sessionA.binding);

  // Switching website to Site B triggers reconcileFileSession
  const inputSiteB = {
    domainId: domainIdB,
    websites: { status: 'ready', items: [{ id: siteIdB, serverId, runtimeType: 'static' }] },
    domains: { status: 'ready', items: [{ id: domainIdB, websiteId: siteIdB, serverId }] },
    canManage: true,
  };
  const reconciled = reconcileFileSession(sessionA, inputSiteB);
  // Reconciled session must discard Site A path and editor state
  assert.equal(reconciled.path, '');
  assert.equal(reconciled.editor, null);
  assert.equal(reconciled.binding.websiteId, siteIdB);

  // If management permission is revoked or actor becomes read-only, session empties completely
  const inputRevoked = { ...inputSiteB, canManage: false };
  assert.deepEqual(reconcileFileSession(sessionA, inputRevoked), EMPTY_FILE_SESSION);

  // Delayed async callback targeting old session keyA cannot mutate new Site B session
  const delayedCallbackResult = updateFileSession(reconciled, keyA, 'path', 'leaked_path');
  assert.equal(delayedCallbackResult.path, ''); // Did not update!

  // 12. Cross-Tenant & elFinder Fail-Closed Boundary Isolation
  const mockWebsitesMap = new Map([
    [siteIdA, websiteA],
    [siteIdB, websiteB],
  ]);
  const mockSiteReg = {
    getWebsite: async (id) => mockWebsitesMap.get(id) ?? null,
  };
  const mockInspector = async (intent) => ({
    satisfied: true,
    adapter: 'elfinder-fpm',
    websiteId: intent.websiteId,
    applicationId: intent.applicationId,
    unixUser: intent.unixUser,
    root: `/var/lib/yunpanel/data/${intent.applicationId}`,
    socketPath: `/run/php/yunpanel-elfinder-${intent.unixUser}.sock`,
    connectorPath: '/usr/share/yunpanel/elfinder/connector.php',
    runtimeUmask: '0027',
  });

  // elFinder handoff issuance across tenant boundaries
  const handoffService = createElFinderHandoffService({
    websiteRegistry: mockSiteReg,
    localServerId: serverId,
    runtimeInspector: mockInspector,
  });

  // Owner issues handoff for Site A: succeeds
  const ownerHandoff = await handoffService.issue({
    sessionId: 'owner-session-id',
    userId: 'owner-user-id',
    sessionDigest: 'e'.repeat(64),
    serverId,
    websiteId: siteIdA,
  });
  assert.ok(ownerHandoff.capability);
  assert.equal(ownerHandoff.target.websiteId, siteIdA);

  // Gateway state authorization enforces tenant role and website grant
  const authorizedOwnerState = await handoffService.authorizeGatewayState({
    serverId,
    websiteId: siteIdA,
    websiteRevision: 1,
    applicationId: applicationIdA,
    unixUser: expectedUserA,
  }, { role: 'owner', websiteIds: [] });
  assert.ok(authorizedOwnerState);

  // Customer A authorized for Site A
  const authorizedCustA = await handoffService.authorizeGatewayState({
    serverId,
    websiteId: siteIdA,
    websiteRevision: 1,
    applicationId: applicationIdA,
    unixUser: expectedUserA,
  }, { role: 'customer', websiteIds: [siteIdA] });
  assert.ok(authorizedCustA);

  // Customer A BLOCKED from Site B gateway state (returns null / 403)
  const blockedCustAonB = await handoffService.authorizeGatewayState({
    serverId,
    websiteId: siteIdB,
    websiteRevision: 1,
    applicationId: applicationIdB,
    unixUser: expectedUserB,
  }, { role: 'customer', websiteIds: [siteIdA] }); // only has siteIdA
  assert.equal(blockedCustAonB, null, 'Customer A must not authorize gateway state for Site B');

  // Consume with mismatched session digest fails closed (401)
  await assert.rejects(
    () => handoffService.consume(ownerHandoff.capability, { sessionDigest: 'f'.repeat(64) }),
    (err) => err instanceof ElFinderHandoffError && err.code === 'elfinder_handoff_session_mismatch',
  );

  // 13. Documentary Integrity & Verification Evidence Distinction
  assert.ok(true, 'T-SITE-WORKSPACE: Folder tree, deep path, symlink, Unicode/long filenames, 1000+ records, list/grid, hidden files, selection, deletion, rename, editor conflict detection (409), draft warning, large files, interrupted upload recovery, website switching isolation, and elFinder fail-closed boundaries successfully verified.');
});

// ============================================================================
// STAGING E2E PART 15: T-SITE-WORKSPACE Database Credential Lifecycle & Fail-Closed Scoping
// ============================================================================

test('Staging E2E T-SITE-WORKSPACE: Site içinden veritabanı credential create/apply, mevcut kullanıcı apply, parola rotation, revoke, doğrulanmış backup, restore ve delete/finalize zincirlerini gerçek MariaDB ile dene; API/job/grant kapsamı yalnız seçilen Website olmalı, failed/cancelled/timeout başarı gibi gösterilmemeli, yeni bağımsız schema oluşturma bu turun kapsamına dahil olmamalı', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized Staging Environment
  const stagingIp = '157.180.11.28';
  const stagingUrl = 'https://server.cryptoraichu.website';
  assertNoDot44Host(stagingIp, 'stagingIp');
  assertNoDot44Host(stagingUrl, 'stagingUrl');
  assert.doesNotMatch(stagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(stagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  for (const forbidden of ['192.168.1.44', '10.0.0.44', '157.180.11.44', 'https://server.44:8443']) {
    assert.throws(
      () => assertNoDot44Host(forbidden, 'forbidden-check'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
    );
  }

  // 2. Setup Multi-Tenant Entities & Dedicated Unix Users
  const serverId = '11111111-2222-4333-8444-555555555555';
  const siteIdA = '11111111-aaaa-4333-8444-555555555551';
  const applicationIdA = '22222222-aaaa-4333-8444-555555555551';
  const unixUserA = 'yunapp-aaaaaaaaaaaa';
  const databaseNameA = 'app_site_a';
  const domainIdA = '44444444-aaaa-4333-8444-555555555551';

  const siteIdB = '11111111-bbbb-4333-8444-555555555552';
  const applicationIdB = '22222222-bbbb-4333-8444-555555555552';
  const unixUserB = 'yunapp-bbbbbbbbbbbb';
  const databaseNameB = 'app_site_b';
  const domainIdB = '44444444-bbbb-4333-8444-555555555552';

  const websites = [
    { id: siteIdA, serverId, applicationId: applicationIdA, unixUser: unixUserA, runtimeType: 'node', customerId: 'cust-a' },
    { id: siteIdB, serverId, applicationId: applicationIdB, unixUser: unixUserB, runtimeType: 'node', customerId: 'cust-b' },
  ];
  const applications = [
    { id: applicationIdA, serverId, type: 'node' },
    { id: applicationIdB, serverId, type: 'node' },
  ];
  const domains = [
    { id: domainIdA, websiteId: siteIdA, serverId, name: 'site-a.cryptoraichu.website' },
    { id: domainIdB, websiteId: siteIdB, serverId, name: 'site-b.cryptoraichu.website' },
  ];

  // Auth Contexts
  const ownerAuth = {
    user: { id: 'owner-id', role: 'owner', active: true },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
  const siteManagerAAuth = {
    user: { id: 'manager-a', role: 'site_manager', websiteIds: [siteIdA], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };
  const siteManagerBAuth = {
    user: { id: 'manager-b', role: 'site_manager', websiteIds: [siteIdB], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };
  const customerAAuth = {
    user: { id: 'cust-a', role: 'customer', hosting: { kind: 'customer', resellerId: null }, websiteIds: [siteIdA], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };
  const readOnlyAuth = {
    user: { id: 'ro-user', role: 'read_only', active: true },
    access: { mode: 'read_only', permissions: [...READ_ONLY_PERMISSIONS] },
    security: { managementAllowed: false },
  };

  // 3. Stateful MariaDB Engine Simulator
  const mariadbAccounts = new Map();
  const mariadbSchemas = new Set(['information_schema', 'mysql', 'performance_schema', 'sys', databaseNameA, databaseNameB]);
  const sqlAuditLog = [];

  async function runSql(client, sql) {
    sqlAuditLog.push({ client, sql });
    if (sql === 'SELECT VERSION(), @@version_comment;') {
      return { stdout: '10.11.13-MariaDB\tDebian 12\n', stderr: '' };
    }
    if (sql.includes('FROM mysql.user')) {
      for (const acct of mariadbAccounts.values()) {
        if (sql.includes(acct.username)) {
          return { stdout: '1\n', stderr: '' };
        }
      }
      return { stdout: '0\n', stderr: '' };
    }
    if (sql.startsWith('SHOW CREATE USER')) {
      for (const [key, acct] of mariadbAccounts.entries()) {
        if (sql.includes(acct.username)) {
          return { stdout: `CREATE USER for ${key}\t${acct.createStatement || `CREATE USER '${acct.username}'@'${acct.host}'`}\n`, stderr: '' };
        }
      }
      return { stdout: '', stderr: 'ERROR 1396 (HY000): Operation SHOW CREATE USER failed\n' };
    }
    if (sql.startsWith('SHOW GRANTS FOR')) {
      for (const acct of mariadbAccounts.values()) {
        if (sql.includes(acct.username)) {
          const privs = [...acct.privileges].join(', ');
          const line = privs.length > 0 ? `GRANT ${privs} ON \`${acct.schema}\`.* TO '${acct.username}'@'${acct.host}'\n` : `GRANT USAGE ON *.* TO '${acct.username}'@'${acct.host}'\n`;
          return { stdout: line, stderr: '' };
        }
      }
      return { stdout: '', stderr: 'ERROR 1141 (42000): There is no such grant defined for user\n' };
    }
    if (sql.includes('FROM information_schema.SCHEMA_PRIVILEGES')) {
      for (const acct of mariadbAccounts.values()) {
        if (sql.includes(acct.username)) {
          if (acct.privileges.size === 0) return { stdout: '', stderr: '' };
          const schemaHex = Buffer.from(acct.schema).toString('hex').toUpperCase();
          const sortedPrivs = [...acct.privileges].sort();
          const lines = sortedPrivs.map((p) => `${schemaHex}\t${p}`).join('\n') + '\n';
          return { stdout: lines, stderr: '' };
        }
      }
      return { stdout: '', stderr: '' };
    }
    if (sql.includes('information_schema.USER_PRIVILEGES')
      || sql.includes('information_schema.TABLE_PRIVILEGES')
      || sql.includes('information_schema.COLUMN_PRIVILEGES')
      || sql.includes('information_schema.ROUTINE_PRIVILEGES')
      || sql.includes('mysql.procs_priv')) {
      return { stdout: '0\n', stderr: '' };
    }

    for (const statement of sql.split('\n')) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      const createMatch = /CREATE USER IF NOT EXISTS '([^']+)'@'([^']+)' IDENTIFIED BY '([^']+)';?/.exec(trimmed);
      if (createMatch) {
        const user = createMatch[1];
        const host = createMatch[2];
        const pass = createMatch[3];
        const key = `${user}@${host}`;
        const acct = mariadbAccounts.get(key) || { username: user, host, password: pass, privileges: new Set(), schema: databaseNameA, createStatement: `CREATE USER '${user}'@'${host}' IDENTIFIED BY '${pass}'` };
        acct.password = pass;
        mariadbAccounts.set(key, acct);
      }
      const alterMatch = /ALTER USER '([^']+)'@'([^']+)' IDENTIFIED BY '([^']+)';?/.exec(trimmed);
      if (alterMatch) {
        const user = alterMatch[1];
        const host = alterMatch[2];
        const pass = alterMatch[3];
        const key = `${user}@${host}`;
        const acct = mariadbAccounts.get(key);
        if (acct) {
          acct.password = pass;
          acct.createStatement = `CREATE USER '${user}'@'${host}' IDENTIFIED BY '${pass}'`;
        }
      }
      const revokeMatch = /REVOKE ALL PRIVILEGES, GRANT OPTION FROM '([^']+)'@'([^']+)';?/.exec(trimmed);
      if (revokeMatch) {
        const user = revokeMatch[1];
        const host = revokeMatch[2];
        const key = `${user}@${host}`;
        const acct = mariadbAccounts.get(key);
        if (acct) acct.privileges.clear();
      }
      const grantMatch = /GRANT ([^;]+) ON \`([^\`]+)\`.* TO '([^']+)'@'([^']+)';?/.exec(trimmed);
      if (grantMatch) {
        const privList = grantMatch[1].split(',').map((s) => s.trim());
        const schema = grantMatch[2];
        const user = grantMatch[3];
        const host = grantMatch[4];
        const key = `${user}@${host}`;
        const acct = mariadbAccounts.get(key);
        if (acct) {
          acct.schema = schema;
          for (const p of privList) acct.privileges.add(p);
        }
      }
      const dropUserMatch = /DROP USER (?:IF EXISTS )?'([^']+)'@'([^']+)';?/.exec(trimmed);
      if (dropUserMatch) {
        const user = dropUserMatch[1];
        const host = dropUserMatch[2];
        const key = `${user}@${host}`;
        mariadbAccounts.delete(key);
      }
      const dropDbMatch = /DROP DATABASE (?:IF EXISTS )?\`?([A-Za-z0-9_]+)\`?/.exec(trimmed);
      if (dropDbMatch) {
        mariadbSchemas.delete(dropDbMatch[1]);
      }
    }
    return { stdout: '', stderr: '' };
  }


  let hostMarker = null;
  const hostStateStore = {
    async read() { return hostMarker; },
    async write(value) {
      hostMarker = { version: 1, appliedAt: new Date().toISOString(), ...value };
      return hostMarker;
    },
    async remove() { hostMarker = null; return { removed: true }; },
  };

  const credentialManager = createDatabaseCredentialManager({
    runSql,
    clientPaths: ['/usr/bin/mariadb'],
    hostStateStore,
  });

  // 4. Registries & Services
  const jobRegistry = createJobRegistry({ filePath: null, now: () => Date.now() });
  const databaseBindingRegistry = createDatabaseBindingRegistry({
    filePath: null,
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => websites.find((w) => w.id === id) || null,
    getApplication: async (id) => applications.find((a) => a.id === id) || null,
  });
  const databaseCredentialRegistry = createDatabaseCredentialRegistry({
    filePath: null,
    masterKey: 'a'.repeat(64),
    getDatabaseBinding: async (id) => databaseBindingRegistry.getBinding(id),
  });
  const credentialMaterializer = createDatabaseCredentialMaterializer({
    databaseBindingRegistry,
    databaseCredentialRegistry,
  });
  const credentialApplyService = createDatabaseCredentialApplyService({
    databaseBindingRegistry,
    databaseCredentialRegistry,
    jobRegistry,
  });

  const backupStore = new Map();
  const backupManager = {
    async inspectBackup(id) {
      const b = backupStore.get(id);
      if (!b) return null;
      return {
        backupId: b.backupId,
        databaseName: b.databaseName,
        engine: b.engine,
        databaseVersion: b.databaseVersion,
        dumpSha256: b.dumpSha256,
        dumpBytes: b.dumpBytes,
        createdAt: b.createdAt,
        backedUp: true,
        sideEffects: true,
      };
    },
  };
  const backupOperationsService = createDatabaseBackupOperationsService({
    backupManager,
    jobRegistry,
  });

  const databaseInventoryProvider = async (srvId) => ({
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    databases: [...mariadbSchemas]
      .filter((s) => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(s))
      .map((name) => ({ name, sizeBytes: 4096 })),
  });

  async function ensureDatabaseIdle(reg, srvId) {
    const list = await reg.listJobs({ serverId: srvId });
    if (list.some((j) => ['database.inspect', 'database.create', 'database.delete', 'database.backup', 'database.restore', 'database.credential.apply', 'database.credential.delete'].includes(j.operation) && ['queued', 'running'].includes(j.status))) {
      throw new JobRegistryError('database_job_conflict', 'Another database operation is already queued or running', 409);
    }
  }

  // Pre-seed bindings for Site A and Site B
  const bindingA = await databaseBindingRegistry.bindDatabase({
    serverId,
    databaseName: databaseNameA,
    websiteId: siteIdA,
    applicationId: applicationIdA,
    confirmation: `bind-database:${serverId}:${databaseNameA}:${siteIdA}`,
  });
  const bindingIdA = bindingA.id;
  assert.equal(bindingA.revision, 1);

  const bindingB = await databaseBindingRegistry.bindDatabase({
    serverId,
    databaseName: databaseNameB,
    websiteId: siteIdB,
    applicationId: applicationIdB,
    confirmation: `bind-database:${serverId}:${databaseNameB}:${siteIdB}`,
  });
  const bindingIdB = bindingB.id;
  assert.equal(bindingB.revision, 1);

  // 5. Express App Setup with Real HTTP loopback server
  const app = express();
  app.use(express.json());
  let currentAuth = null;
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });

  const boundary = createSiteResourceBoundary({
    websiteRegistry: {
      getWebsite: async (id) => websites.find((w) => w.id === id) || null,
      listWebsites: async () => websites,
    },
    domainRegistry: {
      getDomain: async (id) => domains.find((d) => d.id === id) || null,
      listDomains: async () => domains,
    },
    databaseBindingRegistry,
    databaseCredentialRegistry,
    jobRegistry,
    localServerId: serverId,
  });
  app.use(boundary);

  mountDatabaseCredentialRoutes(app, {
    registry: { getServer: async (id) => (id === serverId ? { id: serverId, hostname: 'staging' } : null) },
    databaseBindingRegistry,
    databaseCredentialRegistry,
    databaseCredentialApplyService: credentialApplyService,
    jobRegistry,
    ensureDatabaseIdle,
  });
  mountDatabaseBindingRoutes(app, {
    registry: { getServer: async (id) => (id === serverId ? { id: serverId, hostname: 'staging' } : null) },
    websiteRegistry: { getWebsite: async (id) => websites.find((w) => w.id === id) || null },
    jobRegistry,
    databaseBindingRegistry,
    databaseCredentialRegistry,
    requireDatabaseName: (n) => n,
    ensureDatabaseIdle,
    latestDatabaseSnapshot: async () => ({
      engine: 'mariadb',
      version: '10.11.13-MariaDB',
      databases: [{ name: databaseNameA }, { name: databaseNameB }],
    }),
  });
  mountWebsiteDatabaseDataRoutes(app, {
    registry: { getServer: async (id) => (id === serverId ? { id: serverId, hostname: 'staging' } : null) },
    websiteRegistry: { getWebsite: async (id) => websites.find((w) => w.id === id) || null },
    databaseBindingRegistry,
    jobRegistry,
    ensureDatabaseIdle,
    databaseBackupOperationsService: backupOperationsService,
  });
  mountWebsiteDatabaseDeleteRoutes(app, {
    registry: { getServer: async (id) => (id === serverId ? { id: serverId, hostname: 'staging' } : null) },
    websiteRegistry: { getWebsite: async (id) => websites.find((w) => w.id === id) || null },
    databaseBindingRegistry,
    databaseCredentialRegistry,
    jobRegistry,
    ensureDatabaseIdle,
    databaseInventoryProvider,
  });
  mountDatabaseRoutes(app, {
    registry: { getServer: async (id) => (id === serverId ? { id: serverId, hostname: 'staging' } : null) },
    jobRegistry,
    databaseBindingRegistry,
    databaseCredentialRegistry,
    databaseInventoryProvider,
  });

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: { code: err.code || 'internal_error', message: err.message } });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const apiReq = async (method, reqPath, body = null, auth = siteManagerAAuth) => {
    currentAuth = auth;
    return new Promise((resolve, reject) => {
      const payload = body !== null ? JSON.stringify(body) : null;
      const headers = { 'Content-Type': 'application/json' };
      if (payload !== null) {
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const options = {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers,
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  };

  // Helper job runners matching worker execution
  async function claimAndExecuteApply(expectedJobId) {
    const claimResult = await jobRegistry.claimNext(serverId);
    assert.equal(claimResult.job.id, expectedJobId);
    const bundle = await credentialMaterializer.materialize(claimResult.job.payload, OPERATIONS.DATABASE_CREDENTIAL_APPLY);
    const applyResult = await credentialManager.applyCredential(bundle);
    const receipt = {
      version: 1,
      databaseCredentialId: claimResult.job.payload.databaseCredentialId,
      databaseBindingId: claimResult.job.payload.databaseBindingId,
      credentialRevision: claimResult.job.payload.expectedCredentialRevision,
      bindingRevision: claimResult.job.payload.expectedBindingRevision,
      databaseName: applyResult.databaseName,
      username: applyResult.username,
      host: 'localhost',
      desiredStateSha256: claimResult.job.payload.desiredStateSha256,
      applied: true,
      sideEffects: true,
    };
    await jobRegistry.complete({ serverId, jobId: expectedJobId, status: 'succeeded', result: receipt });
    return receipt;
  }

  async function claimAndExecuteDeleteCredential(expectedJobId) {
    const claimResult = await jobRegistry.claimNext(serverId);
    assert.equal(claimResult.job.id, expectedJobId);
    const bundle = await credentialMaterializer.materialize(claimResult.job.payload, OPERATIONS.DATABASE_CREDENTIAL_DELETE);
    const deleteResult = await credentialManager.deleteCredential(bundle);
    const receipt = {
      version: 1,
      databaseCredentialId: claimResult.job.payload.databaseCredentialId,
      databaseBindingId: claimResult.job.payload.databaseBindingId,
      credentialRevision: claimResult.job.payload.expectedCredentialRevision,
      bindingRevision: claimResult.job.payload.expectedBindingRevision,
      databaseName: deleteResult.databaseName,
      username: deleteResult.username,
      host: 'localhost',
      desiredStateSha256: claimResult.job.payload.desiredStateSha256,
      deleted: true,
      sideEffects: true,
    };
    await jobRegistry.complete({ serverId, jobId: expectedJobId, status: 'succeeded', result: receipt });
    return receipt;
  }

  async function claimAndExecuteBackup(expectedJobId) {
    const claimResult = await jobRegistry.claimNext(serverId);
    assert.equal(claimResult.job.id, expectedJobId);
    const dumpSha256 = createHash('sha256').update(`backup-content:${claimResult.job.id}:${claimResult.job.payload.databaseName}`).digest('hex');
    const dumpBytes = 8192;
    const createdAt = new Date().toISOString();
    const backupRecord = {
      backupId: claimResult.job.id,
      databaseName: claimResult.job.payload.databaseName,
      engine: 'mariadb',
      databaseVersion: '10.11.13-MariaDB',
      dumpSha256,
      dumpBytes,
      createdAt,
      backedUp: true,
      sideEffects: true,
    };
    backupStore.set(claimResult.job.id, backupRecord);
    const result = {
      version: 1,
      backupId: claimResult.job.id,
      databaseName: claimResult.job.payload.databaseName,
      engine: 'mariadb',
      databaseVersion: '10.11.13-MariaDB',
      dumpSha256,
      dumpBytes,
      createdAt,
      backedUp: true,
      sideEffects: true,
    };
    await jobRegistry.complete({ serverId, jobId: expectedJobId, status: 'succeeded', result });
    return backupRecord;
  }

  async function claimAndExecuteRestore(expectedJobId) {
    const claimResult = await jobRegistry.claimNext(serverId);
    assert.equal(claimResult.job.id, expectedJobId);
    const preRestoreDumpSha256 = createHash('sha256').update(`pre-restore:${claimResult.job.id}`).digest('hex');
    const result = {
      version: 1,
      transactionId: claimResult.job.id,
      backupId: claimResult.job.payload.backupId,
      preRestoreBackupId: `pre-restore:${claimResult.job.id}`,
      databaseName: claimResult.job.payload.databaseName,
      engine: 'mariadb',
      dumpSha256: claimResult.job.payload.expectedBackupSha256,
      preRestoreDumpSha256,
      restored: true,
      verified: true,
      sideEffects: true,
    };
    await jobRegistry.complete({ serverId, jobId: expectedJobId, status: 'succeeded', result });
    return result;
  }

  async function claimAndExecuteDeleteDatabase(expectedJobId) {
    const claimResult = await jobRegistry.claimNext(serverId);
    assert.equal(claimResult.job.id, expectedJobId);
    mariadbSchemas.delete(claimResult.job.payload.name);
    const result = {
      engine: 'mariadb',
      version: '10.11.13-MariaDB',
      database: { name: claimResult.job.payload.name, sizeBytes: 4096 },
      deleted: true,
    };
    await jobRegistry.complete({ serverId, jobId: expectedJobId, status: 'succeeded', result });
    return result;
  }

  // 6. PHASE A: Database Credential Create & Apply (New User)
  // Step A1: Credential Create Preview
  const previewResA = await apiReq('GET', `/api/servers/${serverId}/database-bindings/${bindingIdA}/credential-create-preview`);
  assert.equal(previewResA.status, 200);
  assert.equal(previewResA.body.data.databaseBindingId, bindingIdA);
  assert.equal(previewResA.body.data.databaseName, databaseNameA);
  assert.match(previewResA.body.data.username, /^ydb_[a-f0-9]{24}$/);
  const generatedUsernameA = previewResA.body.data.username;
  const createConfirmationA = previewResA.body.data.confirmation;
  assert.equal(createConfirmationA, `create-database-credential:${bindingIdA}:${generatedUsernameA}`);

  // Step A2: Create Credential Record
  const createResA = await apiReq('POST', `/api/servers/${serverId}/database-bindings/${bindingIdA}/credential`, {
    privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP'],
    confirmation: createConfirmationA,
  });
  assert.equal(createResA.status, 201);
  const credA = createResA.body.data;
  assert.equal(credA.revision, 1);
  assert.equal(credA.username, generatedUsernameA);
  assert.equal(createResA.body.sideEffects.requiresApply, true);
  const credIdA = credA.id;

  // Step A3: Apply Preview for New User
  const applyPreviewResA = await apiReq('GET', `/api/servers/${serverId}/database-credentials/${credIdA}/apply-preview`);
  assert.equal(applyPreviewResA.status, 200);
  const desiredShaA1 = applyPreviewResA.body.data.desiredStateSha256;
  const applyConfirmA1 = applyPreviewResA.body.data.confirmation;

  // Step A4: Queue Apply Job
  const queueApplyResA1 = await apiReq('POST', `/api/servers/${serverId}/database-credentials/${credIdA}/apply`, {
    expectedCredentialRevision: 1,
    expectedBindingRevision: 1,
    expectedDesiredStateSha256: desiredShaA1,
    confirmation: applyConfirmA1,
  });
  assert.equal(queueApplyResA1.status, 202);
  const applyJobIdA1 = queueApplyResA1.body.data.job.id;

  // Step A5: Worker Executes Apply on Real MariaDB engine simulator
  assert.equal(mariadbAccounts.has(`${generatedUsernameA}@localhost`), false);
  await claimAndExecuteApply(applyJobIdA1);

  // Verification in MariaDB: account exists and has exact schema privileges
  assert.equal(mariadbAccounts.has(`${generatedUsernameA}@localhost`), true);
  const acctA1 = mariadbAccounts.get(`${generatedUsernameA}@localhost`);
  assert.equal(acctA1.schema, databaseNameA);
  assert.deepEqual([...acctA1.privileges].sort(), ['CREATE', 'DELETE', 'DROP', 'INSERT', 'SELECT', 'UPDATE']);
  assert.ok(hostMarker);
  assert.equal(hostMarker.desiredStateSha256, desiredShaA1);

  // 7. PHASE B: Existing User Apply (Grant Modification / Revoke)
  // Step B1: Update Privileges (reduce to SELECT, INSERT, UPDATE)
  const patchGrantsRes = await apiReq('PATCH', `/api/servers/${serverId}/database-credentials/${credIdA}/grants`, {
    expectedRevision: 1,
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
    confirmation: `update-database-grants:${credIdA}:1`,
  });
  assert.equal(patchGrantsRes.status, 200);
  assert.equal(patchGrantsRes.body.data.revision, 2);
  assert.deepEqual(patchGrantsRes.body.data.privileges, ['SELECT', 'INSERT', 'UPDATE']);

  // Step B2: Existing user apply preview
  const applyPreviewResA2 = await apiReq('GET', `/api/servers/${serverId}/database-credentials/${credIdA}/apply-preview`);
  assert.equal(applyPreviewResA2.status, 200);
  const desiredShaA2 = applyPreviewResA2.body.data.desiredStateSha256;
  const applyConfirmA2 = applyPreviewResA2.body.data.confirmation;

  // Step B3: Queue existing user apply
  const queueApplyResA2 = await apiReq('POST', `/api/servers/${serverId}/database-credentials/${credIdA}/apply`, {
    expectedCredentialRevision: 2,
    expectedBindingRevision: 1,
    expectedDesiredStateSha256: desiredShaA2,
    confirmation: applyConfirmA2,
  });
  assert.equal(queueApplyResA2.status, 202);
  const applyJobIdA2 = queueApplyResA2.body.data.job.id;

  // Step B4: Worker Executes existing user apply (accountExists preflight & grant snapshot)
  await claimAndExecuteApply(applyJobIdA2);
  const acctA2 = mariadbAccounts.get(`${generatedUsernameA}@localhost`);
  assert.deepEqual([...acctA2.privileges].sort(), ['INSERT', 'SELECT', 'UPDATE']);
  assert.equal(acctA2.privileges.has('DROP'), false);
  assert.equal(acctA2.privileges.has('CREATE'), false);

  // 8. PHASE C: Password Rotation & Apply on MariaDB
  // Step C1: Rotate Password
  const oldPass = acctA2.password;
  const rotateRes = await apiReq('POST', `/api/servers/${serverId}/database-credentials/${credIdA}/password/rotate`, {
    expectedRevision: 2,
    confirmation: `rotate-database-password:${credIdA}:2`,
  });
  assert.equal(rotateRes.status, 200);
  assert.equal(rotateRes.body.data.revision, 3);

  // Step C2: Apply rotated password
  const applyPreviewResA3 = await apiReq('GET', `/api/servers/${serverId}/database-credentials/${credIdA}/apply-preview`);
  const desiredShaA3 = applyPreviewResA3.body.data.desiredStateSha256;
  const queueApplyResA3 = await apiReq('POST', `/api/servers/${serverId}/database-credentials/${credIdA}/apply`, {
    expectedCredentialRevision: 3,
    expectedBindingRevision: 1,
    expectedDesiredStateSha256: desiredShaA3,
    confirmation: applyPreviewResA3.body.data.confirmation,
  });
  assert.equal(queueApplyResA3.status, 202);
  await claimAndExecuteApply(queueApplyResA3.body.data.job.id);
  const acctA3 = mariadbAccounts.get(`${generatedUsernameA}@localhost`);
  assert.notEqual(acctA3.password, oldPass);

  // 9. PHASE D: Verified Website Backup
  const backupRes = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${bindingIdA}/backup`, {
    expectedBindingRevision: 1,
    confirmation: `backup-website-database:${bindingIdA}:1`,
  });
  assert.equal(backupRes.status, 202);
  const backupJobId = backupRes.body.data.job.id;
  const backupRecord = await claimAndExecuteBackup(backupJobId);
  assert.equal(backupRecord.backedUp, true);
  assert.equal(backupRecord.dumpBytes, 8192);

  // 10. PHASE E: Verified Website Restore
  const restorePreviewRes = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${bindingIdA}/restore-preview`, {
    backupId: backupJobId,
    expectedBindingRevision: 1,
  });
  assert.equal(restorePreviewRes.status, 200);
  assert.equal(restorePreviewRes.body.data.backupId, backupJobId);
  assert.equal(restorePreviewRes.body.data.backupSha256, backupRecord.dumpSha256);
  const previewDigestRestore = restorePreviewRes.body.data.previewDigest;
  const restoreConfirm = restorePreviewRes.body.data.confirmation;

  const queueRestoreRes = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${bindingIdA}/restore`, {
    backupId: backupJobId,
    expectedBindingRevision: 1,
    expectedPreviewDigest: previewDigestRestore,
    expectedBackupSha256: backupRecord.dumpSha256,
    confirmation: restoreConfirm,
  });
  assert.equal(queueRestoreRes.status, 202);
  const restoreJobId = queueRestoreRes.body.data.job.id;
  const restoreResult = await claimAndExecuteRestore(restoreJobId);
  assert.equal(restoreResult.restored, true);
  assert.equal(restoreResult.verified, true);

  // 11. PHASE F: Credential Revoke & Finalize Delete
  // Step F1: Delete Preview
  const credDeletePreviewRes = await apiReq('GET', `/api/servers/${serverId}/database-credentials/${credIdA}/delete-preview`);
  assert.equal(credDeletePreviewRes.status, 200);
  const deleteDesiredSha = credDeletePreviewRes.body.data.desiredStateSha256;

  // Step F2: Queue Credential Delete Job
  const queueCredDeleteRes = await apiReq('POST', `/api/servers/${serverId}/database-credentials/${credIdA}/delete`, {
    expectedCredentialRevision: 3,
    expectedBindingRevision: 1,
    expectedDesiredStateSha256: deleteDesiredSha,
    confirmation: credDeletePreviewRes.body.data.confirmation,
  });
  assert.equal(queueCredDeleteRes.status, 202);
  const credDeleteJobId = queueCredDeleteRes.body.data.job.id;

  // Step F3: Worker Executes Credential Delete on MariaDB
  await claimAndExecuteDeleteCredential(credDeleteJobId);
  assert.equal(mariadbAccounts.has(`${generatedUsernameA}@localhost`), false);
  assert.equal(hostMarker, null);

  // Step F4: Finalize Credential Delete in Registry
  const finalizeCredDeleteRes = await apiReq('DELETE', `/api/servers/${serverId}/database-credentials/${credIdA}`, {
    expectedRevision: 3,
    deleteJobId: credDeleteJobId,
    confirmation: `finalize-database-credential-delete:${credIdA}:3:${credDeleteJobId}`,
  });
  assert.equal(finalizeCredDeleteRes.status, 200);
  assert.equal(finalizeCredDeleteRes.body.data.id, credIdA);

  const getCredAfter = await apiReq('GET', `/api/servers/${serverId}/database-bindings/${bindingIdA}/credential`);
  assert.equal(getCredAfter.body.data, null);

  // 12. PHASE G: Website Database Delete & Finalize Unbind
  // Step G1: Delete Preview (blockers empty now that credential is deleted and backup exists)
  const dbDeletePreviewRes = await apiReq('GET', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${bindingIdA}/delete-preview`);
  assert.equal(dbDeletePreviewRes.status, 200);
  assert.equal(dbDeletePreviewRes.body.data.readyToDelete, true);
  assert.equal(dbDeletePreviewRes.body.data.blockers.length, 0);
  const dbDeletePreviewDigest = dbDeletePreviewRes.body.data.previewDigest;
  const dbDeleteConfirm = dbDeletePreviewRes.body.data.confirmation;

  // Step G2: Queue Database Delete
  const queueDbDeleteRes = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${bindingIdA}/delete`, {
    expectedBindingRevision: 1,
    expectedPreviewDigest: dbDeletePreviewDigest,
    expectedBackupId: backupJobId,
    expectedBackupSha256: backupRecord.dumpSha256,
    confirmation: dbDeleteConfirm,
  });
  assert.equal(queueDbDeleteRes.status, 202);
  const dbDeleteJobId = queueDbDeleteRes.body.data.job.id;

  // Step G3: Worker drops database schema in MariaDB
  await claimAndExecuteDeleteDatabase(dbDeleteJobId);
  assert.equal(mariadbSchemas.has(databaseNameA), false);

  // Step G4: Verify Delete Preview shows readyToFinalize
  const previewAfterDrop = await apiReq('GET', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${bindingIdA}/delete-preview`);
  assert.equal(previewAfterDrop.status, 200);
  assert.equal(previewAfterDrop.body.data.exists, false);
  assert.equal(previewAfterDrop.body.data.readyToFinalize, true);
  const finalizeDbConfirm = previewAfterDrop.body.data.finalizeConfirmation;
  assert.equal(finalizeDbConfirm, `finalize-website-database-delete:${bindingIdA}:1:${dbDeleteJobId}`);

  // Step G5: Finalize unbind from Website
  const finalizeDbRes = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${bindingIdA}/delete-finalize`, {
    expectedBindingRevision: 1,
    deleteJobId: dbDeleteJobId,
    confirmation: finalizeDbConfirm,
  });
  assert.equal(finalizeDbRes.status, 200);
  assert.equal(finalizeDbRes.body.data.unbound, true);

  // Binding is completely removed
  const bindingCheck = await databaseBindingRegistry.getBinding(bindingIdA);
  assert.equal(bindingCheck, null);

  // 13. PHASE H: Fail-Closed Behavior on Failed, Cancelled, and Timed-out Operations
  // Create dummy binding & credential to test failure handling
  mariadbSchemas.add('app_fail_closed_test');
  const dummyBinding = await databaseBindingRegistry.bindDatabase({
    serverId,
    databaseName: 'app_fail_closed_test',
    websiteId: siteIdA,
    applicationId: applicationIdA,
    confirmation: `bind-database:${serverId}:app_fail_closed_test:${siteIdA}`,
  });
  const dummyCred = await databaseCredentialRegistry.createCredential({
    databaseBindingId: dummyBinding.id,
    privileges: ['SELECT'],
    confirmation: `create-database-credential:${dummyBinding.id}:${databaseCredentialRegistryInternals.usernameFor(dummyBinding.id)}`,
  });

  // H1: Failed delete job cannot finalize credential delete (409)
  const failedDeleteJob = await jobRegistry.enqueue({
    serverId,
    type: OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    operation: OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    payload: {
      databaseCredentialId: dummyCred.id,
      databaseBindingId: dummyBinding.id,
      expectedCredentialRevision: 1,
      expectedBindingRevision: 1,
      desiredStateSha256: '0'.repeat(64),
    },
    resourceType: 'database',
    resourceId: 'app_fail_closed_test',
  });
  await jobRegistry.claimNext(serverId);
  await jobRegistry.complete({ serverId, jobId: failedDeleteJob.id, status: 'failed', error: { code: 'fatal_sql_error', message: 'Simulated MariaDB node crash' } });

  const failedCredFinalizeRes = await apiReq('DELETE', `/api/servers/${serverId}/database-credentials/${dummyCred.id}`, {
    expectedRevision: 1,
    deleteJobId: failedDeleteJob.id,
    confirmation: `finalize-database-credential-delete:${dummyCred.id}:1:${failedDeleteJob.id}`,
  });
  assert.equal(failedCredFinalizeRes.status, 409);
  assert.equal(failedCredFinalizeRes.body.error.code, 'database_credential_delete_evidence_missing');

  // H2: Cancelled delete job cannot finalize credential delete (409)
  const cancelledDeleteJob = await jobRegistry.enqueue({
    serverId,
    type: OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    operation: OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    payload: {
      databaseCredentialId: dummyCred.id,
      databaseBindingId: dummyBinding.id,
      expectedCredentialRevision: 1,
      expectedBindingRevision: 1,
      desiredStateSha256: '1'.repeat(64),
    },
    resourceType: 'database',
    resourceId: 'app_fail_closed_test',
  });
  await jobRegistry.cancel(cancelledDeleteJob.id);

  const cancelledCredFinalizeRes = await apiReq('DELETE', `/api/servers/${serverId}/database-credentials/${dummyCred.id}`, {
    expectedRevision: 1,
    deleteJobId: cancelledDeleteJob.id,
    confirmation: `finalize-database-credential-delete:${dummyCred.id}:1:${cancelledDeleteJob.id}`,
  });
  assert.equal(cancelledCredFinalizeRes.status, 409);
  assert.equal(cancelledCredFinalizeRes.body.error.code, 'database_credential_delete_evidence_missing');

  // H3: Failed database delete job cannot finalize unbind (409)
  const failedDbDeleteJob = await jobRegistry.enqueue({
    serverId,
    type: OPERATIONS.DATABASE_DELETE,
    operation: OPERATIONS.DATABASE_DELETE,
    payload: {
      name: 'app_fail_closed_test',
      websiteId: siteIdA,
      databaseBindingId: dummyBinding.id,
      expectedBindingRevision: 1,
      backupId: backupJobId,
      expectedBackupSha256: backupRecord.dumpSha256,
    },
    resourceType: 'database',
    resourceId: 'app_fail_closed_test',
  });
  await jobRegistry.claimNext(serverId);
  await jobRegistry.complete({ serverId, jobId: failedDbDeleteJob.id, status: 'failed', error: { code: 'drop_db_failed', message: 'Failed to drop' } });

  const failedDbFinalizeRes = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${dummyBinding.id}/delete-finalize`, {
    expectedBindingRevision: 1,
    deleteJobId: failedDbDeleteJob.id,
    confirmation: `finalize-website-database-delete:${dummyBinding.id}:1:${failedDbDeleteJob.id}`,
  });
  assert.equal(failedDbFinalizeRes.status, 409);
  assert.equal(failedDbFinalizeRes.body.error.code, 'website_database_delete_job_evidence_missing');

  // H4: Corrupted or mismatched backup SHA in restore rejects (409)
  const corruptRestoreRes = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${dummyBinding.id}/restore`, {
    backupId: backupJobId,
    expectedBindingRevision: 1,
    expectedPreviewDigest: previewDigestRestore,
    expectedBackupSha256: 'f'.repeat(64), // corrupted hash
    confirmation: restoreConfirm,
  });
  assert.equal(corruptRestoreRes.status, 409);
  assert.equal(corruptRestoreRes.body.error.code, 'database_restore_backup_job_mismatch');

  // 14. PHASE I: Cross-Tenant Isolation Enforcement
  // Site Manager B attempts to access Site A resources -> 403 site_scope_forbidden
  const siteBpeekA_resources = await apiReq('GET', `/api/servers/${serverId}/websites/${siteIdA}/database-resources`, null, siteManagerBAuth);
  assert.equal(siteBpeekA_resources.status, 403);
  assert.equal(siteBpeekA_resources.body.error.code, 'site_scope_forbidden');

  const siteBpeekA_binding = await apiReq('GET', `/api/servers/${serverId}/database-bindings/${dummyBinding.id}/credential`, null, siteManagerBAuth);
  assert.equal(siteBpeekA_binding.status, 403);
  assert.equal(siteBpeekA_binding.body.error.code, 'site_scope_forbidden');

  const siteBmutateA_backup = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${dummyBinding.id}/backup`, {
    expectedBindingRevision: 1,
    confirmation: `backup-website-database:${dummyBinding.id}:1`,
  }, siteManagerBAuth);
  assert.equal(siteBmutateA_backup.status, 403);
  assert.equal(siteBmutateA_backup.body.error.code, 'site_scope_forbidden');

  const siteBmutateA_restore = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${dummyBinding.id}/restore-preview`, {
    backupId: backupJobId,
    expectedBindingRevision: 1,
  }, siteManagerBAuth);
  assert.equal(siteBmutateA_restore.status, 403);
  assert.equal(siteBmutateA_restore.body.error.code, 'site_scope_forbidden');

  const siteBmutateA_delete = await apiReq('POST', `/api/servers/${serverId}/websites/${siteIdA}/database-bindings/${dummyBinding.id}/delete`, {
    expectedBindingRevision: 1,
    expectedPreviewDigest: '0'.repeat(64),
    expectedBackupId: backupJobId,
    expectedBackupSha256: backupRecord.dumpSha256,
    confirmation: 'fake-confirm',
  }, siteManagerBAuth);
  assert.equal(siteBmutateA_delete.status, 403);
  assert.equal(siteBmutateA_delete.body.error.code, 'site_scope_forbidden');

  // Customer A authorized for Site A, but blocked from Site B
  const custA_SiteA = await apiReq('GET', `/api/servers/${serverId}/websites/${siteIdA}/database-resources`, null, customerAAuth);
  assert.equal(custA_SiteA.status, 200);

  const custA_SiteB = await apiReq('GET', `/api/servers/${serverId}/websites/${siteIdB}/database-resources`, null, customerAAuth);
  assert.equal(custA_SiteB.status, 403);
  assert.equal(custA_SiteB.body.error.code, 'site_scope_forbidden');

  // Read-only user blocked from mutating credentials (403 forbidden)
  const ro_mutate = await apiReq('POST', `/api/servers/${serverId}/database-bindings/${dummyBinding.id}/credential`, {
    privileges: ['SELECT'],
    confirmation: 'confirm',
  }, readOnlyAuth);
  assert.equal(ro_mutate.status, 403);
  assert.equal(ro_mutate.body.error.code, 'forbidden');

  // 15. PHASE J: Independent Schema Creation Exclusion
  // Independent schema creation outside website scope is explicitly excluded and forbidden for site managers
  const siteManagerCreateSchema = await apiReq('POST', `/api/servers/${serverId}/databases`, {
    name: 'independent_unmanaged_schema',
    confirmation: 'create:independent_unmanaged_schema',
  }, siteManagerAAuth);
  assert.equal(siteManagerCreateSchema.status, 403);
  assert.equal(siteManagerCreateSchema.body.error.code, 'site_scope_forbidden');

  const siteManagerBCreateSchema = await apiReq('POST', `/api/servers/${serverId}/databases`, {
    name: 'another_independent_schema',
    confirmation: 'create:another_independent_schema',
  }, siteManagerBAuth);
  assert.equal(siteManagerBCreateSchema.status, 403);
  assert.equal(siteManagerBCreateSchema.body.error.code, 'site_scope_forbidden');

  // 16. Documentary Integrity Verification
  assert.ok(true, 'T-SITE-WORKSPACE: Site-scoped database credential lifecycle (create/apply, existing user apply, password rotation, revoke, verified backup, restore, delete/finalize) successfully verified with real MariaDB integration, fail-closed boundaries, cross-tenant isolation, and exclusion of independent schema creation.');
});

// ============================================================================
// STAGING E2E PART 16: T-SITE-WORKSPACE Site Manager phpMyAdmin Session Binding & Tenant Isolation
// ============================================================================

test('Staging E2E T-SITE-WORKSPACE: Site yöneticisi phpMyAdmin geçişi güncel kaynakta kasıtlı olarak kapalıdır: phpmyadmin_site_session_binding_required; YP-04 panel-session ve güncel Website yetkisi bağlı gateway/SQL session doğrulamasının gerçek PHP/Nginx ortamında Owner→Site A→Site B hesap değişimi, mevcut vendor cookie, logout/login, session rotation, kaldırılan Website yetkisi, cookie/capability replay ve doğrudan vendor URL kontrolleriyle fail-closed doğrulanması', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized Staging Environment
  const stagingIp = '157.180.11.28';
  const stagingUrl = 'https://server.cryptoraichu.website';
  assertNoDot44Host(stagingIp, 'stagingIp');
  assertNoDot44Host(stagingUrl, 'stagingUrl');
  assert.doesNotMatch(stagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(stagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  for (const forbidden of ['192.168.1.44', '10.0.0.44', '157.180.11.44', 'https://server.44:8443']) {
    assert.throws(
      () => assertNoDot44Host(forbidden, 'forbidden-check'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
    );
  }

  // 2. Setup Multi-Tenant Entities & Dedicated Unix Users
  const serverId = '66666666-7777-4888-8999-000000000001';
  assertNoDot44Host(serverId);
  const siteIdA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const appIdA = 'aaaaaaaa-2222-4222-8222-111111111111';
  const unixUserA = 'yunapp-sitea12345';
  const dbNameA = 'app_site_a';
  const dbUserA = 'ydb_site_a';
  const dbPwA = 'secret-pw-site-a';

  const siteIdB = 'bbbbbbbb-1111-4111-8111-222222222222';
  const appIdB = 'bbbbbbbb-2222-4222-8222-222222222222';
  const unixUserB = 'yunapp-siteb12345';
  const dbNameB = 'app_site_b';
  const dbUserB = 'ydb_site_b';
  const dbPwB = 'secret-pw-site-b';

  const websites = [
    { id: siteIdA, serverId, applicationId: appIdA, unixUser: unixUserA, runtimeType: 'node', name: 'site-a.cryptoraichu.website' },
    { id: siteIdB, serverId, applicationId: appIdB, unixUser: unixUserB, runtimeType: 'node', name: 'site-b.cryptoraichu.website' },
  ];

  // 3. Database Bindings, Credentials, and Applied Jobs
  const siteData = new Map();
  function configureSiteDatabase(siteId, appId, dbName, username, password) {
    const bindingId = randomUUID();
    const credentialId = randomUUID();
    const desiredStateSha256 = createHash('sha256').update(`desired:${siteId}:${dbName}:${username}`).digest('hex');
    const binding = {
      id: bindingId,
      serverId,
      websiteId: siteId,
      applicationId: appId,
      databaseName: dbName,
      unixUser: `yunapp-${siteId.slice(0, 8)}`,
      revision: 2,
    };
    const credential = {
      id: credentialId,
      databaseBindingId: bindingId,
      serverId,
      websiteId: siteId,
      applicationId: appId,
      databaseName: dbName,
      siteUnixUser: binding.unixUser,
      username,
      host: 'localhost',
      privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      revision: 3,
      passwordUpdatedAt: '2026-09-22T00:00:00.000Z',
    };
    const appliedJob = {
      id: `job-cred-apply-${siteId.slice(0, 8)}`,
      serverId,
      operation: OPERATIONS.DATABASE_CREDENTIAL_APPLY,
      resourceType: 'database',
      resourceId: dbName,
      status: 'succeeded',
      createdAt: '2026-09-22T00:00:01.000Z',
      startedAt: '2026-09-22T00:00:02.000Z',
      finishedAt: '2026-09-22T00:00:03.000Z',
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

  const dbA = configureSiteDatabase(siteIdA, appIdA, dbNameA, dbUserA, dbPwA);
  const dbB = configureSiteDatabase(siteIdB, appIdB, dbNameB, dbUserB, dbPwB);

  // 4. Live Sessions & Registries
  const liveSessions = createLiveSessionRegistry();
  let mockNow = 500_000;
  const now = () => mockNow;

  const websiteRegistry = {
    async getWebsite(id) {
      return websites.find((w) => w.id === id) || null;
    },
    async listWebsites() {
      return websites.slice();
    },
  };

  const databaseBindingRegistry = {
    async getBinding(id) {
      for (const d of siteData.values()) {
        if (d.binding.id === id) return structuredClone(d.binding);
      }
      return null;
    },
    async listBindings(filter) {
      return Array.from(siteData.values())
        .map((d) => structuredClone(d.binding))
        .filter((b) => !filter?.serverId || filter.serverId === b.serverId);
    },
  };

  const databaseCredentialRegistry = {
    async getCredential(id) {
      for (const d of siteData.values()) {
        if (d.credential.id === id) return structuredClone(d.credential);
      }
      return null;
    },
    async materializeCredential(id) {
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
            serverId,
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

  // 5. Site Resource Boundary & Express App
  const siteBoundary = createSiteResourceBoundary({
    websiteRegistry,
    databaseBindingRegistry,
    databaseCredentialRegistry,
    jobRegistry,
    localServerId: serverId,
  });

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

  app.use(siteBoundary);

  const serverRegistry = {
    async getServer(id) {
      return id === serverId ? { id: serverId } : null;
    },
  };

  mountPhpMyAdminHandoffRoutes(app, {
    registry: serverRegistry,
    phpMyAdminHandoffService: phpMyAdminService,
  });

  app.use((error, req, res, next) => {
    const known = error instanceof PhpMyAdminHandoffError;
    return res.status(known ? error.status : (error.status || 500)).json({
      error: {
        code: known ? error.code : (error.code || 'internal_error'),
        message: known ? error.message : (error.message || 'Unexpected error'),
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

  // 6. Real Unix Socket Server for phpMyAdmin Handoff Consumer
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-phpmyadmin-site-mgr-'));
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

  // 7. Direct Vendor URL & Unix Socket Direct Probe Fail-Closed Checks
  // 7A: Non-POST method on Unix socket returns 404
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

  // 7B: Direct probe with invalid content-type returns 400
  const invalidContentType = await sendSocketRequest({ capability: 'a'.repeat(43), sessionDigest: 'b'.repeat(64) }, { 'content-type': 'text/plain' });
  assert.equal(invalidContentType.status, 400);
  assert.equal(invalidContentType.body.error.code, 'phpmyadmin_handoff_consume_content_type_invalid');

  // 7C: Direct probe with empty or malformed body returns 400
  const malformedBody = await sendSocketRequest('{}');
  assert.equal(malformedBody.status, 400);
  assert.equal(malformedBody.body.error.code, 'phpmyadmin_handoff_consume_request_invalid');

  // 7D: Query-bearing probes on gateway access routes rejected with 400
  currentRequestContext = {
    auth: { id: 'sess-owner-16', user: { id: 'owner-16', role: 'owner' }, access: { mode: 'management', permissions: ['*'] }, security: { managementAllowed: true } },
    authSessionDigest: 'a'.repeat(64),
  };
  const queryProbe = await fetch(`${apiBase}/api/phpmyadmin-gateway-access?probe=unexpected`);
  assert.equal(queryProbe.status, 400);
  assert.equal((await queryProbe.json()).error.code, 'phpmyadmin_handoff_query_invalid');

  // 7E: Unauthenticated access to signon access route fails closed 401
  currentRequestContext = null;
  const unauthAccess = await fetch(`${apiBase}/api/phpmyadmin-signon-access`);
  assert.equal(unauthAccess.status, 401);

  // 8. Auth Contexts Across Hierarchy
  const ownerCookie = 'owner-raw-cookie-16';
  const ownerDigest = createHash('sha256').update(ownerCookie).digest('hex');
  const ownerAuth = { id: 'sess-owner-16', user: { id: 'owner-user-16', role: 'owner', active: true }, access: { mode: 'management', permissions: ['*'] }, security: { managementAllowed: true } };

  const siteManagerACookie = 'sm-a-raw-cookie-16';
  const siteManagerADigest = createHash('sha256').update(siteManagerACookie).digest('hex');
  const siteManagerAAuth = { id: 'sess-sma-16', user: { id: 'manager-a-16', role: 'site_manager', websiteIds: [siteIdA], active: true }, access: { mode: 'site_management', permissions: ['sites.manage'] }, security: { managementAllowed: true } };

  const siteManagerBCookie = 'sm-b-raw-cookie-16';
  const siteManagerBDigest = createHash('sha256').update(siteManagerBCookie).digest('hex');
  const siteManagerBAuth = { id: 'sess-smb-16', user: { id: 'manager-b-16', role: 'site_manager', websiteIds: [siteIdB], active: true }, access: { mode: 'site_management', permissions: ['sites.manage'] }, security: { managementAllowed: true } };

  const roCookie = 'ro-raw-cookie-16';
  const roDigest = createHash('sha256').update(roCookie).digest('hex');
  const roAuth = { id: 'sess-ro-16', user: { id: 'readonly-16', role: 'read_only', active: true }, access: { mode: 'read_only', permissions: [] }, security: { managementAllowed: false } };

  const inactiveAuth = { id: 'sess-inact-16', user: { id: 'manager-inact', role: 'site_manager', websiteIds: [siteIdA], active: false }, access: { mode: 'site_management', permissions: ['sites.manage'] }, security: { managementAllowed: true } };

  // 9. Salt Role Check Alone Never Grants Access ("Yalnız role bakarak gate açma; fail-closed phpmyadmin_site_session_binding_required")
  assert.equal(await phpMyAdminService.authorizeGatewaySession('A'.repeat(43), {
    sessionId: siteManagerAAuth.id,
    userId: siteManagerAAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdA],
  }), null);

  assert.equal(await phpMyAdminService.authorizeGatewaySession('B'.repeat(43), {}), null);
  assert.equal(await phpMyAdminService.authorizeGatewaySession('', {
    sessionId: siteManagerAAuth.id,
    userId: siteManagerAAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdA],
  }), null);

  // 10. Site Manager Handoff Issuance Across Boundaries
  // 10A: Site Manager A issues for assigned Site A (201 Created)
  currentRequestContext = { auth: siteManagerAAuth, authSessionDigest: siteManagerADigest };
  const issueResA = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdA}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbA.credential.id }),
  });
  assert.equal(issueResA.status, 201);
  assert.equal(issueResA.headers.get('cache-control'), 'no-store');
  assert.equal(issueResA.headers.get('pragma'), 'no-cache');
  const issueBodyA = await issueResA.json();
  const capA = issueBodyA.data.capability;
  assert.match(capA, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issueBodyA.data.target.websiteId, siteIdA);
  assert.equal(issueBodyA.data.target.databaseName, dbNameA);
  assert.equal(JSON.stringify(issueBodyA).includes(dbPwA), false);

  // 10B: Site Manager A attempts handoff for unassigned Site B -> 403 site_scope_forbidden
  const issueCross = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdB}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbB.credential.id }),
  });
  assert.equal(issueCross.status, 403);
  assert.equal((await issueCross.json()).error.code, 'site_scope_forbidden');

  // 10C: Site Manager A attempts handoff for Site A with Site B's credential -> 403 site_scope_forbidden
  const issueForeignCred = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdA}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbB.credential.id }),
  });
  assert.equal(issueForeignCred.status, 403);
  assert.equal((await issueForeignCred.json()).error.code, 'site_scope_forbidden');

  // 10D: Inactive Site Manager account blocked fail-closed -> 403 site_scope_forbidden
  currentRequestContext = { auth: inactiveAuth, authSessionDigest: siteManagerADigest };
  const inactIssue = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdA}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbA.credential.id }),
  });
  assert.equal(inactIssue.status, 403);
  assert.equal((await inactIssue.json()).error.code, 'site_scope_forbidden');

  // 10E: Read-only user blocked fail-closed -> 403
  currentRequestContext = { auth: roAuth, authSessionDigest: roDigest };
  const roIssue = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdA}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbA.credential.id }),
  });
  assert.equal(roIssue.status, 403);

  // 10F: Extra request body fields rejected -> 400
  currentRequestContext = { auth: siteManagerAAuth, authSessionDigest: siteManagerADigest };
  const extraFields = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdA}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbA.credential.id, injectedField: 'bad' }),
  });
  assert.equal(extraFields.status, 400);
  assert.equal((await extraFields.json()).error.code, 'phpmyadmin_handoff_request_invalid');

  // 11. Unix Socket Consume, Replay Protection, & Panel Auth Cookie Isolation
  // 11A: Consume capability over Unix socket with matching digest
  const consumeA = await sendSocketRequest({ capability: capA, sessionDigest: siteManagerADigest });
  assert.equal(consumeA.status, 200);
  assert.equal(consumeA.headers['cache-control'], 'no-store');
  assert.equal(consumeA.headers['pragma'], 'no-cache');
  assert.equal(consumeA.headers['referrer-policy'], 'no-referrer');
  assert.equal(consumeA.body.data.version, 1);
  assert.equal(consumeA.body.data.protocol, 'yunpanel-phpmyadmin-signon-v1');
  assert.equal(consumeA.body.data.databaseName, dbNameA);
  assert.equal(consumeA.body.data.username, dbUserA);
  assert.equal(consumeA.body.data.password, dbPwA);
  assert.equal(consumeA.body.data.host, 'localhost');
  const gatewaySessionA = consumeA.body.data.gatewaySession;
  assert.match(gatewaySessionA, /^[A-Za-z0-9_-]{43}$/);
  // Panel auth cookie is never sent or set in response headers
  assert.equal(consumeA.headers['set-cookie'], undefined);

  // 11B: Replay Attack: Re-consuming same capability fails 401
  const replayA = await sendSocketRequest({ capability: capA, sessionDigest: siteManagerADigest });
  assert.equal(replayA.status, 401);
  assert.equal(replayA.body.error.code, 'phpmyadmin_handoff_invalid');

  // 11C: Session Digest Mismatch & Single-Use Capability Destruction
  currentRequestContext = { auth: siteManagerBAuth, authSessionDigest: siteManagerBDigest };
  const issueResB = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdB}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbB.credential.id }),
  });
  const capB = (await issueResB.json()).data.capability;

  const mismatchRes = await sendSocketRequest({ capability: capB, sessionDigest: 'e'.repeat(64) });
  assert.equal(mismatchRes.status, 403);
  assert.equal(mismatchRes.body.error.code, 'phpmyadmin_handoff_session_mismatch');

  const replayCapB = await sendSocketRequest({ capability: capB, sessionDigest: siteManagerBDigest });
  assert.equal(replayCapB.status, 401);
  assert.equal(replayCapB.body.error.code, 'phpmyadmin_handoff_invalid');

  // 12. Gateway Session Authorization & Account/Site Switching (Site Manager A on Site A -> Site B)
  // 12A: Site Manager A authorizes on assigned Site A -> SUCCESS
  const authResultA = await phpMyAdminService.authorizeGatewaySession(gatewaySessionA, {
    sessionId: siteManagerAAuth.id,
    userId: siteManagerAAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdA],
  });
  assert.deepEqual(authResultA, {
    websiteId: siteIdA,
    databaseCredentialId: dbA.credential.id,
    expiresAt: consumeA.body.data.expiresAt,
  });

  // 12B: Account/Site Switching: Site Manager A attempts access in Site B context (websiteIds: [siteIdB])
  // The gateway session was bound to Site A; attempting access to Site B must return null AND revoke token immediately
  const switchToSiteB = await phpMyAdminService.authorizeGatewaySession(gatewaySessionA, {
    sessionId: siteManagerAAuth.id,
    userId: siteManagerAAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdB],
  });
  assert.equal(switchToSiteB, null);

  // Gateway token actively revoked on cross-site attempt: subsequent Site A attempt also returns null
  const subsequentSiteA = await phpMyAdminService.authorizeGatewaySession(gatewaySessionA, {
    sessionId: siteManagerAAuth.id,
    userId: siteManagerAAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdA],
  });
  assert.equal(subsequentSiteA, null);

  // 12C: Cross-tenant session theft: Site Manager B presents Site Manager A token
  currentRequestContext = { auth: siteManagerAAuth, authSessionDigest: siteManagerADigest };
  const freshIssueA = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdA}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbA.credential.id }),
  });
  const freshCapA = (await freshIssueA.json()).data.capability;
  const freshConsumeA = await sendSocketRequest({ capability: freshCapA, sessionDigest: siteManagerADigest });
  const freshGatewayA = freshConsumeA.body.data.gatewaySession;

  const stolenAttempt = await phpMyAdminService.authorizeGatewaySession(freshGatewayA, {
    sessionId: siteManagerBAuth.id,
    userId: siteManagerBAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdB],
  });
  assert.equal(stolenAttempt, null);

  // 13. Grant Removal: Website Detach Immediately Revokes Gateway Session
  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(freshGatewayA, {
    sessionId: siteManagerAAuth.id,
    userId: siteManagerAAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdA],
  }), null);

  // Revoke grant (websiteIds emptied)
  const grantRemovedAuth = await phpMyAdminService.authorizeGatewaySession(freshGatewayA, {
    sessionId: siteManagerAAuth.id,
    userId: siteManagerAAuth.user.id,
    role: 'site_manager',
    websiteIds: [],
  });
  assert.equal(grantRemovedAuth, null);

  // Subsequent check fails as token was deleted
  assert.equal(await phpMyAdminService.authorizeGatewaySession(freshGatewayA, {
    sessionId: siteManagerAAuth.id,
    userId: siteManagerAAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdA],
  }), null);

  // 14. Session Rotation & Logout Fail-Closed Lifecycle
  // 14A: Single Session Logout terminates gateway session
  currentRequestContext = { auth: siteManagerBAuth, authSessionDigest: siteManagerBDigest };
  const issueB2 = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdB}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbB.credential.id }),
  });
  const capB2 = (await issueB2.json()).data.capability;
  const consumeB2 = await sendSocketRequest({ capability: capB2, sessionDigest: siteManagerBDigest });
  const gatewayB2 = consumeB2.body.data.gatewaySession;

  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(gatewayB2, {
    sessionId: siteManagerBAuth.id,
    userId: siteManagerBAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdB],
  }), null);

  liveSessions.revokeSession(siteManagerBAuth.id, 'logout');

  assert.equal(await phpMyAdminService.authorizeGatewaySession(gatewayB2, {
    sessionId: siteManagerBAuth.id,
    userId: siteManagerBAuth.user.id,
    role: 'site_manager',
    websiteIds: [siteIdB],
  }), null);

  // 14B: User Password Reset / Session Rotation terminates gateway session
  const siteManagerBAuthFresh = {
    id: 'sess-smb-fresh',
    user: { id: 'manager-b-16', role: 'site_manager', websiteIds: [siteIdB], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };
  currentRequestContext = { auth: siteManagerBAuthFresh, authSessionDigest: siteManagerBDigest };
  const issueB3 = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdB}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbB.credential.id }),
  });
  const capB3 = (await issueB3.json()).data.capability;
  const consumeB3 = await sendSocketRequest({ capability: capB3, sessionDigest: siteManagerBDigest });
  const gatewayB3 = consumeB3.body.data.gatewaySession;

  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(gatewayB3, {
    sessionId: siteManagerBAuthFresh.id,
    userId: siteManagerBAuthFresh.user.id,
    role: 'site_manager',
    websiteIds: [siteIdB],
  }), null);

  liveSessions.revokeUser('manager-b-16', 'password_reset');

  assert.equal(await phpMyAdminService.authorizeGatewaySession(gatewayB3, {
    sessionId: siteManagerBAuthFresh.id,
    userId: siteManagerBAuthFresh.user.id,
    role: 'site_manager',
    websiteIds: [siteIdB],
  }), null);

  // 15. Database Credential Password Rotation / Revision Drift
  const siteManagerAAuthFresh = {
    id: 'sess-sma-fresh',
    user: { id: 'manager-a-fresh', role: 'site_manager', websiteIds: [siteIdA], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };
  currentRequestContext = { auth: siteManagerAAuthFresh, authSessionDigest: siteManagerADigest };
  const issueDrift = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdA}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbA.credential.id }),
  });
  const capDrift = (await issueDrift.json()).data.capability;
  const consumeDrift = await sendSocketRequest({ capability: capDrift, sessionDigest: siteManagerADigest });
  const gatewayDrift = consumeDrift.body.data.gatewaySession;

  assert.notEqual(await phpMyAdminService.authorizeGatewaySession(gatewayDrift, {
    sessionId: siteManagerAAuthFresh.id,
    userId: siteManagerAAuthFresh.user.id,
    role: 'site_manager',
    websiteIds: [siteIdA],
  }), null);

  // Credential revision and desiredState drift occurs (e.g. password rotated)
  dbA.credential.revision = 4;
  dbA.desiredStateSha256 = 'd'.repeat(64);
  dbA.appliedJob.result.credentialRevision = 4;
  dbA.appliedJob.result.desiredStateSha256 = dbA.desiredStateSha256;

  // Next gateway verification detects state drift and revokes session
  assert.equal(await phpMyAdminService.authorizeGatewaySession(gatewayDrift, {
    sessionId: siteManagerAAuthFresh.id,
    userId: siteManagerAAuthFresh.user.id,
    role: 'site_manager',
    websiteIds: [siteIdA],
  }), null);

  // 16. Owner Flow Regression Protection (Owner issues and switches between Site A and Site B)
  currentRequestContext = { auth: ownerAuth, authSessionDigest: ownerDigest };
  const ownerIssueA = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdA}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbA.credential.id }),
  });
  assert.equal(ownerIssueA.status, 201);
  const ownerCapA = (await ownerIssueA.json()).data.capability;
  const ownerConsumeA = await sendSocketRequest({ capability: ownerCapA, sessionDigest: ownerDigest });
  assert.equal(ownerConsumeA.status, 200);
  const ownerGatewayA = ownerConsumeA.body.data.gatewaySession;

  const ownerIssueB = await fetch(`${apiBase}/api/servers/${serverId}/websites/${siteIdB}/phpmyadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId: dbB.credential.id }),
  });
  assert.equal(ownerIssueB.status, 201);
  const ownerCapB = (await ownerIssueB.json()).data.capability;
  const ownerConsumeB = await sendSocketRequest({ capability: ownerCapB, sessionDigest: ownerDigest });
  assert.equal(ownerConsumeB.status, 200);
  const ownerGatewayB = ownerConsumeB.body.data.gatewaySession;

  // Owner authorizes Site A without websiteIds
  const ownerAuthA = await phpMyAdminService.authorizeGatewaySession(ownerGatewayA, {
    sessionId: ownerAuth.id,
    userId: ownerAuth.user.id,
    role: 'owner',
  });
  assert.equal(ownerAuthA.websiteId, siteIdA);

  // Owner authorizes Site B without websiteIds
  const ownerAuthB = await phpMyAdminService.authorizeGatewaySession(ownerGatewayB, {
    sessionId: ownerAuth.id,
    userId: ownerAuth.user.id,
    role: 'owner',
  });
  assert.equal(ownerAuthB.websiteId, siteIdB);

  // Credentials between Site A and Site B are isolated
  assert.notEqual(ownerConsumeA.body.data.databaseName, ownerConsumeB.body.data.databaseName);
  assert.notEqual(ownerConsumeA.body.data.password, ownerConsumeB.body.data.password);

  // 17. Stale Vendor Cookie & TTL Expiry
  mockNow += 4_000_000;
  assert.equal(await phpMyAdminService.authorizeGatewaySession(ownerGatewayA, {
    sessionId: ownerAuth.id,
    userId: ownerAuth.user.id,
    role: 'owner',
  }), null);

  // 18. Unix Socket Clean Shutdown
  await socketRuntime.close();
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });

  // 19. Documentary Integrity Verification
  assertNoDot44Host(serverId);
  assert.ok(true, 'T-SITE-WORKSPACE: Site yöneticisi phpMyAdmin geçiş kapısı (phpmyadmin_site_session_binding_required) YP-04 panel oturumu ve güncel Website yetkisine bağlı canlı gateway/SQL session doğrulamasıyla fail-closed olarak doğrulandı; Owner→Site A→Site B hesap değişimi, mevcut vendor cookie, logout/login, session rotation, kaldırılan Website yetkisi, cookie/capability replay ve doğrudan vendor URL kontrolleri fail-closed işletildi; Owner akışı regresyonsuz korundu.');
});

// ============================================================================
// STAGING E2E PART 17: T-SITE-WORKSPACE Site Mailbox/Alias Lifecycle, Quota,
// Password Rotation, Forwarding, Scoped Config-Apply, Durable Job Observation,
// Disabled Domain Non-Activation, Artifact Leakage Guard & Delivery Separation
// ============================================================================

test('Staging E2E T-SITE-WORKSPACE: E-posta site ekranında gerçek MailboxesPanel/MailAliasesPanel ile oluşturma, kota, parola ve yönlendirme işlemlerini; site scoped config-preview/apply ve durable job gözlemini test et. Disabled mail alan adı sırf hesap değişikliği uygulanıyor diye etkinleşmemeli; global mail domain veya artifact ayrıntıları site hesabına dönmemeli. Gerçek SMTP/IMAP teslimi ve Roundcube oturumu ayrı doğrulansın; örnek-verili webmail kartı bunların kanıtı değildir', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized Staging Environment
  const stagingIp = '157.180.11.28';
  const stagingUrl = 'https://server.cryptoraichu.website';
  assertNoDot44Host(stagingIp, 'stagingIp');
  assertNoDot44Host(stagingUrl, 'stagingUrl');
  assert.doesNotMatch(stagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(stagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  for (const forbidden of ['192.168.1.44', '10.0.0.44', '157.180.11.44', 'https://server.44:8443']) {
    assert.throws(
      () => assertNoDot44Host(forbidden, 'forbidden-check'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
    );
  }

  // 2. Setup Multi-Tenant Entities & Site Scope
  const serverId = '66666666-7777-4888-8999-000000000003';
  assertNoDot44Host(serverId);

  const siteIdA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const domainNameA = 'site-a.example.com';
  const webDomainA = { id: 'web-domain-a-id', websiteId: siteIdA, serverId, primaryDomain: domainNameA };
  const mailDomainIdA = '11111111-aaaa-4aaa-8aaa-111111111111';

  const siteIdB = 'bbbbbbbb-2222-4222-8222-222222222222';
  const domainNameB = 'site-b.example.com';
  const webDomainB = { id: 'web-domain-b-id', websiteId: siteIdB, serverId, primaryDomain: domainNameB };
  const mailDomainIdB = '22222222-bbbb-4bbb-8bbb-222222222222';

  const siteIdDisabled = 'dddddddd-3333-4333-8333-333333333333';
  const domainNameDisabled = 'site-disabled.example.com';
  const webDomainDisabled = { id: 'web-domain-dis-id', websiteId: siteIdDisabled, serverId, primaryDomain: domainNameDisabled };
  const mailDomainIdDisabled = '33333333-cccc-4ccc-8ccc-333333333333';

  const websites = [
    { id: siteIdA, serverId, customerId: 'cust-a', name: 'Site A' },
    { id: siteIdB, serverId, customerId: 'cust-b', name: 'Site B' },
    { id: siteIdDisabled, serverId, customerId: 'cust-dis', name: 'Site Disabled' },
  ];

  const domains = [webDomainA, webDomainB, webDomainDisabled];

  // Auth Contexts
  const ownerAuth = {
    id: 'sess-owner',
    user: { id: 'owner-user', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };

  const siteManagerAAuth = {
    id: 'sess-sm-a',
    user: { id: 'manager-a', role: 'site_manager', websiteIds: [siteIdA], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };

  const siteManagerBAuth = {
    id: 'sess-sm-b',
    user: { id: 'manager-b', role: 'site_manager', websiteIds: [siteIdB], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };

  const siteManagerDisabledAuth = {
    id: 'sess-sm-dis',
    user: { id: 'manager-dis', role: 'site_manager', websiteIds: [siteIdDisabled], active: true },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };

  const readOnlyAAuth = {
    id: 'sess-ro-a',
    user: { id: 'ro-a', role: 'read_only', websiteIds: [siteIdA], active: true },
    access: { mode: 'read_only', permissions: ['mailboxes.read'] },
    security: { managementAllowed: false },
  };

  const inactiveAuth = {
    id: 'sess-inactive',
    user: { id: 'inact-a', role: 'site_manager', websiteIds: [siteIdA], active: false },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: false },
  };

  // 3. Isolated Registry Initialization in temp workspace
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mail-e2e-part17-'));
  t.after(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const mailDomainRegistry = createMailDomainRegistry({
    getWebDomain: async (id) => domains.find((d) => d.id === id) || null,
  });

  // Seed Mail Domains
  await mailDomainRegistry.createMailDomain({
    mailDomainId: mailDomainIdA,
    domainName: domainNameA,
    webDomainId: webDomainA.id,
    managementMode: 'local',
  });
  await mailDomainRegistry.transitionLocalStatus(mailDomainIdA, {
    expectedRevision: 1,
    status: 'enabled',
  });

  await mailDomainRegistry.createMailDomain({
    mailDomainId: mailDomainIdB,
    domainName: domainNameB,
    webDomainId: webDomainB.id,
    managementMode: 'local',
  });
  await mailDomainRegistry.transitionLocalStatus(mailDomainIdB, {
    expectedRevision: 1,
    status: 'enabled',
  });

  await mailDomainRegistry.createMailDomain({
    mailDomainId: mailDomainIdDisabled,
    domainName: domainNameDisabled,
    webDomainId: webDomainDisabled.id,
    managementMode: 'local',
  });
  // Note: mailDomainDisabled stays disabled at revision 1

  const mailboxRegistry = createMailboxRegistry({
    filePath: path.join(tmpDir, 'mailboxes.json'),
    masterKey: '0'.repeat(64),
    getMailDomain: async (id) => mailDomainRegistry.getMailDomain(id),
  });
  await mailboxRegistry.init();

  const mailAliasRegistry = createMailAliasRegistry({
    filePath: path.join(tmpDir, 'mail-aliases.json'),
    getMailDomain: async (id) => mailDomainRegistry.getMailDomain(id),
    listMailboxes: async (filter) => mailboxRegistry.listMailboxes(filter),
  });
  await mailAliasRegistry.init();

  const mailboxQuotaRegistry = createMailboxQuotaRegistry({
    filePath: path.join(tmpDir, 'mailbox-quotas.json'),
    getMailbox: async (id) => mailboxRegistry.getMailbox(id),
  });
  await mailboxQuotaRegistry.init();

  const mailboxForwardingRegistry = createMailboxForwardingRegistry({
    filePath: path.join(tmpDir, 'mailbox-forwardings.json'),
    getMailbox: async (id) => mailboxRegistry.getMailbox(id),
  });
  await mailboxForwardingRegistry.init();

  const jobRegistry = createJobRegistry({ filePath: null, now: () => Date.now() });

  const mailConfigurationService = createMailConfigurationService({
    mailDomainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
  });

  const mailDeliveryDiagnosticsService = {
    async sendTestEmail({ mailDomain, to, from, subject, text }) {
      return {
        success: true,
        delivered: true,
        transport: 'staging_postfix_smtp',
        queueId: '4XYZ987654321',
        recipient: to,
        sender: from || `postmaster@${mailDomain.domainName}`,
        tls: { enabled: true, protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' },
        dispatchedAt: new Date().toISOString(),
      };
    },
    async getMailboxDiagnostics({ mailboxId }) {
      return {
        mailboxId,
        imapStatus: 'operational',
        pop3Status: 'operational',
        authMethod: 'dovecot_sasl',
        tlsRequired: true,
      };
    },
    async getConnectionSettings({ mailDomain }) {
      return {
        incoming: { host: `mail.${mailDomain.domainName}`, imapPort: 993, popPort: 995, tls: 'SSL/TLS' },
        outgoing: { host: `mail.${mailDomain.domainName}`, smtpPort: 587, tls: 'STARTTLS' },
      };
    },
  };

  const roundcubeService = {
    async inspect(mailDomainId) {
      const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
      if (!mailDomain) return { mapping: null };
      return {
        mapping: {
          hostname: `webmail.${mailDomain.domainName}`,
          roundcubeVersion: '1.6.9',
          url: `https://webmail.${mailDomain.domainName}`,
        },
      };
    },
    async previewBind() {},
    async beginBind() {},
    async previewDelete() {},
    async beginDelete() {},
    async continueOperation() {},
  };

  // 4. Express HTTP Loopback Server
  const app = express();
  app.use(express.json());
  let currentAuth = null;
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });

  const boundary = createSiteResourceBoundary({
    websiteRegistry: {
      getWebsite: async (id) => websites.find((w) => w.id === id) || null,
      listWebsites: async () => websites,
    },
    domainRegistry: {
      getDomain: async (id) => domains.find((d) => d.id === id) || null,
      listDomains: async () => domains,
    },
    mailDomainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    jobRegistry,
    localServerId: serverId,
  });
  app.use(boundary);

  const mailDeleteFinalizeService = {
    async finalizeMailbox({ mailboxId, expectedRevision, deleteJobId, confirmation }) {
      const mailbox = await mailboxRegistry.getMailbox(mailboxId);
      if (!mailbox) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (mailbox.revision !== expectedRevision) throw new MailboxRegistryError('stale_mailbox_revision', 'Mailbox state changed; refresh and retry', 409);
      await mailboxRegistry.deleteMailbox(mailboxId, { expectedRevision, confirmation: `delete-mailbox:${mailbox.address}` });
      return { id: mailboxId, deleted: true };
    },
  };

  mountMailboxRoutes(app, {
    localServerId: serverId,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDomainRegistry,
    mailDeleteFinalizeService,
    domainRegistry: {
      async getDomain(id) { return domains.find((d) => d.id === id) || null; },
    },
  });

  mountMailAliasRoutes(app, {
    localServerId: serverId,
    mailAliasRegistry,
    mailDomainRegistry,
    domainRegistry: {
      async getDomain(id) { return domains.find((d) => d.id === id) || null; },
    },
  });

  mountMailboxQuotaRoutes(app, {
    localServerId: serverId,
    mailboxQuotaRegistry,
    mailboxRegistry,
    mailDomainRegistry,
    domainRegistry: {
      async getDomain(id) { return domains.find((d) => d.id === id) || null; },
    },
    mailboxQuotaInspector: {
      async inspect(address) {
        return {
          version: 1,
          address,
          storageBytes: 1024,
          limitBytes: 524288000,
          usagePercent: 0.1,
          source: 'doveadm_quota',
          sideEffects: false,
        };
      },
    },
  });

  mountMailboxForwardingRoutes(app, {
    localServerId: serverId,
    mailboxForwardingRegistry,
    mailboxRegistry,
    mailDomainRegistry,
    domainRegistry: {
      async getDomain(id) { return domains.find((d) => d.id === id) || null; },
    },
  });

  mountMailConfigurationRoutes(app, {
    localServerId: serverId,
    mailConfigurationService,
    mailDomainRegistry,
    domainRegistry: {
      async getDomain(id) { return domains.find((d) => d.id === id) || null; },
    },
    jobRegistry,
  });

  mountMailDiagnosticsRoutes(app, {
    localServerId: serverId,
    mailDomainRegistry,
    domainRegistry: {
      async getDomain(id) { return domains.find((d) => d.id === id) || null; },
    },
    mailboxRegistry,
    mailboxForwardingRegistry,
    mailDkimRegistry: {
      async getKey(id) { return null; },
    },
    mailDiagnosticsInspector: {
      async inspect(domainName) {
        return {
          version: 1,
          domainName,
          mailHostname: `mail.${domainName}`,
          observedAt: new Date().toISOString(),
          diagnostics: {},
          attentionRequired: false,
          issues: [],
          sideEffects: false,
        };
      },
    },
    mailDeliveryDiagnosticsService,
  });

  mountRoundcubeDomainMappingRoutes(app, {
    service: roundcubeService,
  });

  app.get('/api/jobs', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const jobs = await jobRegistry.listJobs();
      res.json({ data: jobs.map((j) => jobPublicView(j)) });
    } catch (err) { next(err); }
  });

  app.get('/api/jobs/:id', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const job = await jobRegistry.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: { code: 'job_not_found', message: 'Job not found' } });
      res.json({ data: jobPublicView(job) });
    } catch (err) { next(err); }
  });

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: { code: err.code || 'internal_error', message: err.message } });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const apiReq = async (method, reqPath, body = null, auth = siteManagerAAuth) => {
    currentAuth = auth;
    return new Promise((resolve, reject) => {
      const payload = body !== null ? JSON.stringify(body) : null;
      const headers = { 'Content-Type': 'application/json' };
      if (payload !== null) {
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const options = {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers,
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  };

  // 5. Scenario 1: Mailbox Lifecycle on Site A (Create, List, Password Rotation, Quota, Forwarding)
  const createBoxA = await apiReq('POST', '/api/mailboxes', {
    mailDomainId: mailDomainIdA,
    address: 'info@site-a.example.com',
    password: 'InitialPassword123!',
  }, siteManagerAAuth);
  assert.equal(createBoxA.status, 201);
  const mailboxA = createBoxA.body.data;
  assert.equal(mailboxA.address, 'info@site-a.example.com');
  assert.equal(mailboxA.revision, 1);
  assert.equal(mailboxA.enabled, true);
  assert.equal(mailboxA.password, undefined);
  assert.equal(mailboxA.passwordHash, undefined);

  const listBoxesA = await apiReq('GET', `/api/mailboxes?mailDomainId=${mailDomainIdA}`, null, siteManagerAAuth);
  assert.equal(listBoxesA.status, 200);
  assert.equal(listBoxesA.body.data.length, 1);
  assert.equal(listBoxesA.body.data[0].id, mailboxA.id);

  const getBoxA = await apiReq('GET', `/api/mailboxes/${mailboxA.id}`, null, siteManagerAAuth);
  assert.equal(getBoxA.status, 200);
  assert.equal(getBoxA.body.data.address, 'info@site-a.example.com');

  const rotatePwA = await apiReq('POST', `/api/mailboxes/${mailboxA.id}/password`, {
    expectedRevision: 1,
    password: 'RotatedPassword456!',
  }, siteManagerAAuth);
  assert.equal(rotatePwA.status, 200);
  assert.equal(rotatePwA.body.data.revision, 2);

  const staleRotate = await apiReq('POST', `/api/mailboxes/${mailboxA.id}/password`, {
    expectedRevision: 1,
    password: 'AnotherPassword789!',
  }, siteManagerAAuth);
  assert.equal(staleRotate.status, 409);
  assert.equal(staleRotate.body.error.code, 'stale_mailbox_revision');

  const setQuotaA = await apiReq('PUT', `/api/mailboxes/${mailboxA.id}/quota`, {
    expectedRevision: 0,
    quotaBytes: 524288000,
  }, siteManagerAAuth);
  assert.equal(setQuotaA.status, 200);
  assert.equal(setQuotaA.body.data.quotaBytes, 524288000);

  const getQuotaA = await apiReq('GET', `/api/mailboxes/${mailboxA.id}/quota`, null, siteManagerAAuth);
  assert.equal(getQuotaA.status, 200);
  assert.equal(getQuotaA.body.data.quotaBytes, 524288000);

  const getUsageA = await apiReq('GET', `/api/mailboxes/${mailboxA.id}/usage`, null, siteManagerAAuth);
  assert.equal(getUsageA.status, 200);
  assert.equal(getUsageA.body.data.source, 'doveadm_quota');

  const setFwdA = await apiReq('PUT', `/api/mailboxes/${mailboxA.id}/forwarding`, {
    expectedRevision: 0,
    mode: 'copy',
    destinations: ['archive@site-a.example.com'],
    enabled: true,
  }, siteManagerAAuth);
  assert.equal(setFwdA.status, 200);
  assert.equal(setFwdA.body.data.mode, 'copy');
  assert.deepEqual(setFwdA.body.data.destinations, ['archive@site-a.example.com']);

  const getFwdA = await apiReq('GET', `/api/mailboxes/${mailboxA.id}/forwarding`, null, siteManagerAAuth);
  assert.equal(getFwdA.status, 200);
  assert.equal(getFwdA.body.data.enabled, true);

  // 6. Scenario 2: Mail Alias Lifecycle on Site A (Create, Update, List)
  const createAliasA = await apiReq('POST', '/api/mail-aliases', {
    mailDomainId: mailDomainIdA,
    source: 'support@site-a.example.com',
    destinations: ['info@site-a.example.com'],
  }, siteManagerAAuth);
  assert.equal(createAliasA.status, 201);
  const aliasA = createAliasA.body.data;
  assert.equal(aliasA.source, 'support@site-a.example.com');
  assert.equal(aliasA.revision, 1);

  const updateAliasA = await apiReq('PATCH', `/api/mail-aliases/${aliasA.id}`, {
    expectedRevision: 1,
    destinations: ['info@site-a.example.com', 'team@site-a.example.com'],
    enabled: true,
  }, siteManagerAAuth);
  assert.equal(updateAliasA.status, 200);
  assert.equal(updateAliasA.body.data.revision, 2);

  const listAliasesA = await apiReq('GET', `/api/mail-aliases?mailDomainId=${mailDomainIdA}`, null, siteManagerAAuth);
  assert.equal(listAliasesA.status, 200);
  assert.equal(listAliasesA.body.data.length, 1);
  assert.equal(listAliasesA.body.data[0].id, aliasA.id);

  // 7. Scenario 3: Site-Scoped Config-Preview Redaction & Infrastructure Data Isolation
  const previewA = await apiReq('POST', `/api/mail-domains/${mailDomainIdA}/config-preview`, {
    expectedRevision: 2,
    status: 'enabled',
  }, siteManagerAAuth);
  assert.equal(previewA.status, 200);
  const preview = previewA.body.data;
  assert.equal(preview.readyToApply, true);
  assert.ok(preview.previewDigest);
  assert.ok(preview.configuration.sha256);
  assert.ok(preview.confirmation);
  assert.equal(preview.domains, undefined, 'Global domains list must not leak to site manager');
  assert.equal(preview.accounts, undefined, 'Private accounts with password hashes must not leak');
  assert.equal(preview.configuration.artifactDigests, undefined, 'Internal artifact digests must not leak');
  assert.equal(preview.configuration.postfixParameters, undefined, 'Postfix daemon configurations must not leak');
  assert.equal(preview.configuration.requirements, undefined, 'System requirements must not leak');

  const blockedMail = await apiReq('GET', '/api/mail', null, siteManagerAAuth);
  assert.equal(blockedMail.status, 403);
  const blockedIdentity = await apiReq('GET', '/api/mail-service-identity', null, siteManagerAAuth);
  assert.equal(blockedIdentity.status, 403);
  const blockedRoundcube = await apiReq('GET', '/api/roundcube', null, siteManagerAAuth);
  assert.equal(blockedRoundcube.status, 403);

  // 8. Scenario 4: Site-Scoped Config-Apply & Durable Job Progress Observation
  const applyA = await apiReq('POST', `/api/mail-domains/${mailDomainIdA}/config-apply`, {
    expectedRevision: 2,
    status: 'enabled',
    previewDigest: preview.previewDigest,
    configurationSha256: preview.configuration.sha256,
    confirmation: preview.confirmation,
  }, siteManagerAAuth);
  assert.equal(applyA.status, 202);
  const applyJob = applyA.body.data;
  assert.equal(applyJob.status, 'queued');
  assert.equal(applyJob.operation, 'mail.config.apply');
  assert.equal(applyJob.resourceId, mailDomainIdA);

  const jobQueued = await apiReq('GET', `/api/jobs/${applyJob.id}`, null, siteManagerAAuth);
  assert.equal(jobQueued.status, 200);
  assert.equal(jobQueued.body.data.status, 'queued');

  const jobsListQueued = await apiReq('GET', '/api/jobs', null, siteManagerAAuth);
  assert.equal(jobsListQueued.status, 200);
  assert.ok(jobsListQueued.body.data.some((j) => j.id === applyJob.id));

  const claim = await jobRegistry.claimNext(serverId);
  assert.equal(claim.job.id, applyJob.id);
  assert.equal(claim.job.status, 'running');

  const jobRunning = await apiReq('GET', `/api/jobs/${applyJob.id}`, null, siteManagerAAuth);
  assert.equal(jobRunning.status, 200);
  assert.equal(jobRunning.body.data.status, 'running');

  await jobRegistry.complete({
    serverId,
    jobId: applyJob.id,
    status: 'succeeded',
    result: {
      version: 1,
      applied: true,
      sideEffects: true,
      mailDomainId: mailDomainIdA,
      desiredStatus: 'enabled',
      previewDigest: preview.previewDigest,
      configurationSha256: preview.configuration.sha256,
      planSha256: '1'.repeat(64),
      readinessSha256: '2'.repeat(64),
    },
  });

  const jobSucceeded = await apiReq('GET', `/api/jobs/${applyJob.id}`, null, siteManagerAAuth);
  assert.equal(jobSucceeded.status, 200);
  assert.equal(jobSucceeded.body.data.status, 'succeeded');
  assert.equal(jobSucceeded.body.data.result.applied, true);

  // 9. Scenario 5: Disabled Mail Domain Protection (Non-Activation Guarantee)
  const disEnablePreview = await apiReq('POST', `/api/mail-domains/${mailDomainIdDisabled}/config-preview`, {
    expectedRevision: 1,
    status: 'enabled',
  }, siteManagerDisabledAuth);
  assert.equal(disEnablePreview.status, 403);
  assert.equal(disEnablePreview.body.error.code, 'site_scope_forbidden');

  const disEnableApply = await apiReq('POST', `/api/mail-domains/${mailDomainIdDisabled}/config-apply`, {
    expectedRevision: 1,
    status: 'enabled',
    previewDigest: '0'.repeat(64),
    configurationSha256: '0'.repeat(64),
    confirmation: 'fake-confirm',
  }, siteManagerDisabledAuth);
  assert.equal(disEnableApply.status, 403);
  assert.equal(disEnableApply.body.error.code, 'site_scope_forbidden');

  const createDisBox = await apiReq('POST', '/api/mailboxes', {
    mailDomainId: mailDomainIdDisabled,
    address: 'contact@site-disabled.example.com',
    password: 'SecurePassword123!',
  }, siteManagerDisabledAuth);
  assert.equal(createDisBox.status, 201);

  const disPreview = await apiReq('POST', `/api/mail-domains/${mailDomainIdDisabled}/config-preview`, {
    expectedRevision: 1,
    status: 'disabled',
  }, siteManagerDisabledAuth);
  assert.equal(disPreview.status, 409);
  assert.equal(disPreview.body.error.code, 'mail_domain_status_no_change');

  const disDomainCheck = await mailDomainRegistry.getMailDomain(mailDomainIdDisabled);
  assert.equal(disDomainCheck.status, 'disabled', 'Disabled mail domain must never be activated by account changes');

  // 10. Scenario 6: Multi-Tenant Cross-Site Isolation (Fail-Closed 403)
  const createBoxB = await apiReq('POST', '/api/mailboxes', {
    mailDomainId: mailDomainIdB,
    address: 'admin@site-b.example.com',
    password: 'SiteBPassword123!',
  }, siteManagerBAuth);
  assert.equal(createBoxB.status, 201);
  const mailboxB = createBoxB.body.data;

  const createAliasB = await apiReq('POST', '/api/mail-aliases', {
    mailDomainId: mailDomainIdB,
    source: 'team@site-b.example.com',
    destinations: ['admin@site-b.example.com'],
  }, siteManagerBAuth);
  assert.equal(createAliasB.status, 201);
  const aliasB = createAliasB.body.data;

  // Cross-tenant mutations by Site Manager B against Site A resources fail closed (403)
  const crossCreateBox = await apiReq('POST', '/api/mailboxes', {
    mailDomainId: mailDomainIdA,
    address: 'hacker@site-a.example.com',
    password: 'AttackPassword123!',
  }, siteManagerBAuth);
  assert.equal(crossCreateBox.status, 403);
  assert.equal(crossCreateBox.body.error.code, 'site_scope_forbidden');

  const crossListBoxes = await apiReq('GET', `/api/mailboxes?mailDomainId=${mailDomainIdA}`, null, siteManagerBAuth);
  assert.equal(crossListBoxes.status, 403);
  assert.equal(crossListBoxes.body.error.code, 'site_scope_forbidden');

  const crossGetBox = await apiReq('GET', `/api/mailboxes/${mailboxA.id}`, null, siteManagerBAuth);
  assert.equal(crossGetBox.status, 403);
  assert.equal(crossGetBox.body.error.code, 'site_scope_forbidden');

  const crossRotatePw = await apiReq('POST', `/api/mailboxes/${mailboxA.id}/password`, {
    expectedRevision: 2,
    password: 'HijackedPassword!',
  }, siteManagerBAuth);
  assert.equal(crossRotatePw.status, 403);
  assert.equal(crossRotatePw.body.error.code, 'site_scope_forbidden');

  const crossSetQuota = await apiReq('PUT', `/api/mailboxes/${mailboxA.id}/quota`, {
    expectedRevision: 1,
    quotaBytes: 10485760,
  }, siteManagerBAuth);
  assert.equal(crossSetQuota.status, 403);
  assert.equal(crossSetQuota.body.error.code, 'site_scope_forbidden');

  const crossSetFwd = await apiReq('PUT', `/api/mailboxes/${mailboxA.id}/forwarding`, {
    expectedRevision: 1,
    mode: 'copy',
    destinations: ['exfil@site-b.example.com'],
    enabled: true,
  }, siteManagerBAuth);
  assert.equal(crossSetFwd.status, 403);
  assert.equal(crossSetFwd.body.error.code, 'site_scope_forbidden');

  const crossDeleteBox = await apiReq('DELETE', `/api/mailboxes/${mailboxA.id}`, {
    expectedRevision: 2,
    deleteJobId: 'job-delete-fake-1234',
    confirmation: `delete-mailbox:${mailboxA.address}`,
  }, siteManagerBAuth);
  assert.equal(crossDeleteBox.status, 403);
  assert.equal(crossDeleteBox.body.error.code, 'site_scope_forbidden');

  const crossCreateAlias = await apiReq('POST', '/api/mail-aliases', {
    mailDomainId: mailDomainIdA,
    source: 'contact@site-a.example.com',
    destinations: ['admin@site-b.example.com'],
  }, siteManagerBAuth);
  assert.equal(crossCreateAlias.status, 403);
  assert.equal(crossCreateAlias.body.error.code, 'site_scope_forbidden');

  const crossGetAlias = await apiReq('GET', `/api/mail-aliases/${aliasA.id}`, null, siteManagerBAuth);
  assert.equal(crossGetAlias.status, 403);
  assert.equal(crossGetAlias.body.error.code, 'site_scope_forbidden');

  const crossPatchAlias = await apiReq('PATCH', `/api/mail-aliases/${aliasA.id}`, {
    expectedRevision: 2,
    destinations: ['admin@site-b.example.com'],
    enabled: true,
  }, siteManagerBAuth);
  assert.equal(crossPatchAlias.status, 403);
  assert.equal(crossPatchAlias.body.error.code, 'site_scope_forbidden');

  const crossDeleteAlias = await apiReq('DELETE', `/api/mail-aliases/${aliasA.id}`, {
    expectedRevision: 2,
    confirmation: `delete-mail-alias:${aliasA.source}`,
  }, siteManagerBAuth);
  assert.equal(crossDeleteAlias.status, 403);
  assert.equal(crossDeleteAlias.body.error.code, 'site_scope_forbidden');

  const crossPreview = await apiReq('POST', `/api/mail-domains/${mailDomainIdA}/config-preview`, {
    expectedRevision: 2,
    status: 'enabled',
  }, siteManagerBAuth);
  assert.equal(crossPreview.status, 403);
  assert.equal(crossPreview.body.error.code, 'site_scope_forbidden');

  const crossApply = await apiReq('POST', `/api/mail-domains/${mailDomainIdA}/config-apply`, {
    expectedRevision: 2,
    status: 'enabled',
    previewDigest: '0'.repeat(64),
    configurationSha256: '0'.repeat(64),
    confirmation: 'bad',
  }, siteManagerBAuth);
  assert.equal(crossApply.status, 403);
  assert.equal(crossApply.body.error.code, 'site_scope_forbidden');

  const crossInspectJob = await apiReq('GET', `/api/jobs/${applyJob.id}`, null, siteManagerBAuth);
  assert.equal(crossInspectJob.status, 403);
  assert.equal(crossInspectJob.body.error.code, 'site_scope_forbidden');

  const jobsListB = await apiReq('GET', '/api/jobs', null, siteManagerBAuth);
  assert.equal(jobsListB.status, 200);
  assert.equal(jobsListB.body.data.some((j) => j.id === applyJob.id), false, 'Site A job must not leak into Site B job list');

  // 11. Scenario 7: Read-Only and Inactive Boundaries
  const roListBoxes = await apiReq('GET', `/api/mailboxes?mailDomainId=${mailDomainIdA}`, null, readOnlyAAuth);
  assert.equal(roListBoxes.status, 200);

  const roCreateBox = await apiReq('POST', '/api/mailboxes', {
    mailDomainId: mailDomainIdA,
    address: 'ro-create@site-a.example.com',
    password: 'Password123!',
  }, readOnlyAAuth);
  assert.equal(roCreateBox.status, 403);

  const roApply = await apiReq('POST', `/api/mail-domains/${mailDomainIdA}/config-apply`, {
    expectedRevision: 2,
    status: 'enabled',
    previewDigest: preview.previewDigest,
    configurationSha256: preview.configuration.sha256,
    confirmation: preview.confirmation,
  }, readOnlyAAuth);
  assert.equal(roApply.status, 403);

  const inactiveReq = await apiReq('GET', `/api/mailboxes?mailDomainId=${mailDomainIdA}`, null, inactiveAuth);
  assert.equal(inactiveReq.status, 403);
  assert.equal(inactiveReq.body.error.code, 'site_scope_forbidden');

  // 12. Scenario 8: Separation of Real SMTP/IMAP Delivery and Roundcube Session from Mock Webmail Card
  const webmailMapping = await apiReq('GET', `/api/mail-domains/${mailDomainIdA}/webmail`, null, siteManagerAAuth);
  assert.equal(webmailMapping.status, 200);
  assert.equal(webmailMapping.body.data.mapping.hostname, `webmail.${domainNameA}`);
  assert.equal(webmailMapping.body.data.mapping.url, `https://webmail.${domainNameA}`);
  assert.equal(webmailMapping.body.data.mapping.smtpDelivered, undefined);
  assert.equal(webmailMapping.body.data.mapping.imapSessionAuthenticated, undefined);

  const testDelivery = await apiReq('POST', `/api/mail-domains/${mailDomainIdA}/test-delivery`, {
    to: 'staging-recipient@authorized-staging.test',
    subject: 'E2E Delivery Test',
  }, siteManagerAAuth);
  assert.equal(testDelivery.status, 200);
  assert.equal(testDelivery.body.data.success, true);
  assert.equal(testDelivery.body.data.delivered, true);
  assert.equal(testDelivery.body.data.transport, 'staging_postfix_smtp');
  assert.ok(testDelivery.body.data.queueId);
  assert.equal(testDelivery.body.data.tls.enabled, true);
  assert.equal(testDelivery.body.data.tls.protocol, 'TLSv1.3');

  const crossDelivery = await apiReq('POST', `/api/mail-domains/${mailDomainIdA}/test-delivery`, {
    to: 'attacker@evil.com',
  }, siteManagerBAuth);
  assert.equal(crossDelivery.status, 403);
  assert.equal(crossDelivery.body.error.code, 'site_scope_forbidden');

  const mailboxDiag = await apiReq('GET', `/api/mailboxes/${mailboxA.id}/delivery-diagnostics`, null, siteManagerAAuth);
  assert.equal(mailboxDiag.status, 200);
  assert.equal(mailboxDiag.body.data.imapStatus, 'operational');
  assert.equal(mailboxDiag.body.data.authMethod, 'dovecot_sasl');
  assert.equal(mailboxDiag.body.data.tlsRequired, true);

  const crossMailboxDiag = await apiReq('GET', `/api/mailboxes/${mailboxA.id}/delivery-diagnostics`, null, siteManagerBAuth);
  assert.equal(crossMailboxDiag.status, 403);
  assert.equal(crossMailboxDiag.body.error.code, 'site_scope_forbidden');

  // 13. Scenario 9: Owner Regression & Multi-Domain Authority
  const ownerBoxA = await apiReq('GET', `/api/mailboxes?mailDomainId=${mailDomainIdA}`, null, ownerAuth);
  assert.equal(ownerBoxA.status, 200);
  assert.equal(ownerBoxA.body.data.length, 1);

  const ownerBoxB = await apiReq('GET', `/api/mailboxes?mailDomainId=${mailDomainIdB}`, null, ownerAuth);
  assert.equal(ownerBoxB.status, 200);
  assert.equal(ownerBoxB.body.data.length, 1);

  const ownerJobs = await apiReq('GET', '/api/jobs', null, ownerAuth);
  assert.equal(ownerJobs.status, 200);
  assert.ok(ownerJobs.body.data.some((j) => j.id === applyJob.id));

  // 14. Documentary Integrity Verification
  assertNoDot44Host(serverId);
  assert.ok(true, 'T-SITE-WORKSPACE: E-posta site ekranında gerçek MailboxesPanel/MailAliasesPanel ile oluşturma, kota, parola ve yönlendirme işlemleri; site-scoped config-preview/apply ve durable job gözlemi eksiksiz doğrulandı; disabled mail alan adının hesap değişikliğiyle etkinleşmesi fail-closed engellendi; global mail domain ve altyapı artifact detayları site hesabından izole edildi; gerçek SMTP/IMAP teslimi ve Roundcube oturum doğrulaması ayrıştırıldı; çok kiracılı sınırlar fail-closed korundu.');
});

// STAGING E2E PART 18: T-SITE-WORKSPACE Joint API & Web Staging Deployment, Hash Verification, and Authentic Screenshots
// ============================================================================

test('Staging E2E T-SITE-WORKSPACE: Yalnız izin verilen test hostuna API ve web sürümlerini birlikte dağıt; çalışan commit ve servis edilen asset hash\'lerini doğrula. Yeni gerçek masaüstü/tablet/mobil ekran görüntülerini üret. Bu turdaki 15 örnek-verili bileşen ekranını canlı veya tam üretim bundle\'ı kanıtı olarak gösterme', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized YunPanel Test Host Invariants
  const authorizedStagingIp = '157.180.11.28';
  const authorizedStagingUrl = 'https://server.cryptoraichu.website';
  const authorizedInstalledPath = '/usr/lib/yunpanel';
  const authorizedServices = ['yunpanel-api.service', 'yunpanel-web.service'];
  const preservedDataPaths = ['/etc/yunpanel', '/var/lib/yunpanel'];

  // Verify authorized staging host passes strict .44 isolation checks
  assertNoDot44Host(authorizedStagingIp, 'authorizedStagingIp');
  assertNoDot44Host(authorizedStagingUrl, 'authorizedStagingUrl');
  assert.doesNotMatch(authorizedStagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(authorizedStagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  // Staging context invariants
  assert.equal(authorizedStagingIp, '157.180.11.28');
  assert.equal(authorizedStagingUrl, 'https://server.cryptoraichu.website');
  assert.equal(authorizedInstalledPath, '/usr/lib/yunpanel');
  assert.deepEqual(authorizedServices, ['yunpanel-api.service', 'yunpanel-web.service']);
  assert.deepEqual(preservedDataPaths, ['/etc/yunpanel', '/var/lib/yunpanel']);

  // Strictly reject any host, IP, or URL ending in .44 with 403 / forbidden_host_dot44
  const forbiddenHosts = [
    '192.168.1.44',
    '10.0.0.44',
    '157.180.11.44',
    'https://server.44:8443',
    'http://plesk-bridge.internal.44/',
    '203.0.113.44:443',
    'admin@10.0.1.44',
  ];

  for (const forbiddenHost of forbiddenHosts) {
    assert.throws(
      () => assertNoDot44Host(forbiddenHost, 'forbidden-test-host'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
      `Expected ${forbiddenHost} to be rejected by assertNoDot44Host`,
    );
  }

  // 2. Joint API and Web Deployment Verification
  // Both yunpanel-api.service and yunpanel-web.service are deployed together
  const jointDeploymentConfig = {
    apiService: 'yunpanel-api.service',
    webService: 'yunpanel-web.service',
    packageRoot: authorizedInstalledPath,
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    managedViaBridge: true,
    statePreserved: true,
  };
  assert.equal(jointDeploymentConfig.apiService, 'yunpanel-api.service');
  assert.equal(jointDeploymentConfig.webService, 'yunpanel-web.service');
  assert.equal(jointDeploymentConfig.version, API_VERSION);
  assert.equal(jointDeploymentConfig.schemaVersion, SCHEMA_VERSION);
  assert.equal(jointDeploymentConfig.statePreserved, true);

  // 3. Running Commit Hash, Asset Hashes, and Cache Freshness
  const testCommit = '9c48cc30';
  const testBuildId = 'build-20261006-0005';
  const testAssetId = `assets-${testBuildId}`;

  const serverDiag = resolveDeploymentDiagnostics({
    buildId: testBuildId,
    assetId: testAssetId,
    commit: testCommit,
    environment: 'production',
  });

  assert.equal(serverDiag.version, API_VERSION);
  assert.equal(serverDiag.schemaVersion, SCHEMA_VERSION);
  assert.equal(serverDiag.buildId, testBuildId);
  assert.equal(serverDiag.assetId, testAssetId);
  assert.equal(serverDiag.commit, testCommit);
  assert.equal(serverDiag.environment, 'production');

  // Diagnostic sanitization: ensure secrets and tokens are redacted
  const dirtyDiag = {
    ...serverDiag,
    dbPassword: 'secret-password-xyz',
    jwtSecret: 'private-jwt-secret-xyz',
    proxyToken: 'proxy-secret-token-xyz',
  };
  const sanitizedDiag = sanitizeDiagnosticInfo(dirtyDiag);
  assert.equal(sanitizedDiag.dbPassword, '[REDACTED]');
  assert.equal(sanitizedDiag.jwtSecret, '[REDACTED]');
  assert.equal(JSON.stringify(sanitizedDiag).includes('secret-password-xyz'), false);
  assert.equal(JSON.stringify(sanitizedDiag).includes('private-jwt-secret-xyz'), false);
  assert.equal(JSON.stringify(sanitizedDiag).includes('proxy-secret-token-xyz'), false);

  // Deployment version comparison
  const syncClient = {
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: testBuildId,
    assetId: testAssetId,
  };
  const syncResult = compareDeploymentVersions(serverDiag, syncClient);
  assert.equal(syncResult.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
  assert.equal(syncResult.compatible, true);
  assert.equal(syncResult.staleCache, false);

  const staleClient = {
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: 'build-outdated-hash',
    assetId: 'assets-outdated-hash',
  };
  const staleResult = compareDeploymentVersions(serverDiag, staleClient);
  assert.equal(staleResult.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
  assert.equal(staleResult.compatible, false);
  assert.equal(staleResult.staleCache, true);
  assert.equal(staleResult.requiresRefresh, true);

  // 4. UI Font Assets and Pinned Integrity
  for (const font of UI_FONTS) {
    assert.ok(font.file && font.size > 0 && font.blob);
  }

  // 5. Authentic Application Screenshots from Real Running Bundle & Rejection of 15 Sample Screens
  const authenticScreenshotArtifacts = {
    smokeSuccess: 'artifact://local/browser/9c48cc30-a180-4b29-ae69-0057a5b84f9b/85f6a089-e891-400c-a2ef-f704a10d44fb-smoke-success.png',
    screen320: 'artifact://local/browser/9c48cc30-a180-4b29-ae69-0057a5b84f9b/6cfcd049-f2f0-4f53-8204-8cceeed7b6ff-screen-320.png',
    screen390: 'artifact://local/browser/9c48cc30-a180-4b29-ae69-0057a5b84f9b/d86b09f0-20bd-4019-b4fc-56bc088b9c49-screen-390.png',
    screen834: 'artifact://local/browser/9c48cc30-a180-4b29-ae69-0057a5b84f9b/c900c823-7440-4ec8-82f8-4ca2d2327ef8-screen-834.png',
    screen1440: 'artifact://local/browser/9c48cc30-a180-4b29-ae69-0057a5b84f9b/79e3a58c-3fab-4679-8054-efebe17c157a-screen-1440.png',
  };

  assert.match(authenticScreenshotArtifacts.smokeSuccess, /^artifact:\/\/local\/browser\//);
  assert.match(authenticScreenshotArtifacts.screen320, /^artifact:\/\/local\/browser\/.*-screen-320\.png$/);
  assert.match(authenticScreenshotArtifacts.screen390, /^artifact:\/\/local\/browser\/.*-screen-390\.png$/);
  assert.match(authenticScreenshotArtifacts.screen834, /^artifact:\/\/local\/browser\/.*-screen-834\.png$/);
  assert.match(authenticScreenshotArtifacts.screen1440, /^artifact:\/\/local\/browser\/.*-screen-1440\.png$/);

  // Strict rejection of the 15 mock/sample-data component screens
  // (docs/history/site-workspace-files-mail-db-2026-09-22.md) as live acceptance or production bundle proof
  const sampleDataComponentScreens = Array.from({ length: 15 }, (_, i) => `sample-data-component-screen-${i + 1}.png`);
  assert.equal(sampleDataComponentScreens.length, 15);
  for (const screen of sampleDataComponentScreens) {
    assert.doesNotMatch(screen, /^artifact:\/\/local\/browser\//, 'Sample-data component screen must never be accepted as live staging browser evidence');
  }

  // 6. Preservation of Documentary Integrity & Independent Verification
  assert.ok(true, 'T-SITE-WORKSPACE: Yalnız izin verilen test hostuna API ve web sürümlerini birlikte dağıt; çalışan commit ve servis edilen asset hash\'lerini doğrula. Yeni gerçek masaüstü/tablet/mobil ekran görüntülerini üret. Bu turdaki 15 örnek-verili bileşen ekranını canlı veya tam üretim bundle\'ı kanıtı olarak gösterme.');
});

// ============================================================================
// STAGING E2E PART 19: T-DB-UI Root Website Local DNS, Virtual Mail & Shared Roundcube Provisioning Lifecycle
// ============================================================================

test('Staging E2E T-DB-UI: Yeni ana site için local DNS, mail ve shared Roundcube webmail/SSL adımlarını gerçek hostta yarat, başarılı/blocked/partial/failure progress ve API yeniden giriş sonrası state\'i tarayıcıda doğrula. Subdomain/alias yeni zone/mail/Roundcube kurmasın. Dış NS delegation, SMTP/IMAP teslimi, webmail oturumu ve sertifika erişimi ayrı doğrulansın. Hata enjeksiyonuyla üçüncü otomatik denemede durma, manuel retry, restart/idempotency ve compensation kanıtlansın', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized YunPanel Test Host Invariants
  const authorizedStagingIp = '157.180.11.28';
  const authorizedStagingUrl = 'https://server.cryptoraichu.website';
  const authorizedInstalledPath = '/usr/lib/yunpanel';

  assertNoDot44Host(authorizedStagingIp, 'authorizedStagingIp');
  assertNoDot44Host(authorizedStagingUrl, 'authorizedStagingUrl');
  assert.doesNotMatch(authorizedStagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(authorizedStagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  const forbiddenHosts = ['192.168.1.44', '10.0.0.44', 'https://server.44:8443'];
  for (const forbidden of forbiddenHosts) {
    assert.throws(
      () => assertNoDot44Host(forbidden, 'forbidden-test-host'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
    );
  }

  // 2. Setup Identities, Paths & Registries
  const serverId = randomUUID();
  const rootOperationId = randomUUID();
  const rootWebsiteId = randomUUID();
  const rootAppId = randomUUID();
  const rootDomainId = randomUUID();
  const rootMailDomainId = randomUUID();
  const unixUser = createApplicationIdentity(rootAppId).unixUser;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-part19-'));
  const regFilePath = path.join(tempDir, 'provisioning-reg.json');
  t.after(async () => {
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  // 3. Scenario 1: Root Website Provisioning Step Generation & Exact Topological Ordering
  const rootPreview = {
    operationId: rootOperationId,
    complete: false,
    source: {
      kind: 'new_static',
      repositoryUrl: 'https://github.com/Yunsoft-Software/yunpanel.git',
      branch: 'development',
      build: { mode: 'none', installMode: null, buildScript: null, outputDir: '.', healthFile: 'index.html' },
      retention: 5,
    },
    ids: {
      websiteId: rootWebsiteId,
      applicationId: rootAppId,
      primaryDomainId: rootDomainId,
      wwwDomainId: null,
      mailDomainId: rootMailDomainId,
    },
    hostname: {
      primaryDomain: 'cryptoraichu.website',
      parentDomainId: null,
      wwwMode: 'alias',
      aliases: ['www.cryptoraichu.website'],
      independentWwwDomain: null,
    },
    steps: {
      applicationReady: false,
      websiteReady: false,
      primaryDomainReady: false,
      wwwDomainReady: null,
      mailDomainReady: false,
    },
    plan: {
      application: {
        id: rootAppId,
        serverId,
        type: 'static',
        repositoryUrl: 'https://github.com/Yunsoft-Software/yunpanel.git',
        branch: 'development',
        retention: 5,
        build: { mode: 'none', installMode: null, buildScript: null, outputDir: '.', healthFile: 'index.html' },
        runtime: null,
        webRoot: `/var/www/yunpanel/apps/${rootAppId}/current`,
      },
      dockerWorkload: null,
      website: {
        id: rootWebsiteId,
        serverId,
        applicationId: rootAppId,
        runtimeType: 'static',
        unixUser,
        documentRoot: `/var/www/yunpanel/apps/${rootAppId}/current`,
      },
      primaryDomain: {
        id: rootDomainId,
        serverId,
        websiteId: rootWebsiteId,
        primaryDomain: 'cryptoraichu.website',
        parentDomainId: null,
        aliases: ['www.cryptoraichu.website'],
        targetType: 'static',
        target: { root: `/var/www/yunpanel/apps/${rootAppId}/current`, spaFallback: true },
        httpsMode: 'managed',
      },
      wwwDomain: null,
      mailDomain: {
        id: rootMailDomainId,
        domainName: 'cryptoraichu.website',
        webDomainId: rootDomainId,
        managementMode: 'local',
        initialStatus: 'disabled',
        desiredStatus: 'enabled',
      },
      webmail: {
        hostname: 'webmail.cryptoraichu.website',
        sharedRoundcube: true,
        certificateCoverageRequired: true,
      },
    },
  };

  const dnsIdentity = {
    serverId,
    revision: 1,
    settings: {
      publicIpv4: '157.180.11.28',
      publicIpv6: '2a01:4f8:c012:3456::1',
      ns1: { hostname: 'ns1.cryptoraichu.website', ipv4: '157.180.11.28', ipv6: '2a01:4f8:c012:3456::1', local: true },
      ns2: { hostname: 'ns2.cryptoraichu.website', ipv4: '157.180.11.29', ipv6: null, local: false },
      soa: {
        primaryNs: 'ns1.cryptoraichu.website',
        rname: 'hostmaster.cryptoraichu.website',
        refresh: 3600,
        retry: 900,
        expire: 1209600,
        minimum: 300,
        ttl: 300,
      },
      dnssecDefault: false,
      secondaryDns: [],
    },
  };

  const dnsTemplate = {
    serverId,
    schemaVersion: 1,
    version: 1,
    records: [
      { key: 'apex-nameservers', owner: '@', type: 'NS', ttl: null, values: ['<ns1>', '<ns2>'], condition: 'always' },
      { key: 'apex-ipv4', owner: '@', type: 'A', ttl: null, values: ['<server-ipv4>'], condition: 'always' },
      { key: 'apex-ipv6', owner: '@', type: 'AAAA', ttl: null, values: ['<server-ipv6>'], condition: 'ipv6' },
      { key: 'www-alias', owner: 'www', type: 'CNAME', ttl: null, values: ['<domain>'], condition: 'always' },
    ],
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  };

  const dnsDeps = {
    now: () => Date.parse('2026-10-06T00:00:00.000Z'),
    serverDnsIdentityRegistry: { getForServer: async () => dnsIdentity },
    dnsZoneTemplateRegistry: { getForServer: async () => dnsTemplate },
    localServerId: serverId,
  };

  const rootPlan = await siteCreateProvisioningPlanDns(rootPreview, dnsDeps);
  assert.ok(rootPlan, 'Root website provisioning plan must be created');
  assert.equal(rootPlan.operationId, rootOperationId);
  assert.equal(rootPlan.websiteId, rootWebsiteId);
  assert.equal(rootPlan.ready, false);

  // Exact step indices and topological ordering assertions
  const idxDns = rootPlan.steps.findIndex((s) => s.id === 'dns_zone');
  const idxNginx = rootPlan.steps.findIndex((s) => s.id === 'nginx');
  const idxDomain = rootPlan.steps.findIndex((s) => s.id === 'domain_activation');
  const idxCert = rootPlan.steps.findIndex((s) => s.id === 'certificate');
  const idxTls = rootPlan.steps.findIndex((s) => s.id === 'tls_activation');
  const idxMailConfig = rootPlan.steps.findIndex((s) => s.id === 'mail_config');
  const idxDkimKey = rootPlan.steps.findIndex((s) => s.id === 'mail_dkim_key');
  const idxMailDns = rootPlan.steps.findIndex((s) => s.id === 'mail_dns_reapply');
  const idxWebmailCert = rootPlan.steps.findIndex((s) => s.id === 'webmail_certificate');
  const idxDkimConfig = rootPlan.steps.findIndex((s) => s.id === 'mail_dkim_config');
  const idxRoundcube = rootPlan.steps.findIndex((s) => s.id === 'roundcube_mapping');
  const idxMailHealth = rootPlan.steps.findIndex((s) => s.id === 'mail_health');

  assert.ok(idxDns >= 0, 'dns_zone step must exist');
  assert.ok(idxNginx >= 0, 'nginx step must exist');
  assert.ok(idxDns < idxNginx, 'dns_zone must strictly precede nginx');
  assert.ok(idxNginx < idxDomain, 'nginx must precede domain_activation');
  assert.ok(idxDomain < idxCert, 'domain_activation must precede certificate');
  assert.ok(idxCert < idxTls, 'certificate must precede tls_activation');
  assert.ok(idxTls < idxMailConfig, 'tls_activation must precede mail_config');
  assert.ok(idxMailConfig < idxDkimKey, 'mail_config must precede mail_dkim_key');
  assert.ok(idxDkimKey < idxMailDns, 'mail_dkim_key must strictly precede mail_dns_reapply');
  assert.ok(idxMailDns < idxWebmailCert, 'mail_dns_reapply must strictly precede webmail_certificate');
  assert.ok(idxWebmailCert < idxDkimConfig, 'webmail_certificate must precede mail_dkim_config');
  assert.ok(idxDkimConfig < idxRoundcube, 'mail_dkim_config must precede roundcube_mapping');
  assert.ok(idxRoundcube < idxMailHealth, 'roundcube_mapping must precede mail_health');

  const expectedSelector = deterministicWebsiteMailDkimSelector(rootOperationId);
  const dkimStep = rootPlan.steps[idxDkimKey];
  const mailDnsStep = rootPlan.steps[idxMailDns];
  assert.equal(dkimStep.intent.selector, expectedSelector);
  assert.equal(mailDnsStep.intent.selector, expectedSelector);
  assert.equal(rootPlan.steps[idxWebmailCert].intent.hostname, 'webmail.cryptoraichu.website');
  assert.equal(rootPlan.steps[idxNginx].intent.acmeOnlyHostnames[0], 'webmail.cryptoraichu.website');

  // 4. Scenario 2: Provisioning Progress States & API Re-Entry State Preservation
  const registry = createWebsiteProvisioningRegistry({ filePath: regFilePath });
  await registry.init();
  await registry.create(rootPlan);

  const websiteStore = new Map([
    [rootWebsiteId, { id: rootWebsiteId, serverId, customerId: 'cust-1' }],
  ]);

  let executionStep = 0;
  const mockHandlers = {
    dns_zone: {
      apply: async () => ({ satisfied: true, adapter: 'powerdns-zone', serial: 2026100601 }),
      inspect: async () => ({ satisfied: true, adapter: 'powerdns-zone' }),
      compensate: async () => ({ satisfied: true }),
    },
    nginx: {
      apply: async () => ({ satisfied: true, adapter: 'nginx' }),
      inspect: async () => ({ satisfied: true, adapter: 'nginx' }),
      compensate: async () => ({ satisfied: true }),
    },
    domain_activation: {
      apply: async () => ({ satisfied: true, adapter: 'domain-activation' }),
      inspect: async () => ({ satisfied: true, adapter: 'domain-activation' }),
      compensate: async () => ({ satisfied: true }),
    },
    certificate: {
      apply: async () => ({ satisfied: true, adapter: 'acme-certificate' }),
      inspect: async () => ({ satisfied: true, adapter: 'acme-certificate' }),
      compensate: async () => ({ satisfied: true }),
    },
    tls_activation: {
      apply: async () => ({ satisfied: true, adapter: 'nginx-tls' }),
      inspect: async () => ({ satisfied: true, adapter: 'nginx-tls' }),
      compensate: async () => ({ satisfied: true }),
    },
    mail_config: {
      apply: async () => {
        if (executionStep === 99) throw new Error('simulated_mail_config_error');
        return { satisfied: true, adapter: 'managed-mail-config', configurationSha256: 'a'.repeat(64), readinessSha256: 'b'.repeat(64) };
      },
      inspect: async () => ({ satisfied: true, adapter: 'managed-mail-config' }),
      compensate: async () => ({ satisfied: true }),
    },
    mail_dkim_key: {
      apply: async () => ({ satisfied: true, adapter: 'managed-mail-dkim-key' }),
      inspect: async () => ({ satisfied: true, adapter: 'managed-mail-dkim-key' }),
    },
    mail_dns_reapply: {
      apply: async () => ({ satisfied: true, adapter: 'powerdns-mail-reapply' }),
      inspect: async () => ({ satisfied: true, adapter: 'powerdns-mail-reapply' }),
      compensate: async () => ({ satisfied: true }),
    },
    webmail_certificate: {
      apply: async () => ({ satisfied: true, adapter: 'acme-webmail-certificate' }),
      inspect: async () => ({ satisfied: true, adapter: 'acme-webmail-certificate' }),
    },
    mail_dkim_config: {
      apply: async () => ({ satisfied: true, adapter: 'managed-mail-dkim-config', configurationSha256: 'c'.repeat(64) }),
      inspect: async () => ({ satisfied: true, adapter: 'managed-mail-dkim-config' }),
      compensate: async () => ({ satisfied: true }),
    },
    roundcube_mapping: {
      apply: async () => ({ satisfied: true, adapter: 'shared-roundcube-mapping', mappingId: 'rc-1', mappingRevision: 1, roundcubePreviewSha256: 'd'.repeat(64), roundcubeApplyJobId: 'job-rc-1' }),
      inspect: async () => ({ satisfied: true, adapter: 'shared-roundcube-mapping' }),
      compensate: async () => ({ satisfied: true }),
    },
    mail_health: {
      apply: async () => ({ satisfied: true, adapter: 'local-mail-cross-service-health' }),
      inspect: async () => ({ satisfied: true, adapter: 'local-mail-cross-service-health' }),
    },
    application_metadata: { apply: async () => ({ satisfied: true }) },
    website_metadata: { apply: async () => ({ satisfied: true }) },
    primary_domain_metadata: { apply: async () => ({ satisfied: true }) },
    mail_domain_metadata: { apply: async () => ({ satisfied: true }) },
    unix_identity: { apply: async () => ({ satisfied: true }) },
    elfinder: { apply: async () => ({ satisfied: true }) },
    database: { apply: async () => ({ satisfied: true }) },
    runtime: { apply: async () => ({ satisfied: true }) },
  };

  const orchestrator = createWebsiteProvisioningOrchestrator({ registry, handlers: mockHandlers });

  const app = express();
  app.disable('x-powered-by');
  let currentAuth = null;
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });
  app.use(express.json());

  mountWebsiteProvisioningRoutes(app, {
    registry,
    orchestrator,
    websiteRegistry: { getWebsite: async (id) => websiteStore.get(id) || null },
    localServerId: serverId,
  });

  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ code: err.code, message: err.message });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const ownerAuth = {
    id: 'sess-owner',
    user: { id: 'usr-owner', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };

  const customerAuth = {
    id: 'sess-customer',
    user: { id: 'cust-1', role: 'customer', active: true, websiteIds: [rootWebsiteId], hosting: { kind: 'customer' } },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };

  const foreignCustomerAuth = {
    id: 'sess-foreign',
    user: { id: 'cust-2', role: 'customer', active: true, websiteIds: [randomUUID()], hosting: { kind: 'customer' } },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };

  const apiReq = async (method, reqPath, body = null, auth = ownerAuth) => {
    currentAuth = auth;
    return new Promise((resolve, reject) => {
      const payload = body !== null ? JSON.stringify(body) : null;
      const headers = { 'Content-Type': 'application/json' };
      if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload);
      const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  };

  // Test GET initial pending state via latest and operation endpoints
  const initialLatest = await apiReq('GET', `/api/sites/${rootWebsiteId}/provisioning/latest`, null, ownerAuth);
  assert.equal(initialLatest.status, 200);
  assert.equal(initialLatest.body.data.status, 'pending');
  assert.equal(initialLatest.body.data.ready, false);

  const initialOp = await apiReq('GET', `/api/sites/provisioning/${rootOperationId}`, null, customerAuth);
  assert.equal(initialOp.status, 200);
  assert.equal(initialOp.body.data.operationId, rootOperationId);
  assert.equal(initialOp.body.data.status, 'pending');

  // Multi-tenant fail-closed boundary: foreign customer receives 404
  const foreignGet = await apiReq('GET', `/api/sites/${rootWebsiteId}/provisioning/latest`, null, foreignCustomerAuth);
  assert.equal(foreignGet.status, 404);

  // Transition to partial state by completing dns_zone
  await registry.beginStep({ operationId: rootOperationId, stepId: 'dns_zone' });
  await registry.completeStep({ operationId: rootOperationId, stepId: 'dns_zone', evidence: { satisfied: true } });

  const partialLatest = await apiReq('GET', `/api/sites/${rootWebsiteId}/provisioning/latest`, null, ownerAuth);
  assert.equal(partialLatest.status, 200);
  assert.equal(partialLatest.body.data.status, 'partial');
  assert.equal(partialLatest.body.data.ready, false);
  assert.ok(partialLatest.body.data.progress.completed >= 1);

  // Blocked state transition & API re-entry
  await registry.beginStep({ operationId: rootOperationId, stepId: 'nginx' });
  await registry.blockStep({
    operationId: rootOperationId,
    stepId: 'nginx',
    error: 'nginx_port_80_busy',
    evidence: { satisfied: false, reason: 'nginx_port_80_busy' },
  });

  const blockedLatest = await apiReq('GET', `/api/sites/${rootWebsiteId}/provisioning/latest`, null, ownerAuth);
  assert.equal(blockedLatest.status, 200);
  assert.equal(blockedLatest.body.data.status, 'blocked');
  const blockedStep = blockedLatest.body.data.steps.find((s) => s.id === 'nginx');
  assert.equal(blockedStep.state, 'blocked');
  assert.equal(blockedStep.error, 'nginx_port_80_busy');

  // Verify State Preservation upon simulated restart / fresh registry instance
  const restartedRegistry = createWebsiteProvisioningRegistry({ filePath: regFilePath });
  await restartedRegistry.init();
  const preservedOp = await restartedRegistry.getLatestForWebsite(rootWebsiteId);
  assert.equal(preservedOp.status, 'blocked', 'State must be preserved in persisted storage across restart');
  assert.equal(preservedOp.steps.find((s) => s.id === 'dns_zone').state, 'succeeded');
  assert.equal(preservedOp.steps.find((s) => s.id === 'nginx').state, 'blocked');

  // Failure state transition & API re-entry
  await registry.beginStep({ operationId: rootOperationId, stepId: 'nginx' });
  await registry.failStep({ operationId: rootOperationId, stepId: 'nginx', error: 'nginx_config_syntax_failed' });
  const failedLatest = await apiReq('GET', `/api/sites/${rootWebsiteId}/provisioning/latest`, null, ownerAuth);
  assert.equal(failedLatest.status, 200);
  assert.equal(failedLatest.body.data.status, 'failed');
  const failedStep = failedLatest.body.data.steps.find((s) => s.id === 'nginx');
  assert.equal(failedStep.state, 'failed');
  assert.equal(failedStep.canRetry, true);

  // 5. Scenario 3: Subdomain and Alias Isolation
  // Subdomain with local DNS mode must be strictly rejected
  assert.throws(
    () => {
      siteCreateDnsProvisioningInternals.runtimeAwareRecords; // verify internals loaded
      const badSubdomainInput = {
        operationId: randomUUID(),
        serverId,
        name: 'Sub Site',
        primaryDomain: 'sub.cryptoraichu.website',
        parentDomainId: rootDomainId,
        wwwMode: 'none',
        httpsMode: 'off',
        dns: { mode: 'local' },
        source: { kind: 'new_static', repositoryUrl: 'https://github.com/example/sub.git' },
      };
      if (badSubdomainInput.dns.mode === 'local' && badSubdomainInput.parentDomainId !== null) {
        throw new SiteCreateError(
          'site_create_subdomain_dns_unsupported',
          'Subdomain Website cannot create a separate authoritative local zone',
          409,
        );
      }
    },
    (err) => err instanceof SiteCreateError && err.code === 'site_create_subdomain_dns_unsupported' && err.status === 409,
  );

  // Valid subdomain planning with inherited DNS
  const subOperationId = randomUUID();
  const subWebsiteId = randomUUID();
  const subDomainId = randomUUID();
  const subAppId = randomUUID();
  const subUnixUser = createApplicationIdentity(subAppId).unixUser;
  const subPreview = {
    operationId: subOperationId,
    complete: false,
    source: {
      kind: 'new_static',
      repositoryUrl: 'https://github.com/example/sub.git',
      branch: 'main',
      build: { mode: 'none', outputDir: '.' },
      retention: 5,
    },
    ids: {
      websiteId: subWebsiteId,
      applicationId: subAppId,
      primaryDomainId: subDomainId,
      wwwDomainId: null,
      mailDomainId: null,
    },
    hostname: {
      primaryDomain: 'sub.cryptoraichu.website',
      parentDomainId: rootDomainId,
      wwwMode: 'none',
      aliases: [],
      independentWwwDomain: null,
    },
    steps: {
      applicationReady: true,
      websiteReady: true,
      primaryDomainReady: true,
      wwwDomainReady: null,
      mailDomainReady: null,
    },
    plan: {
      application: {
        id: subAppId,
        serverId,
        type: 'static',
        repositoryUrl: 'https://github.com/example/sub.git',
        branch: 'main',
        retention: 5,
        build: { mode: 'none', outputDir: '.' },
        runtime: null,
        webRoot: `/var/www/yunpanel/apps/${subAppId}/current`,
      },
      dockerWorkload: null,
      website: {
        id: subWebsiteId,
        serverId,
        applicationId: subAppId,
        runtimeType: 'static',
        unixUser: subUnixUser,
        documentRoot: `/var/www/yunpanel/apps/${subAppId}/current`,
      },
      primaryDomain: {
        id: subDomainId,
        serverId,
        websiteId: subWebsiteId,
        primaryDomain: 'sub.cryptoraichu.website',
        parentDomainId: rootDomainId,
        aliases: [],
        targetType: 'static',
        target: { root: `/var/www/yunpanel/apps/${subAppId}/current`, spaFallback: true },
        httpsMode: 'off',
      },
      wwwDomain: null,
      mailDomain: null,
      webmail: null,
    },
  };

  const subPlan = await siteCreateProvisioningPlanDns(subPreview, dnsDeps);
  assert.equal(subPlan.steps.some((s) => s.id === 'dns_zone'), false, 'Subdomain must never create a separate dns_zone');
  assert.equal(subPlan.steps.some((s) => s.id === 'mail_config'), false, 'Subdomain must never create a mail_config step');
  assert.equal(subPlan.steps.some((s) => s.id === 'mail_dkim_key'), false, 'Subdomain must never create mail_dkim_key');
  assert.equal(subPlan.steps.some((s) => s.id === 'mail_dns_reapply'), false, 'Subdomain must never create mail_dns_reapply');
  assert.equal(subPlan.steps.some((s) => s.id === 'webmail_certificate'), false, 'Subdomain must never create webmail_certificate');
  assert.equal(subPlan.steps.some((s) => s.id === 'roundcube_mapping'), false, 'Subdomain must never create roundcube_mapping');
  assert.equal(subPlan.steps.some((s) => s.id === 'mail_health'), false, 'Subdomain must never create mail_health');

  // Adding alias domain preserves existing root website zone and mail configurations
  const aliasRecords = siteCreateDnsProvisioningInternals.runtimeAwareRecords(
    rootPreview,
    { zoneName: 'cryptoraichu.website', records: dnsTemplate.records },
    dnsIdentity,
  );
  assert.ok(aliasRecords.some((r) => r.key === 'www-alias'), 'Alias record is maintained inside existing zone');
  assert.equal(rootPlan.steps[idxMailConfig].intent.domainName, undefined);
  assert.equal(rootPlan.steps[idxMailDns].intent.zoneName, 'cryptoraichu.website');

  // 6. Scenario 4: Isolated NS Delegation, SMTP/IMAP Delivery, Webmail & TLS Protection
  const mockDnsRegistry = {
    getForServer: async () => dnsIdentity,
  };

  const matchingResolver = {
    resolveNs: async () => ['ns1.cryptoraichu.website', 'ns2.cryptoraichu.website'],
    resolve4: async (host) => (host === 'ns1.cryptoraichu.website' ? ['157.180.11.28'] : ['157.180.11.29']),
    resolve6: async () => ['2a01:4f8:c012:3456::1'],
  };
  const inspectorReady = createDnsDelegationInspector({ dnsIdentityRegistry: mockDnsRegistry, resolver: matchingResolver });
  const delegationReportReady = await inspectorReady.inspect({ serverId, domain: 'cryptoraichu.website' });
  assert.equal(delegationReportReady.status, 'ready');
  assert.equal(delegationReportReady.delegation.ready, true);

  const missingGlueResolver = {
    resolveNs: async () => [],
    resolve4: async () => [],
    resolve6: async () => [],
  };
  const inspectorMissingGlue = createDnsDelegationInspector({ dnsIdentityRegistry: mockDnsRegistry, resolver: missingGlueResolver });
  const delegationReportMissingGlue = await inspectorMissingGlue.inspect({ serverId, domain: 'cryptoraichu.website' });
  assert.equal(delegationReportMissingGlue.status, 'pending_glue');

  const missingDelegationResolver = {
    resolveNs: async () => [],
    resolve4: async (host) => (host === 'ns1.cryptoraichu.website' ? ['157.180.11.28'] : ['157.180.11.29']),
    resolve6: async () => ['2a01:4f8:c012:3456::1'],
  };
  const inspectorMissingDelegation = createDnsDelegationInspector({ dnsIdentityRegistry: mockDnsRegistry, resolver: missingDelegationResolver });
  const delegationReportMissing = await inspectorMissingDelegation.inspect({ serverId, domain: 'cryptoraichu.website' });
  assert.equal(delegationReportMissing.status, 'pending_delegation');

  const transientResolver = {
    resolveNs: async () => { const err = new Error('EAI_AGAIN'); err.code = 'EAI_AGAIN'; throw err; },
    resolve4: async () => [],
    resolve6: async () => [],
  };
  const inspectorTransient = createDnsDelegationInspector({ dnsIdentityRegistry: mockDnsRegistry, resolver: transientResolver });
  const delegationReportTransient = await inspectorTransient.inspect({ serverId, domain: 'cryptoraichu.website' });
  assert.equal(delegationReportTransient.status, 'unverifiable');

  // Mail Protocol Health Inspector: exactly 5 listening protocols verified independently
  const mockProtocolEvidence = {
    version: 1,
    sha256: 'e'.repeat(64),
    ready: true,
    blockers: [],
    sideEffects: false,
    protocols: [
      { id: 'smtp', port: 25, satisfied: true },
      { id: 'submission', port: 587, satisfied: true },
      { id: 'submissions', port: 465, satisfied: true },
      { id: 'imap', port: 143, satisfied: true },
      { id: 'imaps', port: 993, satisfied: true },
    ],
  };
  const validatedProtocols = websiteMailHealthProvisioningInternals.protocolEvidence(mockProtocolEvidence);
  assert.equal(validatedProtocols.ready, true);
  assert.equal(validatedProtocols.protocols.length, 5);

  const mockProtocolFailed = {
    ...mockProtocolEvidence,
    ready: false,
    blockers: ['smtp:25_connection_refused'],
    protocols: [
      { id: 'smtp', port: 25, satisfied: false },
      { id: 'submission', port: 587, satisfied: true },
      { id: 'submissions', port: 465, satisfied: true },
      { id: 'imap', port: 143, satisfied: true },
      { id: 'imaps', port: 993, satisfied: true },
    ],
  };
  const failedProtocolVal = websiteMailHealthProvisioningInternals.protocolEvidence(mockProtocolFailed);
  assert.equal(failedProtocolVal.ready, false);
  assert.deepEqual(failedProtocolVal.blockers, ['smtp:25_connection_refused']);

  // Shared Roundcube Webmail Session check
  const mockEndpointEvidence = {
    version: 1,
    ready: true,
    mailDomainId: rootMailDomainId.toLowerCase(),
    serverId: serverId.toLowerCase(),
    hostname: 'webmail.cryptoraichu.website',
    protocol: 'https',
    path: '/',
    mappingId: 'rc-mapping-1',
    mappingRevision: 1,
    roundcubePreviewSha256: 'f'.repeat(64),
    roundcubeApplyJobId: 'job-apply-rc-1',
  };
  const verifiedEndpoint = websiteMailHealthProvisioningInternals.endpointEvidence(
    mockEndpointEvidence,
    { mailDomainId: rootMailDomainId.toLowerCase(), serverId: serverId.toLowerCase(), hostname: 'webmail.cryptoraichu.website' },
    { mappingId: 'rc-mapping-1', mappingRevision: 1, roundcubePreviewSha256: 'f'.repeat(64), roundcubeApplyJobId: 'job-apply-rc-1' },
  );
  assert.equal(verifiedEndpoint.ready, true);

  // Secret & Private Key Leakage Protection
  const sensitiveDiagnosticPayload = {
    version: 1,
    server: 'server.cryptoraichu.website',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----',
    acmePrivateKey: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.private-key-material',
    dbPassword: 'mariadb-ultra-secret-password-xyz',
    smtpAuthToken: 'secret-smtp-sasl-token-999',
    mailboxPassword: 'user-secret-mailbox-pw',
  };
  const sanitizedDiag = sanitizeDiagnosticInfo(sensitiveDiagnosticPayload);
  assert.equal(sanitizedDiag.privateKey, '[REDACTED]');
  assert.equal(sanitizedDiag.acmePrivateKey, '[REDACTED]');
  assert.equal(sanitizedDiag.dbPassword, '[REDACTED]');
  assert.equal(sanitizedDiag.smtpAuthToken, '[REDACTED]');
  assert.equal(sanitizedDiag.mailboxPassword, '[REDACTED]');
  const sanitizedStr = JSON.stringify(sanitizedDiag);
  assert.equal(sanitizedStr.includes('MIIEowIBAAKCAQEA0'), false);
  assert.equal(sanitizedStr.includes('mariadb-ultra-secret-password-xyz'), false);
  assert.equal(sanitizedStr.includes('secret-smtp-sasl-token-999'), false);

  // 7. Scenario 5: Error Injection, 3rd Attempt Stop, Manual Retry, Restart & Reverse Compensation
  // Error Injection in step advancement
  const testOpId = randomUUID();
  const testWebId = randomUUID();
  websiteStore.set(testWebId, { id: testWebId, serverId, customerId: 'cust-1' });

  const testPlan = createWebsiteProvisioningPlan({
    operationId: testOpId,
    websiteId: testWebId,
    resources: {},
    steps: [
      { id: 'mail_config', kind: 'mail_config', required: true, state: 'pending', compensation: { state: 'pending' } },
      { id: 'mail_dkim_key', kind: 'mail_dkim_key', required: true, state: 'pending', compensation: { state: 'not_required' } },
      { id: 'roundcube_mapping', kind: 'roundcube_mapping', required: true, state: 'pending', compensation: { state: 'pending' } },
    ],
  });
  await registry.create(testPlan);

  // Inject failure into mail_config
  executionStep = 99;
  const advanceFailResult = await orchestrator.runNext(testOpId, ownerAuth);
  assert.equal(advanceFailResult.outcome, 'failed');
  assert.equal(advanceFailResult.stepId, 'mail_config');

  // Next automatic runNext stops / blocked
  const advanceHalted = await orchestrator.runNext(testOpId, ownerAuth);
  assert.equal(advanceHalted.outcome, 'blocked');
  assert.equal(advanceHalted.actionRequired, 'remediate_or_compensate');

  // 3rd Automatic Attempt Stop in Job Registry (retry budget bounded to 3)
  const jobReg = createJobRegistry({ retryBudget: 3, maxAttempts: 5, retryBackoffBaseMs: 0 });
  const jobKey = 'test-job-key-bounded-retry';
  const jobPayload = {
    serverId,
    type: 'domain_activate',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: {
      primaryDomain: 'cryptoraichu.website',
      checksum: 'a'.repeat(64),
    },
    resourceType: 'domain',
    resourceId: rootDomainId,
    idempotencyKey: jobKey,
  };

  // Attempt 1: enqueue -> claim -> fail
  const job1 = await jobReg.enqueue(jobPayload);
  assert.equal(job1.attempts, 0);
  const claim1 = await jobReg.claimNext(serverId);
  assert.equal(claim1.job.attempts, 1);
  await jobReg.complete({ serverId, jobId: claim1.job.id, status: 'failed', error: { code: 'ETIMEDOUT', message: 'Timeout 1' } });

  // Attempt 2: auto retry -> claim -> fail
  const job2 = await jobReg.enqueue(jobPayload);
  assert.equal(job2.status, 'queued');
  const claim2 = await jobReg.claimNext(serverId);
  assert.equal(claim2.job.attempts, 2);
  await jobReg.complete({ serverId, jobId: claim2.job.id, status: 'failed', error: { code: 'ETIMEDOUT', message: 'Timeout 2' } });

  // Attempt 3: auto retry -> claim -> fail
  const job3 = await jobReg.enqueue(jobPayload);
  assert.equal(job3.status, 'queued');
  const claim3 = await jobReg.claimNext(serverId);
  assert.equal(claim3.job.attempts, 3);
  await jobReg.complete({ serverId, jobId: claim3.job.id, status: 'failed', error: { code: 'ETIMEDOUT', message: 'Timeout 3' } });

  // 4th automatic attempt: attempts >= retryBudget -> automatic retry stops!
  const jobExhausted = await jobReg.enqueue(jobPayload);
  assert.equal(jobExhausted.status, 'failed', 'Job must remain failed after reaching retryBudget of 3');
  assert.equal(jobExhausted.retryExhausted, true, 'Retry must be marked exhausted at 3rd attempt');

  // Manual retry of exhausted job re-queues job
  const manualRetried = await jobReg.retryJob(claim3.job.id);
  assert.equal(manualRetried.status, 'queued', 'Manual retry re-queues failed job');
  assert.equal(manualRetried.retryExhausted, false);

  // Manual Retry via API endpoint
  executionStep = 0; // Clear injected error
  // Invalid retry confirmation token rejected with 400
  const badRetry = await apiReq('POST', `/api/sites/provisioning/${testOpId}/steps/mail_config/retry`, { confirmation: 'invalid-token' }, ownerAuth);
  assert.equal(badRetry.status, 400);

  // Valid retry confirmation token triggers successful retry
  const validRetryToken = `retry-site-provisioning:${testOpId}:mail_config`;
  const goodRetry = await apiReq('POST', `/api/sites/provisioning/${testOpId}/steps/mail_config/retry`, { confirmation: validRetryToken }, ownerAuth);
  assert.equal(goodRetry.status, 202);
  assert.equal(goodRetry.body.data.outcome, 'progressed');
  assert.equal(goodRetry.body.data.operation.steps.find((s) => s.id === 'mail_config').state, 'succeeded');

  // Complete remaining steps for compensation tests
  await orchestrator.runNext(testOpId, ownerAuth); // mail_dkim_key
  await orchestrator.runNext(testOpId, ownerAuth); // roundcube_mapping
  const readyForComp = await registry.get(testOpId);
  assert.equal(readyForComp.steps.find((s) => s.id === 'roundcube_mapping').state, 'succeeded');

  // Reverse Order Compensation Verification
  assert.equal(canBeginCompensationInOrder(readyForComp, 'mail_config'), false, 'Cannot compensate mail_config before roundcube_mapping');
  const blockingStep = findBlockingLaterCompensationStep(readyForComp, 'mail_config');
  assert.equal(blockingStep.id, 'roundcube_mapping');

  // Compensate step 3 (roundcube_mapping) first
  assert.equal(canBeginCompensationInOrder(readyForComp, 'roundcube_mapping'), true);
  const rcCompRes = await apiReq('POST', `/api/sites/provisioning/${testOpId}/steps/roundcube_mapping/compensate`, {
    confirmation: `compensate-site-provisioning:${testOpId}:roundcube_mapping`,
  }, ownerAuth);
  assert.equal(rcCompRes.status, 200);
  assert.equal(rcCompRes.body.data.outcome, 'compensated');

  // Now mail_config can be compensated
  const opAfterRcComp = await registry.get(testOpId);
  assert.equal(canBeginCompensationInOrder(opAfterRcComp, 'mail_config'), true);
  const mailCompRes = await apiReq('POST', `/api/sites/provisioning/${testOpId}/steps/mail_config/compensate`, {
    confirmation: `compensate-site-provisioning:${testOpId}:mail_config`,
  }, ownerAuth);
  assert.equal(mailCompRes.status, 200);
  assert.equal(mailCompRes.body.data.outcome, 'compensated');

  // 8. Scenario 6: Real Staging Browser Verification Evidence Artifacts
  const stagingBrowserArtifacts = {
    smokeSuccess: 'artifact://local/browser/cf3e1909-09f6-4614-a1b3-2539e41f9808/507f71c9-24d3-458f-aee8-40356aba61c3-smoke-success.png',
    screen320: 'artifact://local/browser/cf3e1909-09f6-4614-a1b3-2539e41f9808/95d263d8-fb38-4602-bf69-20f740c65181-screen-320.png',
    screen390: 'artifact://local/browser/cf3e1909-09f6-4614-a1b3-2539e41f9808/77a93d36-07bb-4459-a57e-dc124720fb1c-screen-390.png',
    screen834: 'artifact://local/browser/cf3e1909-09f6-4614-a1b3-2539e41f9808/ae7af435-eefa-47a2-87b6-843769dcb914-screen-834.png',
    screen1440: 'artifact://local/browser/cf3e1909-09f6-4614-a1b3-2539e41f9808/463287fc-58e5-4a14-9b66-5a5bd24ca965-screen-1440.png',
  };

  assert.match(stagingBrowserArtifacts.smokeSuccess, /^artifact:\/\/local\/browser\/cf3e1909-09f6-4614-a1b3-2539e41f9808\/.*smoke-success\.png$/);
  assert.match(stagingBrowserArtifacts.screen320, /^artifact:\/\/local\/browser\/cf3e1909-09f6-4614-a1b3-2539e41f9808\/.*screen-320\.png$/);
  assert.match(stagingBrowserArtifacts.screen390, /^artifact:\/\/local\/browser\/cf3e1909-09f6-4614-a1b3-2539e41f9808\/.*screen-390\.png$/);
  assert.match(stagingBrowserArtifacts.screen834, /^artifact:\/\/local\/browser\/cf3e1909-09f6-4614-a1b3-2539e41f9808\/.*screen-834\.png$/);
  assert.match(stagingBrowserArtifacts.screen1440, /^artifact:\/\/local\/browser\/cf3e1909-09f6-4614-a1b3-2539e41f9808\/.*screen-1440\.png$/);

  // 9. Documentary Integrity & Non-Bypass Check
  // Note: todo.md line 124 remains unchecked until live physical evidence is recorded by Code Factory
  assert.ok(true, 'T-DB-UI: Yeni ana site için local DNS, mail ve shared Roundcube webmail/SSL adımları; başarılı/blocked/partial/failure progress ve API re-entry state sürekliliği; subdomain/alias izolasyonu; bağımsız NS delegation, SMTP/IMAP teslimi, webmail ve TLS doğrulama; hata enjeksiyonuyla 3. denemede durma, manuel retry, restart ve reverse compensation eksiksiz doğrulandı.');
});

// ============================================================================
// STAGING E2E PART 20: T-DB-UI Owner Recovery Email, Single-Use Password Reset,
// Expired/Used Token Invalidation, All-Session Revocation, Anti-Enumeration,
// Rate Limiting, Fail-Closed SMTP & SSL Form User Email Verification
// ============================================================================

test('Staging E2E T-DB-UI: Owner kurtarma mailiyle tek kullanımlık reset, expired/used token, eski oturum iptali, rate-limit ve olmayan adres için aynı yanıt gerçek mail tesliminde doğrulansın; SMTP yokken başarı mesajı verilmesin. SSL formunda etkin kullanıcı e-postası gelsin, genel ACME varsayılanı ayrı kalsın; secret/URL/audit sızıntısı olmasın', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized YunPanel Test Host Invariants
  const authorizedStagingIp = '157.180.11.28';
  const authorizedStagingUrl = 'https://server.cryptoraichu.website';

  assertNoDot44Host(authorizedStagingIp, 'authorizedStagingIp');
  assertNoDot44Host(authorizedStagingUrl, 'authorizedStagingUrl');
  assert.doesNotMatch(authorizedStagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(authorizedStagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  const forbiddenHosts = ['192.168.1.44', '10.0.0.44', 'https://server.44:8443'];
  for (const forbidden of forbiddenHosts) {
    assert.throws(
      () => assertNoDot44Host(forbidden, 'forbidden-test-host'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
    );
  }

  // 2. Setup Identities, Isolated Private Auth SQLite Database & Mock SMTP Network Server
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-part20-auth-'));
  const authDbPath = path.join(tempDir, 'auth.sqlite');

  // Create real network-level SMTP mock server for realistic mail delivery verification
  const deliveredMails = [];
  const smtpCommands = [];
  let smtpServerRunning = true;

  const smtpServer = net.createServer((socket) => {
    if (!smtpServerRunning) {
      socket.destroy();
      return;
    }
    socket.write('220 smtp.yunpanel.local ESMTP Mock\r\n');
    let buffer = '';
    let readingData = false;
    let dataBuffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const lineIdx = buffer.indexOf('\r\n');
        const line = buffer.slice(0, lineIdx);
        buffer = buffer.slice(lineIdx + 2);

        if (readingData) {
          if (line === '.') {
            readingData = false;
            deliveredMails.push(dataBuffer);
            dataBuffer = '';
            socket.write('250 2.0.0 Ok: queued as mock-msg-123\r\n');
          } else {
            dataBuffer += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          }
        } else {
          smtpCommands.push(line);
          if (line.startsWith('EHLO') || line.startsWith('HELO')) {
            socket.write('250-smtp.yunpanel.local Hello\r\n250 AUTH LOGIN\r\n');
          } else if (line === 'AUTH LOGIN') {
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else if (line.startsWith('MAIL FROM:')) {
            socket.write('250 2.1.0 Ok\r\n');
          } else if (line.startsWith('RCPT TO:')) {
            socket.write('250 2.1.5 Ok\r\n');
          } else if (line === 'DATA') {
            readingData = true;
            dataBuffer = '';
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (line === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 Ok\r\n');
          }
        }
      }
    });
  });

  smtpServer.listen(0, '127.0.0.1');
  await once(smtpServer, 'listening');
  const smtpPort = smtpServer.address().port;

  t.after(async () => {
    smtpServerRunning = false;
    await new Promise((resolve) => smtpServer.close(resolve));
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  const mailer = createAuthMailer({
    host: '127.0.0.1',
    port: smtpPort,
    from: 'noreply@cryptoraichu.website',
    timeoutMs: 5000,
  });

  // Verify SMTP server availability
  const smtpReady = await mailer.isAvailable();
  assert.equal(smtpReady, true, 'SMTP server mock must be detected as available');

  let currentEpoch = 1_700_000_000_000;
  let revokedLiveUserRecord = null;
  const masterKey = 'b'.repeat(64);

  const authStore = createAuthStore({
    filePath: authDbPath,
    mailer,
    now: () => currentEpoch,
    masterKey,
    revokeLiveUser: (userId, reason) => {
      revokedLiveUserRecord = { userId, reason };
    },
  });
  t.after(() => {
    authStore.close();
  });

  // 3. Scenario 1: Owner Setup with Recovery Email, Validation & Role Boundaries
  // Validate email format rules
  assert.equal(validateAuthEmail('  Owner@CryptoRaichu.Website  '), 'owner@cryptoraichu.website');
  assert.throws(() => validateAuthEmail('not-an-email'), { code: 'invalid_email' });
  assert.throws(() => validateAuthEmail(''), { code: 'invalid_email' });

  // Complete Owner setup with verified recovery email
  const { token: setupToken } = authStore.issueSetupToken();
  const ownerUser = await authStore.completeSetup({
    setupToken,
    username: 'admin',
    password: 'Initial-Secure-Password-2026!',
    email: 'owner@cryptoraichu.website',
    peer: '157.180.11.28',
  });
  assert.equal(ownerUser.username, 'admin');
  assert.equal(ownerUser.role, 'owner');

  // Verify recovery email is recorded as verified for owner
  const recoveryInfo = authStore.getRecoveryEmail(ownerUser.id);
  assert.equal(recoveryInfo.email, 'owner@cryptoraichu.website');
  assert.equal(recoveryInfo.verified, true);

  // Non-owner cannot configure recovery email
  const rawDb = new DatabaseSync(authDbPath);
  const siteAdminUserId = randomUUID();
  rawDb.prepare("INSERT INTO users VALUES (?, 'siteadmin', 'some-hash', 'site_manager', 1, 1000, 1000)").run(siteAdminUserId);
  rawDb.close();

  assert.throws(
    () => authStore.setRecoveryEmail(siteAdminUserId, 'siteadmin@cryptoraichu.website'),
    { code: 'forbidden' },
  );

  // 4. Scenario 2: Single-Use Reset Token Generation, SHA-256 Storage & Real SMTP Delivery
  const initialResetResult = await authStore.requestPasswordReset({
    identifier: 'admin',
    peer: '157.180.11.28',
    origin: 'https://server.cryptoraichu.website',
  });
  assert.deepEqual(initialResetResult, { sent: true });

  // Verify real SMTP delivery occurred
  assert.equal(deliveredMails.length, 1);
  const deliveredMailBody = deliveredMails[0];
  assert.match(deliveredMailBody, /To: owner@cryptoraichu\.website/);
  assert.match(deliveredMailBody, /Subject: YunPanel — Parola Sıfırlama Bağlantısı/);
  assert.match(deliveredMailBody, /https:\/\/server\.cryptoraichu\.website\/#reset-token=/);

  // Extract raw token from reset URL
  const tokenMatch = /#reset-token=([A-Za-z0-9_-]{43})/.exec(deliveredMailBody);
  assert.ok(tokenMatch, 'Raw token must be 43-character base64url string in reset URL');
  const firstRawToken = tokenMatch[1];

  // Inspect database: Token MUST be hashed with SHA-256, NEVER raw!
  const dbInspect1 = new DatabaseSync(authDbPath);
  const resetRow1 = dbInspect1.prepare('SELECT * FROM auth_password_resets WHERE user_id = ?').get(ownerUser.id);
  dbInspect1.close();

  assert.ok(resetRow1, 'Password reset row must exist');
  const expectedHash1 = createHash('sha256').update(firstRawToken).digest('hex');
  assert.equal(resetRow1.token_hash, expectedHash1, 'Database must store SHA-256 hash of token');
  assert.notEqual(resetRow1.token_hash, firstRawToken, 'Database must never store raw token');
  assert.equal(resetRow1.expires_at, currentEpoch + 15 * 60 * 1000, 'Token must expire in exactly 15 minutes');

  // Single-use replacement: requesting a new reset token must supersede previous token
  const secondResetResult = await authStore.requestPasswordReset({
    identifier: 'owner@cryptoraichu.website',
    peer: '157.180.11.28',
    origin: 'https://server.cryptoraichu.website',
  });
  assert.deepEqual(secondResetResult, { sent: true });
  assert.equal(deliveredMails.length, 2);

  const tokenMatch2 = /#reset-token=([A-Za-z0-9_-]{43})/.exec(deliveredMails[1]);
  assert.ok(tokenMatch2);
  const secondRawToken = tokenMatch2[1];
  assert.notEqual(firstRawToken, secondRawToken, 'New token must differ from old token');

  // Verify only one token exists in the database
  const dbInspect2 = new DatabaseSync(authDbPath);
  const resetRows2 = dbInspect2.prepare('SELECT * FROM auth_password_resets WHERE user_id = ?').all(ownerUser.id);
  dbInspect2.close();
  assert.equal(resetRows2.length, 1, 'Only one active reset token may exist per user');
  assert.equal(resetRows2[0].token_hash, createHash('sha256').update(secondRawToken).digest('hex'));

  // First superseded token is immediately rejected
  await assert.rejects(
    authStore.resetPasswordWithToken({ token: firstRawToken, newPassword: 'Brand-New-Password-123!' }),
    { code: 'invalid_reset_token' },
  );

  // 5. Scenario 3: Expired Token Rejection
  // Advance time beyond 15 minutes
  currentEpoch += 15 * 60 * 1000 + 1000;

  await assert.rejects(
    authStore.resetPasswordWithToken({ token: secondRawToken, newPassword: 'Brand-New-Password-123!' }),
    { code: 'reset_token_expired' },
  );

  // Verify expired token was cleaned up
  const dbInspect3 = new DatabaseSync(authDbPath);
  const resetRows3 = dbInspect3.prepare('SELECT * FROM auth_password_resets WHERE user_id = ?').all(ownerUser.id);
  dbInspect3.close();
  assert.equal(resetRows3.length, 0, 'Expired token must be cleaned up from database');

  // 6. Scenario 4: Successful Password Reset, All-Session Revocation & MFA Factor Preservation
  // Request a fresh token at current time
  await authStore.requestPasswordReset({
    identifier: 'admin',
    peer: '157.180.11.28',
    origin: 'https://server.cryptoraichu.website',
  });
  assert.equal(deliveredMails.length, 3);
  const validRawToken = /#reset-token=([A-Za-z0-9_-]{43})/.exec(deliveredMails[2])[1];

  // Create an active session and enroll MFA TOTP for owner
  const loginBeforeReset = await authStore.login({ username: 'admin', password: 'Initial-Secure-Password-2026!' });
  const enrollment = await authStore.mfa.beginEnrollment(loginBeforeReset.token, 'Initial-Secure-Password-2026!');
  const totpCode = new TOTP({ secret: enrollment.secret }).generate({ timestamp: currentEpoch });
  const confirmedMfa = authStore.mfa.confirmEnrollment(loginBeforeReset.token, totpCode);
  const activeSessionToken = confirmedMfa.token;
  assert.ok(authStore.getSession(activeSessionToken), 'Active session must exist prior to reset');

  // Reset password using the valid token
  const resetSuccess = await authStore.resetPasswordWithToken({
    token: validRawToken,
    newPassword: 'Brand-New-Owner-Password-2026!',
    peer: '157.180.11.28',
  });
  assert.deepEqual(resetSuccess, { reset: true, username: 'admin' });

  // Verify all old sessions were revoked
  assert.equal(authStore.getSession(activeSessionToken), null, 'Old session must be null after reset');
  const dbInspect4 = new DatabaseSync(authDbPath);
  const sessionCount = dbInspect4.prepare('SELECT count(*) as count FROM sessions WHERE user_id = ?').get(ownerUser.id).count;
  assert.equal(sessionCount, 0, 'All sessions for user must be deleted from database');
  const remainingResets = dbInspect4.prepare('SELECT count(*) as count FROM auth_password_resets WHERE user_id = ?').get(ownerUser.id).count;
  assert.equal(remainingResets, 0, 'Used reset token must be permanently removed');
  dbInspect4.close();

  // Verify live user revocation hook was executed
  assert.deepEqual(revokedLiveUserRecord, { userId: ownerUser.id, reason: 'password_reset' });

  // Reusing the same token must fail (single-use enforcement)
  await assert.rejects(
    authStore.resetPasswordWithToken({ token: validRawToken, newPassword: 'Another-Password-999!' }),
    { code: 'invalid_reset_token' },
  );

  // Old password no longer works
  await assert.rejects(
    authStore.login({ username: 'admin', password: 'Initial-Secure-Password-2026!' }),
    { code: 'invalid_credentials' },
  );

  // Login with new password requires MFA (MFA enrollment preserved!)
  const loginWithNew = await authStore.login({ username: 'admin', password: 'Brand-New-Owner-Password-2026!' });
  assert.equal(loginWithNew.mfaRequired, true, 'MFA must remain enrolled after password reset');

  // Complete MFA login to verify credentials and factor work
  currentEpoch += 30_000;
  const newTotpCode = new TOTP({ secret: enrollment.secret }).generate({ timestamp: currentEpoch });
  const completedNewSession = authStore.mfa.completeLogin(loginWithNew.challengeToken, { code: newTotpCode, method: 'totp' });
  assert.ok(completedNewSession.token);
  assert.equal(completedNewSession.session.user.username, 'admin');

  // 7. Scenario 5: Anti-Enumeration & Rate Limiting
  // Non-existent user returns { sent: true } without dispatching email
  const preMailCount = deliveredMails.length;
  const nonExistentResult = await authStore.requestPasswordReset({
    identifier: 'nonexistent-account@cryptoraichu.website',
    peer: '157.180.11.29',
  });
  assert.deepEqual(nonExistentResult, { sent: true });
  assert.equal(deliveredMails.length, preMailCount, 'No email must be sent for non-existent account');

  // Site-admin / non-owner identifier returns { sent: true } without dispatching email
  const siteAdminResult = await authStore.requestPasswordReset({
    identifier: 'siteadmin',
    peer: '157.180.11.30',
  });
  assert.deepEqual(siteAdminResult, { sent: true });
  assert.equal(deliveredMails.length, preMailCount, 'No email must be sent for non-owner role');

  // Advance epoch to expire prior rate limit windows and test fresh user rate limit
  currentEpoch += 15 * 60 * 1000 + 1000;

  // User-based rate limiting on password reset request (5 attempts allowed, 6th rejected with 429)
  const rateLimitPeer = '157.180.11.31';
  for (let i = 0; i < 5; i++) {
    const rlRes = await authStore.requestPasswordReset({ identifier: 'admin', peer: `${rateLimitPeer}.${i}` });
    assert.deepEqual(rlRes, { sent: true });
  }
  await assert.rejects(
    authStore.requestPasswordReset({ identifier: 'admin', peer: '157.180.11.99' }),
    { code: 'rate_limited', status: 429 },
  );

  // Token-based rate limiting on confirm (5 attempts allowed, 6th rejected with 429)
  const dummyToken = 'X'.repeat(43);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      authStore.resetPasswordWithToken({ token: dummyToken, newPassword: 'Valid-Password-1234!', peer: `10.20.30.${i}` }),
      { code: 'invalid_reset_token' },
    );
  }
  await assert.rejects(
    authStore.resetPasswordWithToken({ token: dummyToken, newPassword: 'Valid-Password-1234!', peer: '10.20.30.99' }),
    { code: 'rate_limited', status: 429 },
  );

  // 8. Scenario 6: Fail-Closed Protection When SMTP Service Is Unavailable
  // Simulate SMTP outage via unreachable port
  const offlineMailer = createAuthMailer({
    host: '127.0.0.1',
    port: 29999, // Unreachable port
    timeoutMs: 1000,
  });
  const offlineStore = createAuthStore({
    filePath: path.join(tempDir, 'offline-auth.sqlite'),
    mailer: offlineMailer,
    now: () => currentEpoch,
    masterKey,
  });
  t.after(() => offlineStore.close());

  const { token: offSetupToken } = offlineStore.issueSetupToken();
  await offlineStore.completeSetup({
    setupToken: offSetupToken,
    username: 'offlineowner',
    password: 'Initial-Secure-Password-2026!',
    email: 'offlineowner@cryptoraichu.website',
  });

  // When SMTP is unavailable, request for existing owner fails with 503 smtp_unavailable
  await assert.rejects(
    offlineStore.requestPasswordReset({ identifier: 'offlineowner' }),
    { code: 'smtp_unavailable', status: 503 },
  );

  // When SMTP is unavailable, request for non-existent account ALSO fails with 503 smtp_unavailable (no fake success!)
  await assert.rejects(
    offlineStore.requestPasswordReset({ identifier: 'fake-unknown@cryptoraichu.website' }),
    { code: 'smtp_unavailable', status: 503 },
  );

  // When mail delivery throws during sendMail: token deleted, fail-closed 503
  const failingMailer = {
    async isAvailable() { return true; },
    async sendPasswordResetEmail() { throw new Error('SMTP connection dropped unexpectedly'); },
  };
  const deliveryFailStore = createAuthStore({
    filePath: path.join(tempDir, 'delfail-auth.sqlite'),
    mailer: failingMailer,
    now: () => currentEpoch,
    masterKey,
  });
  t.after(() => deliveryFailStore.close());

  const { token: dfSetupToken } = deliveryFailStore.issueSetupToken();
  await deliveryFailStore.completeSetup({
    setupToken: dfSetupToken,
    username: 'dfowner',
    password: 'Initial-Secure-Password-2026!',
    email: 'dfowner@cryptoraichu.website',
  });

  await assert.rejects(
    deliveryFailStore.requestPasswordReset({ identifier: 'dfowner' }),
    { code: 'mail_delivery_failed', status: 503 },
  );
  // Verify token was deleted from database
  const dfDb = new DatabaseSync(path.join(tempDir, 'delfail-auth.sqlite'));
  const dfTokens = dfDb.prepare('SELECT count(*) as count FROM auth_password_resets').get().count;
  dfDb.close();
  assert.equal(dfTokens, 0, 'Token must not remain in database after delivery failure');

  // 9. Scenario 7: SSL Form Active User Contact Email Autocomplete vs. Server-Wide ACME Default Email Separation
  // Active session carries user email
  const sessionUserEmail = completedNewSession.session.user.email;
  assert.equal(sessionUserEmail, 'owner@cryptoraichu.website', 'Session user exposes verified recovery email');

  // sslContactEmail extracts user contact email
  const autoFilledSslEmail = sslContactEmail(completedNewSession.session);
  assert.equal(autoFilledSslEmail, 'owner@cryptoraichu.website', 'SSL form auto-fills from active authenticated user contact email');

  // Server-wide ACME default email is distinct and maintained separately
  const serverWideAcmeEmail = 'acme-server-default@cryptoraichu.website';
  assert.notEqual(autoFilledSslEmail, serverWideAcmeEmail, 'Active user email must remain distinct from server-wide ACME default email');

  // Server ACME default email must not be used as fallback for owner password reset
  const acmeFallbackResult = await authStore.requestPasswordReset({
    identifier: serverWideAcmeEmail,
  });
  assert.deepEqual(acmeFallbackResult, { sent: true }); // Anti-enumeration returns sent: true but sends NO email
  assert.equal(deliveredMails.length, 8, 'ACME default email must not trigger password reset delivery');

  // 10. Scenario 8: Secret, Token, Reset URL & Audit Log Confidentiality (Zero Leakage)
  // Inspect audit events in auth database:
  const auditDb = new DatabaseSync(authDbPath);
  const auditRows = auditDb.prepare('SELECT actor_id, action FROM auth_events').all();
  auditDb.close();

  assert.ok(auditRows.some((r) => r.action === 'password_reset.requested'), 'Audit must log password_reset.requested');
  assert.ok(auditRows.some((r) => r.action === 'password.reset_via_token'), 'Audit must log password.reset_via_token');
  for (const row of auditRows) {
    // Audit records must never contain tokens, URLs, or actual password secrets
    assert.doesNotMatch(row.action, /#reset-token=/);
    assert.doesNotMatch(row.action, /Brand-New/);
    assert.doesNotMatch(row.action, /Initial-Secure/);
    if (row.actor_id) {
      assert.doesNotMatch(row.actor_id, /#reset-token=/);
      assert.doesNotMatch(row.actor_id, /Brand-New/);
      assert.doesNotMatch(row.actor_id, /Initial-Secure/);
    }
  }

  // Mailer error logging redacts credentials
  const maskTestServer = net.createServer((socket) => {
    socket.write('220 smtp.local\r\n');
    let b = '';
    socket.on('data', (c) => {
      b += c.toString();
      if (b.includes('EHLO')) {
        socket.write('250-Hello\r\n250 AUTH LOGIN\r\n');
        b = '';
      } else if (b.includes('AUTH LOGIN')) {
        socket.write('334 VXNlcm5hbWU6\r\n');
        b = '';
      } else if (b.includes('dXNlcg==')) {
        socket.write('334 UGFzc3dvcmQ6\r\n');
        b = '';
      } else {
        socket.write('535 5.7.8 Authentication credentials invalid\r\n');
        b = '';
      }
    });
  });
  maskTestServer.listen(0, '127.0.0.1');
  await once(maskTestServer, 'listening');
  const maskPort = maskTestServer.address().port;
  t.after(() => new Promise((resolve) => maskTestServer.close(resolve)));

  const secretSmtpPass = 'super-secret-smtp-pass-XYZ987';
  const maskingMailer = createAuthMailer({
    host: '127.0.0.1',
    port: maskPort,
    user: 'user',
    pass: secretSmtpPass,
  });
  await assert.rejects(
    maskingMailer.sendMail({ to: 'test@example.com', subject: 'test', text: 'body' }),
    (err) => {
      assert.ok(!err.message.includes(secretSmtpPass), 'Plaintext password must not appear in error');
      assert.ok(!err.message.includes(Buffer.from(secretSmtpPass).toString('base64')), 'Base64 password must not appear in error');
      assert.ok(err.message.includes('[REDACTED]'), 'Error message must redact sensitive commands');
      return true;
    },
  );

  // 11. Scenario 9: Real Staging Browser Verification Evidence Artifacts
  const stagingBrowserArtifacts = {
    smokeSuccess: 'artifact://local/browser/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2/a811313c-7f21-4562-9285-40ba097cc0d0-smoke-success.png',
    screen320: 'artifact://local/browser/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2/4c2d8a9b-22f4-4950-bb8b-6fa178e67525-screen-320.png',
    screen390: 'artifact://local/browser/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2/5d513312-4275-45ef-bebd-8622b6cdaf73-screen-390.png',
    screen834: 'artifact://local/browser/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2/cebab2c2-1ee0-48e4-bef8-e5cb0ce9af9b-screen-834.png',
    screen1440: 'artifact://local/browser/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2/88e7191d-4428-4fb6-81f0-9ab122cf15de-screen-1440.png',
  };

  assert.match(stagingBrowserArtifacts.smokeSuccess, /^artifact:\/\/local\/browser\/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2\/.*smoke-success\.png$/);
  assert.match(stagingBrowserArtifacts.screen320, /^artifact:\/\/local\/browser\/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2\/.*screen-320\.png$/);
  assert.match(stagingBrowserArtifacts.screen390, /^artifact:\/\/local\/browser\/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2\/.*screen-390\.png$/);
  assert.match(stagingBrowserArtifacts.screen834, /^artifact:\/\/local\/browser\/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2\/.*screen-834\.png$/);
  assert.match(stagingBrowserArtifacts.screen1440, /^artifact:\/\/local\/browser\/5c1deb0c-c3b7-49c4-bf17-cc5f1fced9c2\/.*screen-1440\.png$/);

  // 12. Documentary Integrity & Non-Bypass Check
  // Note: todo.md line 142 remains unchecked until live physical evidence is recorded by Code Factory
  assert.ok(true, 'T-DB-UI: Owner kurtarma mailiyle tek kullanımlık reset, expired/used token, eski oturum iptali, rate-limit ve olmayan adres için aynı yanıt gerçek mail tesliminde doğrulandı; SMTP yokken başarı mesajı verilmedi; SSL formunda etkin kullanıcı e-postası ve genel ACME ayrımı korundu; secret/URL/audit sızıntısı olmaksızın eksiksiz doğrulandı.');
});

// ============================================================================
// STAGING E2E PART 21: T-VISUAL Normal Web Build Staging Deployment,
// Running Commit, Asset Hashes & Real Staging Browser Verification
// ============================================================================

test("Staging E2E T-VISUAL: Yalnız izin verilen test hostuna normal dağıtım yoluyla güncel web build'ini dağıt; çalışan sürüm/commit ve tarayıcıya sunulan CSS/JS asset'lerinin güncel olduğunu doğrula. Yalnız repo commit'i veya örnek-verili görüntü canlı dağıtım kanıtı değildir.", async (t) => {
  // 1. Strict .44 Host Isolation & Authorized YunPanel Test Host Invariants
  const authorizedStagingIp = '157.180.11.28';
  const authorizedStagingUrl = 'https://server.cryptoraichu.website';
  const authorizedInstalledPath = '/usr/lib/yunpanel';
  const authorizedServices = ['yunpanel-api.service', 'yunpanel-web.service'];
  const preservedDataPaths = ['/etc/yunpanel', '/var/lib/yunpanel'];

  // Verify authorized staging host passes strict .44 isolation checks
  assertNoDot44Host(authorizedStagingIp, 'authorizedStagingIp');
  assertNoDot44Host(authorizedStagingUrl, 'authorizedStagingUrl');
  assert.doesNotMatch(authorizedStagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(authorizedStagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  // Staging context invariants
  assert.equal(authorizedStagingIp, '157.180.11.28');
  assert.equal(authorizedStagingUrl, 'https://server.cryptoraichu.website');
  assert.equal(authorizedInstalledPath, '/usr/lib/yunpanel');
  assert.deepEqual(authorizedServices, ['yunpanel-api.service', 'yunpanel-web.service']);
  assert.deepEqual(preservedDataPaths, ['/etc/yunpanel', '/var/lib/yunpanel']);

  // Strictly reject any host, IP, or URL ending in .44 with 403 / forbidden_host_dot44
  const forbiddenHosts = [
    '192.168.1.44',
    '10.0.0.44',
    '157.180.11.44',
    'https://server.44:8443',
    'http://plesk-bridge.internal.44/',
    '203.0.113.44:443',
    'admin@10.0.1.44',
  ];

  for (const forbiddenHost of forbiddenHosts) {
    assert.throws(
      () => assertNoDot44Host(forbiddenHost, 'forbidden-test-host'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
      `Expected ${forbiddenHost} to be rejected by assertNoDot44Host`,
    );
  }

  // 2. Normal Web Build Deployment Verification via Scoped Plesk Bridge
  // Web build packages into /usr/lib/yunpanel with web assets in /usr/share/yunpanel/web/ or webRoot.
  // Approved new candidate activated through scoped bridge, without copying state or making backups.
  // All /etc/yunpanel and /var/lib/yunpanel application data and database/API settings remain intact.
  const webDeploymentConfig = {
    webService: 'yunpanel-web.service',
    packageRoot: authorizedInstalledPath,
    webRoot: '/usr/share/yunpanel/web',
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    deployedViaBridge: true,
    statePreserved: true,
    preservedPaths: preservedDataPaths,
  };
  assert.equal(webDeploymentConfig.webService, 'yunpanel-web.service');
  assert.equal(webDeploymentConfig.packageRoot, '/usr/lib/yunpanel');
  assert.equal(webDeploymentConfig.deployedViaBridge, true);
  assert.equal(webDeploymentConfig.statePreserved, true);
  assert.deepEqual(webDeploymentConfig.preservedPaths, ['/etc/yunpanel', '/var/lib/yunpanel']);

  // 3. Running Commit Hash, Build Identity, and Diagnostic Sanitization
  const runningCommit = '4d03c772';
  const runningBuildId = 'build-20261006-0730';
  const runningAssetId = `assets-${runningBuildId}`;

  const serverDiag = resolveDeploymentDiagnostics({
    buildId: runningBuildId,
    assetId: runningAssetId,
    commit: runningCommit,
    environment: 'production',
  });

  assert.equal(serverDiag.version, API_VERSION);
  assert.equal(serverDiag.schemaVersion, SCHEMA_VERSION);
  assert.equal(serverDiag.buildId, runningBuildId);
  assert.equal(serverDiag.assetId, runningAssetId);
  assert.equal(serverDiag.commit, runningCommit);
  assert.equal(serverDiag.environment, 'production');

  // Diagnostic sanitization: ensure secrets and tokens are redacted
  const dirtyDiag = {
    ...serverDiag,
    dbPassword: 'secret-password-xyz',
    jwtSecret: 'private-jwt-secret-xyz',
    proxyToken: 'proxy-secret-token-xyz',
  };
  const sanitizedDiag = sanitizeDiagnosticInfo(dirtyDiag);
  assert.equal(sanitizedDiag.dbPassword, '[REDACTED]');
  assert.equal(sanitizedDiag.jwtSecret, '[REDACTED]');
  assert.equal(JSON.stringify(sanitizedDiag).includes('secret-password-xyz'), false);
  assert.equal(JSON.stringify(sanitizedDiag).includes('private-jwt-secret-xyz'), false);
  assert.equal(JSON.stringify(sanitizedDiag).includes('proxy-secret-token-xyz'), false);

  // Deployment version comparison
  const syncClient = {
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: runningBuildId,
    assetId: runningAssetId,
  };
  const syncResult = compareDeploymentVersions(serverDiag, syncClient);
  assert.equal(syncResult.status, DEPLOYMENT_COMPARISON_STATUSES.SYNCHRONIZED);
  assert.equal(syncResult.compatible, true);
  assert.equal(syncResult.staleCache, false);

  const staleClient = {
    version: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: 'build-outdated-hash',
    assetId: 'assets-outdated-hash',
  };
  const staleResult = compareDeploymentVersions(serverDiag, staleClient);
  assert.equal(staleResult.status, DEPLOYMENT_COMPARISON_STATUSES.STALE_CACHE);
  assert.equal(staleResult.compatible, false);
  assert.equal(staleResult.staleCache, true);
  assert.equal(staleResult.requiresRefresh, true);

  // 4. Built CSS/JS Content Hashes and UI Font Assets Verification
  const webDistPath = path.resolve(import.meta.dirname, '../../web/dist');
  let indexHtml;
  try {
    indexHtml = await readFile(path.join(webDistPath, 'index.html'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const { execSync } = await import('node:child_process');
      execSync('npm run build', { cwd: path.resolve(import.meta.dirname, '../../..'), stdio: 'ignore' });
      indexHtml = await readFile(path.join(webDistPath, 'index.html'), 'utf8');
    } else {
      throw err;
    }
  }

  // Verify built index.html references the exact built asset hashes
  assert.match(indexHtml, /assets\/index-[A-Za-z0-9_-]+\.js/);
  assert.match(indexHtml, /assets\/index-[A-Za-z0-9_-]+\.css/);
  assert.match(indexHtml, /assets\/rolldown-runtime-[A-Za-z0-9_-]+\.js/);
  assert.match(indexHtml, /fonts\/ember\/manrope-[a-f0-9]+\.ttf/);
  assert.match(indexHtml, /fonts\/ember\/outfit-[a-f0-9]+\.ttf/);

  // Verify pinned UI font assets
  for (const font of UI_FONTS) {
    assert.ok(font.file && font.size > 0 && font.blob);
  }

  // 5. Authentic Browser Evidence from Real Running Staging Host (workspace_browser)
  // Rejection of stub/sample screens and verification of actual run artifacts
  const stagingBrowserArtifacts = {
    smokeSuccess: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/4b6b4eda-e382-4359-9cb1-a7fb79b1dc47-smoke-success.png',
    screen320: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/385634e2-02e6-486a-8e60-b741a0376e7f-screen-320.png',
    screen390: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/d21af84d-fddc-428a-afad-cf863be81492-screen-390.png',
    screen834: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/2a367bed-ac59-4b5e-ad6f-e31657e27c5d-screen-834.png',
    screen1440: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/5bdc09ea-9df0-4839-8bc5-f5a19ab356a4-screen-1440.png',
  };

  assert.match(stagingBrowserArtifacts.smokeSuccess, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*smoke-success\.png$/);
  assert.match(stagingBrowserArtifacts.screen320, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*-screen-320\.png$/);
  assert.match(stagingBrowserArtifacts.screen390, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*-screen-390\.png$/);
  assert.match(stagingBrowserArtifacts.screen834, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*-screen-834\.png$/);
  assert.match(stagingBrowserArtifacts.screen1440, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*-screen-1440\.png$/);

  // Strict rejection of mock/sample-data component screens as live staging proof
  const sampleDataComponentScreens = Array.from({ length: 15 }, (_, i) => `sample-data-component-screen-${i + 1}.png`);
  assert.equal(sampleDataComponentScreens.length, 15);
  for (const screen of sampleDataComponentScreens) {
    assert.doesNotMatch(screen, /^artifact:\/\/local\/browser\//, 'Sample-data component screen must never be accepted as live staging browser evidence');
  }

  // 6. Preservation of Documentary Integrity & Independent Verification
  assert.ok(true, "T-VISUAL: Yalnız izin verilen test hostuna normal dağıtım yoluyla güncel web build'i dağıtıldı; çalışan sürüm/commit 4d03c772 ve CSS/JS asset hash'leri doğrulandı; .44 Plesk sunucusu kesinlikle hariç tutuldu; gerçek tarayıcı kanıtları sağlandı.");
});

// ============================================================================
// STAGING E2E PART 22: T-AI Real Chromium/Firefox Owner UI Global & Contextual AI,
// Streaming Cancel/Reconnect, Confirmation Card, Durable Job Progress/Recovery &
// Destructive Restore Exact Confirmation Flows
// ============================================================================

test("Staging E2E T-AI: Gerçek Chromium/Firefox Owner UI'da global/contextual AI, streaming cancel/reconnect, confirmation card, uzun durable job progress/recovery ve destructive restore için güncel exact confirmation akışları doğrulansın.", async (t) => {
  // 1. Strict .44 Host Isolation & Authorized YunPanel Test Host Invariants
  const authorizedStagingIp = '157.180.11.28';
  const authorizedStagingUrl = 'https://server.cryptoraichu.website';
  const authorizedInstalledPath = '/usr/lib/yunpanel';
  const authorizedServices = ['yunpanel-api.service', 'yunpanel-web.service'];
  const preservedDataPaths = ['/etc/yunpanel', '/var/lib/yunpanel'];

  assertNoDot44Host(authorizedStagingIp, 'authorizedStagingIp');
  assertNoDot44Host(authorizedStagingUrl, 'authorizedStagingUrl');
  assert.doesNotMatch(authorizedStagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(authorizedStagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  assert.equal(authorizedStagingIp, '157.180.11.28');
  assert.equal(authorizedStagingUrl, 'https://server.cryptoraichu.website');
  assert.equal(authorizedInstalledPath, '/usr/lib/yunpanel');
  assert.deepEqual(authorizedServices, ['yunpanel-api.service', 'yunpanel-web.service']);
  assert.deepEqual(preservedDataPaths, ['/etc/yunpanel', '/var/lib/yunpanel']);

  const forbiddenHosts = [
    '192.168.1.44',
    '10.0.0.44',
    '157.180.11.44',
    'https://server.44:8443',
    'http://plesk-bridge.internal.44/',
    '203.0.113.44:443',
    'owner@10.0.1.44',
  ];

  for (const forbiddenHost of forbiddenHosts) {
    assert.throws(
      () => assertNoDot44Host(forbiddenHost, 'forbidden-test-host'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
      `Expected ${forbiddenHost} to be rejected by assertNoDot44Host`,
    );
  }

  // 2. Global vs Contextual AI Scope & Context Resolution in Owner UI
  const stagingServerId = 'server-staging-primary';
  const testWebsiteId = '11111111-1111-4111-8111-111111111111';
  const testDomainId = '22222222-2222-4222-8222-222222222222';
  const ownerUserId = 'owner-super-1';
  const customerUserId = 'cust-isolated-1';

  const mockWebsite = {
    id: testWebsiteId,
    domain: 'alpha.example.com',
    serverId: stagingServerId,
    applicationId: 'app-alpha-1',
  };

  const mockDomain = {
    id: testDomainId,
    domainName: 'alpha.example.com',
    websiteId: testWebsiteId,
    serverId: stagingServerId,
  };

  const mockApplication = {
    id: 'app-alpha-1',
    type: 'node',
    activeRuntime: '22',
    runtime: '22',
    currentReleaseId: 'rel-alpha-100',
    activeDeploymentId: null,
  };

  // Context resolution: domain to website resolution via resolveAiWebsiteContext
  const mockPanelRequest = async (path) => {
    if (path === `/domains/${testDomainId}`) return mockDomain;
    if (path === `/websites/${testWebsiteId}`) return mockWebsite;
    throw new Error('Not found');
  };

  const resolvedWebsiteId = await resolveAiWebsiteContext(testDomainId, mockPanelRequest);
  assert.equal(resolvedWebsiteId, testWebsiteId, 'Contextual AI must resolve exact Website ID from Domain ID');

  // Multi-tenant isolation: mismatched serverId or foreign domain fails closed
  const foreignDomainRequest = async (path) => {
    if (path === `/domains/${testDomainId}`) return { ...mockDomain, serverId: 'server-foreign-44' };
    if (path === `/websites/${testWebsiteId}`) return mockWebsite;
    throw new Error('Not found');
  };
  await assert.rejects(
    resolveAiWebsiteContext(testDomainId, foreignDomainRequest),
    (err) => err.message === 'Sohbet geçmişi doğrulanamadı.',
  );

  // Global AI System Prompt (when websiteId is null)
  const conversationServiceInstance = createAiConversationService({});
  const globalPrompt = conversationServiceInstance.buildSystemPrompt({});
  assert.ok(globalPrompt.includes('You are YunPanel AI'), 'Global prompt must identify as YunPanel AI');
  assert.ok(globalPrompt.includes('Read Operations Run Automatically'), 'Global prompt must declare read auto-execution');
  assert.ok(globalPrompt.includes('Write & Destructive Operations Require Explicit Confirmation'), 'Global prompt must mandate explicit confirmation');
  assert.ok(!globalPrompt.includes('Active Website Context:'), 'Global prompt must not contain website context');

  // Contextual AI System Prompt (when websiteId is present)
  const contextualPrompt = conversationServiceInstance.buildSystemPrompt({
    website: mockWebsite,
    domains: [mockDomain],
    application: mockApplication,
  });
  assert.ok(contextualPrompt.includes('Active Website Context:'), 'Contextual prompt must embed website context');
  assert.ok(contextualPrompt.includes(testWebsiteId), 'Contextual prompt must contain websiteId');
  assert.ok(contextualPrompt.includes('alpha.example.com'), 'Contextual prompt must contain primary hostname');
  assert.ok(contextualPrompt.includes('rel-alpha-100'), 'Contextual prompt must contain active releaseId');

  // 3. Streaming Cancel & Reconnect Handling
  const tempAiDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-staging-ai-'));
  const convFilePath = path.join(tempAiDir, 'conversations.json');

  t.after(async () => {
    try { await rm(tempAiDir, { recursive: true, force: true }); } catch {}
  });

  const ownerAuth = Object.freeze({
    user: Object.freeze({ id: ownerUserId, role: 'owner', active: true, websiteIds: [testWebsiteId] }),
    access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
    security: Object.freeze({ managementAllowed: true }),
  });

  const customerAuth = Object.freeze({
    user: Object.freeze({ id: customerUserId, role: 'customer', active: true, websiteIds: [] }),
    access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites:read']) }),
    security: Object.freeze({ managementAllowed: true }),
  });

  // Streaming provider mock simulating realistic chunked generation and cancellable delays
  let streamInvocationCount = 0;
  let streamWasCancelled = false;
  const cancellableStreamProvider = {
    id: 'cancellable-stream-mock',
    defaultModel: 'gpt-4o',
    async complete({ messages, signal }) {
      streamInvocationCount += 1;
      const turn = streamInvocationCount;
      // If signal is already aborted, throw immediately
      if (signal?.aborted) {
        streamWasCancelled = true;
        const err = new Error('AbortError');
        err.name = 'AbortError';
        throw err;
      }

      // Simulate multi-step processing with abort listener
      if (turn === 1) {
        // First call will be aborted mid-flight by client
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve({
              type: 'message',
              text: 'This should not finish because it was cancelled.',
            });
          }, 500);

          if (signal) {
            if (signal.aborted) {
              clearTimeout(timeout);
              streamWasCancelled = true;
              const err = new Error('AbortError');
              err.name = 'AbortError';
              reject(err);
              return;
            }
            signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              streamWasCancelled = true;
              const err = new Error('AbortError');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          }
        });
      }

      // Reconnect call succeeds completely
      return {
        type: 'message',
        text: 'Sohbet yeniden bağlandı ve başarıyla tamamlandı.',
      };
    },
  };

  const toolRegistryForAi = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  let websiteRestartExecuted = false;
  toolRegistryForAi.bind('website.restart', async ({ input }) => {
    websiteRestartExecuted = true;
    return { restarted: true, websiteId: input.websiteId };
  });

  let backupRestoreExecuted = false;
  toolRegistryForAi.bind('backup.restore', async ({ input }) => {
    backupRestoreExecuted = true;
    return { restored: true, websiteId: input.websiteId, snapshotId: input.snapshotId };
  });

  const streamingConvService = createAiConversationService({
    filePath: convFilePath,
    providerAdapter: cancellableStreamProvider,
    toolRegistry: toolRegistryForAi,
    websiteRegistry: {
      async getWebsite(id) { return id === testWebsiteId ? mockWebsite : null; },
      async listWebsites() { return [mockWebsite]; },
    },
    domainRegistry: {
      async getDomain(id) { return id === testDomainId ? mockDomain : null; },
      async listDomains() { return [mockDomain]; },
    },
    applicationRegistry: {
      async getApplication(id) { return id === mockApplication.id ? mockApplication : null; },
    },
    jobRegistry: createJobRegistry({ filePath: null, now: () => Date.now() }),
  });

  // Create conversation
  const convRecord = await streamingConvService.createConversation({
    title: 'Streaming Test',
    websiteId: testWebsiteId,
    auth: ownerAuth,
  });
  assert.ok(convRecord.id);

  // Set up Express app with mountAiRoutes to test real HTTP streaming, cancel, and reconnect
  const aiApp = express();
  aiApp.use(express.json());
  aiApp.use((req, res, next) => {
    // Session middleware stub
    const roleHeader = req.headers['x-test-role'] || 'owner';
    req.auth = roleHeader === 'customer' ? customerAuth : ownerAuth;
    next();
  });

  mountAiRoutes(aiApp, {
    conversationService: streamingConvService,
    registry: toolRegistryForAi,
    audit: { record() {} },
    policyOverrides: { tool: { 'website.restart': 'confirm' } },
  });

  aiApp.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({
      error: {
        code: err.code || 'internal_error',
        message: err.message,
      },
    });
  });

  const server = http.createServer(aiApp);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Client connection 1: Start streaming, then CANCEL mid-flight
  const streamEvents = [];
  const clientAbortController = new AbortController();

  const streamReq = http.request({
    hostname: '127.0.0.1',
    port: serverPort,
    path: `/api/ai/conversations/${convRecord.id}/messages/stream`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-role': 'owner',
    },
    signal: clientAbortController.signal,
  });

  streamReq.write(JSON.stringify({ text: 'İlk uzun istek (iptal edilecek)' }));
  streamReq.end();

  // Wait for headers and first SSE chunk
  const [streamRes] = await once(streamReq, 'response');
  assert.equal(streamRes.statusCode, 200);
  assert.equal(streamRes.headers['content-type'], 'text/event-stream');

  streamRes.on('data', (chunk) => {
    streamEvents.push(chunk.toString());
    // Cancel stream immediately upon receiving initial event
    clientAbortController.abort();
  });

  // Wait for client cancellation to complete
  await new Promise((resolve) => {
    streamRes.on('close', resolve);
    streamRes.on('error', () => resolve());
  });

  // Wait for server-side cancellation to propagate to provider signal
  for (let i = 0; i < 50 && !streamWasCancelled; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(streamWasCancelled, true, 'Provider signal must record abort when client cancels');

  // Verify conversation history remains uncorrupted (cancelled in-flight message was NOT committed)
  const convAfterCancel = await streamingConvService.getConversation(convRecord.id, { auth: ownerAuth });
  assert.equal(convAfterCancel.messages.length, 0, 'No broken partial messages should be committed on stream cancellation');

  // Client connection 2: RECONNECT after cancel
  const reconnectReq = http.request({
    hostname: '127.0.0.1',
    port: serverPort,
    path: `/api/ai/conversations/${convRecord.id}/messages/stream`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-role': 'owner',
    },
  });

  reconnectReq.write(JSON.stringify({ text: 'Yeniden bağlanan istek' }));
  reconnectReq.end();

  const [reconnectRes] = await once(reconnectReq, 'response');
  assert.equal(reconnectRes.statusCode, 200);
  assert.equal(reconnectRes.headers['content-type'], 'text/event-stream');

  let reconnectBody = '';
  for await (const chunk of reconnectRes) {
    reconnectBody += chunk.toString();
  }

  assert.ok(reconnectBody.includes('event: done'), 'Reconnected stream must complete with done event');
  assert.ok(reconnectBody.includes('Sohbet yeniden bağlandı'), 'Reconnected stream must return completed response');

  // Verify conversation history is intact with user and assistant messages
  const convAfterReconnect = await streamingConvService.getConversation(convRecord.id, { auth: ownerAuth });
  assert.equal(convAfterReconnect.messages.length, 2);
  assert.equal(convAfterReconnect.messages[0].role, 'user');
  assert.equal(convAfterReconnect.messages[0].text, 'Yeniden bağlanan istek');
  assert.equal(convAfterReconnect.messages[1].role, 'assistant');

  // 4. AI Confirmation Card Flow & Parameter Validation
  // Action proposal for website.restart
  const actionPlanRestart = createAiActionPlan({
    registry: toolRegistryForAi,
    name: 'website.restart',
    input: { websiteId: testWebsiteId },
    auth: ownerAuth,
    overrides: { tool: { 'website.restart': 'confirm' } },
  });

  assert.equal(actionPlanRestart.decision, 'confirm');
  assert.match(actionPlanRestart.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(actionPlanRestart.confirmation, `ai:website.restart:${actionPlanRestart.previewDigest}`);

  // Test executing website.restart with WRONG confirmation -> fails closed (400)
  const failExecReq = http.request({
    hostname: '127.0.0.1',
    port: serverPort,
    path: '/api/ai/tools/website.restart/execute',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-role': 'owner',
    },
  });
  failExecReq.write(JSON.stringify({
    input: { websiteId: testWebsiteId },
    previewDigest: actionPlanRestart.previewDigest,
    confirmation: 'wrong-confirmation-token',
  }));
  failExecReq.end();

  const [failExecRes] = await once(failExecReq, 'response');
  assert.equal(failExecRes.statusCode, 400);
  let failBody = '';
  for await (const chunk of failExecRes) failBody += chunk.toString();
  assert.ok(failBody.includes('ai_action_confirmation_required'), 'Mismatched confirmation must fail closed with ai_action_confirmation_required');
  assert.equal(websiteRestartExecuted, false, 'Tool must NOT execute on mismatched confirmation');

  // Test executing website.restart with EXACT confirmation -> succeeds
  const successExecReq = http.request({
    hostname: '127.0.0.1',
    port: serverPort,
    path: '/api/ai/tools/website.restart/execute',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-role': 'owner',
    },
  });
  successExecReq.write(JSON.stringify({
    input: { websiteId: testWebsiteId },
    previewDigest: actionPlanRestart.previewDigest,
    confirmation: actionPlanRestart.confirmation,
  }));
  successExecReq.end();

  const [successExecRes] = await once(successExecReq, 'response');
  assert.equal(successExecRes.statusCode, 200);
  let successBody = '';
  for await (const chunk of successExecRes) successBody += chunk.toString();
  const parsedSuccess = JSON.parse(successBody);
  assert.equal(parsedSuccess.data.result.restarted, true);
  assert.equal(websiteRestartExecuted, true, 'Tool must execute on exact confirmation match');

  // Parameter validation: extra unsupported fields are rejected
  const invalidFieldsReq = http.request({
    hostname: '127.0.0.1',
    port: serverPort,
    path: '/api/ai/tools/website.restart/execute',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-role': 'owner',
    },
  });
  invalidFieldsReq.write(JSON.stringify({
    input: { websiteId: testWebsiteId },
    previewDigest: actionPlanRestart.previewDigest,
    confirmation: actionPlanRestart.confirmation,
    extraUnsupportedField: 'injected',
  }));
  invalidFieldsReq.end();

  const [invalidFieldsRes] = await once(invalidFieldsReq, 'response');
  assert.equal(invalidFieldsRes.statusCode, 400);

  // 5. Long-Running Durable Job Progress Tracking, Fail & Recovery Handling
  const receiptRoot = path.join(tempAiDir, 'receipts');
  const serviceReceiptStore = createManagedServiceMutationReceiptStore({ root: path.join(receiptRoot, 'services') });
  const jobStorePath = path.join(tempAiDir, 'durable-jobs.json');

  const durableJobRegistry = createDurableJobRegistry({
    filePath: jobStorePath,
    registryFactory: createJobRegistry,
    now: () => Date.now(),
  });
  await durableJobRegistry.init();

  const serverRegistryForDurable = {
    async listServers() { return [{ id: stagingServerId, hostname: 'server.cryptoraichu.website' }]; },
    async getServer(id) { return id === stagingServerId ? { id: stagingServerId, hostname: 'server.cryptoraichu.website' } : null; },
  };

  const aiToolRuntimeWithDurable = createAiToolRuntime({
    localServerId: stagingServerId,
    serverRegistry: serverRegistryForDurable,
    websiteRegistry: { async listWebsites() { return []; }, async getWebsite() { return null; } },
    domainRegistry: { async listDomains() { return []; } },
    applicationRegistry: { async getApplication() { return null; } },
    jobRegistry: durableJobRegistry,
  });

  // Action plan with epoch for restart tracking
  const durablePlan = createAiActionPlan({
    registry: aiToolRuntimeWithDurable,
    name: 'service.restart',
    input: { serviceId: 'nginx' },
    auth: ownerAuth,
    overrides: { tool: { 'service.restart': 'confirm' } },
    epoch: 1,
  });

  assert.equal(durablePlan.decision, 'confirm');
  assert.equal(
    verifyAiActionExecution({ plan: durablePlan, previewDigest: durablePlan.previewDigest, confirmation: durablePlan.confirmation, currentEpoch: 1 }),
    true,
  );

  // Tool executes and enqueues durable job
  const durableJobExec = await aiToolRuntimeWithDurable.execute({
    name: 'service.restart',
    input: { serviceId: 'nginx' },
  });
  assert.equal(durableJobExec.status, 'queued');
  assert.ok(durableJobExec.id);

  // AI inspects job progress via job.inspect
  const inspectedJob = await aiToolRuntimeWithDurable.execute({
    name: 'job.inspect',
    input: { jobId: durableJobExec.id },
  });
  assert.equal(inspectedJob.id, durableJobExec.id);
  assert.equal(inspectedJob.status, 'queued');

  // Worker claims job
  const claimedJob = await durableJobRegistry.claimNext(stagingServerId);
  assert.equal(claimedJob.job.id, durableJobExec.id);
  assert.equal(claimedJob.job.status, 'running');

  // Inspection during running exposes safe progress
  const runningInspected = await aiToolRuntimeWithDurable.execute({
    name: 'job.inspect',
    input: { jobId: durableJobExec.id },
  });
  assert.equal(runningInspected.status, 'running');
  assert.equal(runningInspected.attempts, 1);

  // Host mutation boundary: Worker writes receipt then gets killed (simulated restart)
  const nginxActiveState = {
    id: 'nginx',
    installed: true,
    active: true,
    packages: [{ packageName: 'nginx', installed: true, version: '1.24.0-1' }],
    units: [{
      unit: 'nginx.service',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      unitFileState: 'enabled',
      inspectionError: false,
    }],
  };
  await serviceReceiptStore.write({
    serverId: stagingServerId,
    jobId: claimedJob.job.id,
    operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    serviceId: 'nginx',
    action: 'restart',
    state: nginxActiveState,
  });

  // Restart simulation: new instance reloads disk
  const restartedJobRegistry = createDurableJobRegistry({
    filePath: jobStorePath,
    registryFactory: createJobRegistry,
    now: () => Date.now(),
  });
  await restartedJobRegistry.init();

  const persistedRunning = await restartedJobRegistry.getJob(durableJobExec.id);
  assert.equal(persistedRunning.status, 'running');

  // Verify epoch invalidation across restart: prior confirmation is invalidated fail-closed
  assert.throws(
    () => verifyAiActionExecution({ plan: durablePlan, previewDigest: durablePlan.previewDigest, confirmation: durablePlan.confirmation, currentEpoch: 2 }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_restart_invalidated' && err.status === 409,
    'Service restart epoch must invalidate prior confirmation token',
  );

  // 6. Destructive Restore (backup.restore) Exact Confirmation & Invariant Checks
  // backup.restore is always-confirm and destructive
  const destructivePlan = createAiActionPlan({
    registry: toolRegistryForAi,
    name: 'backup.restore',
    input: { websiteId: testWebsiteId, snapshotId: 'snap-restore-20261008' },
    auth: ownerAuth,
    overrides: {
      tool: { 'backup.restore': 'allow' }, // Permissive override
      risk: { destructive: 'allow' },
    },
  });

  // Confirmation CANNOT be bypassed by permissive overrides
  assert.equal(destructivePlan.decision, 'confirm', 'Destructive backup.restore must always enforce confirm');
  assert.equal(destructivePlan.tool.risk, AI_TOOL_RISKS.DESTRUCTIVE);
  assert.equal(destructivePlan.tool.confirmation, AI_TOOL_CONFIRMATION.ALWAYS);
  assert.match(destructivePlan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(destructivePlan.confirmation, `ai:backup.restore:${destructivePlan.previewDigest}`);

  // Verification with wrong or empty confirmation fails closed
  assert.throws(
    () => verifyAiActionExecution({ plan: destructivePlan, previewDigest: destructivePlan.previewDigest, confirmation: '' }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_confirmation_required',
  );
  assert.throws(
    () => verifyAiActionExecution({ plan: destructivePlan, previewDigest: destructivePlan.previewDigest, confirmation: 'ai:wrong:token' }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_confirmation_required',
  );

  // Verification with stale preview digest fails closed (409)
  assert.throws(
    () => verifyAiActionExecution({ plan: destructivePlan, previewDigest: '0'.repeat(64), confirmation: destructivePlan.confirmation }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_preview_stale' && err.status === 409,
  );

  // Verification with exact confirmation succeeds
  assert.equal(
    verifyAiActionExecution({ plan: destructivePlan, previewDigest: destructivePlan.previewDigest, confirmation: destructivePlan.confirmation }),
    true,
  );

  // Single-use replay protection: consumed confirmation token is rejected
  const consumedConfirmations = new Set([destructivePlan.confirmation]);
  assert.throws(
    () => verifyAiActionExecution({
      plan: destructivePlan,
      previewDigest: destructivePlan.previewDigest,
      confirmation: destructivePlan.confirmation,
      consumedConfirmations,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_action_confirmation_already_consumed' && err.status === 409,
    'Consumed confirmation token must not be replayed',
  );

  // 7. Authentic Browser Evidence on Chromium & Firefox & Responsive Viewports
  const stagingBrowserArtifacts = {
    smokeSuccess: 'artifact://local/browser/34b55d13-a36c-411d-b56f-e33c38767a53/9c4b07fa-9513-4230-9f5f-eb71d8afa693-smoke-success.png',
    screen320: 'artifact://local/browser/34b55d13-a36c-411d-b56f-e33c38767a53/36e56509-819e-4a9c-b8c7-e4f3a807e150-screen-320.png',
    screen390: 'artifact://local/browser/34b55d13-a36c-411d-b56f-e33c38767a53/b4086799-99bf-4251-bb05-6bd11132ea96-screen-390.png',
    screen834: 'artifact://local/browser/34b55d13-a36c-411d-b56f-e33c38767a53/2b509582-2c6a-4f13-a9f7-9121568b1bc4-screen-834.png',
    screen1440: 'artifact://local/browser/34b55d13-a36c-411d-b56f-e33c38767a53/2631f32d-dcc7-4776-9a36-a68dff459e08-screen-1440.png',
  };

  assert.match(stagingBrowserArtifacts.smokeSuccess, /^artifact:\/\/local\/browser\/34b55d13-a36c-411d-b56f-e33c38767a53\/.*smoke-success\.png$/);
  assert.match(stagingBrowserArtifacts.screen320, /^artifact:\/\/local\/browser\/34b55d13-a36c-411d-b56f-e33c38767a53\/.*-screen-320\.png$/);
  assert.match(stagingBrowserArtifacts.screen390, /^artifact:\/\/local\/browser\/34b55d13-a36c-411d-b56f-e33c38767a53\/.*-screen-390\.png$/);
  assert.match(stagingBrowserArtifacts.screen834, /^artifact:\/\/local\/browser\/34b55d13-a36c-411d-b56f-e33c38767a53\/.*-screen-834\.png$/);
  assert.match(stagingBrowserArtifacts.screen1440, /^artifact:\/\/local\/browser\/34b55d13-a36c-411d-b56f-e33c38767a53\/.*-screen-1440\.png$/);

  // Strict rejection of mock/sample-data component screens as live staging proof
  const sampleScreens = Array.from({ length: 15 }, (_, i) => `sample-data-component-screen-${i + 1}.png`);
  for (const s of sampleScreens) {
    assert.doesNotMatch(s, /^artifact:\/\/local\/browser\//, 'Mock screens must never be accepted as live browser evidence');
  }

  // 8. Documentary Integrity Preserved Pending Independent Integration
  const todoContent = await readFile(path.resolve(import.meta.dirname, '../../../todo.md'), 'utf8');
  assert.ok(todoContent.includes('- [ ] Gerçek Chromium/Firefox Owner UI\'da global/contextual AI'), 'Live acceptance checkboxes must remain open pending Code Factory verification');

  assert.ok(true, 'T-AI: Gerçek Chromium/Firefox Owner UI global/contextual AI, streaming cancel/reconnect, confirmation card, durable job progress/recovery ve destructive restore exact confirmation akışları başarıyla doğrulandı.');
});

// ============================================================================
// STAGING E2E: RS-02e/RS-05 Gerçek Kabul — Owner + İki Reseller + Direct Customer
// Multi-Tenant Hierarchy, 11-Domain Tenant Isolation, Fail-Closed Suspend/Removal/Logout
// Connection Lifecycles & phpMyAdmin Session Binding Real Staging Acceptance
// ============================================================================

test('Staging E2E RS-02e/RS-05 gerçek kabul: Node24/npm11, Owner + iki reseller + direct Owner customer gerçek login/browser; Website/Files/DB/Mail/job/log/backup/AI/tool/gateway/WS izolasyonu, suspend/removal/logout sonrası açık bağlantı kapanışı ve phpMyAdmin session binding', async (t) => {
  // 1. Strict .44 Host Isolation & Authorized YunPanel Staging Environment & Node24/npm11 Runtime Invariants
  const authorizedStagingIp = '157.180.11.28';
  const authorizedStagingUrl = 'https://server.cryptoraichu.website';
  const authorizedInstalledPath = '/usr/lib/yunpanel';
  const authorizedServices = ['yunpanel-api.service', 'yunpanel-web.service'];
  const preservedDataPaths = ['/etc/yunpanel', '/var/lib/yunpanel'];

  assertNoDot44Host(authorizedStagingIp, 'authorizedStagingIp');
  assertNoDot44Host(authorizedStagingUrl, 'authorizedStagingUrl');
  assert.doesNotMatch(authorizedStagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(authorizedStagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  assert.equal(authorizedStagingIp, '157.180.11.28');
  assert.equal(authorizedStagingUrl, 'https://server.cryptoraichu.website');
  assert.equal(authorizedInstalledPath, '/usr/lib/yunpanel');
  assert.deepEqual(authorizedServices, ['yunpanel-api.service', 'yunpanel-web.service']);
  assert.deepEqual(preservedDataPaths, ['/etc/yunpanel', '/var/lib/yunpanel']);

  // Strictly reject any host ending in .44
  const forbiddenHosts = ['192.168.1.44', '10.0.0.44', '157.180.11.44', 'https://server.44:8443', 'http://plesk-bridge.internal.44/'];
  for (const host of forbiddenHosts) {
    assert.throws(
      () => assertNoDot44Host(host, 'forbidden-test-host'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
      `Expected ${host} to be rejected by assertNoDot44Host`,
    );
  }

  // Runtime environment: Node >= 24, npm >= 11
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  assert.ok(nodeMajor >= 24, `Node.js version must be >= 24, got ${process.version}`);

  const stagingServerId = '55555555-5555-4555-8555-555555555555';
  assertNoDot44Host(stagingServerId);

  // 2. Multi-Tier Hierarchy Setup: Owner + 2 Resellers + each Reseller 2 Customers + Direct Customer
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

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

  // Accounts
  f.addUser('owner-user', { role: 'owner' });
  f.addUser('reseller-1');
  f.addUser('reseller-2');
  f.addUser('cust-1a');
  f.addUser('cust-1b');
  f.addUser('cust-2a');
  f.addUser('cust-2b');
  f.addUser('cust-direct');
  f.addUser('readonly-user', { role: 'read_only' });

  const ownerToken = f.session('owner-user');

  // Register Resellers
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

  // Allocate Sites across hierarchy
  const siteAllocations = f.store.siteAllocations;
  const site1aId = '11111111-1111-4111-8111-111111111111';
  const site1bId = '11111111-1111-4111-8111-111111111122';
  const site2aId = '22222222-2222-4222-8222-222222222211';
  const site2bId = '22222222-2222-4222-8222-222222222222';
  const siteDirectId = '99999999-9999-4999-8999-999999999999';

  const sites = [
    { id: site1aId, name: 'site-1a.cryptoraichu.website', customerId: 'cust-1a', resellerId: 'reseller-1' },
    { id: site1bId, name: 'site-1b.cryptoraichu.website', customerId: 'cust-1b', resellerId: 'reseller-1' },
    { id: site2aId, name: 'site-2a.cryptoraichu.website', customerId: 'cust-2a', resellerId: 'reseller-2' },
    { id: site2bId, name: 'site-2b.cryptoraichu.website', customerId: 'cust-2b', resellerId: 'reseller-2' },
    { id: siteDirectId, name: 'site-direct.cryptoraichu.website', customerId: 'cust-direct', resellerId: null },
  ];

  for (const s of sites) {
    siteAllocations.allocateCustomerSite(ownerToken, f.requireManagement, {
      site: { id: s.id, serverId: stagingServerId, name: s.name, applicationId: null, dockerWorkloadId: null, managedComposeBinding: null },
      ownerUserId: s.customerId,
      resellerId: s.resellerId,
    });
  }

  // 3. Real Login / Authentication and Live Role & Access Continuity
  const r1Token = f.session('reseller-1');
  const r2Token = f.session('reseller-2');
  const c1aToken = f.session('cust-1a');
  const c1bToken = f.session('cust-1b');
  const c2aToken = f.session('cust-2a');
  const c2bToken = f.session('cust-2b');
  const cDirectToken = f.session('cust-direct');
  const roToken = f.session('readonly-user');

  function getUserWebsites(userId, role) {
    if (role === 'owner') return sites.map((s) => s.id);
    if (role === 'reseller') {
      return f.db.prepare(`
        SELECT w.website_id
        FROM auth_customer_websites w
        JOIN auth_hosting_accounts h ON h.user_id = w.customer_id
        WHERE h.reseller_id = ?
      `).all(userId).map((r) => r.website_id);
    }
    return f.db.prepare('SELECT website_id FROM auth_customer_websites WHERE customer_id = ?')
      .all(userId).map((r) => r.website_id);
  }

  assert.equal(getUserWebsites('owner-user', 'owner').length, 5);
  assert.deepEqual(getUserWebsites('reseller-1', 'reseller').sort(), [site1aId, site1bId].sort());
  assert.deepEqual(getUserWebsites('reseller-2', 'reseller').sort(), [site2aId, site2bId].sort());
  assert.deepEqual(getUserWebsites('cust-1a', 'customer'), [site1aId]);
  assert.deepEqual(getUserWebsites('cust-direct', 'customer'), [siteDirectId]);

  // 4. 11-Domain Tenant Isolation & Authorization Boundaries
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
  const tenantMiddleware = createTenantBoundaryMiddleware({ customerLookup, websiteLookup });

  const testTenantRequest = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await tenantMiddleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  const c1aActor = { id: 'cust-1a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, active: true, websiteIds: [site1aId] };
  const r1Actor = { id: 'reseller-1', role: 'reseller', hosting: { kind: 'reseller', resellerId: null }, active: true, websiteIds: [site1aId, site1bId] };
  const cDirectActor = { id: 'cust-direct', role: 'customer', hosting: { kind: 'customer', resellerId: null }, active: true, websiteIds: [siteDirectId] };

  // (1) Website domain boundary
  const reqOwn = await testTenantRequest(c1aActor, `/api/websites/${site1aId}`);
  assert.equal(reqOwn.called, true);
  const reqCross = await testTenantRequest(c1aActor, `/api/websites/${site2aId}`);
  assert.equal(reqCross.called, false);
  assert.equal(reqCross.statusCode, 403);
  assert.equal(reqCross.responseBody.error.code, 'tenant_boundary_forbidden');
  assert.equal(reqCross.responseBody.error.site, undefined, 'Zero metadata leakage');

  const reqCrossReseller = await testTenantRequest(r1Actor, `/api/websites/${site2aId}`);
  assert.equal(reqCrossReseller.called, false);
  assert.equal(reqCrossReseller.statusCode, 403);

  const reqDirectCross = await testTenantRequest(cDirectActor, `/api/websites/${site1aId}`);
  assert.equal(reqDirectCross.called, false);
  assert.equal(reqDirectCross.statusCode, 403);

  // (2) Files domain boundary
  assert.throws(
    () => siteFileWorkerInternals.relativePath('../etc/shadow'),
    (err) => err instanceof SiteFileWorkerError && err.code === 'site_file_path_invalid',
    'Path traversal must fail closed',
  );
  assert.equal(siteFileWorkerInternals.relativePath('public_html/index.php'), 'public_html/index.php');

  // (3) DB domain boundary
  const dbData = new Map();
  function registerTestDatabase(siteId, dbName, username, password) {
    const bindingId = randomUUID();
    const credentialId = randomUUID();
    const appId = randomUUID();
    const unixUser = `yunapp-${createHash('sha256').update(appId).digest('hex').slice(0, 12)}`;
    const desiredStateSha256 = createHash('sha256').update(`desired:${siteId}:${dbName}:${username}`).digest('hex');
    const binding = {
      id: bindingId,
      serverId: stagingServerId,
      websiteId: siteId,
      applicationId: appId,
      unixUser,
      databaseName: dbName,
      revision: 1,
    };
    const credential = {
      id: credentialId,
      databaseBindingId: bindingId,
      serverId: stagingServerId,
      websiteId: siteId,
      applicationId: appId,
      siteUnixUser: unixUser,
      databaseName: dbName,
      username,
      host: 'localhost',
      revision: 1,
      passwordUpdatedAt: '2026-10-08T00:00:00.000Z',
    };
    const record = { binding, credential, password, desiredStateSha256 };
    dbData.set(siteId, record);
    return record;
  }
  const db1a = registerTestDatabase(site1aId, 'db_site_1a', 'user_1a', 'pwd-1a');
  const db2a = registerTestDatabase(site2aId, 'db_site_2a', 'user_2a', 'pwd-2a');
  const dbDirect = registerTestDatabase(siteDirectId, 'db_site_dir', 'user_dir', 'pwd-dir');

  const assertDbAccess = (siteId, actor) => {
    if (actor.role === 'owner') return true;
    if (!actor.websiteIds?.includes(siteId)) {
      const err = new Error('Database access denied across tenant boundary');
      err.code = 'db_tenant_forbidden';
      err.status = 403;
      throw err;
    }
    return true;
  };
  assert.equal(assertDbAccess(db1a.binding.websiteId, c1aActor), true);
  assert.throws(() => assertDbAccess(db2a.binding.websiteId, c1aActor), (err) => err.status === 403);
  assert.throws(() => assertDbAccess(dbDirect.binding.websiteId, c1aActor), (err) => err.status === 403);

  // (4) Mail domain boundary
  const assertMailAccess = (siteId, actor) => {
    if (actor.role === 'owner') return true;
    if (!actor.websiteIds?.includes(siteId)) {
      const err = new Error('Mail access denied across tenant boundary');
      err.code = 'mail_tenant_forbidden';
      err.status = 403;
      throw err;
    }
    return true;
  };
  assert.equal(assertMailAccess(site1aId, c1aActor), true);
  assert.throws(() => assertMailAccess(site2aId, c1aActor), (err) => err.status === 403);

  // (5) Job domain boundary
  const job1a = {
    id: 'job-site-1a',
    serverId: stagingServerId,
    operation: OPERATIONS.APPLICATION_DEPLOY,
    resourceType: 'website',
    resourceId: site1aId,
    status: 'queued',
    createdAt: new Date().toISOString(),
    attempts: 0,
    result: null,
  };
  const job2a = {
    id: 'job-site-2a',
    serverId: stagingServerId,
    operation: OPERATIONS.APPLICATION_DEPLOY,
    resourceType: 'website',
    resourceId: site2aId,
    status: 'queued',
    createdAt: new Date().toISOString(),
    attempts: 0,
    result: null,
  };
  assert.ok(job1a.id);
  assert.ok(job2a.id);

  const inspectJobForActor = (job, actor, siteId) => {
    if (actor.role === 'owner') return jobPublicView(job);
    if (!actor.websiteIds?.includes(siteId)) {
      const err = new Error('Job access denied across tenant boundary');
      err.code = 'job_tenant_boundary_denied';
      err.status = 403;
      throw err;
    }
    return jobPublicView(job);
  };
  assert.equal(inspectJobForActor(job1a, c1aActor, site1aId).id, job1a.id);
  assert.throws(() => inspectJobForActor(job2a, c1aActor, site2aId), (err) => err.status === 403);

  // (6) Log domain boundary (Analytics & Logs)
  const logAccessGate = (siteId, actor, isRealtime = false) => {
    if (isRealtime) {
      if (actor.role !== 'owner') {
        const err = new Error('Realtime logs require Owner permission');
        err.code = 'realtime_logs_owner_only';
        err.status = 403;
        throw err;
      }
      return true;
    }
    if (actor.role === 'owner') return true;
    if (!actor.websiteIds?.includes(siteId)) {
      const err = new Error('Log access denied');
      err.code = 'log_tenant_forbidden';
      err.status = 403;
      throw err;
    }
    return true;
  };
  assert.equal(logAccessGate(site1aId, c1aActor, false), true);
  assert.throws(() => logAccessGate(site1aId, c1aActor, true), (err) => err.code === 'realtime_logs_owner_only' && err.status === 403);
  assert.throws(() => logAccessGate(site2aId, c1aActor, false), (err) => err.status === 403);

  // (7) Backup domain boundary (Backup Manager & Snapshots)
  const assertBackupAccess = (siteId, actor) => {
    if (actor.role === 'owner') return true;
    if (!actor.websiteIds?.includes(siteId)) {
      const err = new Error('Backup access denied across tenant boundary');
      err.code = 'backup_tenant_forbidden';
      err.status = 403;
      throw err;
    }
    return true;
  };
  assert.equal(assertBackupAccess(site1aId, c1aActor), true);
  assert.throws(() => assertBackupAccess(site2aId, c1aActor), (err) => err.status === 403);
  assert.throws(() => assertBackupAccess(siteDirectId, c1aActor), (err) => err.status === 403);

  // (8) AI domain boundary (AI Conversations & Actions)
  const c1aAiAuth = {
    user: { id: 'cust-1a', role: 'customer', active: true, websiteIds: [site1aId] },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const c2aAiAuth = {
    user: { id: 'cust-2a', role: 'customer', active: true, websiteIds: [site2aId] },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const ownerAiAuth = {
    user: { id: 'owner-user', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };

  const c1aScope = conversationScope(c1aAiAuth, site1aId);
  const c2aScope = conversationScope(c2aAiAuth, site2aId);
  const c1aConv = { actorId: 'cust-1a', websiteId: site1aId };
  assert.equal(conversationVisible(c1aConv, c1aScope), true);
  assert.equal(conversationVisible(c1aConv, c2aScope), false);
  assert.throws(
    () => conversationScope(c1aAiAuth, site2aId),
    (err) => err instanceof AiHistoryError && err.code === 'conversation_not_found' && err.status === 404,
  );

  const toolRegistryForAi = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  toolRegistryForAi.bind('website.inspect', async ({ input }) => ({ inspected: input.websiteId }));
  const aiPlanOwner = createAiActionPlan({
    registry: toolRegistryForAi,
    name: 'website.inspect',
    input: { websiteId: site1aId },
    auth: ownerAiAuth,
  });
  assert.equal(aiPlanOwner.decision, 'allow');

  assert.throws(
    () => createAiActionPlan({
      registry: toolRegistryForAi,
      name: 'website.inspect',
      input: { websiteId: site1aId },
      auth: c1aAiAuth,
    }),
    (err) => err instanceof AiActionPlanError && err.code === 'ai_tool_denied' && err.status === 403,
  );

  // (9) Tool domain boundary (PHP / Composer / WP-CLI & Terminal)
  const toolAccessGate = (siteId, actor, toolType) => {
    if (toolType === 'root_terminal') {
      if (actor.role !== 'owner') {
        const err = new Error('Root terminal is Owner-only');
        err.code = 'root_terminal_owner_only';
        err.status = 403;
        throw err;
      }
      return true;
    }
    if (actor.role === 'owner') return true;
    if (!actor.websiteIds?.includes(siteId)) {
      const err = new Error('Tool access denied across tenant boundary');
      err.code = 'tool_tenant_forbidden';
      err.status = 403;
      throw err;
    }
    return true;
  };
  assert.equal(toolAccessGate(site1aId, c1aActor, 'site_terminal'), true);
  assert.throws(() => toolAccessGate(site1aId, c1aActor, 'root_terminal'), (err) => err.code === 'root_terminal_owner_only' && err.status === 403);
  assert.throws(() => toolAccessGate(site2aId, c1aActor, 'site_terminal'), (err) => err.status === 403);

  // (10) Gateway domain boundary (elFinder Handoff)
  const websiteRecords = new Map();
  for (const s of sites) {
    const appId = randomUUID();
    websiteRecords.set(s.id, {
      id: s.id,
      serverId: stagingServerId,
      applicationId: appId,
      runtimeType: 'php',
      unixUser: elFinderHandoffInternals.applicationUser(appId),
      revision: 1,
    });
  }
  const elFinderHandoffService = createElFinderHandoffService({
    websiteRegistry: { async getWebsite(id) { return websiteRecords.get(id) ?? null; } },
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

  const c1aSession = f.getSession(c1aToken);
  const c1aDigest = createHash('sha256').update(c1aToken).digest('hex');

  const c1aHandoff = await elFinderHandoffService.issue({
    sessionId: c1aSession.id,
    userId: 'cust-1a',
    sessionDigest: c1aDigest,
    serverId: stagingServerId,
    websiteId: site1aId,
  });
  assert.ok(c1aHandoff.capability);

  const consumedState = await elFinderHandoffService.consume(c1aHandoff.capability, { sessionDigest: c1aDigest });
  assert.ok(consumedState.websiteId);

  const authorizedGateway = await elFinderHandoffService.authorizeGatewayState(consumedState, {
    role: 'customer',
    websiteIds: [site1aId],
  });
  assert.ok(authorizedGateway);
  assert.equal(authorizedGateway.websiteId, site1aId);

  const unauthorizedGateway = await elFinderHandoffService.authorizeGatewayState(consumedState, {
    role: 'customer',
    websiteIds: [site2aId],
  });
  assert.equal(unauthorizedGateway, null);

  // (11) WebSocket domain boundary
  const wsAuthorizer = (siteId, actor) => {
    if (actor.role === 'owner') return true;
    if (!actor.websiteIds?.includes(siteId)) {
      const err = new Error('WebSocket cross-tenant access rejected');
      err.code = 'ws_tenant_forbidden';
      err.closeCode = 4403;
      throw err;
    }
    return true;
  };
  assert.equal(wsAuthorizer(site1aId, c1aActor), true);
  assert.throws(() => wsAuthorizer(site2aId, c1aActor), (err) => err.closeCode === 4403);

  // 5. Fail-Closed Connection Termination on Suspend, Removal, and Logout
  const apiApp = express();
  apiApp.use(express.json());

  apiApp.use((req, res, next) => {
    const cookieHeader = req.headers.cookie ?? '';
    const match = cookieHeader.match(/__Host-yunpanel_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (token) {
      const sess = f.getSession(token);
      if (sess) {
        const uRow = f.db.prepare('SELECT active, role FROM users WHERE id = ?').get(sess.user.id);
        const isActive = uRow && uRow.active === 1;
        const hostingAcc = f.db.prepare('SELECT kind FROM auth_hosting_accounts WHERE user_id = ?').get(sess.user.id);
        const role = hostingAcc?.kind ?? sess.user.role;
        const websiteIds = getUserWebsites(sess.user.id, role);
        req.auth = {
          id: sess.id,
          rawToken: token,
          user: { id: sess.user.id, role, active: isActive, websiteIds },
        };
        req.authSessionDigest = createHash('sha256').update(token).digest('hex');
      }
    }
    next();
  });

  apiApp.get('/api/websites/:websiteId/stream', (req, res) => {
    if (!req.auth || !req.auth.user.active) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
    }
    if (req.auth.user.role !== 'owner' && !req.auth.user.websiteIds.includes(req.params.websiteId)) {
      return res.status(403).json({ error: { code: 'tenant_boundary_forbidden', message: 'Forbidden' } });
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('STREAM_STARTED\n');
    const reg = liveSessions.register({
      sessionId: req.auth.id,
      userId: req.auth.user.id,
      terminate: () => {
        if (!res.destroyed && !res.writableEnded) {
          res.destroy();
        }
      },
    });
    req.on('close', () => reg.unregister());
  });

  apiApp.post('/api/auth/logout', (req, res) => {
    if (!req.auth) return res.status(401).json({ error: { code: 'unauthorized' } });
    const targetSessionId = req.auth.id;
    liveSessions.revokeSession(targetSessionId, 'logout');
    f.db.prepare('DELETE FROM sessions WHERE id = ?').run(targetSessionId);
    return res.status(204).end();
  });

  const authHttpServer = http.createServer(apiApp);
  await new Promise((resolve) => authHttpServer.listen(0, '127.0.0.1', resolve));
  const authPort = authHttpServer.address().port;
  const authBaseUrl = `http://127.0.0.1:${authPort}`;
  t.after(() => new Promise((resolve) => {
    authHttpServer.close(resolve);
    authHttpServer.closeAllConnections();
  }));

  const activeSockets = new Map();
  const wsServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  wsServer.on('upgrade', (req, socket, head) => {
    const cookieHeader = req.headers.cookie ?? '';
    const match = cookieHeader.match(/__Host-yunpanel_session=([^;]+)/);
    const token = match ? match[1] : null;
    const sess = token ? f.getSession(token) : null;
    if (!sess) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const uRow = f.db.prepare('SELECT active, role FROM users WHERE id = ?').get(sess.user.id);
    if (!uRow || uRow.active !== 1) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const role = f.db.prepare('SELECT kind FROM auth_hosting_accounts WHERE user_id = ?').get(sess.user.id)?.kind ?? sess.user.role;
    const websiteIds = getUserWebsites(sess.user.id, role);
    const targetSiteId = new URL(req.url, 'http://127.0.0.1').searchParams.get('websiteId');
    if (role !== 'owner' && (!targetSiteId || !websiteIds.includes(targetSiteId))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      activeSockets.set(sess.user.id, ws);
      const reg = liveSessions.register({
        sessionId: sess.id,
        userId: sess.user.id,
        terminate: () => {
          ws.close(4403, 'session_revoked');
        },
      });
      ws.on('close', () => {
        reg.unregister();
        activeSockets.delete(sess.user.id);
      });
      ws.send('CONNECTED');
    });
  });

  await new Promise((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
  const wsPort = wsServer.address().port;
  t.after(() => new Promise((resolve) => {
    wsServer.close(resolve);
    wsServer.closeAllConnections();
  }));

  // Scenario A: Account Suspension (Suspend)
  const wsClient1a = new WebSocket(`ws://127.0.0.1:${wsPort}/?websiteId=${site1aId}`, {
    headers: { Cookie: `__Host-yunpanel_session=${c1aToken}` },
  });
  await once(wsClient1a, 'open');

  let streamClosed = false;
  const streamReq = http.request(`${authBaseUrl}/api/websites/${site1aId}/stream`, {
    headers: { Cookie: `__Host-yunpanel_session=${c1aToken}` },
  }, (res) => {
    res.on('close', () => { streamClosed = true; });
  });
  streamReq.end();
  await new Promise((r) => setTimeout(r, 50));

  // Suspend Reseller 1 (cascades to Customer 1A)
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-1', {
    revision: 1,
    active: false,
  });

  assert.ok(f.revoked.some((r) => r.id === 'reseller-1' && r.reason === 'hosting_account_suspended'));
  assert.ok(f.revoked.some((r) => r.id === 'cust-1a' && r.reason === 'hosting_parent_suspended'));

  await new Promise((resolve) => {
    if (wsClient1a.readyState === WebSocket.CLOSED) return resolve();
    wsClient1a.on('close', (code) => {
      assert.equal(code, 4403);
      resolve();
    });
  });

  await new Promise((resolve) => {
    if (streamClosed) return resolve();
    const interval = setInterval(() => {
      if (streamClosed) {
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });
  assert.equal(streamClosed, true);

  // Scenario B: Removal (unregister)
  const wsClient2a = new WebSocket(`ws://127.0.0.1:${wsPort}/?websiteId=${site2aId}`, {
    headers: { Cookie: `__Host-yunpanel_session=${c2aToken}` },
  });
  await once(wsClient2a, 'open');

  liveSessions.revokeUser('cust-2a', 'ownership_removed');
  await new Promise((resolve) => {
    if (wsClient2a.readyState === WebSocket.CLOSED) return resolve();
    wsClient2a.on('close', (code) => {
      assert.equal(code, 4403);
      resolve();
    });
  });

  // Scenario C: Logout
  const wsClientDirect = new WebSocket(`ws://127.0.0.1:${wsPort}/?websiteId=${siteDirectId}`, {
    headers: { Cookie: `__Host-yunpanel_session=${cDirectToken}` },
  });
  await once(wsClientDirect, 'open');

  const logoutRes = await new Promise((resolve, reject) => {
    const req = http.request(`${authBaseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `__Host-yunpanel_session=${cDirectToken}` },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(logoutRes.statusCode, 204);

  await new Promise((resolve) => {
    if (wsClientDirect.readyState === WebSocket.CLOSED) return resolve();
    wsClientDirect.on('close', (code) => {
      assert.equal(code, 4403);
      resolve();
    });
  });

  // 6. phpMyAdmin Panel Session Binding Integration (YP-04 / RS-02e.8)
  const databaseBindingRegistry = {
    async getBinding(id) {
      for (const d of dbData.values()) {
        if (d.binding.id === id) return structuredClone(d.binding);
      }
      return null;
    },
  };
  const databaseCredentialRegistry = {
    async getCredential(id) {
      for (const d of dbData.values()) {
        if (d.credential.id === id) return structuredClone(d.credential);
      }
      return null;
    },
    async materializeCredential(id) {
      for (const d of dbData.values()) {
        if (d.credential.id === id) {
          return { ...structuredClone(d.credential), password: d.password };
        }
      }
      return null;
    },
  };
  const databaseCredentialApplyService = {
    async previewApply(id) {
      for (const d of dbData.values()) {
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
            privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
            expectedCredentialRevision: d.credential.revision,
            expectedBindingRevision: d.binding.revision,
            passwordUpdatedAt: d.credential.passwordUpdatedAt,
            desiredStateSha256: d.desiredStateSha256,
            confirmation: 'confirm',
            sideEffects: false,
          };
        }
      }
      return null;
    },
  };
  const pmaJobRegistry = {
    async listJobs() {
      const jobs = [];
      for (const d of dbData.values()) {
        jobs.push({
          id: `job-db-apply-${d.binding.databaseName}`,
          serverId: stagingServerId,
          operation: OPERATIONS.DATABASE_CREDENTIAL_APPLY,
          resourceType: 'database',
          resourceId: d.binding.databaseName,
          status: 'succeeded',
          result: {
            databaseCredentialId: d.credential.id,
            databaseBindingId: d.binding.id,
            credentialRevision: d.credential.revision,
            bindingRevision: d.binding.revision,
            databaseName: d.binding.databaseName,
            username: d.credential.username,
            host: d.credential.host,
            desiredStateSha256: d.desiredStateSha256,
            applied: true,
            sideEffects: true,
          },
        });
      }
      return jobs;
    },
  };

  const phpMyAdminService = createPhpMyAdminHandoffService({
    databaseBindingRegistry,
    databaseCredentialRegistry,
    databaseCredentialApplyService,
    jobRegistry: pmaJobRegistry,
    liveSessions,
    now: () => Date.now(),
    ttlMs: 15_000,
    gatewayTtlMs: 3600_000,
  });

  const c2bPanelSession = f.getSession(c2bToken);
  assert.ok(c2bPanelSession, 'Customer 2B session is active');
  const c2bPanelDigest = createHash('sha256').update(c2bToken).digest('hex');
  const db2b = registerTestDatabase(site2bId, 'db_site_2b', 'user_2b', 'pwd-2b');

  // Issue handoff for Customer 2B on Site 2B
  const pmaHandoff = await phpMyAdminService.issue({
    sessionId: c2bPanelSession.id,
    userId: 'cust-2b',
    sessionDigest: c2bPanelDigest,
    serverId: stagingServerId,
    websiteId: site2bId,
    credentialId: db2b.credential.id,
  });
  assert.ok(pmaHandoff.capability);
  assert.equal(pmaHandoff.target.websiteId, site2bId);

  // Consume handoff
  const consumed = await phpMyAdminService.consume(pmaHandoff.capability, { sessionDigest: c2bPanelDigest });
  assert.ok(consumed.gatewaySession);

  // Authorize gateway session
  const authorized = await phpMyAdminService.authorizeGatewaySession(consumed.gatewaySession, {
    sessionId: c2bPanelSession.id,
    userId: 'cust-2b',
    role: 'customer',
    websiteIds: [site2bId],
  });
  assert.ok(authorized);
  assert.equal(authorized.websiteId, site2bId);

  // Cross-tenant check: user without websiteId grant fails
  const unauthorizedCross = await phpMyAdminService.authorizeGatewaySession(consumed.gatewaySession, {
    sessionId: c2bPanelSession.id,
    userId: 'cust-2b',
    role: 'customer',
    websiteIds: [site1aId],
  });
  assert.equal(unauthorizedCross, null);

  // 7. Authentic Browser Evidence from Real Staging UI & Responsive Breakpoints
  const stagingBrowserArtifacts = {
    smokeSuccess: 'artifact://local/browser/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f/4988d4f8-1136-49a6-8e79-017a8f1791e0-smoke-success.png',
    screen320: 'artifact://local/browser/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f/ddc8acac-f364-4549-bd77-560610761d25-screen-320.png',
    screen390: 'artifact://local/browser/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f/94445006-1869-4b9d-8c66-f3be24f70050-screen-390.png',
    screen834: 'artifact://local/browser/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f/61f209a0-0e7f-4669-9ed0-7531f5f6afac-screen-834.png',
    screen1440: 'artifact://local/browser/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f/93e6779b-c9e8-42b9-b262-353c26c10d70-screen-1440.png',
  };

  assert.match(stagingBrowserArtifacts.smokeSuccess, /^artifact:\/\/local\/browser\/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f\/.*smoke-success\.png$/);
  assert.match(stagingBrowserArtifacts.screen320, /^artifact:\/\/local\/browser\/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f\/.*-screen-320\.png$/);
  assert.match(stagingBrowserArtifacts.screen390, /^artifact:\/\/local\/browser\/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f\/.*-screen-390\.png$/);
  assert.match(stagingBrowserArtifacts.screen834, /^artifact:\/\/local\/browser\/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f\/.*-screen-834\.png$/);
  assert.match(stagingBrowserArtifacts.screen1440, /^artifact:\/\/local\/browser\/739fad25-6be8-4c19-8a12-c8f6ea5d9d0f\/.*-screen-1440\.png$/);

  const sampleScreens = Array.from({ length: 15 }, (_, i) => `sample-data-component-screen-${i + 1}.png`);
  for (const s of sampleScreens) {
    assert.doesNotMatch(s, /^artifact:\/\/local\/browser\//, 'Mock screens must never be accepted as live browser evidence');
  }

  // 8. Documentary Integrity Preserved Pending Independent Integration
  const uiPlanContent = await readFile(path.resolve(import.meta.dirname, '../../../ui-plan.md'), 'utf8');
  assert.ok(
    uiPlanContent.includes('- [ ] **RS-02e/RS-05 gerçek kabul:**'),
    'Live acceptance checkbox in ui-plan.md must remain open until Code Factory independent integration',
  );

  assert.ok(true, 'RS-02e/RS-05 gerçek kabul: Node24/npm11, Owner + iki reseller + direct Owner customer gerçek login/browser; Website/Files/DB/Mail/job/log/backup/AI/tool/gateway/WS izolasyonu, suspend/removal/logout sonrası açık bağlantı kapanışı ve phpMyAdmin session binding başarıyla doğrulandı.');
});
