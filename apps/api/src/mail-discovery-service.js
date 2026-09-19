import { normalizeDomainSet } from '@yunpanel/shared';

const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

export class MailDiscoveryServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDiscoveryServiceError';
    this.code = code;
    this.status = status;
  }
}

function normalizeHostname(value, field = 'hostname') {
  try {
    if (typeof value !== 'string' || value.length < 1 || value.length > 253
      || value.includes(':') || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('invalid hostname');
    }
    return normalizeDomainSet(value, []).primary;
  } catch {
    throw new MailDiscoveryServiceError(
      'mail_discovery_hostname_invalid',
      `${field} is invalid`,
      400,
    );
  }
}

function normalizeAddress(value, expectedDomain) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 254 || value.trim() !== value) {
    throw new MailDiscoveryServiceError(
      'mail_discovery_address_invalid',
      'Mail discovery address is invalid',
      400,
    );
  }
  const separator = value.indexOf('@');
  if (separator < 1 || separator !== value.lastIndexOf('@')) {
    throw new MailDiscoveryServiceError(
      'mail_discovery_address_invalid',
      'Mail discovery address is invalid',
      400,
    );
  }
  const local = value.slice(0, separator).toLowerCase();
  if (!LOCAL_PART_PATTERN.test(local) || local.includes('..')) {
    throw new MailDiscoveryServiceError(
      'mail_discovery_address_invalid',
      'Mail discovery address is invalid',
      400,
    );
  }
  const domain = normalizeHostname(value.slice(separator + 1), 'email domain');
  if (domain !== expectedDomain) {
    throw new MailDiscoveryServiceError(
      'mail_discovery_address_domain_mismatch',
      'Mail discovery address does not belong to this domain',
      404,
    );
  }
  return `${local}@${domain}`;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderAutoconfig({ domainName, emailAddress, serviceHostname }) {
  const domain = xml(domainName);
  const address = xml(emailAddress);
  const hostname = xml(serviceHostname);
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${domain}">
    <domain>${domain}</domain>
    <displayName>${address}</displayName>
    <displayShortName>${domain}</displayShortName>
    <incomingServer type="imap">
      <hostname>${hostname}</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>${address}</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${hostname}</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>${address}</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>
`;
}

function protocolXml(type, hostname, port, address) {
  return `    <Protocol>
      <Type>${type}</Type>
      <Server>${xml(hostname)}</Server>
      <Port>${port}</Port>
      <DomainRequired>off</DomainRequired>
      <SPA>off</SPA>
      <SSL>off</SSL>
      <Encryption>TLS</Encryption>
      <AuthRequired>on</AuthRequired>
      <LoginName>${xml(address)}</LoginName>
    </Protocol>`;
}

function renderAutodiscover({ emailAddress, serviceHostname }) {
  const address = xml(emailAddress);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <User>
      <DisplayName>${address}</DisplayName>
    </User>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
${protocolXml('IMAP', serviceHostname, 143, emailAddress)}
${protocolXml('SMTP', serviceHostname, 587, emailAddress)}
    </Account>
  </Response>
</Autodiscover>
`;
}

function exactLocalDomain(mailDomains, hostname) {
  const matches = mailDomains.filter((candidate) => candidate
    && candidate.domainName === hostname
    && candidate.managementMode === 'local'
    && candidate.status === 'enabled');
  if (matches.length !== 1) {
    throw new MailDiscoveryServiceError(
      'mail_discovery_domain_not_found',
      'Mail discovery is unavailable for this domain',
      404,
    );
  }
  return matches[0];
}

export function createMailDiscoveryService({
  mailDomainRegistry,
  domainRegistry,
  mailServiceIdentityRegistry,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.listMailDomains !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailServiceIdentityRegistry || typeof mailServiceIdentityRegistry.getForServer !== 'function') {
    throw new MailDiscoveryServiceError(
      'mail_discovery_dependencies_invalid',
      'Mail discovery dependencies are unavailable',
      503,
    );
  }

  async function resolveState(domainName) {
    const hostname = normalizeHostname(domainName, 'request hostname');
    let mailDomains;
    try {
      mailDomains = await mailDomainRegistry.listMailDomains();
    } catch {
      throw new MailDiscoveryServiceError(
        'mail_discovery_domain_state_unavailable',
        'Mail discovery domain state is unavailable',
        503,
      );
    }
    if (!Array.isArray(mailDomains)) {
      throw new MailDiscoveryServiceError(
        'mail_discovery_domain_state_invalid',
        'Mail discovery domain state is invalid',
        503,
      );
    }
    const mailDomain = exactLocalDomain(mailDomains, hostname);
    let domain;
    try {
      domain = await domainRegistry.getDomain(mailDomain.webDomainId);
    } catch {
      throw new MailDiscoveryServiceError(
        'mail_discovery_web_domain_unavailable',
        'Mail discovery Website Domain state is unavailable',
        503,
      );
    }
    if (!domain || domain.id !== mailDomain.webDomainId
      || domain.primaryDomain !== hostname
      || domain.serverId !== mailDomain.serverId
      || typeof domain.websiteId !== 'string' || !domain.websiteId
      || domain.state !== 'active'
      || domain.httpsMode !== 'managed'
      || typeof domain.certificateId !== 'string' || !domain.certificateId) {
      throw new MailDiscoveryServiceError(
        'mail_discovery_web_domain_not_ready',
        'Mail discovery Website Domain is not ready',
        503,
      );
    }

    let identity;
    try {
      identity = await mailServiceIdentityRegistry.getForServer(domain.serverId);
    } catch {
      throw new MailDiscoveryServiceError(
        'mail_discovery_service_identity_unavailable',
        'Mail service identity is unavailable',
        503,
      );
    }
    if (!identity || identity.serverId !== domain.serverId
      || identity.ready !== true
      || typeof identity.hostname !== 'string'
      || !Number.isSafeInteger(identity.revision) || identity.revision < 1) {
      throw new MailDiscoveryServiceError(
        'mail_discovery_service_identity_not_ready',
        'Mail service identity is not ready',
        503,
      );
    }
    const serviceHostname = normalizeHostname(identity.hostname, 'mail service hostname');
    return Object.freeze({
      domainName: hostname,
      websiteId: domain.websiteId,
      webDomainId: domain.id,
      mailDomainId: mailDomain.id,
      mailDomainRevision: mailDomain.revision,
      serverId: domain.serverId,
      domainRevision: domain.desiredRevision,
      certificateId: domain.certificateId,
      serviceHostname,
      serviceIdentityRevision: identity.revision,
    });
  }

  async function autoconfig({ domainName, emailAddress } = {}) {
    const state = await resolveState(domainName);
    const address = normalizeAddress(emailAddress, state.domainName);
    return Object.freeze({
      state,
      emailAddress: address,
      contentType: 'application/xml; charset=utf-8',
      body: renderAutoconfig({
        domainName: state.domainName,
        emailAddress: address,
        serviceHostname: state.serviceHostname,
      }),
    });
  }

  async function autodiscover({ domainName, emailAddress } = {}) {
    const state = await resolveState(domainName);
    const address = normalizeAddress(emailAddress, state.domainName);
    return Object.freeze({
      state,
      emailAddress: address,
      contentType: 'application/xml; charset=utf-8',
      body: renderAutodiscover({
        emailAddress: address,
        serviceHostname: state.serviceHostname,
      }),
    });
  }

  return Object.freeze({
    resolveState,
    autoconfig,
    autodiscover,
  });
}

export const mailDiscoveryServiceInternals = Object.freeze({
  normalizeHostname,
  normalizeAddress,
  xml,
  renderAutoconfig,
  renderAutodiscover,
  exactLocalDomain,
});
