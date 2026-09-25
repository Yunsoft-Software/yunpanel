import { OPERATIONS } from '@yunpanel/protocol';
import { ensureMailConfigurationIdle } from './mail-configuration-http.js';
import { websiteProvisioningJobAuthorization } from './website-provisioning-job-authorization.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const INTENT_FIELDS = new Set([
  'adapter',
  'serverId',
  'websiteId',
  'webDomainId',
  'mailDomainId',
  'domainName',
  'expectedMailDomainRevision',
  'expectedMailDomainStatus',
  'expectedKeyRevision',
  'selector',
]);

export class WebsiteMailDkimConfigProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMailDkimConfigProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function requestIntent(value, websiteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.adapter !== 'managed-mail-dkim-config'
    || !UUID_PATTERN.test(value.serverId ?? '')
    || !UUID_PATTERN.test(value.websiteId ?? '') || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.webDomainId ?? '')
    || !UUID_PATTERN.test(value.mailDomainId ?? '')
    || typeof value.domainName !== 'string' || !value.domainName
    || value.expectedMailDomainRevision !== 2
    || value.expectedMailDomainStatus !== 'enabled'
    || value.expectedKeyRevision !== 1
    || typeof value.selector !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.selector)) {
    throw new WebsiteMailDkimConfigProvisioningError(
      'website_mail_dkim_config_intent_invalid',
      'Website DKIM configuration provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    adapter: value.adapter,
    serverId: value.serverId.toLowerCase(),
    websiteId: value.websiteId.toLowerCase(),
    webDomainId: value.webDomainId.toLowerCase(),
    mailDomainId: value.mailDomainId.toLowerCase(),
    domainName: value.domainName,
    expectedMailDomainRevision: value.expectedMailDomainRevision,
    expectedMailDomainStatus: value.expectedMailDomainStatus,
    expectedKeyRevision: value.expectedKeyRevision,
    selector: value.selector,
  });
}

function childType(operationId, phase) {
  if (!UUID_PATTERN.test(operationId ?? '') || !['apply', 'cleanup'].includes(phase)) {
    throw new WebsiteMailDkimConfigProvisioningError(
      'website_mail_dkim_config_operation_invalid',
      'Website DKIM configuration operation identity is invalid',
      400,
    );
  }
  return `website_dkim_${phase}:${operationId.toLowerCase()}`;
}

function idempotencyKey(operationId, phase, attempt) {
  if (!UUID_PATTERN.test(operationId ?? '') || !['apply', 'cleanup'].includes(phase)
    || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new WebsiteMailDkimConfigProvisioningError(
      'website_mail_dkim_config_attempt_invalid',
      'Website DKIM configuration attempt identity is invalid',
      500,
    );
  }
  return `website.mail.dkim.${phase}:${operationId.toLowerCase()}:attempt:${attempt}`;
}

function orderedJobs(jobs) {
  return [...jobs].sort((left, right) => {
    const byCreatedAt = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
    return byCreatedAt !== 0 ? byCreatedAt : String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
}

function scopedJobs(jobs, request, operationId, phase) {
  if (!Array.isArray(jobs)) {
    throw new WebsiteMailDkimConfigProvisioningError(
      'website_mail_dkim_config_job_state_invalid',
      'Website DKIM configuration child job state is invalid',
      503,
    );
  }
  const type = childType(operationId, phase);
  return orderedJobs(jobs.filter((job) => (
    job?.serverId === request.serverId
    && job?.type === type
    && job?.operation === OPERATIONS.MAIL_DKIM_APPLY
    && job?.resourceType === 'mail_domain'
    && job?.resourceId === request.mailDomainId
  )));
}

function successfulJob(job, request, operationId, phase) {
  if (!job || !UUID_PATTERN.test(job.id ?? '')
    || job.serverId !== request.serverId
    || job.type !== childType(operationId, phase)
    || job.operation !== OPERATIONS.MAIL_DKIM_APPLY
    || job.resourceType !== 'mail_domain'
    || job.resourceId !== request.mailDomainId
    || job.status !== 'succeeded'
    || job.result?.version !== 1
    || job.result.mailDomainId !== request.mailDomainId
    || job.result.expectedKeyRevision !== request.expectedKeyRevision
    || !SHA256_PATTERN.test(job.result.previewDigest ?? '')
    || !SHA256_PATTERN.test(job.result.configurationSha256 ?? '')
    || job.result.applied !== true
    || job.result.sideEffects !== true) {
    throw new WebsiteMailDkimConfigProvisioningError(
      phase === 'apply'
        ? 'website_mail_dkim_config_child_failed'
        : 'website_mail_dkim_cleanup_child_failed',
      phase === 'apply'
        ? 'Website DKIM configuration child job did not complete successfully'
        : 'Website DKIM cleanup child job did not complete successfully',
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
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_config_job_missing',
        'Website DKIM configuration child job disappeared before completion',
        503,
      );
    }
  }
  if (!TERMINAL_JOB_STATES.has(current.status)) {
    throw new WebsiteMailDkimConfigProvisioningError(
      'website_mail_dkim_config_job_pending',
      'Website DKIM configuration child job is still running; retry the provisioning step',
      503,
    );
  }
  return current;
}

function applyEvidence(job, request) {
  return Object.freeze({
    satisfied: true,
    adapter: 'managed-mail-dkim-config',
    mailDomainId: request.mailDomainId,
    dkimApplyJobId: job.id,
    expectedKeyRevision: request.expectedKeyRevision,
    previewDigest: job.result.previewDigest,
    configurationSha256: job.result.configurationSha256,
  });
}

function cleanupEvidence(job, request, mailConfigCompensation) {
  return Object.freeze({
    satisfied: true,
    adapter: 'managed-mail-dkim-config',
    mailDomainId: request.mailDomainId,
    dkimCleanupJobId: job.id,
    expectedKeyRevision: request.expectedKeyRevision,
    previewDigest: job.result.previewDigest,
    configurationSha256: job.result.configurationSha256,
    mailConfigRollbackJobId: mailConfigCompensation?.rollbackJobId ?? null,
    cleanedUp: true,
  });
}

export function createWebsiteMailDkimConfigProvisioningHandler({
  jobRegistry,
  mailDomainRegistry,
  domainRegistry,
  mailDkimRegistry,
  mailDkimConfigurationService,
  mailConfigProvisioningHandler,
  waitForTerminalJob = (job) => defaultWaitForTerminalJob(jobRegistry, job),
} = {}) {
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function'
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.listJobs !== 'function'
    || !mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || !mailDkimConfigurationService || typeof mailDkimConfigurationService.previewApply !== 'function'
    || !mailConfigProvisioningHandler || typeof mailConfigProvisioningHandler.compensate !== 'function'
    || typeof mailConfigProvisioningHandler.inspectCompensation !== 'function'
    || typeof waitForTerminalJob !== 'function') {
    throw new WebsiteMailDkimConfigProvisioningError(
      'website_mail_dkim_config_dependencies_invalid',
      'Website DKIM configuration provisioning dependencies are invalid',
      503,
    );
  }

  async function ownership(request) {
    const [mailDomain, webDomain, key] = await Promise.all([
      mailDomainRegistry.getMailDomain(request.mailDomainId),
      domainRegistry.getDomain(request.webDomainId),
      mailDkimRegistry.getKey(request.mailDomainId),
    ]);
    if (!mailDomain || mailDomain.id !== request.mailDomainId
      || mailDomain.webDomainId !== request.webDomainId
      || mailDomain.domainName !== request.domainName
      || mailDomain.managementMode !== 'local') {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_config_domain_conflict',
        'Website DKIM configuration Mail Domain ownership does not match provisioning intent',
      );
    }
    if (!webDomain || webDomain.id !== request.webDomainId
      || webDomain.serverId !== request.serverId
      || webDomain.websiteId !== request.websiteId
      || webDomain.primaryDomain !== request.domainName) {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_config_web_domain_conflict',
        'Website DKIM configuration Web Domain ownership does not match provisioning intent',
      );
    }
    if (!key || key.mailDomainId !== request.mailDomainId
      || key.domainName !== request.domainName
      || key.selector !== request.selector
      || key.revision !== request.expectedKeyRevision) {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_config_key_drift',
        'Website DKIM configuration key does not match operation-owned intent',
      );
    }
    return Object.freeze({ mailDomain, webDomain, key });
  }

  async function jobs(request) {
    const values = await jobRegistry.listJobs({ serverId: request.serverId });
    if (!Array.isArray(values)) {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_config_job_state_invalid',
        'Website DKIM configuration child job state is invalid',
        503,
      );
    }
    return values;
  }

  async function preview(request) {
    return mailDkimConfigurationService.previewApply({
      mailDomainId: request.mailDomainId,
      expectedKeyRevision: request.expectedKeyRevision,
    });
  }

  async function applyOrRecover(request, context, phase) {
    let values = await jobs(request);
    let owned = scopedJobs(values, request, context.operationId, phase);
    let latest = owned.at(-1) ?? null;
    if (latest?.status === 'succeeded') return successfulJob(latest, request, context.operationId, phase);
    if (latest && (latest.status === 'queued' || latest.status === 'running')) {
      return successfulJob(
        await waitForTerminalJob(latest),
        request,
        context.operationId,
        phase,
      );
    }

    const desired = await preview(request);
    if (!desired?.readyToApply || !desired.configuration
      || !SHA256_PATTERN.test(desired.previewDigest ?? '')
      || !SHA256_PATTERN.test(desired.configuration.sha256 ?? '')) {
      return Object.freeze({
        blocked: true,
        reason: 'website_mail_dkim_dns_not_ready',
        preview: desired ?? null,
      });
    }

    await ensureMailConfigurationIdle(jobRegistry, request.serverId);
    values = await jobs(request);
    owned = scopedJobs(values, request, context.operationId, phase);
    latest = owned.at(-1) ?? null;
    if (latest?.status === 'succeeded') return successfulJob(latest, request, context.operationId, phase);
    if (latest && (latest.status === 'queued' || latest.status === 'running')) {
      return successfulJob(
        await waitForTerminalJob(latest),
        request,
        context.operationId,
        phase,
      );
    }

    const attempt = owned.length + 1;
    const queued = await jobRegistry.enqueue({
      serverId: request.serverId,
      type: childType(context.operationId, phase),
      operation: OPERATIONS.MAIL_DKIM_APPLY,
      payload: {
        mailDomainId: request.mailDomainId,
        expectedKeyRevision: request.expectedKeyRevision,
        previewDigest: desired.previewDigest,
        configurationSha256: desired.configuration.sha256,
      },
      resourceType: 'mail_domain',
      resourceId: request.mailDomainId,
      idempotencyKey: idempotencyKey(context.operationId, phase, attempt),
      authorization: websiteProvisioningJobAuthorization(context),
    });
    return successfulJob(
      await waitForTerminalJob(queued),
      request,
      context.operationId,
      phase,
    );
  }

  function mailConfigContext(context) {
    const step = context.operation?.steps?.find((candidate) => candidate.id === 'mail_config');
    if (!step || step.kind !== 'mail_config' || !step.intent) {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_mail_config_step_missing',
        'Website DKIM cleanup requires the sibling managed-mail configuration step',
        503,
      );
    }
    return Object.freeze({
      operation: context.operation,
      operationId: context.operationId,
      websiteId: context.websiteId,
      stepId: step.id,
      intent: step.intent,
      evidence: step.evidence,
      compensation: step.compensation,
    });
  }

  async function inspectMailConfigCompensation(context) {
    const sibling = mailConfigContext(context);
    const inspected = await mailConfigProvisioningHandler.inspectCompensation(sibling);
    return Object.freeze({ sibling, inspected });
  }

  async function ensureMailConfigCompensated(context) {
    const { sibling, inspected } = await inspectMailConfigCompensation(context);
    if (inspected?.satisfied === true) return inspected;
    const compensated = await mailConfigProvisioningHandler.compensate(sibling);
    if (!compensated || compensated.satisfied !== true) {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_mail_config_compensation_failed',
        'Website DKIM cleanup could not disable the operation-owned Mail Domain first',
        503,
      );
    }
    return compensated;
  }

  async function inspect(context = {}) {
    const request = requestIntent(context.intent, context.websiteId);
    const { mailDomain } = await ownership(request);
    if (mailDomain.status !== request.expectedMailDomainStatus
      || mailDomain.revision !== request.expectedMailDomainRevision) {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_config_mail_state_drift',
        'Website DKIM configuration requires the operation-owned enabled Mail Domain revision',
      );
    }
    const owned = scopedJobs(await jobs(request), request, context.operationId, 'apply');
    const latest = owned.at(-1) ?? null;
    if (!latest) {
      const desired = await preview(request);
      return Object.freeze({
        satisfied: false,
        reason: desired?.readyToApply
          ? 'website_mail_dkim_apply_required'
          : 'website_mail_dkim_dns_not_ready',
      });
    }
    if (latest.status === 'succeeded') {
      return applyEvidence(successfulJob(latest, request, context.operationId, 'apply'), request);
    }
    if (latest.status === 'queued' || latest.status === 'running') {
      return Object.freeze({ satisfied: false, reason: 'website_mail_dkim_job_pending' });
    }
    return Object.freeze({ satisfied: false, reason: 'website_mail_dkim_child_failed' });
  }

  async function apply(context = {}) {
    const request = requestIntent(context.intent, context.websiteId);
    const { mailDomain } = await ownership(request);
    if (mailDomain.status !== request.expectedMailDomainStatus
      || mailDomain.revision !== request.expectedMailDomainRevision) {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_config_mail_state_drift',
        'Website DKIM configuration requires the operation-owned enabled Mail Domain revision',
      );
    }
    const result = await applyOrRecover(request, context, 'apply');
    if (result?.blocked) {
      return Object.freeze({ satisfied: false, reason: result.reason });
    }
    return applyEvidence(result, request);
  }

  async function inspectCompensation(context = {}) {
    const request = requestIntent(context.intent, context.websiteId);
    const { mailDomain } = await ownership(request);
    const { inspected } = await inspectMailConfigCompensation(context);
    if (!inspected || inspected.satisfied !== true) {
      return Object.freeze({ satisfied: false, reason: 'website_mail_dkim_mail_config_rollback_required' });
    }
    if (mailDomain.status !== 'disabled'
      || mailDomain.revision !== request.expectedMailDomainRevision + 1) {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_cleanup_mail_state_drift',
        'Website DKIM cleanup requires the operation-owned disabled Mail Domain revision',
      );
    }
    const owned = scopedJobs(await jobs(request), request, context.operationId, 'cleanup');
    const latest = owned.at(-1) ?? null;
    if (!latest) return Object.freeze({ satisfied: false, reason: 'website_mail_dkim_cleanup_required' });
    if (latest.status === 'succeeded') {
      return cleanupEvidence(
        successfulJob(latest, request, context.operationId, 'cleanup'),
        request,
        inspected,
      );
    }
    if (latest.status === 'queued' || latest.status === 'running') {
      return Object.freeze({ satisfied: false, reason: 'website_mail_dkim_cleanup_pending' });
    }
    return Object.freeze({ satisfied: false, reason: 'website_mail_dkim_cleanup_failed' });
  }

  async function compensate(context = {}) {
    const request = requestIntent(context.intent, context.websiteId);
    await ownership(request);
    const mailConfigCompensation = await ensureMailConfigCompensated(context);
    const { mailDomain } = await ownership(request);
    if (mailDomain.status !== 'disabled'
      || mailDomain.revision !== request.expectedMailDomainRevision + 1) {
      throw new WebsiteMailDkimConfigProvisioningError(
        'website_mail_dkim_cleanup_mail_state_drift',
        'Website DKIM cleanup requires the operation-owned disabled Mail Domain revision',
      );
    }
    const result = await applyOrRecover(request, context, 'cleanup');
    if (result?.blocked) {
      return Object.freeze({ satisfied: false, reason: 'website_mail_dkim_cleanup_blocked' });
    }
    return cleanupEvidence(result, request, mailConfigCompensation);
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websiteMailDkimConfigProvisioningInternals = Object.freeze({
  requestIntent,
  childType,
  idempotencyKey,
  scopedJobs,
  successfulJob,
  defaultWaitForTerminalJob,
  applyEvidence,
  cleanupEvidence,
});
