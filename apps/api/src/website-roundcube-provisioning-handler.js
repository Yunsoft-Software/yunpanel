const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTENT_FIELDS = new Set([
  'adapter',
  'serverId',
  'websiteId',
  'webDomainId',
  'mailDomainId',
  'domainName',
]);

export class WebsiteRoundcubeProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteRoundcubeProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function requestIntent(value, websiteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.adapter !== 'shared-roundcube-mapping'
    || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.serverId ?? '')
    || !UUID_PATTERN.test(value.websiteId ?? '')
    || !UUID_PATTERN.test(value.webDomainId ?? '')
    || !UUID_PATTERN.test(value.mailDomainId ?? '')
    || typeof value.domainName !== 'string' || !value.domainName) {
    throw new WebsiteRoundcubeProvisioningError(
      'website_roundcube_intent_invalid',
      'Website Roundcube provisioning intent is invalid',
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
    hostname: `webmail.${value.domainName}`,
  });
}

function certificateEvidence(operation) {
  const step = operation?.steps?.find((candidate) => candidate.id === 'certificate');
  const value = step?.state === 'succeeded' ? step.evidence : null;
  if (!value || value.satisfied !== true || value.adapter !== 'acme-certificate'
    || !UUID_PATTERN.test(value.certificateId ?? '')
    || value.provisioningOperationId !== operation.operationId) {
    throw new WebsiteRoundcubeProvisioningError(
      'website_roundcube_certificate_evidence_missing',
      'Website Roundcube provisioning requires the operation-owned certificate evidence',
      503,
    );
  }
  return value;
}

function activeEvidence(mapping, endpoint, request, certificateId) {
  if (!mapping || mapping.state !== 'active'
    || mapping.mailDomainId !== request.mailDomainId
    || mapping.webDomainId !== request.webDomainId
    || mapping.serverId !== request.serverId
    || mapping.domainName !== request.domainName
    || mapping.hostname !== request.hostname
    || mapping.certificateId !== certificateId
    || !Number.isSafeInteger(mapping.revision) || mapping.revision < 1
    || !endpoint || endpoint.ready !== true
    || endpoint.mailDomainId !== request.mailDomainId
    || endpoint.serverId !== request.serverId
    || endpoint.mappingId !== mapping.id
    || endpoint.mappingRevision !== mapping.revision
    || endpoint.hostname !== request.hostname
    || endpoint.protocol !== 'https'
    || endpoint.path !== '/'
    || typeof endpoint.roundcubePreviewSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(endpoint.roundcubePreviewSha256)
    || typeof endpoint.roundcubeApplyJobId !== 'string'
    || !endpoint.roundcubeApplyJobId) {
    throw new WebsiteRoundcubeProvisioningError(
      'website_roundcube_completion_evidence_invalid',
      'Website Roundcube mapping completion evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    adapter: 'shared-roundcube-mapping',
    mappingId: mapping.id,
    mappingRevision: mapping.revision,
    hostname: mapping.hostname,
    certificateId: mapping.certificateId,
    roundcubePreviewSha256: endpoint.roundcubePreviewSha256,
    roundcubeApplyJobId: endpoint.roundcubeApplyJobId,
  });
}

async function defaultWaitForTerminalJob(jobRegistry, job, {
  timeoutMs = 90_000,
  pollMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = job;
  while (!['succeeded', 'failed', 'cancelled'].includes(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = await jobRegistry.getJob(job.id);
    if (!current) {
      throw new WebsiteRoundcubeProvisioningError(
        'website_roundcube_apply_job_missing',
        'Website Roundcube apply job disappeared before completion',
        503,
      );
    }
  }
  if (!['succeeded', 'failed', 'cancelled'].includes(current.status)) {
    throw new WebsiteRoundcubeProvisioningError(
      'website_roundcube_apply_job_pending',
      'Website Roundcube apply job is still running',
      503,
    );
  }
  return current;
}

export function createWebsiteRoundcubeProvisioningHandler({
  mailDomainRegistry,
  domainRegistry,
  roundcubeDomainMappingRegistry,
  roundcubeDomainMappingService,
  roundcubeWebmailEndpointResolver,
  jobRegistry,
  waitForTerminalJob = (job) => defaultWaitForTerminalJob(jobRegistry, job),
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !roundcubeDomainMappingRegistry
    || typeof roundcubeDomainMappingRegistry.getForMailDomain !== 'function'
    || typeof roundcubeDomainMappingRegistry.getRecordForMailDomain !== 'function'
    || typeof roundcubeDomainMappingRegistry.completeApply !== 'function'
    || !roundcubeDomainMappingService
    || typeof roundcubeDomainMappingService.previewBind !== 'function'
    || typeof roundcubeDomainMappingService.beginBind !== 'function'
    || typeof roundcubeDomainMappingService.inspect !== 'function'
    || typeof roundcubeDomainMappingService.continueOperation !== 'function'
    || !roundcubeWebmailEndpointResolver
    || typeof roundcubeWebmailEndpointResolver.resolve !== 'function'
    || !jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof waitForTerminalJob !== 'function') {
    throw new WebsiteRoundcubeProvisioningError(
      'website_roundcube_dependencies_invalid',
      'Website Roundcube provisioning dependencies are invalid',
      503,
    );
  }

  async function scope(request) {
    const [mailDomain, domain] = await Promise.all([
      mailDomainRegistry.getMailDomain(request.mailDomainId),
      domainRegistry.getDomain(request.webDomainId),
    ]);
    if (!mailDomain || mailDomain.id !== request.mailDomainId
      || mailDomain.webDomainId !== request.webDomainId
      || mailDomain.domainName !== request.domainName
      || mailDomain.managementMode !== 'local'
      || mailDomain.status !== 'enabled') {
      throw new WebsiteRoundcubeProvisioningError(
        'website_roundcube_mail_domain_drift',
        'Website Roundcube provisioning requires the enabled local Mail Domain',
      );
    }
    if (!domain || domain.id !== request.webDomainId
      || domain.serverId !== request.serverId
      || domain.websiteId !== request.websiteId
      || domain.primaryDomain !== request.domainName) {
      throw new WebsiteRoundcubeProvisioningError(
        'website_roundcube_domain_drift',
        'Website Roundcube provisioning Domain ownership changed after planning',
      );
    }
    return Object.freeze({ mailDomain, domain });
  }

  async function completion(request, certificateId, scoped) {
    const mapping = await roundcubeDomainMappingRegistry.getForMailDomain(request.mailDomainId);
    if (!mapping) return null;
    const endpoint = await roundcubeWebmailEndpointResolver.resolve(scoped);
    if (!endpoint) return null;
    return activeEvidence(mapping, endpoint, request, certificateId);
  }

  async function inspect(context = {}) {
    const request = requestIntent(context.intent, context.websiteId);
    const certificate = certificateEvidence(context.operation);
    const scoped = await scope(request);
    const completed = await completion(request, certificate.certificateId, scoped);
    if (completed) return completed;

    const record = await roundcubeDomainMappingRegistry.getRecordForMailDomain(request.mailDomainId);
    if (!record) {
      return Object.freeze({ satisfied: false, reason: 'website_roundcube_mapping_required' });
    }
    if (record.state === 'pending' && record.operationId === context.operationId
      && record.certificateId === certificate.certificateId) {
      const state = await roundcubeDomainMappingService.inspect(request.mailDomainId);
      if (state?.job?.status === 'succeeded') {
        const job = await jobRegistry.getJob(state.job.id);
        const reconciled = await roundcubeDomainMappingRegistry.completeApply(request.mailDomainId, {
          operationId: context.operationId,
          job,
        });
        const endpoint = await roundcubeWebmailEndpointResolver.resolve(scoped);
        return activeEvidence(reconciled, endpoint, request, certificate.certificateId);
      }
      return Object.freeze({
        satisfied: false,
        reason: state?.job === null
          ? 'website_roundcube_apply_not_dispatched'
          : ['queued', 'running'].includes(state.job.status)
            ? 'website_roundcube_apply_pending'
            : 'website_roundcube_apply_failed',
      });
    }
    throw new WebsiteRoundcubeProvisioningError(
      'website_roundcube_mapping_conflict',
      'Website Roundcube mapping is owned by another lifecycle or certificate',
    );
  }

  async function beginOrResume(context, request, certificateId) {
    let record = await roundcubeDomainMappingRegistry.getRecordForMailDomain(request.mailDomainId);
    if (!record) {
      let preview;
      try {
        preview = await roundcubeDomainMappingService.previewBind({
          mailDomainId: request.mailDomainId,
          certificateId,
        });
      } catch (error) {
        if (error?.code === 'roundcube_mapping_certificate_hostname_mismatch'
          || error?.code === 'roundcube_mapping_certificate_not_ready'
          || error?.code === 'roundcube_mapping_certificate_drift') {
          throw new WebsiteRoundcubeProvisioningError(
            'website_roundcube_certificate_coverage_required',
            'Website Roundcube requires an active certificate covering webmail.<domain>',
          );
        }
        throw error;
      }
      const begun = await roundcubeDomainMappingService.beginBind({
        mailDomainId: request.mailDomainId,
        certificateId,
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
        operationId: context.operationId,
      });
      record = begun.mapping;
    }
    if (record.state === 'active') return record;
    if (record.state !== 'pending'
      || record.operationId !== context.operationId
      || record.certificateId !== certificateId) {
      throw new WebsiteRoundcubeProvisioningError(
        'website_roundcube_mapping_conflict',
        'Website Roundcube mapping is owned by another lifecycle or certificate',
      );
    }
    return record;
  }

  async function driveApply(request, record) {
    let state = await roundcubeDomainMappingService.inspect(request.mailDomainId);
    if (!state || state.mapping.operationId !== record.operationId) {
      throw new WebsiteRoundcubeProvisioningError(
        'website_roundcube_mapping_state_invalid',
        'Website Roundcube mapping state is unavailable',
        503,
      );
    }
    if (state.job === null || ['failed', 'cancelled'].includes(state.job.status)) {
      state = await roundcubeDomainMappingService.continueOperation({
        mailDomainId: request.mailDomainId,
        operationId: state.mapping.operationId,
        expectedUpdatedAt: state.mapping.updatedAt,
        confirmation: state.actions.continuation,
      });
    }
    if (state.job && ['queued', 'running'].includes(state.job.status)) {
      const child = await jobRegistry.getJob(state.job.id);
      if (!child) {
        throw new WebsiteRoundcubeProvisioningError(
          'website_roundcube_apply_job_missing',
          'Website Roundcube apply job disappeared before completion',
          503,
        );
      }
      const terminal = await waitForTerminalJob(child);
      if (!terminal || terminal.status !== 'succeeded') {
        throw new WebsiteRoundcubeProvisioningError(
          'website_roundcube_apply_failed',
          'Website Roundcube configuration apply did not complete successfully',
          503,
        );
      }
      state = await roundcubeDomainMappingService.inspect(request.mailDomainId);
    }
    if (state?.job?.status === 'succeeded') {
      state = await roundcubeDomainMappingService.continueOperation({
        mailDomainId: request.mailDomainId,
        operationId: state.mapping.operationId,
        expectedUpdatedAt: state.mapping.updatedAt,
        confirmation: state.actions.continuation,
      });
    }
    if (!state?.mapping || state.mapping.state !== 'active') {
      throw new WebsiteRoundcubeProvisioningError(
        'website_roundcube_activation_unverified',
        'Website Roundcube mapping did not become active',
        503,
      );
    }
    return state.mapping;
  }

  async function apply(context = {}) {
    const request = requestIntent(context.intent, context.websiteId);
    const certificate = certificateEvidence(context.operation);
    const scoped = await scope(request);
    const existing = await completion(request, certificate.certificateId, scoped);
    if (existing) return existing;

    const record = await beginOrResume(context, request, certificate.certificateId);
    const active = record.state === 'active' ? record : await driveApply(request, record);
    const endpoint = await roundcubeWebmailEndpointResolver.resolve(scoped);
    return activeEvidence(active, endpoint, request, certificate.certificateId);
  }

  return Object.freeze({ apply, inspect });
}

export const websiteRoundcubeProvisioningInternals = Object.freeze({
  requestIntent,
  certificateEvidence,
  activeEvidence,
  defaultWaitForTerminalJob,
});
