import { OPERATIONS } from '@yunpanel/protocol';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class RoundcubeDomainMappingServiceError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'RoundcubeDomainMappingServiceError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new RoundcubeDomainMappingServiceError(code, message, status);
}

function continueConfirmation(mapping) {
  if (!mapping || mapping.state === 'active' || typeof mapping.operationId !== 'string') return null;
  return [
    'continue-roundcube-domain',
    mapping.id,
    mapping.operationId,
    mapping.revision,
    mapping.updatedAt,
  ].join(':');
}

function publicState(mapping, job = null) {
  if (!mapping) return null;
  const terminalJob = job && ['succeeded', 'failed', 'cancelled'].includes(job.status);
  const continuable = ['pending', 'removing'].includes(mapping.state)
    && (mapping.applyJobId === null || terminalJob);
  return Object.freeze({
    mapping: Object.freeze({ ...mapping }),
    job: job ? Object.freeze({
      id: job.id,
      status: job.status,
      operation: job.operation,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }) : null,
    actions: Object.freeze({
      continuation: continuable ? continueConfirmation(mapping) : null,
    }),
  });
}

function previewIncludesPendingMapping(preview, mapping) {
  if (!preview?.readyToApply || !Array.isArray(preview.mappings)
    || typeof preview.sha256 !== 'string' || !SHA256_PATTERN.test(preview.sha256)
    || typeof preview.nginxSha256 !== 'string' || !SHA256_PATTERN.test(preview.nginxSha256)
    || !preview.configuration || typeof preview.configuration.sha256 !== 'string'
    || !preview.fpm || typeof preview.fpm.sha256 !== 'string') return false;
  const matches = preview.mappings.filter((candidate) => (
    candidate.id === mapping.id
    && candidate.mailDomainId === mapping.mailDomainId
    && candidate.webDomainId === mapping.webDomainId
    && candidate.hostname === mapping.hostname
    && candidate.certificateId === mapping.certificateId
    && candidate.certificateFingerprint256 === mapping.certificateFingerprint256
    && candidate.revision === mapping.revision
    && candidate.updatedAt === mapping.updatedAt
  ));
  return matches.length === 1;
}

function previewExcludesRemovingMapping(preview, mapping) {
  return Boolean(preview?.readyToApply
    && Array.isArray(preview.mappings)
    && typeof preview.sha256 === 'string' && SHA256_PATTERN.test(preview.sha256)
    && typeof preview.nginxSha256 === 'string' && SHA256_PATTERN.test(preview.nginxSha256)
    && preview.configuration && typeof preview.configuration.sha256 === 'string'
    && preview.fpm && typeof preview.fpm.sha256 === 'string'
    && !preview.mappings.some((candidate) => candidate.id === mapping.id
      || candidate.mailDomainId === mapping.mailDomainId
      || candidate.hostname === mapping.hostname));
}

export function createRoundcubeDomainMappingService({
  registry,
  roundcubeConfigurationService,
  jobRegistry,
} = {}) {
  if (!registry || typeof registry.previewBind !== 'function'
    || typeof registry.beginBind !== 'function'
    || typeof registry.previewDelete !== 'function'
    || typeof registry.beginDelete !== 'function'
    || typeof registry.getRecordForMailDomain !== 'function'
    || typeof registry.attachApplyJob !== 'function'
    || typeof registry.replaceFailedApplyJob !== 'function'
    || typeof registry.completeApply !== 'function'
    || !roundcubeConfigurationService
    || typeof roundcubeConfigurationService.previewForServer !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function'
    || typeof jobRegistry.listJobs !== 'function'
    || typeof jobRegistry.getJob !== 'function') {
    throw new RoundcubeDomainMappingServiceError(
      'roundcube_mapping_service_dependencies_invalid',
      'Roundcube Domain mapping service dependencies are unavailable',
      503,
    );
  }

  async function jobFor(mapping) {
    if (!mapping?.applyJobId) return null;
    let job;
    try { job = await jobRegistry.getJob(mapping.applyJobId); }
    catch {
      fail(
        'roundcube_mapping_apply_job_unavailable',
        'Roundcube mapping apply job could not be inspected',
        503,
      );
    }
    if (!job) {
      fail(
        'roundcube_mapping_apply_job_missing',
        'Roundcube mapping references a missing apply job',
      );
    }
    return job;
  }

  async function inspect(mailDomainId) {
    const mapping = await registry.getRecordForMailDomain(mailDomainId);
    if (!mapping) return null;
    return publicState(mapping, await jobFor(mapping));
  }

  async function desiredPreview(mapping) {
    let preview;
    try { preview = await roundcubeConfigurationService.previewForServer(mapping.serverId); }
    catch (error) {
      if (Number.isInteger(error?.status)) throw error;
      fail(
        'roundcube_mapping_preview_unavailable',
        'Roundcube desired state could not be materialized',
        503,
      );
    }
    const matches = mapping.state === 'pending'
      ? previewIncludesPendingMapping(preview, mapping)
      : mapping.state === 'removing'
        ? previewExcludesRemovingMapping(preview, mapping)
        : false;
    if (!matches) {
      fail(
        'roundcube_mapping_preview_drift',
        'Roundcube desired state does not match the in-flight mapping operation',
      );
    }
    return preview;
  }

  async function assertNoConcurrentApply(serverId, ignoredJobId = null) {
    let jobs;
    try { jobs = await jobRegistry.listJobs({ serverId }); }
    catch {
      fail(
        'roundcube_mapping_job_inventory_unavailable',
        'Roundcube apply job inventory could not be inspected',
        503,
      );
    }
    if (!Array.isArray(jobs)) {
      fail(
        'roundcube_mapping_job_inventory_invalid',
        'Roundcube apply job inventory is invalid',
        503,
      );
    }
    const conflict = jobs.find((job) => job.id !== ignoredJobId
      && job.operation === OPERATIONS.ROUNDCUBE_CONFIG_APPLY
      && ['queued', 'running'].includes(job.status));
    if (conflict) {
      fail(
        'roundcube_configuration_job_conflict',
        'Another Roundcube configuration change is already queued or running',
      );
    }
  }

  async function enqueueApply(mapping, { replacingJobId = null } = {}) {
    await assertNoConcurrentApply(mapping.serverId, replacingJobId);
    const preview = await desiredPreview(mapping);
    let job;
    try {
      job = await jobRegistry.enqueue({
        serverId: mapping.serverId,
        type: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
        operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
        payload: {
          previewSha256: preview.sha256,
          configSha256: preview.configuration.sha256,
          fpmSha256: preview.fpm.sha256,
        },
        resourceType: 'server',
        resourceId: mapping.serverId,
      });
    } catch (error) {
      if (Number.isInteger(error?.status)) throw error;
      fail(
        'roundcube_mapping_apply_enqueue_failed',
        'Roundcube mapping apply job could not be queued',
        503,
      );
    }
    if (!job || typeof job.id !== 'string') {
      fail(
        'roundcube_mapping_apply_enqueue_failed',
        'Roundcube mapping apply job identity is unavailable',
        503,
      );
    }
    const attached = replacingJobId === null
      ? await registry.attachApplyJob(mapping.mailDomainId, {
        operationId: mapping.operationId,
        jobId: job.id,
        previewSha256: preview.sha256,
        nginxSha256: preview.nginxSha256,
      })
      : await registry.replaceFailedApplyJob(mapping.mailDomainId, {
        operationId: mapping.operationId,
        previousJobId: replacingJobId,
        jobId: job.id,
        previewSha256: preview.sha256,
        nginxSha256: preview.nginxSha256,
      });
    return publicState(attached, job);
  }

  async function beginBind(input) {
    const mapping = await registry.beginBind(input);
    return Object.freeze({
      ...publicState(mapping),
      started: true,
      sideEffects: false,
    });
  }

  async function previewBind(input) {
    return registry.previewBind(input);
  }

  async function previewDelete(mailDomainId) {
    return registry.previewDelete(mailDomainId);
  }

  async function beginDelete(mailDomainId, input, { operationId = null } = {}) {
    const mapping = await registry.beginDelete(mailDomainId, {
      ...input,
      ...(operationId === null ? {} : { operationId }),
    });
    return Object.freeze({
      ...publicState(mapping),
      started: true,
      sideEffects: false,
    });
  }

  async function continueOperation({
    mailDomainId,
    operationId,
    expectedUpdatedAt,
    confirmation,
  } = {}) {
    const mapping = await registry.getRecordForMailDomain(mailDomainId);
    if (!mapping || !['pending', 'removing'].includes(mapping.state)
      || mapping.operationId !== operationId
      || mapping.updatedAt !== expectedUpdatedAt
      || confirmation !== continueConfirmation(mapping)) {
      fail(
        'roundcube_mapping_continuation_stale',
        'Roundcube mapping continuation is stale or confirmation is invalid',
      );
    }

    const job = await jobFor(mapping);
    if (job === null) return enqueueApply(mapping);
    if (['queued', 'running'].includes(job.status)) return publicState(mapping, job);
    if (job.status === 'succeeded') {
      const completed = await registry.completeApply(mailDomainId, {
        operationId: mapping.operationId,
        job,
      });
      if (completed?.state === 'removed') {
        return Object.freeze({
          ...publicState(completed, job),
          deleted: true,
        });
      }
      return Object.freeze({
        ...publicState(completed, job),
        activated: true,
      });
    }
    if (['failed', 'cancelled'].includes(job.status)) {
      const currentPreview = await desiredPreview(mapping);
      if (currentPreview.sha256 === mapping.expectedRoundcubePreviewSha256
        && currentPreview.nginxSha256 === mapping.expectedRoundcubeNginxSha256) {
        return enqueueApply(mapping, { replacingJobId: job.id });
      }
      fail(
        'roundcube_mapping_retry_preview_drift',
        'Roundcube mapping desired state changed after the failed apply',
      );
    }
    fail(
      'roundcube_mapping_apply_job_state_invalid',
      'Roundcube mapping apply job has an unsupported state',
      503,
    );
  }

  return Object.freeze({
    previewBind,
    beginBind,
    previewDelete,
    beginDelete,
    inspect,
    continueOperation,
  });
}

export const roundcubeDomainMappingServiceInternals = Object.freeze({
  continueConfirmation,
  publicState,
  previewIncludesPendingMapping,
  previewExcludesRemovingMapping,
});
