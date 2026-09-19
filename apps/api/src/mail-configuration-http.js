import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';
import { JobRegistryError } from './job-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const PREVIEW_FIELDS = new Set(['expectedRevision', 'status']);
const APPLY_FIELDS = new Set([
  'expectedRevision',
  'status',
  'previewDigest',
  'configurationSha256',
  'confirmation',
]);
const ROLLBACK_PREVIEW_FIELDS = new Set(['sourceApplyJobId']);
const ROLLBACK_FIELDS = new Set(['sourceApplyJobId', 'previewDigest', 'confirmation']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MANAGED_MAIL_MUTATIONS = new Set([
  OPERATIONS.MAIL_CONFIG_APPLY,
  OPERATIONS.MAIL_CONFIG_ROLLBACK,
  OPERATIONS.MAIL_DKIM_APPLY,
]);

export class MailConfigurationHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailConfigurationHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailConfigurationHttpError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailConfigurationHttpError('mail_configuration_query_invalid', 'Managed mail configuration does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

async function scopedMailDomain({ mailDomainRegistry, domainRegistry, mailDomainId, localServerId }) {
  const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
  if (!mailDomain) throw new MailConfigurationHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
  if (!mailDomain.webDomainId) {
    throw new MailConfigurationHttpError('mail_domain_server_unavailable', 'Mail domain is not bound to a local web domain', 409);
  }
  const domain = await domainRegistry.getDomain(mailDomain.webDomainId);
  if (!domain || (localServerId !== null && domain.serverId !== localServerId)) {
    throw new MailConfigurationHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
  }
  return Object.freeze({ mailDomain, domain });
}

export async function ensureMailConfigurationIdle(jobRegistry, serverId) {
  const jobs = await jobRegistry.listJobs({ serverId });
  assertMailConfigurationJobsIdle(jobs);
}

function assertMailConfigurationJobsIdle(jobs) {
  if (!Array.isArray(jobs) || jobs.some((job) => MANAGED_MAIL_MUTATIONS.has(job.operation)
    && (job.status === 'queued' || job.status === 'running'))) {
    throw new JobRegistryError(
      'mail_configuration_job_conflict',
      'Another managed mail configuration change is already queued or running',
      409,
    );
  }
}

export function rollbackPreview(mailDomain, sourceJob, jobs) {
  const result = sourceJob?.result;
  if (!sourceJob || sourceJob.status !== 'succeeded' || sourceJob.operation !== OPERATIONS.MAIL_CONFIG_APPLY
    || sourceJob.resourceType !== 'mail_domain' || sourceJob.resourceId !== mailDomain.id
    || result?.version !== 3 || result.applied !== true || result.sideEffects !== true
    || result.mailDomainId !== mailDomain.id
    || !Number.isSafeInteger(result.previousRevision) || result.previousRevision < 1
    || !['disabled', 'enabled'].includes(result.previousStatus)
    || !['disabled', 'enabled'].includes(result.desiredStatus)
    || !SHA256_PATTERN.test(result.configurationSha256 ?? '')
    || !SHA256_PATTERN.test(result.planSha256 ?? '')
    || !SHA256_PATTERN.test(result.backupSha256 ?? '')
    || !SHA256_PATTERN.test(result.readinessSha256 ?? '')) {
    throw new MailConfigurationHttpError(
      'mail_configuration_rollback_unavailable',
      'Managed mail apply does not have complete rollback evidence',
      409,
    );
  }
  const sourceIndexes = jobs
    .map((job, index) => job?.id === sourceJob.id ? index : -1)
    .filter((index) => index >= 0);
  const latestSuccessfulApplyIndex = jobs.findLastIndex(
    (job) => job?.operation === OPERATIONS.MAIL_CONFIG_APPLY && job.status === 'succeeded',
  );
  if (sourceIndexes.length !== 1 || sourceIndexes[0] !== latestSuccessfulApplyIndex) {
    throw new MailConfigurationHttpError(
      'mail_configuration_rollback_superseded',
      'Managed mail apply was superseded by a newer global configuration',
      409,
    );
  }
  const changedStatus = result.previousStatus !== result.desiredStatus;
  const expectedCurrentRevision = result.previousRevision + (changedStatus ? 1 : 0);
  if (mailDomain.managementMode !== 'local' || mailDomain.status !== result.desiredStatus
    || mailDomain.revision !== expectedCurrentRevision) {
    throw new MailConfigurationHttpError(
      'mail_configuration_rollback_state_changed',
      'Mail domain state changed after the selected apply',
      409,
    );
  }
  const identity = Object.freeze({
    version: 1,
    operation: 'mail_configuration_rollback',
    mailDomainId: mailDomain.id,
    sourceApplyJobId: sourceJob.id,
    previousRevision: result.previousRevision,
    expectedCurrentRevision,
    currentStatus: result.desiredStatus,
    targetStatus: result.previousStatus,
    resultingRevision: expectedCurrentRevision + (changedStatus ? 1 : 0),
    currentConfigurationSha256: result.configurationSha256,
    sourcePlanSha256: result.planSha256,
    backupSha256: result.backupSha256,
  });
  const previewDigest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return Object.freeze({
    ...identity,
    previewDigest,
    confirmation: `rollback-mail-configuration:${mailDomain.id}:${sourceJob.id}:${previewDigest}`,
    readyToRollback: true,
    sideEffects: false,
  });
}

export function mountMailConfigurationRoutes(app, {
  mailConfigurationService,
  mailDomainRegistry,
  domainRegistry,
  jobRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!mailConfigurationService || typeof mailConfigurationService.previewTransition !== 'function') {
    throw new Error('Managed mail configuration service is required');
  }
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function') {
    throw new Error('Mail domain registry is required');
  }
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function') {
    throw new Error('Domain registry is required');
  }
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.listJobs !== 'function') {
    throw new Error('Job registry is required');
  }

  app.post('/api/mail-domains/:mailDomainId/config-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, PREVIEW_FIELDS, 'mail_configuration_preview_input_invalid');
    await scopedMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const preview = await mailConfigurationService.previewTransition({
      mailDomainId: request.params.mailDomainId,
      expectedRevision: body.expectedRevision,
      status: body.status,
    });
    return response.json({ data: preview });
  }));

  app.post('/api/mail-domains/:mailDomainId/config-rollback-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(
      request.body,
      ROLLBACK_PREVIEW_FIELDS,
      'mail_configuration_rollback_preview_input_invalid',
    );
    if (typeof body.sourceApplyJobId !== 'string' || !JOB_ID_PATTERN.test(body.sourceApplyJobId)) {
      throw new MailConfigurationHttpError(
        'mail_configuration_rollback_source_invalid',
        'Managed mail rollback source job identity is invalid',
      );
    }
    const scoped = await scopedMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const jobs = await jobRegistry.listJobs({ serverId: scoped.domain.serverId });
    assertMailConfigurationJobsIdle(jobs);
    const sourceJob = await jobRegistry.getJob(body.sourceApplyJobId);
    if (!sourceJob || sourceJob.serverId !== scoped.domain.serverId) {
      throw new MailConfigurationHttpError(
        'mail_configuration_rollback_source_not_found',
        'Managed mail rollback source job was not found',
        404,
      );
    }
    return response.json({ data: rollbackPreview(scoped.mailDomain, sourceJob, jobs) });
  }));

  app.post('/api/mail-domains/:mailDomainId/config-apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, APPLY_FIELDS, 'mail_configuration_apply_input_invalid');
    if (!SHA256_PATTERN.test(body.previewDigest ?? '') || !SHA256_PATTERN.test(body.configurationSha256 ?? '')
      || typeof body.confirmation !== 'string' || body.confirmation.length > 256) {
      throw new MailConfigurationHttpError('mail_configuration_confirmation_invalid', 'Managed mail configuration confirmation is invalid');
    }
    const scoped = await scopedMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const preview = await mailConfigurationService.previewTransition({
      mailDomainId: request.params.mailDomainId,
      expectedRevision: body.expectedRevision,
      status: body.status,
    });
    if (!preview.readyToApply || !preview.configuration) {
      throw new MailConfigurationHttpError('mail_configuration_not_ready', 'Managed mail configuration is not ready to apply', 409);
    }
    if (body.previewDigest !== preview.previewDigest
      || body.configurationSha256 !== preview.configuration.sha256
      || body.confirmation !== preview.confirmation) {
      throw new MailConfigurationHttpError('mail_configuration_preview_stale', 'Managed mail configuration changed after preview', 409);
    }

    const serverId = scoped.domain.serverId;
    if (typeof serverId !== 'string' || !serverId) {
      throw new MailConfigurationHttpError('mail_domain_server_unavailable', 'Mail domain server identity is unavailable', 409);
    }
    await ensureMailConfigurationIdle(jobRegistry, serverId);
    const job = await jobRegistry.enqueue({
      serverId,
      type: OPERATIONS.MAIL_CONFIG_APPLY,
      operation: OPERATIONS.MAIL_CONFIG_APPLY,
      payload: {
        mailDomainId: request.params.mailDomainId,
        expectedRevision: body.expectedRevision,
        desiredStatus: body.status,
        previewDigest: preview.previewDigest,
        configurationSha256: preview.configuration.sha256,
      },
      resourceType: 'mail_domain',
      resourceId: request.params.mailDomainId,
    });
    return response.status(202).json({ data: job });
  }));

  app.post('/api/mail-domains/:mailDomainId/config-rollback', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, ROLLBACK_FIELDS, 'mail_configuration_rollback_input_invalid');
    if (typeof body.sourceApplyJobId !== 'string' || !JOB_ID_PATTERN.test(body.sourceApplyJobId)
      || !SHA256_PATTERN.test(body.previewDigest ?? '')
      || typeof body.confirmation !== 'string' || body.confirmation.length > 512) {
      throw new MailConfigurationHttpError(
        'mail_configuration_rollback_confirmation_invalid',
        'Managed mail rollback confirmation is invalid',
      );
    }
    const scoped = await scopedMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const serverId = scoped.domain.serverId;
    if (typeof serverId !== 'string' || !serverId) {
      throw new MailConfigurationHttpError('mail_domain_server_unavailable', 'Mail domain server identity is unavailable', 409);
    }
    const jobs = await jobRegistry.listJobs({ serverId });
    assertMailConfigurationJobsIdle(jobs);
    const sourceJob = await jobRegistry.getJob(body.sourceApplyJobId);
    if (!sourceJob || sourceJob.serverId !== serverId) {
      throw new MailConfigurationHttpError(
        'mail_configuration_rollback_source_not_found',
        'Managed mail rollback source job was not found',
        404,
      );
    }
    const preview = rollbackPreview(scoped.mailDomain, sourceJob, jobs);
    if (!preview.readyToRollback || body.previewDigest !== preview.previewDigest
      || body.confirmation !== preview.confirmation) {
      throw new MailConfigurationHttpError(
        'mail_configuration_rollback_preview_stale',
        'Managed mail rollback changed after preview',
        409,
      );
    }

    const refreshed = await scopedMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    if (refreshed.domain.serverId !== serverId) {
      throw new MailConfigurationHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
    }
    const refreshedJobs = await jobRegistry.listJobs({ serverId });
    assertMailConfigurationJobsIdle(refreshedJobs);
    const refreshedSourceJob = await jobRegistry.getJob(body.sourceApplyJobId);
    if (!refreshedSourceJob || refreshedSourceJob.serverId !== serverId) {
      throw new MailConfigurationHttpError(
        'mail_configuration_rollback_source_not_found',
        'Managed mail rollback source job was not found',
        404,
      );
    }
    const refreshedPreview = rollbackPreview(refreshed.mailDomain, refreshedSourceJob, refreshedJobs);
    if (body.previewDigest !== refreshedPreview.previewDigest
      || body.confirmation !== refreshedPreview.confirmation) {
      throw new MailConfigurationHttpError(
        'mail_configuration_rollback_preview_stale',
        'Managed mail rollback changed after preview',
        409,
      );
    }
    const job = await jobRegistry.enqueue({
      serverId,
      type: OPERATIONS.MAIL_CONFIG_ROLLBACK,
      operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
      payload: {
        mailDomainId: request.params.mailDomainId,
        sourceApplyJobId: refreshedPreview.sourceApplyJobId,
        previousRevision: refreshedPreview.previousRevision,
        expectedCurrentRevision: refreshedPreview.expectedCurrentRevision,
        currentStatus: refreshedPreview.currentStatus,
        targetStatus: refreshedPreview.targetStatus,
        currentConfigurationSha256: refreshedPreview.currentConfigurationSha256,
        sourcePlanSha256: refreshedPreview.sourcePlanSha256,
        backupSha256: refreshedPreview.backupSha256,
        previewDigest: refreshedPreview.previewDigest,
      },
      resourceType: 'mail_domain',
      resourceId: request.params.mailDomainId,
    });
    return response.status(202).json({ data: job });
  }));
}

export const mailConfigurationHttpInternals = Object.freeze({
  exactBody,
  emptyQuery,
  scopedMailDomain,
  ensureMailConfigurationIdle,
  assertMailConfigurationJobsIdle,
  rollbackPreview,
  managedMailMutations: MANAGED_MAIL_MUTATIONS,
});
