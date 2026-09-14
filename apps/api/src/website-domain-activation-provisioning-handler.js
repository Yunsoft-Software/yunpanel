const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export class WebsiteDomainActivationProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteDomainActivationProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function nginxEvidence(operation) {
  const step = operation?.steps?.find((candidate) => candidate.id === 'nginx');
  const evidence = step?.state === 'succeeded' ? step.evidence : null;
  if (!evidence || evidence.satisfied !== true || evidence.active !== true
    || typeof evidence.checksum !== 'string' || !CHECKSUM_PATTERN.test(evidence.checksum)
    || typeof evidence.configName !== 'string' || evidence.configName.length < 1 || evidence.configName.length > 300) {
    throw new WebsiteDomainActivationProvisioningError(
      'website_domain_activation_nginx_evidence_invalid',
      'Active Nginx evidence is required before Domain state can be finalized',
    );
  }
  return evidence;
}

function normalizedIntent(context = {}) {
  const { operation, operationId, websiteId, intent } = context;
  if (!operation || typeof operation !== 'object' || operation.operationId !== operationId
    || operation.websiteId !== websiteId
    || !intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'domain-activation'
    || intent.websiteId !== websiteId
    || !Array.isArray(intent.domains) || intent.domains.length < 1 || intent.domains.length > 2) {
    throw new WebsiteDomainActivationProvisioningError(
      'website_domain_activation_intent_invalid',
      'Provisioned Domain activation intent is invalid',
      400,
    );
  }
  const seen = new Set();
  const domains = intent.domains.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || typeof entry.domainId !== 'string'
      || !Number.isSafeInteger(entry.expectedRevision) || entry.expectedRevision < 1
      || seen.has(entry.domainId)) {
      throw new WebsiteDomainActivationProvisioningError(
        'website_domain_activation_intent_invalid',
        'Provisioned Domain activation evidence is invalid',
        400,
      );
    }
    seen.add(entry.domainId);
    return Object.freeze({ domainId: entry.domainId, expectedRevision: entry.expectedRevision });
  }).sort((left, right) => left.domainId.localeCompare(right.domainId));
  const planned = [
    operation.resources?.primaryDomain?.id,
    operation.resources?.wwwDomain?.id,
  ].filter(Boolean).sort();
  if (planned.length !== domains.length || planned.some((domainId, index) => domainId !== domains[index].domainId)) {
    throw new WebsiteDomainActivationProvisioningError(
      'website_domain_activation_plan_drift',
      'Provisioned Domain activation intent no longer matches the Website plan',
    );
  }
  return Object.freeze({ websiteId, domains: Object.freeze(domains), nginx: nginxEvidence(operation) });
}

function exactActive(domain, expected, nginx) {
  return domain.websiteId === expected.websiteId
    && domain.desiredRevision === expected.expectedRevision
    && domain.stagedRevision === expected.expectedRevision
    && domain.appliedRevision === expected.expectedRevision
    && domain.stagedChecksum === nginx.checksum
    && domain.stagedConfigName === nginx.configName
    && domain.appliedPrimaryDomain === domain.primaryDomain
    && domain.state === 'active'
    && domain.lastError === null;
}

function pristine(domain, expected) {
  return domain.websiteId === expected.websiteId
    && domain.desiredRevision === expected.expectedRevision
    && domain.certificateId === null
    && domain.stagedRevision === 0 && domain.appliedRevision === 0
    && domain.stagedChecksum === null && domain.stagedConfigName === null
    && domain.lastStagedAt === null && domain.lastAppliedAt === null
    && domain.appliedPrimaryDomain === null
    && domain.state === 'draft'
    && domain.lastError === null;
}

function publicEvidence(spec) {
  return Object.freeze({
    satisfied: true,
    adapter: 'domain-activation',
    websiteId: spec.websiteId,
    domains: Object.freeze(spec.domains.map((entry) => Object.freeze({ ...entry }))),
    nginxChecksum: spec.nginx.checksum,
    nginxConfigName: spec.nginx.configName,
  });
}

export function createWebsiteDomainActivationProvisioningHandler({ domainRegistry } = {}) {
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || typeof domainRegistry.activateProvisionedDomains !== 'function'
    || typeof domainRegistry.resetProvisionedDomains !== 'function') {
    throw new WebsiteDomainActivationProvisioningError(
      'website_domain_activation_dependencies_invalid',
      'Provisioned Domain activation dependencies are invalid',
      503,
    );
  }

  async function inspectState(spec, { compensation = false } = {}) {
    const live = await Promise.all(spec.domains.map(async (expected) => Object.freeze({
      expected: Object.freeze({ ...expected, websiteId: spec.websiteId }),
      domain: await domainRegistry.getDomain(expected.domainId),
    })));
    if (live.some(({ domain }) => !domain)) {
      throw new WebsiteDomainActivationProvisioningError(
        compensation ? 'website_domain_activation_compensation_drift' : 'website_domain_activation_domain_missing',
        'Provisioned Domain is unavailable',
      );
    }
    const active = live.map(({ domain, expected }) => exactActive(domain, expected, spec.nginx));
    const clean = live.map(({ domain, expected }) => pristine(domain, expected));
    if (active.every(Boolean)) return 'active';
    if (clean.every(Boolean)) return 'pristine';
    throw new WebsiteDomainActivationProvisioningError(
      compensation ? 'website_domain_activation_compensation_drift' : 'website_domain_activation_state_drift',
      'Provisioned Domain set is partially applied or has drifted',
    );
  }

  async function inspect(context = {}) {
    const spec = normalizedIntent(context);
    const state = await inspectState(spec);
    if (state === 'active') return publicEvidence(spec);
    return Object.freeze({
      satisfied: false,
      reason: 'website_domain_activation_pending',
      websiteId: spec.websiteId,
    });
  }

  async function apply(context = {}) {
    const spec = normalizedIntent(context);
    const current = await inspectState(spec);
    if (current === 'active') return publicEvidence(spec);
    await domainRegistry.activateProvisionedDomains({
      websiteId: spec.websiteId,
      domains: spec.domains,
      checksum: spec.nginx.checksum,
      configName: spec.nginx.configName,
    });
    const verified = await inspectState(spec);
    if (verified !== 'active') {
      throw new WebsiteDomainActivationProvisioningError(
        'website_domain_activation_unverified',
        'Provisioned Domain state did not match the active Nginx evidence',
      );
    }
    return publicEvidence(spec);
  }

  async function inspectCompensation(context = {}) {
    const spec = normalizedIntent(context);
    const state = await inspectState(spec, { compensation: true });
    if (state === 'pristine') {
      return Object.freeze({
        satisfied: true,
        adapter: 'domain-activation',
        websiteId: spec.websiteId,
        domains: Object.freeze(spec.domains.map((entry) => Object.freeze({ ...entry }))),
        reset: true,
      });
    }
    return Object.freeze({
      satisfied: false,
      reason: 'website_domain_activation_compensation_pending',
      websiteId: spec.websiteId,
    });
  }

  async function compensate(context = {}) {
    const spec = normalizedIntent(context);
    const current = await inspectCompensation(context);
    if (current.satisfied === true) return current;
    await domainRegistry.resetProvisionedDomains({
      websiteId: spec.websiteId,
      domains: spec.domains,
      checksum: spec.nginx.checksum,
      configName: spec.nginx.configName,
    });
    return inspectCompensation(context);
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websiteDomainActivationProvisioningInternals = Object.freeze({
  nginxEvidence,
  normalizedIntent,
  exactActive,
  pristine,
  publicEvidence,
});
