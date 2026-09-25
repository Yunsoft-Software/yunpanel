import { lstat, rm } from 'node:fs/promises';
import { createWebsitePathContract } from '@yunpanel/host-runtime';

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
  lstatFn = lstat,
  rmFn = rm,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function' || typeof websiteRegistry.listWebsites !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !websiteProvisioningRuntime?.registry || typeof websiteProvisioningRuntime.registry.listForWebsite !== 'function'
    || typeof websiteProvisioningRuntime.handlers?.unix_identity?.compensate !== 'function'
    || typeof websiteProvisioningRuntime.handlers?.unix_identity?.inspectCompensation !== 'function'
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

  async function inspectFileCleanup({ websiteId, applicationId } = {}) {
    await currentTarget(websiteId, applicationId);
    const targets = (await inspectFileCleanup({ websiteId, applicationId })).targets;
    for (const target of targets) await absentOrDirectory(target, lstatFn);
    return Object.freeze({ ready: true, websiteId, applicationId, targets: Object.freeze([...targets]) });
  }

  async function fileCleanupHandler({ websiteId, applicationId, retainedBackups = [], retainedLogScopes = [] } = {}) {
    await inspectFileCleanup({ websiteId, applicationId });
    if (!Array.isArray(retainedBackups) || retainedBackups.some((id) => typeof id !== 'string' || !id)
      || !Array.isArray(retainedLogScopes) || retainedLogScopes.some((id) => typeof id !== 'string' || !id)) {
      unavailable('website_cleanup_retained_scope_invalid', 'Retained backup or log scope is invalid');
    }
    const contract = createWebsitePathContract({ websiteId, applicationId });
    const targets = [
      contract.runtime.applicationRoot,
      contract.workspace.homeDirectory,
      contract.static.buildRoot,
      contract.static.publishRoot,
    ];
    let removed = 0;
    for (const target of targets) {
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
    inspectFileCleanup,
    inspectUnixIdentityCleanup,
    fileCleanupHandler,
    unixIdentityCleanupHandler,
  });
}
