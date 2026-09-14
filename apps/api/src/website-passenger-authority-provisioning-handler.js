const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export class WebsitePassengerAuthorityProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsitePassengerAuthorityProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function succeededStep(operation, stepId) {
  const step = operation?.steps?.find((candidate) => candidate.id === stepId);
  return step?.state === 'succeeded' && step.evidence && typeof step.evidence === 'object'
    ? step.evidence
    : null;
}

function normalizeIntent(context = {}) {
  const { operation, operationId, websiteId, intent } = context;
  if (!operation || typeof operation !== 'object' || operation.operationId !== operationId
    || operation.websiteId !== websiteId
    || !intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'passenger-authority'
    || typeof intent.applicationId !== 'string'
    || intent.websiteId !== websiteId
    || !Array.isArray(intent.domainIds) || intent.domainIds.length < 1 || intent.domainIds.length > 2
    || new Set(intent.domainIds).size !== intent.domainIds.length
    || intent.domainIds.some((value) => typeof value !== 'string')) {
    throw new WebsitePassengerAuthorityProvisioningError(
      'website_passenger_authority_intent_invalid',
      'Passenger runtime authority intent is invalid',
      400,
    );
  }

  const application = operation.resources?.application;
  const website = operation.resources?.website;
  const plannedDomainIds = [
    operation.resources?.primaryDomain?.id,
    operation.resources?.wwwDomain?.id,
  ].filter(Boolean).sort();
  if (!application || application.id !== intent.applicationId || application.type !== 'node'
    || application.runtimeAdapter !== 'passenger' || !application.runtime
    || !website || website.id !== websiteId || website.applicationId !== application.id
    || website.runtimeType !== 'node'
    || !same([...intent.domainIds].sort(), plannedDomainIds)) {
    throw new WebsitePassengerAuthorityProvisioningError(
      'website_passenger_authority_plan_drift',
      'Passenger runtime authority no longer matches the provisioning plan',
    );
  }

  const environment = succeededStep(operation, 'passenger_environment');
  const release = succeededStep(operation, 'application_release');
  const runtime = succeededStep(operation, 'runtime');
  const nginx = succeededStep(operation, 'nginx');
  const domainActivation = succeededStep(operation, 'domain_activation');
  if (!environment || environment.adapter !== 'passenger-environment'
    || environment.applicationId !== application.id
    || !Number.isSafeInteger(environment.environmentRevision) || environment.environmentRevision < 0
    || typeof environment.environmentInclude !== 'string'
    || typeof environment.includeSha256 !== 'string' || !CHECKSUM_PATTERN.test(environment.includeSha256)
    || !release || release.adapter !== 'passenger-application-release'
    || release.applicationId !== application.id || release.releaseId !== operationId
    || !runtime || runtime.adapter !== 'passenger' || runtime.applicationId !== application.id
    || runtime.releaseId !== operationId || runtime.unixUser !== website.unixUser
    || typeof runtime.appRoot !== 'string' || typeof runtime.documentRoot !== 'string'
    || typeof runtime.startupFile !== 'string' || typeof runtime.nodeBinary !== 'string'
    || !nginx || nginx.satisfied !== true || typeof nginx.checksum !== 'string'
    || !CHECKSUM_PATTERN.test(nginx.checksum)
    || !domainActivation || domainActivation.adapter !== 'domain-activation'
    || domainActivation.websiteId !== websiteId
    || domainActivation.nginxChecksum !== nginx.checksum) {
    throw new WebsitePassengerAuthorityProvisioningError(
      'website_passenger_authority_evidence_invalid',
      'Passenger runtime authority evidence is incomplete or drifted',
    );
  }

  return Object.freeze({
    applicationId: application.id,
    websiteId,
    operationId,
    domainIds: Object.freeze([...plannedDomainIds]),
    releaseId: release.releaseId,
    environment,
    runtime,
    nginx,
    domainActivation,
    appEnv: application.runtime.mode ?? 'production',
  });
}

function publicEvidence(binding, checksum, environmentRevision) {
  return Object.freeze({
    satisfied: true,
    adapter: 'passenger-authority',
    applicationId: binding.applicationId,
    websiteId: binding.websiteId,
    releaseId: binding.releaseId,
    bindingRevision: binding.revision,
    websiteRevision: binding.websiteRevision,
    environmentRevision,
    domainIds: Object.freeze(binding.domains.map((entry) => entry.domainId)),
    nginxChecksum: checksum,
  });
}

export function createWebsitePassengerAuthorityProvisioningHandler({
  applicationRegistry,
  websiteRegistry,
  domainRegistry,
  runtimeBindingRegistry,
} = {}) {
  if (!applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !runtimeBindingRegistry || typeof runtimeBindingRegistry.getBinding !== 'function'
    || typeof runtimeBindingRegistry.activate !== 'function'
    || typeof runtimeBindingRegistry.removeOwnedPassenger !== 'function') {
    throw new WebsitePassengerAuthorityProvisioningError(
      'website_passenger_authority_dependencies_invalid',
      'Passenger runtime authority dependencies are invalid',
      503,
    );
  }

  async function expectedBinding(context = {}) {
    const spec = normalizeIntent(context);
    const [application, website, ...domains] = await Promise.all([
      applicationRegistry.getApplication(spec.applicationId),
      websiteRegistry.getWebsite(spec.websiteId),
      ...spec.domainIds.map((domainId) => domainRegistry.getDomain(domainId)),
    ]);
    if (!application || application.type !== 'node' || application.runtimeAdapter !== 'passenger'
      || application.currentReleaseId !== spec.releaseId
      || application.serverId !== website?.serverId
      || !website || website.applicationId !== application.id || website.runtimeType !== 'node'
      || !Number.isSafeInteger(website.revision) || website.revision < 1) {
      throw new WebsitePassengerAuthorityProvisioningError(
        'website_passenger_authority_resource_drift',
        'Passenger Application or Website authority changed before binding activation',
      );
    }
    const domainEvidence = domains.map((domain, index) => {
      const domainId = spec.domainIds[index];
      if (!domain || domain.id !== domainId || domain.serverId !== application.serverId
        || domain.websiteId !== website.id || domain.targetType !== 'passenger'
        || domain.target?.applicationId !== application.id
        || !Number.isSafeInteger(domain.desiredRevision) || domain.desiredRevision < 1
        || domain.stagedRevision !== domain.desiredRevision
        || domain.appliedRevision !== domain.desiredRevision
        || domain.stagedChecksum !== spec.nginx.checksum
        || domain.state !== 'active' || domain.lastError !== null) {
        throw new WebsitePassengerAuthorityProvisioningError(
          'website_passenger_authority_domain_drift',
          'Passenger Domain authority changed before binding activation',
        );
      }
      return Object.freeze({
        domainId,
        desiredRevision: domain.desiredRevision,
        nginxChecksum: spec.nginx.checksum,
      });
    }).sort((left, right) => left.domainId.localeCompare(right.domainId));

    return Object.freeze({
      spec,
      binding: Object.freeze({
        applicationId: application.id,
        serverId: application.serverId,
        adapter: 'passenger',
        state: 'active',
        sourceOperationId: spec.operationId,
        releaseId: spec.releaseId,
        websiteId: website.id,
        websiteRevision: website.revision,
        domains: Object.freeze(domainEvidence),
        passengerTarget: Object.freeze({
          appRoot: spec.runtime.appRoot,
          documentRoot: spec.runtime.documentRoot,
          startupFile: spec.runtime.startupFile,
          nodeBinary: spec.runtime.nodeBinary,
          user: spec.runtime.unixUser,
          group: spec.runtime.unixUser,
          appEnv: spec.appEnv,
          environmentInclude: spec.environment.environmentInclude,
        }),
      }),
    });
  }

  function bindingMatches(current, expected) {
    return Boolean(current)
      && current.applicationId === expected.applicationId
      && current.serverId === expected.serverId
      && current.adapter === expected.adapter
      && current.state === expected.state
      && current.sourceOperationId === expected.sourceOperationId
      && current.releaseId === expected.releaseId
      && current.websiteId === expected.websiteId
      && current.websiteRevision === expected.websiteRevision
      && same(current.domains, expected.domains)
      && same(current.passengerTarget, expected.passengerTarget);
  }

  async function inspect(context = {}) {
    const { spec, binding: expected } = await expectedBinding(context);
    const current = await runtimeBindingRegistry.getBinding(spec.applicationId);
    if (!current) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_passenger_authority_binding_missing',
        applicationId: spec.applicationId,
      });
    }
    if (!bindingMatches(current, expected)) {
      throw new WebsitePassengerAuthorityProvisioningError(
        'website_passenger_authority_binding_drift',
        'Persisted Passenger runtime binding conflicts with provisioning evidence',
      );
    }
    return publicEvidence(current, spec.nginx.checksum, spec.environment.environmentRevision);
  }

  async function apply(context = {}) {
    const { spec, binding } = await expectedBinding(context);
    const current = await runtimeBindingRegistry.getBinding(spec.applicationId);
    if (current) {
      if (!bindingMatches(current, binding)) {
        throw new WebsitePassengerAuthorityProvisioningError(
          'website_passenger_authority_binding_drift',
          'Existing Passenger runtime binding conflicts with native provisioning evidence',
        );
      }
      return publicEvidence(current, spec.nginx.checksum, spec.environment.environmentRevision);
    }
    const activated = await runtimeBindingRegistry.activate(binding, { expectedRevision: 0 });
    return publicEvidence(activated, spec.nginx.checksum, spec.environment.environmentRevision);
  }

  async function inspectCompensation(context = {}) {
    const spec = normalizeIntent(context);
    const bindingRevision = context.evidence?.bindingRevision;
    if (!Number.isSafeInteger(bindingRevision) || bindingRevision < 1) {
      throw new WebsitePassengerAuthorityProvisioningError(
        'website_passenger_authority_compensation_evidence_invalid',
        'Passenger authority compensation requires the persisted binding revision',
      );
    }
    const current = await runtimeBindingRegistry.getBinding(spec.applicationId);
    if (!current) {
      return Object.freeze({
        satisfied: true,
        adapter: 'passenger-authority',
        applicationId: spec.applicationId,
        bindingRevision,
        removed: true,
      });
    }
    if (current.adapter !== 'passenger' || current.sourceOperationId !== spec.operationId
      || current.revision !== bindingRevision) {
      throw new WebsitePassengerAuthorityProvisioningError(
        'website_passenger_authority_compensation_drift',
        'Passenger runtime authority changed after provisioning and cannot be removed automatically',
      );
    }
    return Object.freeze({
      satisfied: false,
      reason: 'website_passenger_authority_compensation_pending',
      bindingRevision,
    });
  }

  async function compensate(context = {}) {
    const spec = normalizeIntent(context);
    const current = await inspectCompensation(context);
    if (current.satisfied === true) return current;
    await runtimeBindingRegistry.removeOwnedPassenger(spec.applicationId, {
      sourceOperationId: spec.operationId,
      expectedRevision: current.bindingRevision,
    });
    return inspectCompensation(context);
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websitePassengerAuthorityProvisioningInternals = Object.freeze({
  succeededStep,
  normalizeIntent,
  publicEvidence,
});
