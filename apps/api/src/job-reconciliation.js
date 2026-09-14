import { OPERATIONS } from '@yunpanel/protocol';
import { reconcileApplicationPassengerMigration } from './application-passenger-migration-reconciliation.js';
import { acknowledgeAutomaticJobReconciliation } from './durable-job-registry.js';

const SAFE_ERROR_CODE = /^[a-z0-9_.-]{1,80}$/;

export class JobReconciliationError extends Error {
  constructor(code) {
    super('Completed job reconciliation failed');
    this.name = 'JobReconciliationError';
    this.code = code;
  }
}

function safeReconciliationCode(error) {
  const suffix = typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code) ? error.code : 'failed';
  return `reconcile_${suffix}`;
}

function passengerDomainStageError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function markEnvironmentApplied(applicationEnvironmentRegistry, job, releaseId) {
  if (!applicationEnvironmentRegistry || typeof applicationEnvironmentRegistry.markApplied !== 'function') return;
  if (![OPERATIONS.APP_NODE_DEPLOY, OPERATIONS.APP_NODE_RESTART, OPERATIONS.APP_NODE_ROLLBACK].includes(job.operation)) return;
  await applicationEnvironmentRegistry.markApplied({
    applicationId: job.resourceId,
    revision: job.result?.environmentRevision ?? 0,
    releaseId,
  });
}

async function reconcileApplicationJob(applicationRegistry, applicationEnvironmentRegistry, job) {
  const application = await applicationRegistry.getApplication(job.resourceId);
  if (!application) return;

  if (job.status === 'failed') {
    if (application.activeDeploymentId !== job.id) return;
    await applicationRegistry.markFailed(job.resourceId, job.id, job.error?.code ?? 'application_operation_failed');
    return;
  }

  if (job.operation === OPERATIONS.APP_STATIC_DEPLOY || job.operation === OPERATIONS.APP_NODE_DEPLOY) {
    if (!(application.activeDeploymentId == null && application.currentReleaseId === job.result?.releaseId)) {
      await applicationRegistry.markDeployed(job.resourceId, {
        deploymentId: job.id,
        releaseId: job.result.releaseId,
        commitSha: job.result.commitSha,
        gitTarget: job.result.gitTarget,
        previousReleaseId: job.result.previousReleaseId,
        artifactFiles: job.result.artifactFiles ?? null,
        artifactBytes: job.result.artifactBytes ?? null,
        serviceName: job.result.serviceName ?? null,
        port: job.result.port ?? null,
        healthPath: job.result.healthPath ?? null,
        healthy: job.result.healthy ?? null,
        runtime: job.payload?.runtime ?? null,
      });
    }
    await markEnvironmentApplied(applicationEnvironmentRegistry, job, job.result.releaseId);
    return;
  }

  if (job.operation === OPERATIONS.APP_STATIC_ROLLBACK || job.operation === OPERATIONS.APP_NODE_ROLLBACK) {
    if (!(application.activeDeploymentId == null && application.currentReleaseId === job.result?.releaseId)) {
      await applicationRegistry.markRolledBack(job.resourceId, {
        operationId: job.id,
        releaseId: job.result.releaseId,
        previousReleaseId: job.result.previousReleaseId,
        serviceName: job.result.serviceName ?? null,
        port: job.result.port ?? null,
        healthPath: job.result.healthPath ?? null,
        healthy: job.result.healthy ?? null,
      });
    }
    await markEnvironmentApplied(applicationEnvironmentRegistry, job, job.result.releaseId);
    return;
  }

  if (job.operation === OPERATIONS.APP_NODE_RESTART) {
    await markEnvironmentApplied(applicationEnvironmentRegistry, job, job.result.releaseId);
  }
}

async function reconcileMailDomainJob(mailDomainRegistry, job) {
  if (job.operation !== OPERATIONS.MAIL_CONFIG_APPLY || job.status === 'failed') return;
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof mailDomainRegistry.transitionLocalStatus !== 'function') {
    const error = new Error('Mail-domain reconciliation registry is unavailable');
    error.code = 'mail_domain_reconciliation_unavailable';
    throw error;
  }
  const expectedRevision = job.payload?.expectedRevision;
  const desiredStatus = job.result?.desiredStatus;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || !['disabled', 'enabled'].includes(desiredStatus)
    || job.result?.mailDomainId !== job.resourceId || job.payload?.mailDomainId !== job.resourceId) {
    const error = new Error('Mail-domain reconciliation identity is invalid');
    error.code = 'mail_domain_reconciliation_invalid';
    throw error;
  }
  const current = await mailDomainRegistry.getMailDomain(job.resourceId);
  if (!current || current.managementMode !== 'local') {
    const error = new Error('Mail-domain reconciliation target is unavailable');
    error.code = 'mail_domain_reconciliation_target_unavailable';
    throw error;
  }
  if (current.status === desiredStatus
    && (current.revision === expectedRevision || current.revision === expectedRevision + 1)) return;
  if (current.revision !== expectedRevision || current.status === desiredStatus) {
    const error = new Error('Mail-domain state changed before reconciliation');
    error.code = 'mail_domain_reconciliation_conflict';
    throw error;
  }
  await mailDomainRegistry.transitionLocalStatus(job.resourceId, {
    expectedRevision,
    status: desiredStatus,
  });
}

async function reconcilePassengerDomainStageBinding({
  job,
  domain,
  applicationRegistry,
  websiteRegistry,
  runtimeBindingRegistry,
}) {
  if (job.payload?.targetType !== 'passenger') return null;
  if (!applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !runtimeBindingRegistry || typeof runtimeBindingRegistry.getBinding !== 'function'
    || typeof runtimeBindingRegistry.activate !== 'function') {
    passengerDomainStageError(
      'passenger_domain_stage_reconciliation_unavailable',
      'Passenger Domain stage reconciliation dependencies are unavailable',
    );
  }
  if (!domain?.websiteId || domain.id !== job.resourceId || domain.serverId !== job.serverId) {
    passengerDomainStageError(
      'passenger_domain_stage_identity_drift',
      'Passenger Domain stage resource identity changed before reconciliation',
    );
  }

  const website = await websiteRegistry.getWebsite(domain.websiteId);
  if (!website || website.serverId !== domain.serverId || website.runtimeType !== 'node' || !website.applicationId) {
    passengerDomainStageError(
      'passenger_domain_stage_website_drift',
      'Passenger Domain stage Website binding changed before reconciliation',
    );
  }
  const [application, binding] = await Promise.all([
    applicationRegistry.getApplication(website.applicationId),
    runtimeBindingRegistry.getBinding(website.applicationId),
  ]);
  if (!application || application.type !== 'node' || application.serverId !== domain.serverId
    || !binding || binding.adapter !== 'passenger' || binding.serverId !== domain.serverId
    || binding.applicationId !== application.id || binding.websiteId !== website.id
    || binding.websiteRevision !== website.revision || binding.releaseId !== application.currentReleaseId) {
    passengerDomainStageError(
      'passenger_domain_stage_runtime_drift',
      'Passenger runtime authority changed before Domain stage reconciliation',
    );
  }

  const expectedTarget = {
    root: binding.passengerTarget?.appRoot,
    startupFile: binding.passengerTarget?.startupFile,
    nodeBinary: binding.passengerTarget?.nodeBinary,
  };
  if (!same(job.payload.target, expectedTarget)) {
    passengerDomainStageError(
      'passenger_domain_stage_target_drift',
      'Passenger Domain stage target does not match current runtime authority',
    );
  }
  const previousEvidence = binding.domains.find((entry) => entry.domainId === domain.id);
  if (!previousEvidence || previousEvidence.desiredRevision > domain.desiredRevision) {
    passengerDomainStageError(
      'passenger_domain_stage_revision_drift',
      'Passenger Domain stage revision moved behind runtime binding evidence',
    );
  }

  const domains = binding.domains.map((entry) => entry.domainId === domain.id ? {
    domainId: entry.domainId,
    desiredRevision: domain.desiredRevision,
    nginxChecksum: job.result.checksum,
  } : {
    domainId: entry.domainId,
    desiredRevision: entry.desiredRevision,
    nginxChecksum: entry.nginxChecksum,
  });

  return runtimeBindingRegistry.activate({
    applicationId: binding.applicationId,
    serverId: binding.serverId,
    adapter: 'passenger',
    state: binding.state,
    sourceOperationId: job.id,
    releaseId: binding.releaseId,
    websiteId: binding.websiteId,
    websiteRevision: binding.websiteRevision,
    domains,
    passengerTarget: binding.passengerTarget,
  }, { expectedRevision: binding.revision });
}

async function applyReconciliation({
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  applicationEnvironmentRegistry,
  websiteRegistry,
  runtimeBindingRegistry,
  mailDomainRegistry,
  job,
}) {
  if (job.resourceType === 'application') {
    if (job.operation === OPERATIONS.APP_NODE_PASSENGER_MIGRATE) {
      if (job.status !== 'failed') {
        await reconcileApplicationPassengerMigration({
          job,
          applicationRegistry,
          websiteRegistry,
          domainRegistry,
          certificateRegistry,
          runtimeBindingRegistry,
        });
      }
      return;
    }
    await reconcileApplicationJob(applicationRegistry, applicationEnvironmentRegistry, job);
    return;
  }

  if (job.resourceType === 'mail_domain') {
    await reconcileMailDomainJob(mailDomainRegistry, job);
    return;
  }

  if (job.resourceType === 'domain') {
    if (job.status === 'failed') {
      await domainRegistry.markFailed(job.resourceId, job.error?.code ?? 'agent_job_failed');
      return;
    }
    if (job.operation === OPERATIONS.DOMAIN_STAGE) {
      const domain = await domainRegistry.markStaged(job.resourceId, {
        checksum: job.result.checksum,
        configName: job.result.configName,
      });
      await reconcilePassengerDomainStageBinding({
        job,
        domain,
        applicationRegistry,
        websiteRegistry,
        runtimeBindingRegistry,
      });
      return;
    }
    if (job.operation === OPERATIONS.DOMAIN_ACTIVATE) await domainRegistry.markApplied(job.resourceId, { checksum: job.result.checksum });
    return;
  }

  if (job.resourceType === 'certificate') {
    if (job.status === 'failed') {
      await certificateRegistry.markFailed(job.resourceId, job.error?.code ?? 'certificate_operation_failed');
      return;
    }
    if (job.operation === OPERATIONS.SSL_ISSUE) {
      const certificate = await certificateRegistry.markActive(job.resourceId, job.result, { renewal: false });
      if (!certificate.staging) {
        await domainRegistry.attachCertificate(certificate.domainId, certificate.id, { domains: certificate.domains });
        await certificateRegistry.commitSelection(certificate.id);
      }
      return;
    }
    if (job.operation === OPERATIONS.SSL_RENEW) {
      if (job.result.dryRun === true) {
        await certificateRegistry.setState(job.resourceId, 'active');
        return;
      }
      await certificateRegistry.markActive(job.resourceId, job.result, { renewal: true });
    }
  }
}

/**
 * Apply a completed job to its desired-state registry without coupling that
 * state transition to the transport that executed the operation. Reconciliation
 * failures are recorded on the resource where possible, then raised as a safe
 * control-plane failure so HTTP/local callers cannot report false success.
 * Automatic durable reconciliation is acknowledged only after this transition
 * succeeds; failed reconciliation therefore remains visible in recovery state.
 */
export async function reconcileCompletedJob({
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  applicationEnvironmentRegistry = null,
  websiteRegistry = null,
  runtimeBindingRegistry = null,
  mailDomainRegistry = null,
  job,
}) {
  try {
    await applyReconciliation({
      domainRegistry,
      certificateRegistry,
      applicationRegistry,
      applicationEnvironmentRegistry,
      websiteRegistry,
      runtimeBindingRegistry,
      mailDomainRegistry,
      job,
    });
  } catch (error) {
    const code = safeReconciliationCode(error);
    try {
      if (job.resourceType === 'domain') {
        await domainRegistry.markFailed(job.resourceId, code);
      } else if (job.resourceType === 'certificate') {
        await certificateRegistry.markFailed(job.resourceId, code);
      } else if (job.resourceType === 'application') {
        const application = await applicationRegistry.getApplication(job.resourceId);
        if (application?.activeDeploymentId === job.id) await applicationRegistry.markFailed(job.resourceId, job.id, code);
      }
    } catch {
      // The job is already terminal. Preserve its sanitized result and retain the
      // durable recovery journal instead of replacing the original failure.
    }
    throw new JobReconciliationError(code);
  }

  await acknowledgeAutomaticJobReconciliation(job);
  return { reconciled: true, error: null };
}

export const jobReconciliationInternals = Object.freeze({
  safeReconciliationCode,
  reconcileMailDomainJob,
  reconcilePassengerDomainStageBinding,
});