import { OPERATIONS } from '@yunpanel/protocol';
import { ApplicationRegistryError } from './application-registry.js';
import { materializeApplicationPassengerMigrationDomainEnvelope } from './application-passenger-migration-domain.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const ACTIVE_CERTIFICATE_STATES = new Set(['pending', 'validating', 'issuing', 'renewing']);

function applyInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || value.confirmation.length > 200) {
    throw new ApplicationRegistryError(
      'node_passenger_migration_input_invalid',
      'Passenger migration requires previewDigest and exact confirmation',
    );
  }
  return Object.freeze({ previewDigest: value.previewDigest, confirmation: value.confirmation });
}

async function assertRoutingIdle({ jobRegistry, certificateRegistry, domainId }) {
  const [jobs, certificates] = await Promise.all([
    jobRegistry.listJobs({ resourceType: 'domain', resourceId: domainId }),
    certificateRegistry.listCertificates(),
  ]);
  if (jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))
    || certificates.some((certificate) => certificate.domainId === domainId
      && ACTIVE_CERTIFICATE_STATES.has(certificate.state))) {
    throw new ApplicationRegistryError(
      'node_passenger_migration_routing_busy',
      'Wait for the active Domain or certificate operation to finish before Passenger migration',
      409,
    );
  }
}

export function createApplicationPassengerMigrationService({
  previewService,
  applicationRegistry,
  domainRegistry,
  certificateRegistry,
  runtimeBindingRegistry,
  jobRegistry,
} = {}) {
  for (const [dependency, methods] of [
    [previewService, ['preview']],
    [applicationRegistry, ['getApplication']],
    [domainRegistry, ['getDomain']],
    [certificateRegistry, ['getCertificate', 'listCertificates']],
    [runtimeBindingRegistry, ['getBinding']],
    [jobRegistry, ['enqueue', 'listJobs']],
  ]) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== 'function')) {
      throw new Error('Application Passenger migration service dependencies are required');
    }
  }

  async function apply(applicationId, rawInput) {
    const input = applyInput(rawInput);
    const preview = await previewService.preview(applicationId);
    if (preview.previewDigest !== input.previewDigest) {
      throw new ApplicationRegistryError(
        'node_passenger_migration_preview_stale',
        'Passenger migration state changed after preview; request a new preview',
        409,
      );
    }
    if (preview.confirmation !== input.confirmation) {
      throw new ApplicationRegistryError(
        'node_passenger_migration_confirmation_required',
        `Confirm Passenger migration with ${preview.confirmation}`,
      );
    }

    const application = await applicationRegistry.getApplication(applicationId);
    if (!application || application.id !== preview.application?.applicationId
      || application.currentReleaseId !== preview.application.releaseId
      || application.type !== 'node' || !application.activeRuntime) {
      throw new ApplicationRegistryError(
        'node_passenger_migration_application_drift',
        'Passenger migration Application changed after preview',
        409,
      );
    }
    const existingBinding = await runtimeBindingRegistry.getBinding(application.id);
    const cleanupRetry = existingBinding?.adapter === 'passenger'
      && existingBinding.state === 'cleanup_required'
      && existingBinding.releaseId === application.currentReleaseId
      && existingBinding.websiteId === preview.website?.websiteId
      && existingBinding.websiteRevision === preview.website?.revision
      && existingBinding.domains?.length === 1
      && existingBinding.domains[0].domainId === preview.domain?.domainId
      && existingBinding.domains[0].desiredRevision === preview.domain?.desiredRevision;
    if (existingBinding?.adapter === 'passenger' && existingBinding.state === 'active'
      && existingBinding.releaseId === application.currentReleaseId) {
      throw new ApplicationRegistryError(
        'node_passenger_migration_already_active',
        'Application already uses the Passenger runtime adapter',
        409,
      );
    }
    if (!preview.ready && !cleanupRetry) {
      throw new ApplicationRegistryError(
        'node_passenger_migration_preview_blocked',
        'Passenger migration preview is not ready to apply',
        409,
      );
    }
    if (!preview.domain?.domainId || !preview.website?.websiteId) {
      throw new ApplicationRegistryError(
        'node_passenger_migration_binding_missing',
        'Passenger migration requires one current Website and Domain binding',
        409,
      );
    }

    const domain = await domainRegistry.getDomain(preview.domain.domainId);
    if (!domain || domain.websiteId !== preview.website.websiteId
      || domain.desiredRevision !== preview.domain.desiredRevision
      || domain.appliedRevision !== preview.domain.appliedRevision) {
      throw new ApplicationRegistryError(
        'node_passenger_migration_domain_drift',
        'Passenger migration Domain changed after preview',
        409,
      );
    }
    await assertRoutingIdle({ jobRegistry, certificateRegistry, domainId: domain.id });
    const domainEnvelope = await materializeApplicationPassengerMigrationDomainEnvelope(domain, certificateRegistry);
    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: 'app.node.passenger-migrate',
      operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
      payload: {
        node: {
          applicationId: application.id,
          releaseId: application.currentReleaseId,
          runtime: application.activeRuntime,
        },
        domain: domainEnvelope,
      },
      resourceType: 'application',
      resourceId: application.id,
      idempotencyKey: `node-passenger-migrate:${application.id}:${preview.previewDigest}`,
    });
    return Object.freeze({ preview, job });
  }

  return Object.freeze({ apply });
}

export const applicationPassengerMigrationServiceInternals = Object.freeze({ applyInput, assertRoutingIdle });