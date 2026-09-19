const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INTENT_FIELDS = new Set([
  'adapter',
  'websiteId',
  'primaryDomainId',
  'primaryDomain',
  'aliases',
]);

export class WebsiteTlsProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteTlsProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function requestIntent(value, websiteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.adapter !== 'managed-certificate-nginx'
    || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.websiteId ?? '')
    || !UUID_PATTERN.test(value.primaryDomainId ?? '')
    || typeof value.primaryDomain !== 'string' || !value.primaryDomain
    || !Array.isArray(value.aliases)
    || value.aliases.some((alias) => typeof alias !== 'string' || !alias)) {
    throw new WebsiteTlsProvisioningError(
      'website_tls_intent_invalid',
      'Website TLS activation intent is invalid',
      400,
    );
  }
  const names = [value.primaryDomain, ...value.aliases];
  if (new Set(names).size !== names.length) {
    throw new WebsiteTlsProvisioningError(
      'website_tls_intent_invalid',
      'Website TLS route names are not unique',
      400,
    );
  }
  return Object.freeze({
    adapter: value.adapter,
    websiteId: value.websiteId.toLowerCase(),
    primaryDomainId: value.primaryDomainId.toLowerCase(),
    primaryDomain: value.primaryDomain,
    aliases: Object.freeze([...value.aliases]),
    names: Object.freeze(names),
  });
}

function sibling(operation, id, kind) {
  const step = operation?.steps?.find((candidate) => candidate.id === id);
  if (!step || step.kind !== kind || step.state !== 'succeeded' || !step.evidence) {
    throw new WebsiteTlsProvisioningError(
      'website_tls_dependency_evidence_missing',
      `Website TLS activation requires completed ${id} evidence`,
      503,
    );
  }
  return step;
}

function certificateEvidence(operation, request) {
  const step = sibling(operation, 'certificate', 'certificate');
  const value = step.evidence;
  if (value.satisfied !== true || value.adapter !== 'acme-certificate'
    || !UUID_PATTERN.test(value.certificateId ?? '')
    || value.provisioningOperationId !== operation.operationId
    || !Number.isSafeInteger(value.attachedDomainRevision) || value.attachedDomainRevision < 2) {
    throw new WebsiteTlsProvisioningError(
      'website_tls_certificate_evidence_invalid',
      'Website TLS activation certificate evidence is invalid',
      503,
    );
  }
  return value;
}

function nginxStep(operation) {
  const step = sibling(operation, 'nginx', 'nginx');
  if (!step.intent || step.intent.websiteId !== operation.websiteId) {
    throw new WebsiteTlsProvisioningError(
      'website_tls_nginx_evidence_invalid',
      'Website TLS activation Nginx ownership evidence is invalid',
      503,
    );
  }
  return step;
}

function tlsMaterial(certificate) {
  if (!certificate || typeof certificate.fullchainPath !== 'string' || !certificate.fullchainPath.startsWith('/')
    || typeof certificate.privateKeyPath !== 'string' || !certificate.privateKeyPath.startsWith('/')) {
    throw new WebsiteTlsProvisioningError(
      'website_tls_certificate_material_missing',
      'Website certificate material is unavailable for TLS activation',
      503,
    );
  }
  return Object.freeze({
    fullchainPath: certificate.fullchainPath,
    privateKeyPath: certificate.privateKeyPath,
  });
}

function completionEvidence({ certificate, domain, nginx, certificateStep }) {
  if (!nginx || nginx.satisfied !== true
    || !SHA256_PATTERN.test(nginx.checksum ?? '')
    || typeof nginx.configName !== 'string' || !nginx.configName
    || nginx.active !== true
    || domain.certificateId !== certificate.id
    || domain.desiredRevision !== certificateStep.attachedDomainRevision
    || domain.stagedRevision !== certificateStep.attachedDomainRevision
    || domain.appliedRevision !== certificateStep.attachedDomainRevision
    || domain.stagedChecksum !== nginx.checksum
    || domain.state !== 'active'
    || domain.lastError !== null) {
    throw new WebsiteTlsProvisioningError(
      'website_tls_completion_evidence_invalid',
      'Website TLS activation completion evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    adapter: 'managed-certificate-nginx',
    certificateId: certificate.id,
    domainId: domain.id,
    domainRevision: domain.desiredRevision,
    nginxChecksum: nginx.checksum,
    nginxConfigName: nginx.configName,
    httpsRedirect: domain.httpsRedirect,
    canonicalRedirect: domain.canonicalRedirect,
  });
}

export function createWebsiteTlsProvisioningHandler({
  certificateRegistry,
  domainRegistry,
  nginxProvisioningHandler,
} = {}) {
  if (!certificateRegistry || typeof certificateRegistry.getCertificate !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || typeof domainRegistry.markStaged !== 'function'
    || typeof domainRegistry.markApplied !== 'function'
    || !nginxProvisioningHandler || typeof nginxProvisioningHandler.apply !== 'function'
    || typeof nginxProvisioningHandler.inspect !== 'function') {
    throw new WebsiteTlsProvisioningError(
      'website_tls_dependencies_invalid',
      'Website TLS activation dependencies are invalid',
      503,
    );
  }

  async function scope(context, request) {
    const certEvidence = certificateEvidence(context.operation, request);
    const nginx = nginxStep(context.operation);
    const [domain, certificate] = await Promise.all([
      domainRegistry.getDomain(request.primaryDomainId),
      certificateRegistry.getCertificate(certEvidence.certificateId),
    ]);
    if (!domain || domain.id !== request.primaryDomainId
      || domain.websiteId !== request.websiteId
      || domain.primaryDomain !== request.primaryDomain
      || JSON.stringify(domain.aliases) !== JSON.stringify(request.aliases)
      || domain.httpsMode !== 'managed'
      || domain.certificateId !== certEvidence.certificateId
      || domain.desiredRevision !== certEvidence.attachedDomainRevision) {
      throw new WebsiteTlsProvisioningError(
        'website_tls_domain_drift',
        'Website Domain state changed after certificate attachment',
      );
    }
    if (!certificate || certificate.id !== certEvidence.certificateId
      || certificate.domainId !== domain.id
      || certificate.serverId !== domain.serverId
      || certificate.provisioningOperationId !== context.operationId
      || certificate.source !== 'acme'
      || certificate.state !== 'active'
      || certificate.staging !== false
      || JSON.stringify(certificate.domains) !== JSON.stringify(request.names)) {
      throw new WebsiteTlsProvisioningError(
        'website_tls_certificate_drift',
        'Website certificate state changed before TLS activation',
      );
    }
    return Object.freeze({
      domain,
      certificate,
      certEvidence,
      nginxStep: nginx,
      tls: tlsMaterial(certificate),
    });
  }

  async function inspectHost(operation, nginx, domain, tls) {
    return nginxProvisioningHandler.inspect({
      operation,
      intent: nginx.intent,
      tls,
      httpsRedirect: domain.httpsRedirect,
      canonicalRedirect: domain.canonicalRedirect,
    });
  }

  async function reconcileDomain(domain, nginxEvidence, expectedRevision) {
    let current = await domainRegistry.getDomain(domain.id);
    if (!current || current.certificateId !== domain.certificateId
      || current.desiredRevision !== expectedRevision
      || current.primaryDomain !== domain.primaryDomain
      || JSON.stringify(current.aliases) !== JSON.stringify(domain.aliases)) {
      throw new WebsiteTlsProvisioningError(
        'website_tls_domain_reconciliation_drift',
        'Website Domain changed before TLS reconciliation',
      );
    }

    if (current.stagedRevision === expectedRevision
      && current.appliedRevision === expectedRevision
      && current.stagedChecksum === nginxEvidence.checksum
      && current.state === 'active'
      && current.lastError === null) {
      return current;
    }

    const pristineAttached = current.stagedRevision === 0
      && current.appliedRevision === expectedRevision - 1
      && current.stagedChecksum === null
      && current.state === 'draft'
      && current.lastError === null;
    const stagedAttached = current.stagedRevision === expectedRevision
      && current.appliedRevision === expectedRevision - 1
      && current.stagedChecksum === nginxEvidence.checksum
      && current.state === 'staged'
      && current.lastError === null;

    if (pristineAttached) {
      current = await domainRegistry.markStaged(current.id, {
        checksum: nginxEvidence.checksum,
        configName: nginxEvidence.configName,
      });
    } else if (!stagedAttached) {
      throw new WebsiteTlsProvisioningError(
        'website_tls_domain_reconciliation_drift',
        'Website Domain routing state is not safely reconcilable to the TLS host evidence',
      );
    }

    if (current.appliedRevision !== expectedRevision) {
      current = await domainRegistry.markApplied(current.id, {
        checksum: nginxEvidence.checksum,
      });
    }
    return current;
  }

  async function inspect(context = {}) {
    const request = requestIntent(context.intent, context.websiteId);
    const owned = await scope(context, request);
    const host = await inspectHost(context.operation, owned.nginxStep, owned.domain, owned.tls);
    if (!host || host.satisfied !== true) {
      return Object.freeze({
        satisfied: false,
        reason: host?.reason ?? 'website_tls_activation_required',
      });
    }
    const domain = await reconcileDomain(
      owned.domain,
      host,
      owned.certEvidence.attachedDomainRevision,
    );
    return completionEvidence({
      certificate: owned.certificate,
      domain,
      nginx: host,
      certificateStep: owned.certEvidence,
    });
  }

  async function apply(context = {}) {
    const request = requestIntent(context.intent, context.websiteId);
    const owned = await scope(context, request);
    let host = await inspectHost(context.operation, owned.nginxStep, owned.domain, owned.tls);
    if (!host || host.satisfied !== true) {
      host = await nginxProvisioningHandler.apply({
        operation: context.operation,
        intent: owned.nginxStep.intent,
        tls: owned.tls,
        httpsRedirect: owned.domain.httpsRedirect,
        canonicalRedirect: owned.domain.canonicalRedirect,
      });
    }
    if (!host || host.satisfied !== true) {
      throw new WebsiteTlsProvisioningError(
        'website_tls_activation_unverified',
        'Website TLS Nginx activation did not return exact host evidence',
        503,
      );
    }
    const domain = await reconcileDomain(
      owned.domain,
      host,
      owned.certEvidence.attachedDomainRevision,
    );
    return completionEvidence({
      certificate: owned.certificate,
      domain,
      nginx: host,
      certificateStep: owned.certEvidence,
    });
  }

  return Object.freeze({ apply, inspect });
}

export const websiteTlsProvisioningInternals = Object.freeze({
  requestIntent,
  sibling,
  certificateEvidence,
  nginxStep,
  tlsMaterial,
  completionEvidence,
});
