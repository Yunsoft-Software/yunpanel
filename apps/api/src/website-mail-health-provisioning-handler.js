const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INTENT_FIELDS = new Set([
  'adapter',
  'serverId',
  'websiteId',
  'webDomainId',
  'mailDomainId',
  'domainName',
  'hostname',
  'expectedMailDomainRevision',
]);

export class WebsiteMailHealthProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMailHealthProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function requestIntent(value, websiteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.adapter !== 'local-mail-cross-service-health'
    || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.serverId ?? '')
    || !UUID_PATTERN.test(value.websiteId ?? '')
    || !UUID_PATTERN.test(value.webDomainId ?? '')
    || !UUID_PATTERN.test(value.mailDomainId ?? '')
    || typeof value.domainName !== 'string' || !value.domainName
    || value.hostname !== `webmail.${value.domainName}`
    || value.expectedMailDomainRevision !== 2) {
    throw new WebsiteMailHealthProvisioningError(
      'website_mail_health_intent_invalid',
      'Website local-mail health provisioning intent is invalid',
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
    hostname: value.hostname,
    expectedMailDomainRevision: value.expectedMailDomainRevision,
  });
}

function siblingEvidence(operation, request) {
  const mailConfig = operation?.steps?.find((step) => step.id === 'mail_config');
  const dkimConfig = operation?.steps?.find((step) => step.id === 'mail_dkim_config');
  const roundcube = operation?.steps?.find((step) => step.id === 'roundcube_mapping');
  const mail = mailConfig?.state === 'succeeded' ? mailConfig.evidence : null;
  const dkim = dkimConfig?.state === 'succeeded' ? dkimConfig.evidence : null;
  const webmail = roundcube?.state === 'succeeded' ? roundcube.evidence : null;

  if (!mail || mail.satisfied !== true || mail.adapter !== 'managed-mail-config'
    || mail.mailDomainId !== request.mailDomainId
    || mail.resultingRevision !== request.expectedMailDomainRevision
    || mail.desiredStatus !== 'enabled'
    || !SHA256_PATTERN.test(mail.configurationSha256 ?? '')
    || !SHA256_PATTERN.test(mail.readinessSha256 ?? '')) {
    throw new WebsiteMailHealthProvisioningError(
      'website_mail_health_config_evidence_missing',
      'Website local-mail health requires exact managed-mail configuration evidence',
      503,
    );
  }
  if (!dkim || dkim.satisfied !== true || dkim.adapter !== 'managed-mail-dkim-config'
    || dkim.mailDomainId !== request.mailDomainId
    || dkim.expectedKeyRevision !== 1
    || !SHA256_PATTERN.test(dkim.configurationSha256 ?? '')) {
    throw new WebsiteMailHealthProvisioningError(
      'website_mail_health_dkim_evidence_missing',
      'Website local-mail health requires exact DKIM configuration evidence',
      503,
    );
  }
  if (!webmail || webmail.satisfied !== true || webmail.adapter !== 'shared-roundcube-mapping'
    || webmail.hostname !== request.hostname
    || typeof webmail.mappingId !== 'string' || !webmail.mappingId
    || !Number.isSafeInteger(webmail.mappingRevision) || webmail.mappingRevision < 1
    || !SHA256_PATTERN.test(webmail.roundcubePreviewSha256 ?? '')
    || typeof webmail.roundcubeApplyJobId !== 'string' || !webmail.roundcubeApplyJobId) {
    throw new WebsiteMailHealthProvisioningError(
      'website_mail_health_roundcube_evidence_missing',
      'Website local-mail health requires exact shared Roundcube mapping evidence',
      503,
    );
  }
  return Object.freeze({ mail, dkim, webmail });
}

function readinessEvidence(value, previewSha256) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.phase !== 'post'
    || value.previewSha256 !== previewSha256
    || !SHA256_PATTERN.test(value.sha256 ?? '')
    || typeof value.ready !== 'boolean'
    || !Array.isArray(value.blockers)
    || value.blockers.some((entry) => typeof entry !== 'string' || !entry)
    || value.sideEffects !== false) {
    throw new WebsiteMailHealthProvisioningError(
      'website_mail_health_readiness_invalid',
      'Managed mail readiness inspection returned invalid evidence',
      503,
    );
  }
  return value;
}

function protocolEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || !SHA256_PATTERN.test(value.sha256 ?? '')
    || typeof value.ready !== 'boolean'
    || !Array.isArray(value.protocols) || value.protocols.length !== 3
    || !Array.isArray(value.blockers)
    || value.blockers.some((entry) => typeof entry !== 'string' || !entry)
    || value.sideEffects !== false) {
    throw new WebsiteMailHealthProvisioningError(
      'website_mail_health_protocol_evidence_invalid',
      'Mail protocol listener inspection returned invalid evidence',
      503,
    );
  }
  const expected = [['smtp', 25], ['submission', 587], ['imap', 143]];
  for (let index = 0; index < expected.length; index += 1) {
    const [id, port] = expected[index];
    const current = value.protocols[index];
    if (!current || current.id !== id || current.port !== port || typeof current.satisfied !== 'boolean') {
      throw new WebsiteMailHealthProvisioningError(
        'website_mail_health_protocol_evidence_invalid',
        'Mail protocol listener inspection returned invalid evidence',
        503,
      );
    }
  }
  return value;
}

function discoveryEvidence(value, request) {
  if (!value) return null;
  if (value.version !== 1
    || value.mailDomainId !== request.mailDomainId
    || value.serverId !== request.serverId
    || value.revision !== request.expectedMailDomainRevision
    || !value.autodiscover || value.autodiscover.ready !== true
    || value.autodiscover.hostname !== request.domainName
    || value.autodiscover.protocol !== 'https'
    || value.autodiscover.path !== '/autodiscover/autodiscover.xml'
    || !value.autoconfig || value.autoconfig.ready !== true
    || value.autoconfig.hostname !== request.domainName
    || value.autoconfig.protocol !== 'https'
    || value.autoconfig.path !== '/mail/config-v1.1.xml') {
    throw new WebsiteMailHealthProvisioningError(
      'website_mail_health_discovery_evidence_drift',
      'Current mail discovery endpoint evidence drifted from Website provisioning',
      503,
    );
  }
  return value;
}

function endpointEvidence(endpoint, request, expected) {
  if (!endpoint) return null;
  if (endpoint.version !== 1 || endpoint.ready !== true
    || endpoint.mailDomainId !== request.mailDomainId
    || endpoint.serverId !== request.serverId
    || endpoint.hostname !== request.hostname
    || endpoint.protocol !== 'https' || endpoint.path !== '/'
    || endpoint.mappingId !== expected.mappingId
    || endpoint.mappingRevision !== expected.mappingRevision
    || endpoint.roundcubePreviewSha256 !== expected.roundcubePreviewSha256
    || endpoint.roundcubeApplyJobId !== expected.roundcubeApplyJobId) {
    throw new WebsiteMailHealthProvisioningError(
      'website_mail_health_webmail_evidence_drift',
      'Current Roundcube endpoint evidence drifted from Website provisioning',
      503,
    );
  }
  return endpoint;
}

function completionEvidence(request, source, readiness, protocols, endpoint, discovery) {
  return Object.freeze({
    satisfied: true,
    adapter: 'local-mail-cross-service-health',
    mailDomainId: request.mailDomainId,
    mailDomainRevision: request.expectedMailDomainRevision,
    configurationSha256: source.mail.configurationSha256,
    dkimConfigurationSha256: source.dkim.configurationSha256,
    mailReadinessSha256: readiness.sha256,
    protocolHealthSha256: protocols.sha256,
    hostname: request.hostname,
    roundcubeMappingId: endpoint.mappingId,
    roundcubeMappingRevision: endpoint.mappingRevision,
    roundcubePreviewSha256: endpoint.roundcubePreviewSha256,
    roundcubeApplyJobId: endpoint.roundcubeApplyJobId,
    autodiscoverHostname: discovery.autodiscover.hostname,
    autodiscoverPath: discovery.autodiscover.path,
    autoconfigHostname: discovery.autoconfig.hostname,
    autoconfigPath: discovery.autoconfig.path,
  });
}

export function createWebsiteMailHealthProvisioningHandler({
  mailDomainRegistry,
  domainRegistry,
  mailConfigurationService,
  mailReadinessInspector,
  mailProtocolHealthInspector,
  roundcubeWebmailEndpointResolver,
  mailDiscoveryEndpointResolver,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailConfigurationService || typeof mailConfigurationService.materializeCurrent !== 'function'
    || !mailReadinessInspector || typeof mailReadinessInspector.inspect !== 'function'
    || !mailProtocolHealthInspector || typeof mailProtocolHealthInspector.inspect !== 'function'
    || !roundcubeWebmailEndpointResolver || typeof roundcubeWebmailEndpointResolver.resolve !== 'function'
    || !mailDiscoveryEndpointResolver || typeof mailDiscoveryEndpointResolver.resolve !== 'function') {
    throw new WebsiteMailHealthProvisioningError(
      'website_mail_health_dependencies_invalid',
      'Website local-mail health dependencies are invalid',
      503,
    );
  }

  async function inspectHealth(context = {}) {
    const request = requestIntent(context.intent, context.websiteId);
    const source = siblingEvidence(context.operation, request);
    const [mailDomain, domain] = await Promise.all([
      mailDomainRegistry.getMailDomain(request.mailDomainId),
      domainRegistry.getDomain(request.webDomainId),
    ]);
    if (!mailDomain || mailDomain.id !== request.mailDomainId
      || mailDomain.webDomainId !== request.webDomainId
      || mailDomain.domainName !== request.domainName
      || mailDomain.managementMode !== 'local'
      || mailDomain.status !== 'enabled'
      || mailDomain.revision !== request.expectedMailDomainRevision) {
      throw new WebsiteMailHealthProvisioningError(
        'website_mail_health_mail_domain_drift',
        'Website local-mail health requires the operation-owned enabled Mail Domain',
      );
    }
    if (!domain || domain.id !== request.webDomainId
      || domain.serverId !== request.serverId
      || domain.websiteId !== request.websiteId
      || domain.primaryDomain !== request.domainName
      || domain.state !== 'active') {
      throw new WebsiteMailHealthProvisioningError(
        'website_mail_health_domain_drift',
        'Website local-mail health Domain ownership changed after planning',
      );
    }

    const current = await mailConfigurationService.materializeCurrent({
      mailDomainId: request.mailDomainId,
      expectedRevision: request.expectedMailDomainRevision,
      status: 'enabled',
    }, {
      expectedConfigurationSha256: source.mail.configurationSha256,
    });
    if (!current?.preview || current.preview.sha256 !== source.mail.configurationSha256
      || current.state?.mailDomainId !== request.mailDomainId
      || current.state?.revision !== request.expectedMailDomainRevision
      || current.state?.status !== 'enabled') {
      throw new WebsiteMailHealthProvisioningError(
        'website_mail_health_configuration_drift',
        'Current managed mail configuration does not match Website provisioning evidence',
        503,
      );
    }

    const readiness = readinessEvidence(
      await mailReadinessInspector.inspect(current.preview, { phase: 'post' }),
      current.preview.sha256,
    );
    if (!readiness.ready) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_mail_service_health_not_ready',
        blockers: Object.freeze([...readiness.blockers]),
      });
    }

    const protocols = protocolEvidence(await mailProtocolHealthInspector.inspect());
    if (!protocols.ready) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_mail_protocol_health_not_ready',
        blockers: Object.freeze([...protocols.blockers]),
      });
    }

    const endpoint = endpointEvidence(
      await roundcubeWebmailEndpointResolver.resolve({ mailDomain, domain }),
      request,
      source.webmail,
    );
    if (!endpoint) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_webmail_health_not_ready',
        blockers: Object.freeze(['webmail']),
      });
    }

    const discovery = discoveryEvidence(
      await mailDiscoveryEndpointResolver.resolve({ mailDomain, domain }),
      request,
    );
    if (!discovery) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_mail_discovery_health_not_ready',
        blockers: Object.freeze(['autodiscover', 'autoconfig']),
      });
    }
    return completionEvidence(request, source, readiness, protocols, endpoint, discovery);
  }

  return Object.freeze({
    apply: inspectHealth,
    inspect: inspectHealth,
  });
}

export const websiteMailHealthProvisioningInternals = Object.freeze({
  requestIntent,
  siblingEvidence,
  readinessEvidence,
  protocolEvidence,
  discoveryEvidence,
  endpointEvidence,
  completionEvidence,
});
