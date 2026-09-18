import { createHash } from 'node:crypto';
import { createNginxManager } from '@yunpanel/host-runtime';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DomainSuspensionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainSuspensionError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function localDomain(domain, localServerId) {
  if (!domain || domain.serverId !== localServerId) {
    throw new DomainSuspensionError('domain_not_found', 'Domain not found', 404);
  }
  if (typeof domain.id !== 'string' || !domain.id
    || typeof domain.primaryDomain !== 'string' || !domain.primaryDomain
    || !Number.isSafeInteger(domain.desiredRevision) || domain.desiredRevision < 1
    || !Number.isSafeInteger(domain.stagedRevision) || domain.stagedRevision < 0
    || !Number.isSafeInteger(domain.appliedRevision) || domain.appliedRevision < 0
    || (domain.stagedChecksum !== null
      && (typeof domain.stagedChecksum !== 'string' || !SHA256_PATTERN.test(domain.stagedChecksum)))) {
    throw new DomainSuspensionError(
      'domain_suspension_domain_invalid',
      'Domain routing state is invalid for suspension',
      409,
    );
  }
  return domain;
}

function activeRoutingEvidence(domain) {
  return Boolean(domain.state === 'active'
    && domain.desiredRevision === domain.stagedRevision
    && domain.desiredRevision === domain.appliedRevision
    && typeof domain.stagedChecksum === 'string'
    && SHA256_PATTERN.test(domain.stagedChecksum)
    && domain.appliedPrimaryDomain === domain.primaryDomain
    && domain.lastError === null);
}

function controlPlaneSuspendState(domain, {
  operationId,
  expectedRevision,
  checksum,
} = {}) {
  if (domain.state === 'suspended'
    && domain.suspensionOperationId === operationId
    && domain.desiredRevision === expectedRevision
    && domain.stagedRevision === expectedRevision
    && domain.appliedRevision === expectedRevision
    && domain.stagedChecksum === checksum
    && domain.suspendedChecksum === checksum
    && domain.appliedPrimaryDomain === domain.primaryDomain
    && domain.lastError === null) return 'suspended';
  if (domain.state === 'active'
    && domain.lastSuspensionOperationId === operationId
    && domain.desiredRevision === expectedRevision
    && domain.stagedRevision === expectedRevision
    && domain.appliedRevision === expectedRevision
    && domain.stagedChecksum === checksum
    && domain.appliedPrimaryDomain === domain.primaryDomain
    && domain.lastError === null) return 'resumed';
  if (domain.state === 'active'
    && domain.desiredRevision === expectedRevision
    && domain.stagedRevision === expectedRevision
    && domain.appliedRevision === expectedRevision
    && domain.stagedChecksum === checksum
    && domain.appliedPrimaryDomain === domain.primaryDomain
    && domain.lastError === null) return 'active';
  return 'drift';
}

function normalizeHostSuspendInspection(value, checksum) {
  if (!value || typeof value !== 'object'
    || value.checksum !== checksum
    || typeof value.satisfied !== 'boolean'
    || (value.deactivationCandidate !== undefined && typeof value.deactivationCandidate !== 'boolean')
    || (value.restorable !== undefined && typeof value.restorable !== 'boolean')) {
    throw new DomainSuspensionError(
      'domain_suspension_host_inspection_invalid',
      'Nginx suspension inspection returned invalid evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: value.satisfied,
    deactivationCandidate: value.deactivationCandidate === true,
    restorable: value.restorable === true,
    reason: typeof value.reason === 'string' ? value.reason : null,
    configName: typeof value.configName === 'string' ? value.configName : null,
    checksum,
    receiptVersion: Number.isSafeInteger(value.receiptVersion) ? value.receiptVersion : null,
  });
}

function normalizeHostResumeInspection(value, checksum) {
  if (!value || typeof value !== 'object'
    || value.checksum !== checksum || typeof value.satisfied !== 'boolean') {
    throw new DomainSuspensionError(
      'domain_resume_host_inspection_invalid',
      'Nginx resume inspection returned invalid evidence',
      503,
    );
  }
  return Object.freeze({
    satisfied: value.satisfied,
    restored: value.restored === true,
    reason: typeof value.reason === 'string' ? value.reason : null,
    configName: typeof value.configName === 'string' ? value.configName : null,
    checksum,
    receiptVersion: Number.isSafeInteger(value.receiptVersion) ? value.receiptVersion : null,
  });
}

function mappedHostError(error, fallbackCode, fallbackMessage) {
  if (typeof error?.code === 'string' && error.code.startsWith('nginx_')) {
    return new DomainSuspensionError(error.code, error.message, 409);
  }
  return new DomainSuspensionError(fallbackCode, fallbackMessage, 503);
}

export function createDomainSuspensionService({
  domainRegistry,
  jobRegistry,
  nginxManager = createNginxManager(),
  localServerId,
} = {}) {
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || typeof domainRegistry.markSuspended !== 'function'
    || typeof domainRegistry.markResumed !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function'
    || !nginxManager || typeof nginxManager.inspectDomainDeactivation !== 'function'
    || typeof nginxManager.deactivateDomain !== 'function'
    || typeof nginxManager.inspectDomainDeactivationRollback !== 'function'
    || typeof nginxManager.rollbackDomainDeactivation !== 'function'
    || typeof localServerId !== 'string' || !localServerId) {
    throw new DomainSuspensionError(
      'domain_suspension_dependencies_invalid',
      'Domain suspension dependencies are unavailable',
      503,
    );
  }

  async function currentDomain(domainId) {
    return localDomain(await domainRegistry.getDomain(domainId), localServerId);
  }

  async function activeJobs(domainId) {
    let jobs;
    try { jobs = await jobRegistry.listJobs({ resourceType: 'domain', resourceId: domainId }); }
    catch {
      throw new DomainSuspensionError(
        'domain_suspension_job_inventory_unavailable',
        'Active Domain jobs could not be inspected',
        503,
      );
    }
    if (!Array.isArray(jobs)) {
      throw new DomainSuspensionError(
        'domain_suspension_job_inventory_invalid',
        'Active Domain job inventory is invalid',
        503,
      );
    }
    return Object.freeze(jobs
      .filter((job) => ['queued', 'running'].includes(job?.status))
      .map((job) => Object.freeze({
        id: String(job.id),
        operation: typeof job.operation === 'string' ? job.operation : null,
        status: job.status,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  async function inspectHostSuspend(primaryDomain, checksum) {
    try {
      return normalizeHostSuspendInspection(
        await nginxManager.inspectDomainDeactivation({ primaryDomain, checksum }),
        checksum,
      );
    } catch (error) {
      if (error instanceof DomainSuspensionError) throw error;
      throw mappedHostError(
        error,
        'domain_suspension_host_inspection_unavailable',
        'Nginx suspension state could not be inspected',
      );
    }
  }

  async function preview({ domainId } = {}) {
    const domain = await currentDomain(domainId);
    const jobs = await activeJobs(domain.id);
    const blockers = [];
    if (domain.state !== 'active') blockers.push('domain_active_state_required');
    if (!activeRoutingEvidence(domain)) blockers.push('domain_routing_evidence_invalid');

    let host = null;
    if (typeof domain.stagedChecksum === 'string' && SHA256_PATTERN.test(domain.stagedChecksum)) {
      try { host = await inspectHostSuspend(domain.primaryDomain, domain.stagedChecksum); }
      catch (error) {
        if (error.code === 'nginx_deactivation_drift') {
          blockers.push('domain_nginx_active_state_drift');
          host = Object.freeze({
            satisfied: false,
            deactivationCandidate: false,
            restorable: false,
            reason: error.code,
            configName: null,
            checksum: domain.stagedChecksum,
            receiptVersion: null,
          });
        } else {
          throw error;
        }
      }
      if (!host.satisfied && !host.deactivationCandidate) {
        blockers.push('domain_nginx_deactivation_unavailable');
      }
      if (host.satisfied) {
        blockers.push('domain_nginx_already_deactivated');
      }
    }
    if (jobs.length > 0) blockers.push('domain_job_active');

    const identity = Object.freeze({
      version: 1,
      operation: 'domain_suspend',
      domain: Object.freeze({
        id: domain.id,
        serverId: domain.serverId,
        primaryDomain: domain.primaryDomain,
        desiredRevision: domain.desiredRevision,
        stagedRevision: domain.stagedRevision,
        appliedRevision: domain.appliedRevision,
        stagedChecksum: domain.stagedChecksum,
        state: domain.state,
      }),
      nginx: host,
      activeJobs: jobs,
      blockers: Object.freeze(blockers),
      readyToSuspend: blockers.length === 0,
    });
    const previewDigest = digest(identity);
    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation: identity.readyToSuspend
        ? `suspend-domain:${domain.id}:${domain.desiredRevision}:${domain.stagedChecksum}:${previewDigest}`
        : null,
      sideEffects: false,
    });
  }

  async function inspectSuspend({
    domainId,
    operationId,
    expectedRevision,
    checksum,
  } = {}) {
    const domain = await currentDomain(domainId);
    const controlPlane = controlPlaneSuspendState(domain, {
      operationId,
      expectedRevision,
      checksum,
    });
    let host;
    try { host = await inspectHostSuspend(domain.primaryDomain, checksum); }
    catch (error) { throw error; }
    return Object.freeze({
      domainId: domain.id,
      primaryDomain: domain.primaryDomain,
      expectedRevision,
      checksum,
      controlPlane,
      host,
    });
  }

  async function deactivateHost({ primaryDomain, checksum } = {}) {
    try { return await nginxManager.deactivateDomain({ primaryDomain, checksum }); }
    catch (error) {
      throw mappedHostError(
        error,
        'domain_suspension_host_failed',
        'Nginx Domain deactivation failed',
      );
    }
  }

  async function restoreHost({ primaryDomain, checksum } = {}) {
    try { return await nginxManager.rollbackDomainDeactivation({ primaryDomain, checksum }); }
    catch (error) {
      throw mappedHostError(
        error,
        'domain_resume_host_failed',
        'Nginx Domain resume failed',
      );
    }
  }

  async function inspectResume({
    domainId,
    operationId,
    expectedRevision,
    checksum,
  } = {}) {
    const domain = await currentDomain(domainId);
    const controlPlane = controlPlaneSuspendState(domain, {
      operationId,
      expectedRevision,
      checksum,
    });
    let host;
    try {
      host = normalizeHostResumeInspection(
        await nginxManager.inspectDomainDeactivationRollback({
          primaryDomain: domain.primaryDomain,
          checksum,
        }),
        checksum,
      );
    } catch (error) {
      if (error instanceof DomainSuspensionError) throw error;
      throw mappedHostError(
        error,
        'domain_resume_host_inspection_unavailable',
        'Nginx resume state could not be inspected',
      );
    }
    return Object.freeze({
      domainId: domain.id,
      primaryDomain: domain.primaryDomain,
      expectedRevision,
      checksum,
      controlPlane,
      host,
    });
  }

  async function commitSuspended({
    domainId,
    operationId,
    expectedRevision,
    checksum,
  } = {}) {
    try {
      return await domainRegistry.markSuspended(domainId, {
        expectedRevision,
        checksum,
        operationId,
      });
    } catch (error) {
      if (typeof error?.code === 'string') {
        throw new DomainSuspensionError(error.code, error.message, error.status ?? 409);
      }
      throw error;
    }
  }

  async function commitResumed({
    domainId,
    operationId,
    expectedRevision,
    checksum,
  } = {}) {
    try {
      return await domainRegistry.markResumed(domainId, {
        expectedRevision,
        checksum,
        operationId,
      });
    } catch (error) {
      if (typeof error?.code === 'string') {
        throw new DomainSuspensionError(error.code, error.message, error.status ?? 409);
      }
      throw error;
    }
  }

  return Object.freeze({
    preview,
    inspectSuspend,
    deactivateHost,
    commitSuspended,
    inspectResume,
    restoreHost,
    commitResumed,
  });
}

export const domainSuspensionInternals = Object.freeze({
  digest,
  localDomain,
  activeRoutingEvidence,
  controlPlaneSuspendState,
  normalizeHostSuspendInspection,
  normalizeHostResumeInspection,
});
