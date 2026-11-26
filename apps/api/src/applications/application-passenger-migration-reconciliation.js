import { OPERATIONS } from '@yunpanel/protocol';
import { materializeApplicationPassengerMigrationDomainEnvelope } from './application-passenger-migration-domain.js';

export class ApplicationPassengerMigrationReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApplicationPassengerMigrationReconciliationError';
    this.code = code;
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reconciliationError(code, message) {
  throw new ApplicationPassengerMigrationReconciliationError(code, message);
}

export async function reconcileApplicationPassengerMigration({
  job,
  applicationRegistry,
  websiteRegistry,
  domainRegistry,
  certificateRegistry,
  runtimeBindingRegistry,
} = {}) {
  for (const [dependency, methods] of [
    [applicationRegistry, ['getApplication']],
    [websiteRegistry, ['getWebsite', 'listWebsites']],
    [domainRegistry, ['getDomain', 'listDomains']],
    [certificateRegistry, ['getCertificate']],
    [runtimeBindingRegistry, ['getBinding', 'activate']],
  ]) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== 'function')) {
      reconciliationError(
        'node_passenger_migration_reconciliation_dependencies_invalid',
        'Passenger migration reconciliation dependencies are unavailable',
      );
    }
  }
  if (job?.operation !== OPERATIONS.APP_NODE_PASSENGER_MIGRATE
    || job.resourceType !== 'application'
    || job.resourceId !== job.payload?.node?.applicationId) {
    reconciliationError(
      'node_passenger_migration_reconciliation_identity_invalid',
      'Passenger migration reconciliation job identity is invalid',
    );
  }
  if (job.status !== 'succeeded') return null;

  const authority = job.payload?.authority;
  if (!authority?.websiteId || !authority?.domainId
    || !Number.isSafeInteger(authority.websiteRevision)
    || !Number.isSafeInteger(authority.domainDesiredRevision)
    || !Number.isSafeInteger(authority.domainAppliedRevision)) {
    reconciliationError(
      'node_passenger_migration_authority_invalid',
      'Passenger migration queued authority snapshot is invalid',
    );
  }

  const application = await applicationRegistry.getApplication(job.resourceId);
  if (!application || application.serverId !== job.serverId || application.type !== 'node') {
    reconciliationError(
      'node_passenger_migration_application_drift',
      'Passenger migration Application state changed before reconciliation',
    );
  }
  if (application.currentReleaseId !== job.payload.node.releaseId
    || !same(application.activeRuntime, job.payload.node.runtime)) {
    reconciliationError(
      'node_passenger_migration_release_drift',
      'Passenger migration release or runtime changed before reconciliation',
    );
  }

  const [website, applicationWebsites, domain, allDomains] = await Promise.all([
    websiteRegistry.getWebsite(authority.websiteId),
    websiteRegistry.listWebsites({ serverId: application.serverId }),
    domainRegistry.getDomain(authority.domainId),
    domainRegistry.listDomains(),
  ]);
  const websites = applicationWebsites.filter((candidate) => candidate.applicationId === application.id);
  if (!website || website.id !== authority.websiteId || website.serverId !== application.serverId
    || website.applicationId !== application.id || website.runtimeType !== 'node'
    || website.revision !== authority.websiteRevision
    || websites.length !== 1 || websites[0].id !== website.id) {
    reconciliationError(
      'node_passenger_migration_website_drift',
      'Passenger migration Website authority changed before reconciliation',
    );
  }

  const domains = allDomains.filter((candidate) => (
    candidate.serverId === application.serverId && candidate.websiteId === website.id
  ));
  if (!domain || domain.id !== authority.domainId || domain.serverId !== application.serverId
    || domain.websiteId !== website.id
    || domain.desiredRevision !== authority.domainDesiredRevision
    || domain.appliedRevision !== authority.domainAppliedRevision
    || domains.length !== 1 || domains[0].id !== domain.id) {
    reconciliationError(
      'node_passenger_migration_domain_drift',
      'Passenger migration Domain authority changed before reconciliation',
    );
  }
  if (domain.state !== 'active' || domain.appliedRevision !== domain.desiredRevision
    || domain.targetType !== 'proxy'
    || domain.target?.upstreamHost !== '127.0.0.1'
    || domain.target?.upstreamPort !== application.activeRuntime.port) {
    reconciliationError(
      'node_passenger_migration_domain_drift',
      'Passenger migration Domain route changed before reconciliation',
    );
  }

  const currentEnvelope = await materializeApplicationPassengerMigrationDomainEnvelope(domain, certificateRegistry);
  if (!same(currentEnvelope, job.payload.domain)) {
    reconciliationError(
      'node_passenger_migration_domain_drift',
      'Passenger migration Domain configuration changed before reconciliation',
    );
  }

  const currentBinding = await runtimeBindingRegistry.getBinding(application.id);
  const expectedRevision = currentBinding?.revision ?? 0;
  if (typeof applicationRegistry.markPassengerMigrated === 'function') {
    await applicationRegistry.markPassengerMigrated(application.id, { operationId: job.id });
  }
  return runtimeBindingRegistry.activate({
    applicationId: application.id,
    serverId: application.serverId,
    adapter: 'passenger',
    state: job.result.state === 'migrated' ? 'active' : 'cleanup_required',
    sourceOperationId: job.id,
    releaseId: application.currentReleaseId,
    websiteId: website.id,
    websiteRevision: authority.websiteRevision,
    domains: [{
      domainId: domain.id,
      desiredRevision: authority.domainDesiredRevision,
      nginxChecksum: job.result.nginx.targetChecksum,
    }],
    passengerTarget: job.result.passengerTarget,
  }, { expectedRevision });
}

export const applicationPassengerMigrationReconciliationInternals = Object.freeze({ same });
