export class ApplicationPassengerMigrationDomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApplicationPassengerMigrationDomainError';
    this.code = code;
  }
}

export function applicationPassengerMigrationDomainEnvelope(domain, certificate = null) {
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) {
    throw new ApplicationPassengerMigrationDomainError(
      'node_passenger_migration_domain_invalid',
      'Passenger migration Domain state is invalid',
    );
  }
  return Object.freeze({
    primaryDomain: domain.primaryDomain,
    aliases: Object.freeze([...domain.aliases]),
    tls: certificate ? Object.freeze({
      fullchainPath: certificate.fullchainPath,
      privateKeyPath: certificate.privateKeyPath,
    }) : null,
    canonicalRedirect: domain.canonicalRedirect === true,
    httpsRedirect: domain.httpsRedirect !== false,
    nginxSettings: Object.freeze(structuredClone(domain.nginxSettings)),
  });
}

export async function materializeApplicationPassengerMigrationDomainEnvelope(domain, certificateRegistry) {
  if (!domain?.certificateId) return applicationPassengerMigrationDomainEnvelope(domain);
  if (!certificateRegistry || typeof certificateRegistry.getCertificate !== 'function') {
    throw new ApplicationPassengerMigrationDomainError(
      'node_passenger_migration_certificate_registry_unavailable',
      'Passenger migration certificate registry is unavailable',
    );
  }
  const certificate = await certificateRegistry.getCertificate(domain.certificateId);
  if (!certificate || certificate.state !== 'active' || certificate.staging === true) {
    throw new ApplicationPassengerMigrationDomainError(
      'node_passenger_migration_certificate_drift',
      'Passenger migration certificate state is not active production material',
    );
  }
  if (certificate.domains?.join('\n') !== [domain.primaryDomain, ...domain.aliases].join('\n')) {
    throw new ApplicationPassengerMigrationDomainError(
      'node_passenger_migration_certificate_domain_mismatch',
      'Passenger migration certificate does not cover current Domain routing names',
    );
  }
  return applicationPassengerMigrationDomainEnvelope(domain, certificate);
}
