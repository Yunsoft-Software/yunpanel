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
    [websiteRegistry, ['listWebsites']],
    [domainRegistry, ['listDomains']],
    [certificateRegistry, ['getCertificate']],
    [runtimeBindingRegistry, ['getBinding', 'activate']],
  ]) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== 'function')) {
      throw new ApplicationPassengerMigrationReconciliationError(
        'node_passenger_migration_reconciliation_dependencies_invalid',
        'Passenger migration reconciliation dependencies are unavailable',
      );
    }
  }
  if (job?.operation !== OPERATIONS.APP_NODE_PASSENGER_MIGRATE
    || job.resourceType !== 'application'
    || job.resourceId !== job.payload?.node?.applicationId) {
    throw new ApplicationPassengerMigrationReconciliationError(
      'node_passenger_migration_reconciliation_identity_invalid',
      'Passenger migration reconciliation job identity is invalid',
    );
  }
  if (job.status !== 'succeeded') return null;

  const application = await applicationRegistry.getApplication(job.resourceId);
  if (!application || application.serverId !== job.serverId || application.type !== 'node') {
    throw new ApplicationPassengerMigrationReconciliationError(
      'node_passenger_migration_application_drift',
      'Passenger migration Application state changed before reconciliation',
    );
  }
  if (application.currentReleaseId !== job.payload.node.releaseId
    || !same(application.activeRuntime, job.payload.node.runtime)) {
    throw new ApplicationPassengerMigrationReconciliationError(
      'node_passenger_migration_release_drift',
      'Passenger migration release or runtime changed before reconciliation',
    );
  }

  const websites = (await websiteRegistry.listWebsites({ serverId: application.serverId }))
    .filter((website) => website.applicationId === application.id);
  if (websites.length !== 1 || websites[0].runtimeType !== 'node') {
    throw new ApplicationPassengerMigrationReconciliationError(
      'node_passenger_migration_website_drift',
      'Passenger migration Website binding changed before reconciliation',
    );
  }
  const website = websites[0];
  const domains = (await domainRegistry.listDomains())
    .filter((domain) => domain.serverId === application.serverId && domain.websiteId === website.id);
  if (domains.length !== 1) {
    throw new ApplicationPassengerMigrationReconciliationError(
      'node_passenger_migration_domain_drift',
      'Passenger migration Domain binding changed before reconciliation',
    );
  }
  const domain = domains[0];
  if (domain.state !== 'active' || domain.appliedRevision !== domain.desiredRevision
    || domain.targetType !== 'proxy'
    || domain.target?.upstreamHost !== '127.0.0.1'
    || domain.target?.upstreamPort !== application.activeRuntime.port) {
    throw new ApplicationPassengerMigrationReconciliationError(
      'node_passenger_migration_domain_drift',
      'Passenger migration Domain route changed before reconciliation',
    );
  }

  const currentEnvelope = await materializeApplicationPassengerMigrationDomainEnvelope(domain, certificateRegistry);
  if (!same(currentEnvelope, job.payload.domain)) {
    throw new ApplicationPassengerMigrationReconciliationError(
      'node_passenger_migration_domain_drift',
      'Passenger migration Domain configuration changed before reconciliation',
    );
  }

  const currentBinding = await runtimeBindingRegistry.getBinding(application.id);
  const expectedRevision = currentBinding?.revision ?? 0;
  return runtimeBindingRegistry.activate({
    applicationId: application.id,
    serverId: application.serverId,
    adapter: 'passenger',
    state: job.result.state === 'migrated' ? 'active' : 'cleanup_required',
    sourceOperationId: job.id,
    releaseId: application.currentReleaseId,
    websiteId: website.id,
    websiteRevision: website.revision,
    domains: [{
      domainId: domain.id,
      desiredRevision: domain.desiredRevision,
      nginxChecksum: job.result.nginx.targetChecksum,
    }],
    passengerTarget: job.result.passengerTarget,
  }, { expectedRevision });
}

export const applicationPassengerMigrationReconciliationInternals = Object.freeze({ same });
