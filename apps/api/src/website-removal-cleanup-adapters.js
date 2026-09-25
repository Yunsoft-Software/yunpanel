import { lstat, rm } from 'node:fs/promises';
import { createNodeServiceRemovalManager, createWebsitePathContract } from '@yunpanel/host-runtime';
import { createNodeDeploymentReceiptStore } from './node-deployment-receipt.js';

export class WebsiteRemovalCleanupAdapterError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteRemovalCleanupAdapterError';
    this.code = code;
    this.status = status;
  }
}

function unavailable(code, message) {
  throw new WebsiteRemovalCleanupAdapterError(code, message, 409);
}

async function absentOrDirectory(target, lstatFn) {
  try {
    const metadata = await lstatFn(target);
    if (metadata.isSymbolicLink?.() || !metadata.isDirectory?.()) {
      unavailable('website_cleanup_path_unsafe', 'Managed Website cleanup root is not a regular directory');
    }
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

export function createWebsiteRemovalCleanupAdapters({
  websiteRegistry,
  applicationRegistry,
  websiteProvisioningRuntime,
  nodeServiceRemovalManager = createNodeServiceRemovalManager(),
  nodeDeploymentReceiptStore = createNodeDeploymentReceiptStore(),
  lstatFn = lstat,
  rmFn = rm,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function' || typeof websiteRegistry.listWebsites !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !websiteProvisioningRuntime?.registry || typeof websiteProvisioningRuntime.registry.listForWebsite !== 'function'
    || typeof websiteProvisioningRuntime.handlers?.unix_identity?.compensate !== 'function'
    || typeof websiteProvisioningRuntime.handlers?.unix_identity?.inspectCompensation !== 'function'
    || !nodeServiceRemovalManager || typeof nodeServiceRemovalManager.inspectRemoval !== 'function'
    || typeof nodeServiceRemovalManager.removeService !== 'function'
    || !nodeDeploymentReceiptStore || typeof nodeDeploymentReceiptStore.read !== 'function'
    || typeof lstatFn !== 'function' || typeof rmFn !== 'function') {
    throw new WebsiteRemovalCleanupAdapterError(
      'website_removal_cleanup_dependencies_invalid',
      'Website removal cleanup dependencies are invalid',
      503,
    );
  }

  async function currentTarget(websiteId, applicationId) {
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || website.id !== websiteId || website.applicationId !== applicationId) {
      unavailable('website_cleanup_identity_drift', 'Website/Application cleanup identity changed');
    }
    const application = await applicationRegistry.getApplication(applicationId);
    if (!application || application.id !== applicationId || application.serverId !== website.serverId) {
      unavailable('website_cleanup_application_drift', 'Application cleanup identity changed');
    }
    const websites = await websiteRegistry.listWebsites({ serverId: website.serverId });
    if (!Array.isArray(websites)
      || websites.some((candidate) => candidate.id !== websiteId && candidate.applicationId === applicationId)) {
      unavailable('website_cleanup_application_shared', 'Application is bound to another Website');
    }
    return Object.freeze({ website, application });
  }

  async function ownedIdentitySource({ websiteId, systemUser } = {}) {
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || !website.applicationId || website.unixUser !== systemUser) {
      unavailable('website_cleanup_identity_drift', 'Website Unix identity changed');
    }
    const operations = await websiteProvisioningRuntime.registry.listForWebsite(websiteId);
    if (!Array.isArray(operations)) unavailable('website_cleanup_identity_evidence_unavailable', 'Website identity journal is unavailable');
    for (const operation of operations) {
      const step = operation?.steps?.find((entry) => entry.kind === 'unix_identity'
        && entry.intent?.websiteId === websiteId
        && entry.intent?.applicationId === website.applicationId
        && entry.intent?.unixUser === systemUser
        && ['succeeded', 'compensated'].includes(entry.state));
      if (step && typeof operation.operationId === 'string') return Object.freeze({ website, operation, step });
    }
    unavailable('website_cleanup_identity_evidence_unavailable', 'Owned Website Unix identity evidence is unavailable');
  }

  async function directSystemdSource(input = {}) {
    const {
      websiteId,
      applicationId,
      serverId,
      releaseId = null,
      serviceName = null,
      currentCommitSha = null,
      servicePort = null,
      healthPath = null,
    } = input;
    const source = await currentTarget(websiteId, applicationId);
    const application = source.application;
    if (source.website.serverId !== serverId
      || application.type !== 'node'
      || application.runtimeAdapter !== 'direct-systemd'
      || (application.currentReleaseId ?? null) !== releaseId
      || (application.serviceName ?? null) !== serviceName
      || (application.currentCommitSha ?? null) !== currentCommitSha
      || (application.servicePort ?? null) !== servicePort
      || (application.healthPath ?? null) !== healthPath) {
      unavailable('website_cleanup_direct_systemd_drift', 'direct-systemd Application evidence changed after preview');
    }

    let deploymentReceipt = null;
    if (releaseId !== null) {
      try { deploymentReceipt = await nodeDeploymentReceiptStore.read(serverId, releaseId); }
      catch { unavailable('website_cleanup_direct_systemd_evidence_unavailable', 'Node deployment receipt could not be read'); }
      if (!deploymentReceipt
        || deploymentReceipt.serverId !== serverId
        || deploymentReceipt.jobId !== releaseId
        || deploymentReceipt.releaseId !== releaseId
        || deploymentReceipt.applicationId !== applicationId
        || deploymentReceipt.serviceName !== serviceName
        || deploymentReceipt.commitSha !== currentCommitSha
        || deploymentReceipt.port !== servicePort
        || deploymentReceipt.healthPath !== healthPath) {
        unavailable('website_cleanup_direct_systemd_evidence_unavailable', 'Node deployment receipt does not match current Application state');
      }
    }

    let host;
    try {
      host = await nodeServiceRemovalManager.inspectRemoval({ applicationId, releaseId, serviceName });
    } catch {
      unavailable('website_cleanup_direct_systemd_host_unverified', 'direct-systemd host state could not be verified');
    }
    if (!host || host.ready !== true || host.applicationId !== applicationId
      || host.releaseId !== releaseId || typeof host.serviceName !== 'string') {
      unavailable('website_cleanup_direct_systemd_host_unverified', 'direct-systemd host state does not match removal evidence');
    }
    if (releaseId !== null && host.serviceName !== serviceName) {
      unavailable('website_cleanup_direct_systemd_host_unverified', 'direct-systemd service identity does not match removal evidence');
    }
    return Object.freeze({ ...source, deploymentReceipt, host });
  }

  async function inspectDirectSystemdCleanup(input = {}) {
    const source = await directSystemdSource(input);
    return Object.freeze({
      ready: true,
      websiteId: source.website.id,
      applicationId: source.application.id,
      serverId: source.website.serverId,
      releaseId: source.application.currentReleaseId ?? null,
      serviceName: source.application.serviceName ?? null,
    });
  }

  async function directSystemdCleanupHandler(input = {}) {
    const source = await directSystemdSource(input);
    let result;
    try {
      result = await nodeServiceRemovalManager.removeService({
        applicationId: source.application.id,
        releaseId: source.application.currentReleaseId ?? null,
        serviceName: source.application.serviceName ?? null,
      });
    } catch {
      unavailable('website_cleanup_direct_systemd_remove_failed', 'direct-systemd host cleanup failed or could not be verified');
    }
    if (!result || result.directSystemdCleaned !== true
      || result.applicationId !== source.application.id
      || result.releaseId !== (source.application.currentReleaseId ?? null)
      || typeof result.serviceName !== 'string'
      || (source.application.currentReleaseId !== null && result.serviceName !== source.application.serviceName)) {
      unavailable('website_cleanup_direct_systemd_host_unverified', 'direct-systemd cleanup receipt is invalid');
    }
    return Object.freeze({
      websiteId: source.website.id,
      applicationId: source.application.id,
      serverId: source.website.serverId,
      releaseId: source.application.currentReleaseId ?? null,
      serviceName: source.application.serviceName ?? null,
      directSystemdCleaned: true,
    });
  }

  async function inspectUnixIdentityCleanup(input) {
    const source = await ownedIdentitySource(input);
    return Object.freeze({
      ready: true,
      websiteId: source.website.id,
      applicationId: source.website.applicationId,
      systemUser: input.systemUser,
      operationId: source.operation.operationId,
    });
  }

  async function unixIdentityCleanupHandler(input = {}) {
    const source = await ownedIdentitySource(input);
    const { websiteId, systemUser } = input;
    const context = {
      intent: source.step.intent,
      operationId: source.operation.operationId,
      evidence: source.step.evidence,
    };
    const step = source.step;
    let result;
    if (step.state === 'compensated') {
      result = await websiteProvisioningRuntime.handlers.unix_identity.inspectCompensation(context);
    } else {
      result = await websiteProvisioningRuntime.handlers.unix_identity.compensate(context);
      result = await websiteProvisioningRuntime.handlers.unix_identity.inspectCompensation(context);
    }
    if (!result || result.satisfied !== true || result.removedUser !== true || result.removedGroup !== true) {
      unavailable('website_cleanup_identity_unverified', 'Website Unix identity cleanup could not be verified');
    }
    return Object.freeze({ websiteId, systemUser, unixIdentityCleaned: true });
  }

  function canonicalFileCleanupTargets(websiteId, applicationId) {
    const contract = createWebsitePathContract({ websiteId, applicationId });
    return Object.freeze([
      contract.runtime.applicationRoot,
      contract.workspace.homeDirectory,
      contract.static.buildRoot,
      contract.static.publishRoot,
    ]);
  }

  async function inspectFileCleanup({ websiteId, applicationId } = {}) {
    await currentTarget(websiteId, applicationId);
    const targets = canonicalFileCleanupTargets(websiteId, applicationId);
    for (const target of targets) await absentOrDirectory(target, lstatFn);
    return Object.freeze({ ready: true, websiteId, applicationId, targets });
  }

  async function fileCleanupHandler({ websiteId, applicationId, retainedBackups = [], retainedLogScopes = [] } = {}) {
    const inspection = await inspectFileCleanup({ websiteId, applicationId });
    if (!Array.isArray(retainedBackups) || retainedBackups.some((id) => typeof id !== 'string' || !id)
      || !Array.isArray(retainedLogScopes) || retainedLogScopes.some((id) => typeof id !== 'string' || !id)) {
      unavailable('website_cleanup_retained_scope_invalid', 'Retained backup or log scope is invalid');
    }
    let removed = 0;
    for (const target of inspection.targets) {
      if (await absentOrDirectory(target, lstatFn)) continue;
      await rmFn(target, { recursive: true, force: false, maxRetries: 0 });
      if (!(await absentOrDirectory(target, lstatFn))) {
        unavailable('website_cleanup_path_unverified', 'Managed Website cleanup root is still present');
      }
      removed += 1;
    }
    return Object.freeze({
      websiteId,
      applicationId,
      retainedBackups: Object.freeze([...retainedBackups]),
      retainedLogScopes: Object.freeze([...retainedLogScopes]),
      filesCleaned: true,
      cleanedFilesCount: removed,
    });
  }

  return Object.freeze({
    inspectDirectSystemdCleanup,
    directSystemdCleanupHandler,
    inspectFileCleanup,
    inspectUnixIdentityCleanup,
    fileCleanupHandler,
    unixIdentityCleanupHandler,
  });
}
