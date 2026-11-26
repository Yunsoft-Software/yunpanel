import { lstat, rm } from 'node:fs/promises';
import { createNodeServiceRemovalManager, createWebsitePathContract } from '@yunpanel/host-runtime';
import { createNodeDeploymentReceiptStore } from '../applications/node-deployment-receipt.js';
import { createWebsitePassengerEnvironmentManager } from '@yunpanel/host-runtime/website-passenger-environment-manager';

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
  applicationEnvironmentRegistry = null,
  passengerEnvironmentManager = createWebsitePassengerEnvironmentManager(),
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

  async function currentTarget(websiteId, applicationId, { allowExternalProxy = false } = {}) {
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || website.id !== websiteId || website.applicationId !== applicationId) {
      unavailable('website_cleanup_identity_drift', 'Website/Application cleanup identity changed');
    }
    if (allowExternalProxy && applicationId === null && website.runtimeType === 'proxy'
      && !website.unixUser && !website.systemUser && website.documentRoot == null
      && !website.dockerWorkloadId && !website.managedComposeBinding) {
      return Object.freeze({ website, application: null });
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

  async function passengerEnvironmentCleanupHandler({ operation, priorReceipt = null, checkpoint } = {}) {
    const { id: removalId, websiteId, applicationId, serverId } = operation ?? {};
    if (typeof removalId !== 'string' || !/^ws-rem-[a-f0-9-]{36}$/.test(removalId)
      || !applicationId || !websiteId || !serverId || typeof checkpoint !== 'function') {
      unavailable('website_cleanup_passenger_environment_scope_invalid', 'Passenger environment removal authority is unavailable');
    }
    if (typeof passengerEnvironmentManager?.inspectAbsence !== 'function'
      || typeof passengerEnvironmentManager?.retire !== 'function') {
      unavailable('website_cleanup_passenger_environment_unavailable', 'Passenger environment retirement is unavailable');
    }
    const [website, application, websites] = await Promise.all([
      websiteRegistry.getWebsite(websiteId), applicationRegistry.getApplication(applicationId),
      websiteRegistry.listWebsites({ serverId }),
    ]);
    if (!Array.isArray(websites) || websites.some(row => row.id !== websiteId && row.applicationId === applicationId)
      || website && (website.id !== websiteId || website.serverId !== serverId || website.applicationId !== applicationId)
      || application && (application.id !== applicationId || application.serverId !== serverId
        || application.desiredRevision !== operation.applicationRevision || application.activeDeploymentId !== null)) {
      unavailable('website_cleanup_passenger_environment_scope_invalid', 'Passenger environment Application ownership changed');
    }
    if (priorReceipt && (priorReceipt.removalId !== removalId || priorReceipt.websiteId !== websiteId
      || priorReceipt.applicationId !== applicationId || priorReceipt.serverId !== serverId)) {
      unavailable('website_cleanup_passenger_environment_scope_invalid', 'Passenger environment removal checkpoint changed');
    }
    const presence = await passengerEnvironmentManager.inspectAbsence(applicationId);
    if (!application && (!priorReceipt || priorReceipt.state !== 'retired' || !presence.includeAbsent)) {
      unavailable('website_cleanup_passenger_environment_ownership_missing', 'An absent Application requires a completed same-journal retirement and physical absence');
    }
    if (operation.plan?.applicationRuntime?.adapter === 'passenger' && priorReceipt?.kind === 'passenger-environment-absence') {
      unavailable('website_cleanup_passenger_environment_ownership_missing', 'A Passenger removal requires its owned retirement checkpoint');
    }
    if (priorReceipt?.kind === 'passenger-environment-absence' && !presence.includeAbsent) {
      unavailable('website_cleanup_passenger_environment_drift', 'Passenger environment include reappeared after verified absence');
    }
    const passenger = application?.type === 'node' && application.runtimeAdapter === 'passenger';
    if (application && !passenger && operation.plan?.applicationRuntime?.adapter === 'passenger') {
      unavailable('website_cleanup_passenger_environment_scope_invalid', 'Application adapter changed after the removal plan');
    }
    if (!passenger && !priorReceipt?.sourceOperationId) {
      if (!presence.includeAbsent) unavailable('website_cleanup_passenger_environment_ownership_missing', 'An environment include exists without supported Passenger authority');
      const result = Object.freeze({ version: 1, kind: 'passenger-environment-absence', state: 'retired', removalId,
        websiteId, applicationId, serverId, includeAbsent: true, applicable: false });
      if (priorReceipt && (Object.keys(priorReceipt).length !== Object.keys(result).length
        || Object.entries(result).some(([key, value]) => priorReceipt[key] !== value))) {
        unavailable('website_cleanup_passenger_environment_ownership_missing', 'The same-journal absence checkpoint is invalid');
      }
      if (!priorReceipt) await checkpoint(result);
      return result;
    }
    if (application && !passenger) unavailable('website_cleanup_passenger_environment_scope_invalid', 'Application adapter changed after Passenger retirement');
    if (!application && !priorReceipt) {
      unavailable('website_cleanup_passenger_environment_ownership_missing', 'Application is absent without a Passenger retirement checkpoint');
    }
    const operations = await websiteProvisioningRuntime.registry.listForWebsite(websiteId);
    if (!Array.isArray(operations)) unavailable('website_cleanup_passenger_environment_ownership_missing', 'Passenger provisioning authority is unavailable');
    const matching = operations.flatMap(source => {
      const app = source?.resources?.application, site = source?.resources?.website;
      if (source.websiteId !== websiteId || app?.id !== applicationId || site?.id !== websiteId
        || site.applicationId !== applicationId || site.serverId !== serverId
        || app.type !== 'node' || app.runtimeAdapter !== 'passenger') return [];
      return source.steps.filter(step => step.kind === 'passenger_environment' && step.state === 'succeeded'
        && step.intent?.applicationId === applicationId && step.evidence?.ownedByOperation === true
        && step.evidence?.applicationId === applicationId && typeof step.evidence?.includeSha256 === 'string')
        .map(step => ({ source, step }));
    }).filter(row => !priorReceipt?.sourceOperationId || row.source.operationId === priorReceipt.sourceOperationId);
    if (matching.length !== 1) unavailable('website_cleanup_passenger_environment_ownership_missing', 'Passenger provisioning ownership is missing or ambiguous');
    const { source, step } = matching[0];
    if (website && (website.runtimeType !== 'node' || website.unixUser !== source.resources.website.unixUser
      || website.documentRoot !== source.resources.website.documentRoot)) {
      unavailable('website_cleanup_passenger_environment_scope_invalid', 'Passenger Website identity changed');
    }
    let snapshot;
    if (application && priorReceipt?.state !== 'retired') {
      if (typeof applicationEnvironmentRegistry?.environmentStatus !== 'function') {
        unavailable('website_cleanup_passenger_environment_unavailable', 'Application environment metadata is unavailable');
      }
      const status = await applicationEnvironmentRegistry.environmentStatus(applicationId);
      const initialSteps = source.steps.filter(row => row.kind === 'passenger_application_release' && row.state === 'succeeded');
      const initialStep = initialSteps.length === 1 ? initialSteps[0] : null;
      const initialReleaseId = application.currentReleaseId === source.operationId && application.lastDeploymentId === source.operationId
        && application.previousReleaseId === null && Array.isArray(application.releases) && application.releases.length === 1
        && application.releases[0].releaseId === source.operationId && application.releases[0].deploymentId === source.operationId
        && initialStep?.intent?.adapter === 'passenger-application-release' && initialStep.intent.applicationId === applicationId
        && initialStep.intent.releaseId === source.operationId && initialStep.evidence?.satisfied === true
        && initialStep.evidence.adapter === 'passenger-application-release' && initialStep.evidence.applicationId === applicationId
        && initialStep.evidence.releaseId === source.operationId && initialStep.evidence.previousReleaseId === null
        && initialStep.evidence.commitSha === application.currentCommitSha && application.releases[0].commitSha === application.currentCommitSha
        ? source.operationId : null;
      snapshot = { releaseId: application.currentReleaseId ?? null, savedRevision: status.savedRevision,
        appliedRevision: status.appliedRevision, appliedReleaseId: status.appliedReleaseId,
        originalIncludeSha256: step.evidence.includeSha256, initialReleaseId };
    } else {
      snapshot = priorReceipt?.authoritySnapshot;
      if (!snapshot || snapshot.originalIncludeSha256 !== step.evidence.includeSha256) {
        unavailable('website_cleanup_passenger_environment_ownership_missing', 'Passenger retirement checkpoint authority is unavailable');
      }
    }
    return passengerEnvironmentManager.retire({ ...snapshot, removalId, websiteId, applicationId, serverId,
      sourceOperationId: source.operationId }, { priorReceipt, checkpoint });
  }

  async function ownedIdentitySource({ websiteId, systemUser } = {}) {
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || !website.applicationId || website.unixUser !== systemUser) {
      unavailable('website_cleanup_identity_drift', 'Website Unix identity changed');
    }
    const operations = await websiteProvisioningRuntime.registry.listForWebsite(websiteId);
    if (!Array.isArray(operations)) unavailable('website_cleanup_identity_evidence_unavailable', 'Website identity journal is unavailable');
    const findStep = (states) => {
      for (const operation of operations) {
        const step = operation?.steps?.find((entry) => entry.kind === 'unix_identity'
          && entry.intent?.websiteId === websiteId
          && entry.intent?.applicationId === website.applicationId
          && entry.intent?.unixUser === systemUser
          && states.includes(entry.state));
        if (step && typeof operation.operationId === 'string') return { operation, step };
      }
      return null;
    };
    const completed = findStep(['succeeded', 'compensated']);
    if (completed) return Object.freeze({ website, ...completed });
    const incomplete = findStep(['pending', 'failed', 'blocked']);
    if (incomplete) return Object.freeze({ website, ...incomplete, neverProvisioned: await identityNeverCreated(incomplete) });
    unavailable('website_cleanup_identity_evidence_unavailable', 'Owned Website Unix identity evidence is unavailable');
  }

  // An unfinished step with a receipt follows normal compensation. Without one, the panel never
  // created the account, so removal may only continue once the host confirms it does not exist.
  async function identityNeverCreated({ operation, step }) {
    const handler = websiteProvisioningRuntime.handlers.unix_identity;
    const context = { intent: step.intent, operationId: operation.operationId, evidence: step.evidence };
    let host;
    try {
      const compensation = await handler.inspectCompensation(context);
      if (compensation?.preservedUnownedState !== true) return false;
      host = await handler.inspect(context);
    } catch {
      unavailable('website_cleanup_identity_evidence_unavailable', 'Website Unix identity host state could not be verified');
    }
    if (host?.satisfied !== false || host.reason !== 'website_identity_user_missing') {
      unavailable('website_cleanup_identity_unowned_account', 'A Unix account with this Website user name exists without an ownership receipt');
    }
    return true;
  }

  function fileManagerContext(source) {
    const handler = websiteProvisioningRuntime.handlers?.elfinder;
    if (typeof handler?.retire !== 'function' || typeof handler?.inspectRetirement !== 'function') {
      unavailable('website_cleanup_elfinder_unavailable', 'Website file manager retirement is unavailable');
    }
    const steps = source.operation.steps.filter((step) => step.kind === 'elfinder');
    if (steps.length > 1) unavailable('website_cleanup_elfinder_evidence_invalid', 'Website file manager journal is ambiguous');
    const intent = { adapter: 'elfinder-fpm', websiteId: source.website.id,
      applicationId: source.website.applicationId, unixUser: source.website.unixUser };
    const step = steps[0];
    if (step && Object.entries(intent).some(([key, value]) => step.intent?.[key] !== value)) {
      unavailable('website_cleanup_elfinder_evidence_invalid', 'Website file manager journal scope changed');
    }
    return {
      handler,
      hasJournal: Boolean(step),
      stepState: step?.state ?? null,
      context: {
        intent: step?.intent ?? intent,
        operationId: source.operation.operationId,
        evidence: step?.evidence ?? null,
      },
    };
  }

  async function retireFileManager(source) {
    const { handler, hasJournal, stepState, context } = fileManagerContext(source);
    try {
      let result;
      if (hasJournal && stepState === 'succeeded') {
        await handler.retire(context);
        result = await handler.inspectRetirement(context);
      } else {
        result = await handler.inspectRetirement(context);
        if (hasJournal && (!result || result.satisfied !== true || result.poolRemoved !== true || result.socketRemoved !== true)) {
          await handler.retire(context);
          result = await handler.inspectRetirement(context);
        }
      }
      if (!result || result.satisfied !== true || result.poolRemoved !== true || result.socketRemoved !== true
        || result.websiteId !== source.website.id || result.applicationId !== source.website.applicationId
        || result.unixUser !== source.website.unixUser) {
        unavailable('website_cleanup_elfinder_unverified', 'Website file manager pool or socket is still present');
      }
    } catch (error) {
      if (error instanceof WebsiteRemovalCleanupAdapterError) throw error;
      unavailable('website_cleanup_elfinder_unverified', 'Website file manager retirement could not be verified');
    }
  }

  async function retirePhpRuntime(source) {
    const steps = source.operation.steps.filter(step => step.kind === 'php_runtime');
    const application = await applicationRegistry.getApplication(source.website.applicationId);
    if (steps.length === 0 && application?.type !== 'php') return;
    const step = steps[0], handler = websiteProvisioningRuntime.handlers?.php_runtime;
    if (steps.length !== 1 || !['succeeded', 'compensated', 'pending', 'failed', 'blocked'].includes(step?.state)
      || step.intent?.adapter !== 'php-fpm' || step.intent?.websiteId !== source.website.id
      || step.intent?.applicationId !== source.website.applicationId || step.intent?.unixUser !== source.website.unixUser) {
      unavailable('website_cleanup_php_evidence_invalid', 'Owned Website PHP provisioning journal is unavailable or changed');
    }
    if (typeof handler?.retire !== 'function' || typeof handler?.inspectRetirement !== 'function') {
      unavailable('website_cleanup_php_unavailable', 'Website PHP retirement is unavailable');
    }
    const currentIntent = { ...step.intent, ...(source.website.phpConfig ?? {}) };
    const context = { intent: step.intent, currentIntent,
      operationId: source.operation.operationId, evidence: step.evidence ?? null };
    try {
      let result;
      if (step.state === 'succeeded') {
        await handler.retire(context);
        result = await handler.inspectRetirement(context);
      } else {
        result = await handler.inspectRetirement(context);
        if (!result?.satisfied || result.poolRemoved !== true || result.socketRemoved !== true) {
          await handler.retire(context);
          result = await handler.inspectRetirement(context);
        }
      }
      if (!result?.satisfied || result.poolRemoved !== true || result.socketRemoved !== true
        || result.websiteId !== source.website.id || result.applicationId !== source.website.applicationId
        || result.unixUser !== source.website.unixUser) {
        unavailable('website_cleanup_php_unverified', 'Website PHP pool or socket is still present');
      }
    } catch (error) {
      if (error instanceof WebsiteRemovalCleanupAdapterError) throw error;
      unavailable('website_cleanup_php_unverified', 'Website PHP retirement could not be verified');
    }
  }

  async function retirePythonRuntime(source) {
    const steps = source.operation.steps.filter((step) => step.kind === 'python_runtime');
    const application = await applicationRegistry.getApplication(source.website.applicationId);
    if (steps.length === 0 && application?.type !== 'python') return;
    const step = steps[0];
    const handler = websiteProvisioningRuntime.handlers?.python_runtime;
    if (steps.length !== 1 || !['succeeded', 'compensated', 'pending', 'failed', 'blocked'].includes(step?.state)
      || step.intent?.adapter !== 'python-runtime' || step.intent?.websiteId !== source.website.id
      || step.intent?.applicationId !== source.website.applicationId || step.intent?.unixUser !== source.website.unixUser) {
      unavailable('website_cleanup_python_evidence_invalid', 'Owned Website Python provisioning journal is unavailable or changed');
    }
    if (typeof handler?.retire !== 'function' || typeof handler?.inspectRetirement !== 'function') {
      unavailable('website_cleanup_python_unavailable', 'Website Python retirement is unavailable');
    }
    const context = {
      intent: step.intent,
      operationId: source.operation.operationId,
      evidence: step.evidence ?? null,
    };
    try {
      let result;
      if (step.state === 'succeeded') {
        await handler.retire(context);
        result = await handler.inspectRetirement(context);
      } else {
        result = await handler.inspectRetirement(context);
        if (!result?.satisfied || result.unitFileRemoved !== true || result.socketRemoved !== true
          || result.envFileRemoved !== true || result.serviceInactive !== true
          || result.serviceUnloaded !== true || result.serviceMasked === true || result.mainPid !== 0) {
          await handler.retire(context);
          result = await handler.inspectRetirement(context);
        }
      }
      if (!result?.satisfied || result.unitFileRemoved !== true || result.socketRemoved !== true
        || result.envFileRemoved !== true || result.serviceInactive !== true
        || result.serviceUnloaded !== true || result.serviceMasked === true || result.mainPid !== 0
        || result.websiteId !== source.website.id || result.applicationId !== source.website.applicationId
        || result.unixUser !== source.website.unixUser) {
        unavailable('website_cleanup_python_unverified', 'Website Python systemd unit, socket, or environment file is still present');
      }
    } catch (error) {
      if (error instanceof WebsiteRemovalCleanupAdapterError) throw error;
      unavailable('website_cleanup_python_unverified', 'Website Python retirement could not be verified');
    }
  }

  async function retireSftp(source) {
    const steps = source.operation.steps.filter(step => step.kind === 'sftp');
    const handler = websiteProvisioningRuntime.handlers?.sftp;
    const intent = { adapter: 'openssh-internal-sftp', websiteId: source.website.id,
      applicationId: source.website.applicationId, unixUser: source.website.unixUser };
    if (steps.length > 1 || steps[0] && (Object.entries(intent).some(([key, value]) => steps[0].intent?.[key] !== value)
      || !['succeeded', 'compensated', 'pending', 'failed', 'blocked'].includes(steps[0].state))) {
      unavailable('website_cleanup_sftp_evidence_invalid', 'Website SFTP journal scope changed');
    }
    if (typeof handler?.retire !== 'function' || typeof handler?.inspectRetirement !== 'function') {
      unavailable('website_cleanup_sftp_unavailable', 'Website SFTP retirement is unavailable');
    }
    const context = { intent: steps[0]?.intent ?? intent, operationId: source.operation.operationId };
    try {
      let result;
      if (steps[0]?.state === 'succeeded') {
        await handler.retire(context);
        result = await handler.inspectRetirement(context);
      } else {
        result = await handler.inspectRetirement(context);
        if (steps.length && (result?.satisfied !== true || result.sshdConfigRemoved !== true || result.mountUnitRemoved !== true || result.chrootRemoved !== true)) {
          await handler.retire(context);
          result = await handler.inspectRetirement(context);
        }
      }
      if (result?.satisfied !== true || result.sshdConfigRemoved !== true || result.mountUnitRemoved !== true || result.chrootRemoved !== true
        || result.websiteId !== source.website.id || result.applicationId !== source.website.applicationId || result.unixUser !== source.website.unixUser) {
        unavailable('website_cleanup_sftp_unverified', 'Website SFTP mount or configuration is still present');
      }
    } catch (error) {
      if (error instanceof WebsiteRemovalCleanupAdapterError) throw error;
      unavailable('website_cleanup_sftp_unverified', 'Website SFTP retirement could not be verified');
    }
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
    } else {
      unavailable('website_cleanup_direct_systemd_evidence_unavailable', 'Legacy direct-systemd service without deployment receipt requires operator recovery');
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
    fileManagerContext(source);
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
    await retireSftp(source);
    await retirePhpRuntime(source);
    await retirePythonRuntime(source);
    await retireFileManager(source);
    const { websiteId, systemUser } = input;
    if (source.neverProvisioned) return Object.freeze({ websiteId, systemUser, unixIdentityCleaned: true });
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
    const { website, application } = await currentTarget(websiteId, applicationId, { allowExternalProxy: true });
    if (application === null) return Object.freeze({ ready: true, websiteId, applicationId, targets: Object.freeze([]) });
    const targets = canonicalFileCleanupTargets(websiteId, applicationId);
    for (const target of targets) await absentOrDirectory(target, lstatFn);
    fileManagerContext(await ownedIdentitySource({ websiteId, systemUser: website.unixUser }));
    return Object.freeze({ ready: true, websiteId, applicationId, targets });
  }

  async function fileCleanupHandler({ websiteId, applicationId, retainedBackups = [], retainedLogScopes = [] } = {}) {
    const inspection = await inspectFileCleanup({ websiteId, applicationId });
    if (!Array.isArray(retainedBackups) || retainedBackups.some((id) => typeof id !== 'string' || !id)
      || !Array.isArray(retainedLogScopes) || retainedLogScopes.some((id) => typeof id !== 'string' || !id)) {
      unavailable('website_cleanup_retained_scope_invalid', 'Retained backup or log scope is invalid');
    }
    if (applicationId === null) {
      return Object.freeze({ websiteId, applicationId,
        retainedBackups: Object.freeze([...retainedBackups]), retainedLogScopes: Object.freeze([...retainedLogScopes]),
        filesCleaned: true, cleanedFilesCount: 0 });
    }
    const { website } = await currentTarget(websiteId, applicationId);
    const source = await ownedIdentitySource({ websiteId, systemUser: website.unixUser });
    await retireSftp(source);
    await retirePhpRuntime(source);
    await retirePythonRuntime(source);
    await retireFileManager(source);
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
    passengerEnvironmentCleanupHandler,
    inspectDirectSystemdCleanup,
    directSystemdCleanupHandler,
    inspectFileCleanup,
    inspectUnixIdentityCleanup,
    fileCleanupHandler,
    unixIdentityCleanupHandler,
  });
}
