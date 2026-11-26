import { OPERATIONS } from '@yunpanel/protocol';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const MANAGED_MAIL_MUTATIONS = new Set([
  OPERATIONS.MAIL_CONFIG_APPLY,
  OPERATIONS.MAIL_CONFIG_ROLLBACK,
  OPERATIONS.MAIL_DKIM_APPLY,
]);

export class MailDomainRemovalConfigPhaseError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainRemovalConfigPhaseError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new MailDomainRemovalConfigPhaseError(code, message, status);
}

function emptyEvidence() {
  return Object.freeze({
    disableJobId: null,
    finalRevision: null,
    cleanupEvidenceDigest: null,
    dataDeleteJobId: null,
    backupId: null,
  });
}

function outcome(operation, disposition, details, sideEffects) {
  return Object.freeze({
    version: 1,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    fromStatus: operation.status,
    disposition,
    sideEffects,
    ...details,
  });
}

function blocked(operation, code, message, sideEffects) {
  return outcome(operation, 'blocked', { error: Object.freeze({ code, message }) }, sideEffects);
}

function failed(operation, code, message, sideEffects) {
  return outcome(operation, 'failed', { error: Object.freeze({ code, message }) }, sideEffects);
}

function operationIdentity(operation) {
  const configuration = operation?.cleanupPlan?.disableConfiguration;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)
    || typeof operation.id !== 'string' || !operation.id
    || operation.managementMode !== 'local'
    || !['enabled', 'disabled'].includes(operation.sourceStatus)
    || !Number.isSafeInteger(operation.sourceRevision) || operation.sourceRevision < 1
    || typeof operation.mailDomainId !== 'string' || !operation.mailDomainId
    || typeof operation.webDomainId !== 'string' || !operation.webDomainId
    || typeof operation.domainName !== 'string' || !operation.domainName
    || !['pending', 'disabling'].includes(operation.status)
    || !operation.cleanupPlan || operation.cleanupPlan.version !== 2
    || operation.cleanupPlan.mailDomainId !== operation.mailDomainId
    || (operation.sourceStatus === 'enabled' && (
      !configuration
      || typeof configuration.previewDigest !== 'string'
      || !SHA256_PATTERN.test(configuration.previewDigest)
      || typeof configuration.configurationSha256 !== 'string'
      || !SHA256_PATTERN.test(configuration.configurationSha256)
    ))
    || (operation.sourceStatus === 'disabled' && configuration !== null)) {
    fail(
      'mail_domain_removal_config_operation_invalid',
      'Mail Domain removal config phase operation is invalid',
    );
  }
  return operation;
}

function idempotencyKey(operation) {
  return `mail-domain-remove-disable:${operation.id}`;
}

function requestFor(operation, serverId) {
  const configuration = operation.cleanupPlan.disableConfiguration;
  if (!configuration) {
    fail(
      'mail_domain_removal_config_intent_missing',
      'Mail Domain removal lacks pinned config disable evidence',
    );
  }
  return Object.freeze({
    serverId,
    type: OPERATIONS.MAIL_CONFIG_APPLY,
    operation: OPERATIONS.MAIL_CONFIG_APPLY,
    payload: Object.freeze({
      mailDomainId: operation.mailDomainId,
      expectedRevision: operation.sourceRevision,
      desiredStatus: 'disabled',
      previewDigest: configuration.previewDigest,
      configurationSha256: configuration.configurationSha256,
    }),
    resourceType: 'mail_domain',
    resourceId: operation.mailDomainId,
    idempotencyKey: idempotencyKey(operation),
  });
}

function jobMatches(job, operation, serverId) {
  return Boolean(job
    && typeof job.id === 'string' && job.id.length >= 8
    && job.serverId === serverId
    && job.type === OPERATIONS.MAIL_CONFIG_APPLY
    && job.operation === OPERATIONS.MAIL_CONFIG_APPLY
    && job.resourceType === 'mail_domain'
    && job.resourceId === operation.mailDomainId
    && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status));
}

function successfulJobEvidence(job, operation) {
  const result = job?.result;
  const configuration = operation.cleanupPlan.disableConfiguration;
  return Boolean(job?.status === 'succeeded'
    && result?.version === 3
    && result.mailDomainId === operation.mailDomainId
    && result.previousRevision === operation.sourceRevision
    && result.previousStatus === 'enabled'
    && result.desiredStatus === 'disabled'
    && result.previewDigest === configuration.previewDigest
    && result.configurationSha256 === configuration.configurationSha256
    && typeof result.planSha256 === 'string' && SHA256_PATTERN.test(result.planSha256)
    && typeof result.backupSha256 === 'string' && SHA256_PATTERN.test(result.backupSha256)
    && typeof result.readinessSha256 === 'string' && SHA256_PATTERN.test(result.readinessSha256)
    && result.applied === true
    && result.sideEffects === true);
}

export function createMailDomainRemovalConfigPhase({
  mailDomainRegistry,
  domainRegistry,
  mailConfigurationService,
  jobRegistry,
  jobIdempotencyLookup,
  localServerId = null,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailConfigurationService || typeof mailConfigurationService.previewTransition !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function'
    || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.listJobs !== 'function'
    || !jobIdempotencyLookup || typeof jobIdempotencyLookup.find !== 'function') {
    throw new MailDomainRemovalConfigPhaseError(
      'mail_domain_removal_config_dependencies_invalid',
      'Mail Domain removal config phase dependencies are unavailable',
      503,
    );
  }

  async function currentState(operation) {
    let mailDomain;
    let domain;
    try {
      mailDomain = await mailDomainRegistry.getMailDomain(operation.mailDomainId);
      domain = await domainRegistry.getDomain(operation.webDomainId);
    } catch {
      fail(
        'mail_domain_removal_config_state_unavailable',
        'Mail Domain config state could not be inspected',
        503,
      );
    }
    if (!mailDomain || mailDomain.id !== operation.mailDomainId
      || mailDomain.webDomainId !== operation.webDomainId
      || mailDomain.domainName !== operation.domainName
      || mailDomain.managementMode !== 'local'
      || !domain || domain.id !== operation.webDomainId
      || domain.primaryDomain !== operation.domainName
      || typeof domain.serverId !== 'string' || !domain.serverId
      || (localServerId !== null && domain.serverId !== localServerId)) {
      fail(
        'mail_domain_removal_config_state_drift',
        'Mail Domain config identity changed after removal preview',
      );
    }
    return Object.freeze({ mailDomain, serverId: domain.serverId });
  }

  function sourceStateMatches(operation, mailDomain) {
    return mailDomain.status === operation.sourceStatus
      && mailDomain.revision === operation.sourceRevision
      && mailDomain.updatedAt === operation.sourceUpdatedAt;
  }

  async function currentDisablePreview(operation) {
    let preview;
    try {
      preview = await mailConfigurationService.previewTransition({
        mailDomainId: operation.mailDomainId,
        expectedRevision: operation.sourceRevision,
        status: 'disabled',
      });
    } catch (error) {
      if (error?.status === 409) throw error;
      fail(
        'mail_domain_removal_config_preview_unavailable',
        'Mail configuration disable preview could not be refreshed',
        503,
      );
    }
    const pinned = operation.cleanupPlan.disableConfiguration;
    if (!preview || preview.version !== 1 || preview.operation !== 'mail_configuration_apply'
      || preview.mailDomainId !== operation.mailDomainId
      || preview.expectedRevision !== operation.sourceRevision
      || preview.currentStatus !== 'enabled' || preview.desiredStatus !== 'disabled'
      || preview.readyToApply !== true || !Array.isArray(preview.blockers)
      || preview.blockers.length !== 0 || preview.sideEffects !== false
      || preview.previewDigest !== pinned.previewDigest
      || preview.configuration?.sha256 !== pinned.configurationSha256) {
      fail(
        'mail_domain_removal_config_preview_stale',
        'Mail configuration disable preview changed after removal approval',
      );
    }
    return preview;
  }

  async function findPreparedJob(operation, serverId) {
    const request = requestFor(operation, serverId);
    let job;
    try { job = await jobIdempotencyLookup.find(request); }
    catch (error) {
      if (typeof error?.code === 'string' && Number.isInteger(error?.status)) throw error;
      fail(
        'mail_domain_removal_config_job_lookup_failed',
        'Mail configuration disable job could not be reconciled',
        503,
      );
    }
    if (job !== null && !jobMatches(job, operation, serverId)) {
      fail(
        'mail_domain_removal_config_job_mismatch',
        'Mail configuration disable job does not match removal intent',
      );
    }
    return Object.freeze({ request, job });
  }

  async function dispatch(operation, serverId) {
    const prepared = await findPreparedJob(operation, serverId);
    if (prepared.job) return prepared.job;
    const { mailDomain } = await currentState(operation);
    if (!sourceStateMatches(operation, mailDomain)) {
      fail(
        'mail_domain_removal_config_state_drift',
        'Mail Domain changed before config disable dispatch',
      );
    }
    await currentDisablePreview(operation);
    let jobs;
    try { jobs = await jobRegistry.listJobs({ serverId }); }
    catch {
      fail(
        'mail_domain_removal_config_job_state_unavailable',
        'Managed mail job state could not be inspected',
        503,
      );
    }
    if (!Array.isArray(jobs)) {
      fail(
        'mail_domain_removal_config_job_state_unavailable',
        'Managed mail job state is invalid',
        503,
      );
    }
    if (jobs.some((job) => ACTIVE_JOB_STATUSES.has(job?.status)
      && MANAGED_MAIL_MUTATIONS.has(job?.operation))) {
      return null;
    }
    try { return await jobRegistry.enqueue(prepared.request); }
    catch (error) {
      if (error?.status === 409) return null;
      fail(
        'mail_domain_removal_config_job_enqueue_failed',
        'Mail configuration disable job could not be queued',
        503,
      );
    }
  }

  async function inspectJob(operation, serverId, { sideEffects }) {
    let job = null;
    if (operation.disableJobId === null) {
      job = (await findPreparedJob(operation, serverId)).job;
      if (job === null) {
        return blocked(
          operation,
          'mail_domain_removal_config_dispatch_required',
          'Mail configuration disable job requires explicit dispatch',
          sideEffects,
        );
      }
    } else {
      try { job = await jobRegistry.getJob(operation.disableJobId); }
      catch {
        return blocked(
          operation,
          'mail_domain_removal_config_job_unavailable',
          'Mail configuration disable job could not be inspected',
          sideEffects,
        );
      }
    }
    if (!jobMatches(job, operation, serverId)
      || (operation.disableJobId !== null && job.id !== operation.disableJobId)) {
      return failed(
        operation,
        'mail_domain_removal_config_job_mismatch',
        'Mail configuration disable job does not match removal intent',
        sideEffects,
      );
    }
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      return blocked(
        operation,
        'mail_domain_removal_config_job_pending',
        'Mail configuration disable job is still active',
        sideEffects,
      );
    }
    if (job.status !== 'succeeded' || !successfulJobEvidence(job, operation)) {
      return failed(
        operation,
        'mail_domain_removal_config_job_failed',
        'Mail configuration disable job did not produce exact success evidence',
        sideEffects,
      );
    }
    const { mailDomain } = await currentState(operation);
    if (mailDomain.status !== 'disabled'
      || mailDomain.revision !== operation.sourceRevision + 1) {
      return blocked(
        operation,
        'mail_domain_removal_config_reconciliation_pending',
        'Mail Domain disable reconciliation is not complete',
        sideEffects,
      );
    }
    return outcome(operation, 'advance', {
      status: 'cleaning',
      evidence: Object.freeze({
        ...emptyEvidence(),
        disableJobId: job.id,
        finalRevision: mailDomain.revision,
      }),
    }, sideEffects);
  }

  async function execute(operationValue) {
    const operation = operationIdentity(operationValue);
    const { mailDomain, serverId } = await currentState(operation);
    if (operation.status === 'pending') {
      if (!sourceStateMatches(operation, mailDomain)) {
        fail(
          'mail_domain_removal_config_state_drift',
          'Mail Domain changed before config phase start',
        );
      }
      if (operation.sourceStatus === 'disabled') {
        return outcome(operation, 'advance', {
          status: 'cleaning',
          evidence: Object.freeze({ ...emptyEvidence(), finalRevision: operation.sourceRevision }),
        }, true);
      }
      await currentDisablePreview(operation);
      return outcome(operation, 'advance', {
        status: 'disabling',
        evidence: emptyEvidence(),
      }, true);
    }
    if (operation.disableJobId === null) {
      const job = await dispatch(operation, serverId);
      if (!job) {
        return blocked(
          operation,
          'mail_domain_removal_config_job_conflict',
          'Another managed mail operation is active',
          true,
        );
      }
      if (!jobMatches(job, operation, serverId)) {
        return failed(
          operation,
          'mail_domain_removal_config_job_mismatch',
          'Mail configuration disable job does not match removal intent',
          true,
        );
      }
      return outcome(operation, 'advance', {
        status: 'disabling',
        evidence: Object.freeze({ ...emptyEvidence(), disableJobId: job.id }),
      }, true);
    }
    return inspectJob(operation, serverId, { sideEffects: true });
  }

  async function inspect(operationValue) {
    const operation = operationIdentity(operationValue);
    if (operation.status !== 'disabling') {
      fail(
        'mail_domain_removal_config_inspection_invalid',
        'Only an interrupted config disable phase can be inspected',
      );
    }
    const { serverId } = await currentState(operation);
    return inspectJob(operation, serverId, { sideEffects: false });
  }

  return Object.freeze({ execute, inspect });
}

export const mailDomainRemovalConfigPhaseInternals = Object.freeze({
  emptyEvidence,
  operationIdentity,
  idempotencyKey,
  requestFor,
  jobMatches,
  successfulJobEvidence,
});
