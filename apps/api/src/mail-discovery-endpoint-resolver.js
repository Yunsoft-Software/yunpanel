const SOCKET_PATH = '/run/yunpanel-mail-discovery/discovery.sock';
const AUTODISCOVER_PATH = '/autodiscover/autodiscover.xml';
const AUTOCONFIG_PATH = '/mail/config-v1.1.xml';

export class MailDiscoveryEndpointResolverError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'MailDiscoveryEndpointResolverError';
    this.code = code;
    this.status = status;
  }
}

function resourceScope(mailDomain, domain) {
  if (!mailDomain || typeof mailDomain !== 'object' || Array.isArray(mailDomain)
    || !domain || typeof domain !== 'object' || Array.isArray(domain)
    || typeof mailDomain.id !== 'string' || !mailDomain.id
    || mailDomain.managementMode !== 'local' || mailDomain.status !== 'enabled'
    || !Number.isSafeInteger(mailDomain.revision) || mailDomain.revision < 1
    || mailDomain.webDomainId !== domain.id || mailDomain.domainName !== domain.primaryDomain
    || typeof domain.serverId !== 'string' || !domain.serverId
    || typeof domain.websiteId !== 'string' || !domain.websiteId
    || domain.state !== 'active' || domain.httpsMode !== 'managed'
    || typeof domain.certificateId !== 'string' || !domain.certificateId
    || !Number.isSafeInteger(domain.desiredRevision) || domain.desiredRevision < 1
    || typeof domain.stagedChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(domain.stagedChecksum)) {
    throw new MailDiscoveryEndpointResolverError(
      'mail_discovery_endpoint_scope_invalid',
      'Mail discovery endpoint resource scope is invalid',
    );
  }
  return Object.freeze({ mailDomain, domain });
}

function runtimeReady(value) {
  return Boolean(value
    && value.version === 1
    && value.ready === true
    && value.socketPath === SOCKET_PATH
    && value.sideEffects === false);
}

function matchingRouteOperation(operations, scope) {
  if (!Array.isArray(operations)) {
    throw new MailDiscoveryEndpointResolverError(
      'mail_discovery_endpoint_provisioning_state_invalid',
      'Website provisioning state is invalid',
      503,
    );
  }
  for (const operation of operations) {
    if (!operation || operation.websiteId !== scope.domain.websiteId) continue;
    const nginx = operation.steps?.find((step) => step.id === 'nginx');
    const tls = operation.steps?.find((step) => step.id === 'tls_activation');
    if (!nginx || nginx.kind !== 'nginx' || nginx.state !== 'succeeded'
      || nginx.intent?.websiteId !== scope.domain.websiteId
      || nginx.intent?.primaryDomain !== scope.domain.primaryDomain
      || nginx.intent?.mailDiscoverySocketPath !== SOCKET_PATH
      || !tls || tls.kind !== 'tls_activation' || tls.state !== 'succeeded'
      || tls.evidence?.satisfied !== true
      || tls.evidence?.adapter !== 'managed-certificate-nginx'
      || tls.evidence?.domainId !== scope.domain.id
      || tls.evidence?.certificateId !== scope.domain.certificateId
      || tls.evidence?.domainRevision !== scope.domain.desiredRevision
      || tls.evidence?.nginxChecksum !== scope.domain.stagedChecksum
      || tls.evidence?.httpsRedirect !== scope.domain.httpsRedirect
      || tls.evidence?.canonicalRedirect !== scope.domain.canonicalRedirect) {
      continue;
    }
    return Object.freeze({
      operationId: operation.operationId,
      nginxChecksum: tls.evidence.nginxChecksum,
      nginxConfigName: tls.evidence.nginxConfigName,
    });
  }
  return null;
}

function endpoint(hostname, path) {
  return Object.freeze({
    ready: true,
    hostname,
    protocol: 'https',
    path,
  });
}

export function createMailDiscoveryEndpointResolver({
  mailDiscoveryService,
  mailDiscoveryRuntime,
  websiteProvisioningRegistry,
} = {}) {
  if (!mailDiscoveryService || typeof mailDiscoveryService.resolveState !== 'function'
    || !mailDiscoveryRuntime || typeof mailDiscoveryRuntime.inspect !== 'function'
    || !websiteProvisioningRegistry || typeof websiteProvisioningRegistry.listForWebsite !== 'function') {
    throw new MailDiscoveryEndpointResolverError(
      'mail_discovery_endpoint_dependencies_invalid',
      'Mail discovery endpoint resolver dependencies are unavailable',
      503,
    );
  }

  async function resolve({ mailDomain, domain } = {}) {
    const scope = resourceScope(mailDomain, domain);
    let runtime;
    try {
      runtime = await mailDiscoveryRuntime.inspect();
    } catch {
      return null;
    }
    if (!runtimeReady(runtime)) return null;

    let state;
    try {
      state = await mailDiscoveryService.resolveState(scope.domain.primaryDomain);
    } catch {
      return null;
    }
    if (!state
      || state.mailDomainId !== scope.mailDomain.id
      || state.webDomainId !== scope.domain.id
      || state.websiteId !== scope.domain.websiteId
      || state.serverId !== scope.domain.serverId
      || state.certificateId !== scope.domain.certificateId
      || state.mailDomainRevision !== scope.mailDomain.revision
      || state.domainRevision !== scope.domain.desiredRevision) {
      throw new MailDiscoveryEndpointResolverError(
        'mail_discovery_endpoint_state_drift',
        'Mail discovery service state drifted from the requested resources',
        503,
      );
    }

    let operations;
    try {
      operations = await websiteProvisioningRegistry.listForWebsite(scope.domain.websiteId);
    } catch {
      return null;
    }
    const route = matchingRouteOperation(operations, scope);
    if (!route) return null;

    return Object.freeze({
      version: 1,
      mailDomainId: scope.mailDomain.id,
      serverId: scope.domain.serverId,
      revision: scope.mailDomain.revision,
      autodiscover: endpoint(scope.domain.primaryDomain, AUTODISCOVER_PATH),
      autoconfig: endpoint(scope.domain.primaryDomain, AUTOCONFIG_PATH),
    });
  }

  return Object.freeze({ resolve });
}

export const mailDiscoveryEndpointResolverInternals = Object.freeze({
  socketPath: SOCKET_PATH,
  autodiscoverPath: AUTODISCOVER_PATH,
  autoconfigPath: AUTOCONFIG_PATH,
  resourceScope,
  runtimeReady,
  matchingRouteOperation,
  endpoint,
});
