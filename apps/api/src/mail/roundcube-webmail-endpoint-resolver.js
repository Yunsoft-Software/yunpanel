import { OPERATIONS } from '@yunpanel/protocol';

export class RoundcubeWebmailEndpointResolverError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'RoundcubeWebmailEndpointResolverError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new RoundcubeWebmailEndpointResolverError(code, message, status);
}

function sourceIdentity(mailDomain, domain) {
  if (!mailDomain || typeof mailDomain !== 'object' || Array.isArray(mailDomain)
    || !domain || typeof domain !== 'object' || Array.isArray(domain)
    || typeof mailDomain.id !== 'string' || !mailDomain.id
    || typeof mailDomain.webDomainId !== 'string' || mailDomain.webDomainId !== domain.id
    || mailDomain.domainName !== domain.primaryDomain
    || mailDomain.managementMode !== 'local' || mailDomain.status !== 'enabled'
    || typeof domain.serverId !== 'string' || !domain.serverId) {
    fail(
      'roundcube_webmail_source_invalid',
      'Roundcube webmail endpoint source state is invalid',
    );
  }
  return Object.freeze({ mailDomain, domain });
}

function successfulApply(job, serverId, preview) {
  return Boolean(job
    && job.serverId === serverId
    && job.operation === OPERATIONS.ROUNDCUBE_CONFIG_APPLY
    && job.resourceType === 'server'
    && job.resourceId === serverId
    && job.status === 'succeeded'
    && job.result?.previewSha256 === preview.sha256
    && job.result?.nginxSha256 === preview.nginxSha256
    && job.result?.httpHealthy === true
    && job.result?.applied === true);
}

export function createRoundcubeWebmailEndpointResolver({
  roundcubeDomainMappingRegistry,
  roundcubeConfigurationService,
  jobRegistry,
} = {}) {
  if (!roundcubeDomainMappingRegistry
    || typeof roundcubeDomainMappingRegistry.getForMailDomain !== 'function'
    || !roundcubeConfigurationService
    || typeof roundcubeConfigurationService.previewForServer !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function') {
    throw new RoundcubeWebmailEndpointResolverError(
      'roundcube_webmail_dependencies_invalid',
      'Roundcube webmail endpoint dependencies are unavailable',
      503,
    );
  }

  async function resolve(input = {}) {
    const { mailDomain, domain } = sourceIdentity(input.mailDomain, input.domain);
    let mapping;
    try { mapping = await roundcubeDomainMappingRegistry.getForMailDomain(mailDomain.id); }
    catch {
      fail(
        'roundcube_webmail_mapping_unavailable',
        'Roundcube webmail mapping could not be inspected',
        503,
      );
    }
    if (mapping === null) return null;
    if (mapping.mailDomainId !== mailDomain.id
      || mapping.webDomainId !== domain.id
      || mapping.serverId !== domain.serverId
      || mapping.domainName !== domain.primaryDomain
      || mapping.hostname !== 'webmail.' + domain.primaryDomain
      || !Number.isSafeInteger(mapping.revision) || mapping.revision < 1) {
      fail(
        'roundcube_webmail_mapping_drift',
        'Roundcube webmail mapping no longer matches its Mail Domain',
      );
    }

    let preview;
    try { preview = await roundcubeConfigurationService.previewForServer(domain.serverId); }
    catch (error) {
      if (Number(error?.status) >= 400 && Number(error?.status) < 500) throw error;
      fail(
        'roundcube_webmail_preview_unavailable',
        'Roundcube current desired state could not be inspected',
        503,
      );
    }
    if (!preview?.readyToApply || !Array.isArray(preview.mappings)
      || typeof preview.sha256 !== 'string' || typeof preview.nginxSha256 !== 'string') {
      return null;
    }
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
    if (matches.length !== 1) {
      fail(
        'roundcube_webmail_preview_drift',
        'Roundcube desired state does not contain the exact mapping revision',
      );
    }

    let jobs;
    try { jobs = await jobRegistry.listJobs({ serverId: domain.serverId }); }
    catch {
      fail(
        'roundcube_webmail_job_inventory_unavailable',
        'Roundcube apply job inventory could not be inspected',
        503,
      );
    }
    if (!Array.isArray(jobs)) {
      fail(
        'roundcube_webmail_job_inventory_invalid',
        'Roundcube apply job inventory is invalid',
        503,
      );
    }
    const applied = jobs.filter((job) => successfulApply(job, domain.serverId, preview))
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))[0] ?? null;
    if (!applied) return null;

    return Object.freeze({
      version: 1,
      mailDomainId: mailDomain.id,
      serverId: domain.serverId,
      mappingId: mapping.id,
      mappingRevision: mapping.revision,
      hostname: mapping.hostname,
      protocol: 'https',
      path: '/',
      roundcubePreviewSha256: preview.sha256,
      roundcubeApplyJobId: applied.id,
      ready: true,
    });
  }

  return Object.freeze({ resolve });
}

export const roundcubeWebmailEndpointResolverInternals = Object.freeze({
  sourceIdentity,
  successfulApply,
});
