import { OPERATIONS } from '@yunpanel/protocol';
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

async function applyReconciliation({
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  applicationEnvironmentRegistry,
  mailDomainRegistry,
  job,
}) {
  if (job.resourceType === 'application') {
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
      await domainRegistry.markStaged(job.resourceId, { checksum: job.result.checksum, configName: job.result.configName });
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
  mailDomainRegistry = null,
  job,
}) {
  try {
    await applyReconciliation({
      domainRegistry,
      certificateRegistry,
      applicationRegistry,
      applicationEnvironmentRegistry,
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
});
