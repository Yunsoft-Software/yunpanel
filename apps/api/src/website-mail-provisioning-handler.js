import { OPERATIONS } from '@yunpanel/protocol';
import {
  ensureMailConfigurationIdle,
  rollbackPreview,
} from './mail-configuration-http.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const INTENT_FIELDS = new Set([
  'adapter',
  'serverId',
  'websiteId',
  'webDomainId',
  'mailDomainId',
  'expectedRevision',
  'initialStatus',
  'desiredStatus',
]);

export class WebsiteMailProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMailProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function mailIntent(value, websiteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.adapter !== 'managed-mail-config'
    || !UUID_PATTERN.test(value.serverId ?? '')
    || !UUID_PATTERN.test(value.websiteId ?? '') || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.webDomainId ?? '')
    || !UUID_PATTERN.test(value.mailDomainId ?? '')
    || value.expectedRevision !== 1
    || value.initialStatus !== 'disabled'
    || value.desiredStatus !== 'enabled') {
    throw new WebsiteMailProvisioningError(
      'website_mail_intent_invalid',
      'Website managed-mail provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    adapter: value.adapter,
    serverId: value.serverId.toLowerCase(),
    websiteId: value.websiteId.toLowerCase(),
    webDomainId: value.webDomainId.toLowerCase(),
    mailDomainId: value.mailDomainId.toLowerCase(),
    expectedRevision: value.expectedRevision,
    initialStatus: value.initialStatus,
    desiredStatus: value.desiredStatus,
  });
}

function applyType(operationId) {
  if (!UUID_PATTERN.test(operationId ?? '')) {
    throw new WebsiteMailProvisioningError(
      'website_mail_operation_invalid',
      'Website managed-mail provisioning operation identity is invalid',
      400,
    );
  }
  return `website_mail_apply:${operationId.toLowerCase()}`;
}

function rollbackType(operationId) {
  if (!UUID_PATTERN.test(operationId ?? '')) {
    throw new WebsiteMailProvisioningError(
      'website_mail_operation_invalid',
      'Website managed-mail provisioning operation identity is invalid',
      400,
    );
  }
  return `website_mail_rollback:${operationId.toLowerCase()}`;
}

function idempotencyKey(operationId, phase, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new WebsiteMailProvisioningError(
      'website_mail_attempt_invalid',
      'Website managed-mail provisioning attempt identity is invalid',
      500,
    );
  }
  return `website.mail.${phase}:${operationId.toLowerCase()}:attempt:${attempt}`;
}

function orderedJobs(jobs) {
  return [...jobs].sort((left, right) => {
    const byCreatedAt = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
    if (byCreatedAt !== 0) return byCreatedAt;
    return String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
}

function scopedJobs(jobs, intent, operationId, operation, type) {
  if (!Array.isArray(jobs)) {
    throw new WebsiteMailProvisioningError(
      'website_mail_job_state_invalid',
      'Website managed-mail child job state is invalid',
      503,
    );
  }
  return orderedJobs(jobs.filter((job) => (
    job?.serverId === intent.serverId
    && job?.resourceType === 'mail_domain'
    && job?.resourceId === intent.mailDomainId
    && job?.operation === operation
    && job?.type === type(operationId)
  )));
}

function applyJobIdentity(job, intent, operationId) {
  if (!job || !UUID_PATTERN.test(job.id ?? '')
    || job.serverId !== intent.serverId
    || job.type !== applyType(operationId)
    || job.operation !== OPERATIONS.MAIL_CONFIG_APPLY
    || job.resourceType !== 'mail_domain'
    || job.resourceId !== intent.mailDomainId) {
    throw new WebsiteMailProvisioningError(
      'website_mail_apply_job_invalid',
      'Website managed-mail apply child job identity is invalid',
      503,
    );
  }
  return job;
}

function successfulApplyJob(job, intent, operationId) {
  applyJobIdentity(job, intent, operationId);
  const result = job.result;
  if (job.status !== 'succeeded'
    || result?.version !== 3
    || result.mailDomainId !== intent.mailDomainId
    || result.previousRevision !== intent.expectedRevision
    || result.previousStatus !== intent.initialStatus
    || result.desiredStatus !== intent.desiredStatus
    || !SHA256_PATTERN.test(result.previewDigest ?? '')
    || !SHA256_PATTERN.test(result.configurationSha256 ?? '')
    || !SHA256_PATTERN.test(result.planSha256 ?? '')
    || !SHA256_PATTERN.test(result.backupSha256 ?? '')
    || !SHA256_PATTERN.test(result.readinessSha256 ?? '')
    || result.applied !== true
    || result.sideEffects !== true) {
    throw new WebsiteMailProvisioningError(
      'website_mail_apply_child_failed',
      'Website managed-mail apply child job did not complete successfully',
      503,
    );
  }
  return job;
}

function rollbackJobIdentity(job, intent, operationId) {
  if (!job || !UUID_PATTERN.test(job.id ?? '')
    || job.serverId !== intent.serverId
    || job.type !== rollbackType(operationId)
    || job.operation !== OPERATIONS.MAIL_CONFIG_ROLLBACK
    || job.resourceType !== 'mail_domain'
    || job.resourceId !== intent.mailDomainId) {
    throw new WebsiteMailProvisioningError(
      'website_mail_rollback_job_invalid',
      'Website managed-mail rollback child job identity is invalid',
      503,
    );
  }
  return job;
}

function successfulRollbackJob(job, intent, operationId, sourceApplyJobId) {
  rollbackJobIdentity(job, intent, operationId);
  const result = job.result;
  if (job.status !== 'succeeded'
    || result?.version !== 1
    || result.mailDomainId !== intent.mailDomainId
    || result.sourceApplyJobId !== sourceApplyJobId
    || result.previousRevision !== intent.expectedRevision
    || result.expectedCurrentRevision !== intent.expectedRevision + 1
    || result.currentStatus !== intent.desiredStatus
    || result.targetStatus !== intent.initialStatus
    || !SHA256_PATTERN.test(result.previewDigest ?? '')
    || !SHA256_PATTERN.test(result.currentConfigurationSha256 ?? '')
    || !SHA256_PATTERN.test(result.sourcePlanSha256 ?? '')
    || !SHA256_PATTERN.test(result.backupSha256 ?? '')
    || !SHA256_PATTERN.test(result.compensationBackupSha256 ?? '')
    || result.restored !== true
    || result.sideEffects !== true) {
    throw new WebsiteMailProvisioningError(
      'website_mail_rollback_child_failed',
      'Website managed-mail rollback child job did not complete successfully',
      503,
    );
  }
  return job;
}

async function defaultWaitForTerminalJob(jobRegistry, job, { timeoutMs = 30_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = job;
  while (!TERMINAL_JOB_STATES.has(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = await jobRegistry.getJob(job.id);
    if (!current) {
      throw new WebsiteMailProvisioningError(
        'website_mail_job_missing',
        'Website managed-mail child job disappeared before completion',
        503,
      );
    }
  }
  if (!TERMINAL_JOB_STATES.has(current.status)) {
    throw new WebsiteMailProvisioningError(
      'website_mail_job_pending',
      'Website managed-mail child job is still running; retry the provisioning step',
      503,
    );
  }
  return current;
}

async function defaultWaitForMailDomain(mailDomainRegistry, mailDomainId, predicate, {
  timeoutMs = 30_000,
  pollMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = await mailDomainRegistry.getMailDomain(mailDomainId);
  while (!predicate(current) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = await mailDomainRegistry.getMailDomain(mailDomainId);
  }
  return current;
}

function applyEvidence(job, intent) {
  const result = job.result;
  return Object.freeze({
    satisfied: true,
    adapter: 'managed-mail-config',
    mailDomainId: intent.mailDomainId,
    applyJobId: job.id,
    previousRevision: result.previousRevision,
    resultingRevision: intent.expectedRevision + 1,
    previousStatus: result.previousStatus,
    desiredStatus: result.desiredStatus,
    previewDigest: result.previewDigest,
    configurationSha256: result.configurationSha256,
    planSha256: result.planSha256,
    backupSha256: result.backupSha256,
    readinessSha256: result.readinessSha256,
  });
}

function compensationEvidence(job, intent, sourceApplyJobId, { noop = false } = {}) {
  if (noop) {
    return Object.freeze({
      satisfied: true,
      adapter: 'managed-mail-config',
      mailDomainId: intent.mailDomainId,
      sourceApplyJobId: null,
      rollbackJobId: null,
      targetStatus: intent.initialStatus,
      resultingRevision: intent.expectedRevision,
      noop: true,
    });
  }
  const result = job.result;
  return Object.freeze({
    satisfied: true,
    adapter: 'managed-mail-config',
    mailDomainId: intent.mailDomainId,
    sourceApplyJobId,
    rollbackJobId: job.id,
    targetStatus: result.targetStatus,
    resultingRevision: result.expectedCurrentRevision + 1,
    previewDigest: result.previewDigest,
    compensationBackupSha256: result.compensationBackupSha256,
    noop: false,
  });
}

export function createWebsiteMailProvisioningHandler({
  jobRegistry,
  mailDomainRegistry,
  domainRegistry,
  mailConfigurationService,
  waitForTerminalJob = (job) => defaultWaitForTerminalJob(jobRegistry, job),
  waitForMailDomain = (mailDomainId, predicate) => defaultWaitForMailDomain(
    mailDomainRegistry,
    mailDomainId,
    predicate,
  ),
} = {}) {
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function'
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.listJobs !== 'function'
    || !mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailConfigurationService || typeof mailConfigurationService.previewTransition !== 'function'
    || typeof waitForTerminalJob !== 'function'
    || typeof waitForMailDomain !== 'function') {
    throw new WebsiteMailProvisioningError(
      'website_mail_dependencies_invalid',
      'Website managed-mail provisioning dependencies are invalid',
      503,
    );
  }

  async function state(intent) {
    const [mailDomain, webDomain] = await Promise.all([
      mailDomainRegistry.getMailDomain(intent.mailDomainId),
      domainRegistry.getDomain(intent.webDomainId),
    ]);
    if (!mailDomain || mailDomain.managementMode !== 'local'
      || mailDomain.webDomainId !== intent.webDomainId
      || !UUID_PATTERN.test(mailDomain.id ?? '')) {
      throw new WebsiteMailProvisioningError(
        'website_mail_domain_conflict',
        'Managed Mail Domain does not match the Website provisioning operation',
      );
    }
    if (!webDomain || webDomain.id !== intent.webDomainId
      || webDomain.serverId !== intent.serverId
      || webDomain.websiteId !== intent.websiteId
      || webDomain.primaryDomain !== mailDomain.domainName) {
      throw new WebsiteMailProvisioningError(
        'website_mail_web_domain_conflict',
        'Managed Mail Domain Web Domain ownership does not match the Website provisioning operation',
      );
    }
    if (!Number.isSafeInteger(mailDomain.revision) || mailDomain.revision < 1
      || !['disabled', 'enabled'].includes(mailDomain.status)) {
      throw new WebsiteMailProvisioningError(
        'website_mail_domain_state_invalid',
        'Managed Mail Domain lifecycle state is invalid',
        503,
      );
    }
    return Object.freeze({ mailDomain, webDomain });
  }

  async function jobs(intent) {
    const values = await jobRegistry.listJobs({ serverId: intent.serverId });
    if (!Array.isArray(values)) {
      throw new WebsiteMailProvisioningError(
        'website_mail_job_state_invalid',
        'Website managed-mail child job state is invalid',
        503,
      );
    }
    return values;
  }

  async function waitForAppliedState(intent) {
    const current = await waitForMailDomain(
      intent.mailDomainId,
      (candidate) => candidate?.status === intent.desiredStatus
        && candidate?.revision === intent.expectedRevision + 1,
    );
    if (!current || current.status !== intent.desiredStatus
      || current.revision !== intent.expectedRevision + 1) {
      throw new WebsiteMailProvisioningError(
        'website_mail_reconciliation_pending',
        'Managed mail apply completed but Mail Domain reconciliation is not confirmed',
        503,
      );
    }
    return current;
  }

  async function waitForRolledBackState(intent) {
    const current = await waitForMailDomain(
      intent.mailDomainId,
      (candidate) => candidate?.status === intent.initialStatus
        && candidate?.revision === intent.expectedRevision + 2,
    );
    if (!current || current.status !== intent.initialStatus
      || current.revision !== intent.expectedRevision + 2) {
      throw new WebsiteMailProvisioningError(
        'website_mail_rollback_reconciliation_pending',
        'Managed mail rollback completed but Mail Domain reconciliation is not confirmed',
        503,
      );
    }
    return current;
  }

  async function ownedApplyJobs(intent, operationId, values = null) {
    return scopedJobs(
      values ?? await jobs(intent),
      intent,
      operationId,
      OPERATIONS.MAIL_CONFIG_APPLY,
      applyType,
    );
  }

  async function ownedRollbackJobs(intent, operationId, values = null) {
    return scopedJobs(
      values ?? await jobs(intent),
      intent,
      operationId,
      OPERATIONS.MAIL_CONFIG_ROLLBACK,
      rollbackType,
    );
  }

  async function inspect(context = {}) {
    const intent = mailIntent(context.intent, context.websiteId);
    const current = await state(intent);
    const owned = await ownedApplyJobs(intent, context.operationId);
    const latest = owned.at(-1) ?? null;

    if (current.mailDomain.status === intent.desiredStatus
      && current.mailDomain.revision === intent.expectedRevision + 1) {
      const source = [...owned].reverse().find((job) => job.status === 'succeeded') ?? null;
      if (!source) {
        throw new WebsiteMailProvisioningError(
          'website_mail_ownership_evidence_missing',
          'Enabled Mail Domain is missing Website provisioning ownership evidence',
        );
      }
      return applyEvidence(successfulApplyJob(source, intent, context.operationId), intent);
    }

    if (current.mailDomain.status !== intent.initialStatus
      || current.mailDomain.revision !== intent.expectedRevision) {
      throw new WebsiteMailProvisioningError(
        'website_mail_state_drift',
        'Managed Mail Domain state changed outside the Website provisioning operation',
      );
    }
    if (!latest) return Object.freeze({ satisfied: false, reason: 'website_mail_not_applied' });
    if (latest.status === 'queued' || latest.status === 'running') {
      return Object.freeze({ satisfied: false, reason: 'website_mail_job_pending' });
    }
    if (latest.status === 'succeeded') {
      successfulApplyJob(latest, intent, context.operationId);
      return Object.freeze({ satisfied: false, reason: 'website_mail_reconciliation_pending' });
    }
    return Object.freeze({ satisfied: false, reason: 'website_mail_child_failed' });
  }

  async function apply(context = {}) {
    const intent = mailIntent(context.intent, context.websiteId);
    const initial = await state(intent);
    if (initial.mailDomain.status === intent.desiredStatus
      && initial.mailDomain.revision === intent.expectedRevision + 1) {
      const inspected = await inspect(context);
      if (inspected.satisfied === true) return inspected;
    }
    if (initial.mailDomain.status !== intent.initialStatus
      || initial.mailDomain.revision !== intent.expectedRevision) {
      throw new WebsiteMailProvisioningError(
        'website_mail_state_drift',
        'Managed Mail Domain is not at the operation-owned initial revision',
      );
    }

    let values = await jobs(intent);
    let owned = await ownedApplyJobs(intent, context.operationId, values);
    let latest = owned.at(-1) ?? null;
    let terminal = null;

    if (latest && (latest.status === 'queued' || latest.status === 'running')) {
      terminal = await waitForTerminalJob(applyJobIdentity(latest, intent, context.operationId));
    } else if (latest?.status === 'succeeded') {
      terminal = latest;
    }

    if (!terminal) {
      const preview = await mailConfigurationService.previewTransition({
        mailDomainId: intent.mailDomainId,
        expectedRevision: intent.expectedRevision,
        status: intent.desiredStatus,
      });
      if (!preview?.readyToApply || !preview.configuration
        || !SHA256_PATTERN.test(preview.previewDigest ?? '')
        || !SHA256_PATTERN.test(preview.configuration.sha256 ?? '')) {
        throw new WebsiteMailProvisioningError(
          'website_mail_configuration_not_ready',
          'Managed mail configuration is not ready for Website provisioning',
          503,
        );
      }
      await ensureMailConfigurationIdle(jobRegistry, intent.serverId);
      values = await jobs(intent);
      owned = await ownedApplyJobs(intent, context.operationId, values);
      latest = owned.at(-1) ?? null;
      if (latest && (latest.status === 'queued' || latest.status === 'running')) {
        terminal = await waitForTerminalJob(applyJobIdentity(latest, intent, context.operationId));
      } else if (latest?.status === 'succeeded') {
        terminal = latest;
      } else {
        const attempt = owned.length + 1;
        const queued = await jobRegistry.enqueue({
          serverId: intent.serverId,
          type: applyType(context.operationId),
          operation: OPERATIONS.MAIL_CONFIG_APPLY,
          payload: {
            mailDomainId: intent.mailDomainId,
            expectedRevision: intent.expectedRevision,
            desiredStatus: intent.desiredStatus,
            previewDigest: preview.previewDigest,
            configurationSha256: preview.configuration.sha256,
          },
          resourceType: 'mail_domain',
          resourceId: intent.mailDomainId,
          idempotencyKey: idempotencyKey(context.operationId, 'apply', attempt),
        });
        terminal = await waitForTerminalJob(applyJobIdentity(queued, intent, context.operationId));
      }
    }

    const succeeded = successfulApplyJob(terminal, intent, context.operationId);
    await waitForAppliedState(intent);
    return applyEvidence(succeeded, intent);
  }

  async function sourceApplyJob(intent, context, values) {
    if (UUID_PATTERN.test(context.evidence?.applyJobId ?? '')) {
      const direct = await jobRegistry.getJob(context.evidence.applyJobId);
      if (direct) return successfulApplyJob(direct, intent, context.operationId);
    }
    const owned = await ownedApplyJobs(intent, context.operationId, values);
    const source = [...owned].reverse().find((job) => job.status === 'succeeded') ?? null;
    if (!source) return null;
    return successfulApplyJob(source, intent, context.operationId);
  }

  async function inspectCompensation(context = {}) {
    const intent = mailIntent(context.intent, context.websiteId);
    const current = await state(intent);
    if (current.mailDomain.status === intent.initialStatus
      && current.mailDomain.revision === intent.expectedRevision) {
      return compensationEvidence(null, intent, null, { noop: true });
    }
    const values = await jobs(intent);
    const source = await sourceApplyJob(intent, context, values);
    if (!source) {
      throw new WebsiteMailProvisioningError(
        'website_mail_compensation_ownership_missing',
        'Managed mail compensation requires operation-owned apply evidence',
      );
    }
    const rollbacks = await ownedRollbackJobs(intent, context.operationId, values);
    const latest = rollbacks.at(-1) ?? null;
    if (current.mailDomain.status === intent.initialStatus
      && current.mailDomain.revision === intent.expectedRevision + 2) {
      const completed = [...rollbacks].reverse().find((job) => job.status === 'succeeded') ?? null;
      if (!completed) {
        throw new WebsiteMailProvisioningError(
          'website_mail_rollback_evidence_missing',
          'Rolled-back Mail Domain is missing Website provisioning rollback evidence',
        );
      }
      return compensationEvidence(
        successfulRollbackJob(completed, intent, context.operationId, source.id),
        intent,
        source.id,
      );
    }
    if (current.mailDomain.status !== intent.desiredStatus
      || current.mailDomain.revision !== intent.expectedRevision + 1) {
      throw new WebsiteMailProvisioningError(
        'website_mail_compensation_state_drift',
        'Managed Mail Domain state changed before Website provisioning compensation',
      );
    }
    if (!latest) return Object.freeze({ satisfied: false, reason: 'website_mail_rollback_required' });
    if (latest.status === 'queued' || latest.status === 'running') {
      return Object.freeze({ satisfied: false, reason: 'website_mail_rollback_pending' });
    }
    if (latest.status === 'succeeded') {
      successfulRollbackJob(latest, intent, context.operationId, source.id);
      return Object.freeze({ satisfied: false, reason: 'website_mail_rollback_reconciliation_pending' });
    }
    return Object.freeze({ satisfied: false, reason: 'website_mail_rollback_failed' });
  }

  async function compensate(context = {}) {
    const intent = mailIntent(context.intent, context.websiteId);
    const current = await state(intent);
    if (current.mailDomain.status === intent.initialStatus
      && current.mailDomain.revision === intent.expectedRevision) {
      return compensationEvidence(null, intent, null, { noop: true });
    }
    if (current.mailDomain.status === intent.initialStatus
      && current.mailDomain.revision === intent.expectedRevision + 2) {
      const inspected = await inspectCompensation(context);
      if (inspected.satisfied === true) return inspected;
    }
    if (current.mailDomain.status !== intent.desiredStatus
      || current.mailDomain.revision !== intent.expectedRevision + 1) {
      throw new WebsiteMailProvisioningError(
        'website_mail_compensation_state_drift',
        'Managed Mail Domain is not at the operation-owned enabled revision',
      );
    }

    let values = await jobs(intent);
    const source = await sourceApplyJob(intent, context, values);
    if (!source) {
      throw new WebsiteMailProvisioningError(
        'website_mail_compensation_ownership_missing',
        'Managed mail compensation requires operation-owned apply evidence',
      );
    }
    let rollbacks = await ownedRollbackJobs(intent, context.operationId, values);
    let latest = rollbacks.at(-1) ?? null;
    let terminal = null;
    if (latest && (latest.status === 'queued' || latest.status === 'running')) {
      terminal = await waitForTerminalJob(rollbackJobIdentity(latest, intent, context.operationId));
    } else if (latest?.status === 'succeeded') {
      terminal = latest;
    }

    if (!terminal) {
      const preview = rollbackPreview(current.mailDomain, source, values);
      await ensureMailConfigurationIdle(jobRegistry, intent.serverId);
      values = await jobs(intent);
      rollbacks = await ownedRollbackJobs(intent, context.operationId, values);
      latest = rollbacks.at(-1) ?? null;
      if (latest && (latest.status === 'queued' || latest.status === 'running')) {
        terminal = await waitForTerminalJob(rollbackJobIdentity(latest, intent, context.operationId));
      } else if (latest?.status === 'succeeded') {
        terminal = latest;
      } else {
        const attempt = rollbacks.length + 1;
        const queued = await jobRegistry.enqueue({
          serverId: intent.serverId,
          type: rollbackType(context.operationId),
          operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
          payload: {
            mailDomainId: intent.mailDomainId,
            sourceApplyJobId: preview.sourceApplyJobId,
            previousRevision: preview.previousRevision,
            expectedCurrentRevision: preview.expectedCurrentRevision,
            currentStatus: preview.currentStatus,
            targetStatus: preview.targetStatus,
            currentConfigurationSha256: preview.currentConfigurationSha256,
            sourcePlanSha256: preview.sourcePlanSha256,
            backupSha256: preview.backupSha256,
            previewDigest: preview.previewDigest,
          },
          resourceType: 'mail_domain',
          resourceId: intent.mailDomainId,
          idempotencyKey: idempotencyKey(context.operationId, 'rollback', attempt),
        });
        terminal = await waitForTerminalJob(rollbackJobIdentity(queued, intent, context.operationId));
      }
    }

    const succeeded = successfulRollbackJob(terminal, intent, context.operationId, source.id);
    await waitForRolledBackState(intent);
    return compensationEvidence(succeeded, intent, source.id);
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websiteMailProvisioningInternals = Object.freeze({
  mailIntent,
  applyType,
  rollbackType,
  idempotencyKey,
  scopedJobs,
  applyJobIdentity,
  successfulApplyJob,
  rollbackJobIdentity,
  successfulRollbackJob,
  defaultWaitForTerminalJob,
  defaultWaitForMailDomain,
  applyEvidence,
  compensationEvidence,
});
