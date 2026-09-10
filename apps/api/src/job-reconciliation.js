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

async function reconcileApplicationJob(applicationRegistry, job) {
  const application = await applicationRegistry.getApplication(job.resourceId);
  if (!application) return;

  if (job.status === 'failed') {
    if (application.activeDeploymentId !== job.id) return;
    await applicationRegistry.markFailed(job.resourceId, job.id, job.error?.code ?? 'application_operation_failed');
    return;
  }

  if (job.operation === OPERATIONS.APP_STATIC_DEPLOY || job.operation === OPERATIONS.APP_NODE_DEPLOY) {
    if (application.activeDeploymentId == null && application.currentReleaseId === job.result?.releaseId) return;
    await applicationRegistry.markDeployed(job.resourceId, {
      deploymentId: job.id,
      releaseId: job.result.releaseId,
      commitSha: job.result.commitSha,
      previousReleaseId: job.result.previousReleaseId,
      artifactFiles: job.result.artifactFiles ?? null,
      artifactBytes: job.result.artifactBytes ?? null,
      serviceName: job.result.serviceName ?? null,
      port: job.result.port ?? null,
      healthPath: job.result.healthPath ?? null,
      healthy: job.result.healthy ?? null,
    });
    return;
  }

  if (job.operation === OPERATIONS.APP_STATIC_ROLLBACK || job.operation === OPERATIONS.APP_NODE_ROLLBACK) {
    if (application.activeDeploymentId == null && application.currentReleaseId === job.result?.releaseId) return;
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
}

async function applyReconciliation({ domainRegistry, certificateRegistry, applicationRegistry, job }) {
  if (job.resourceType === 'application') {
    await reconcileApplicationJob(applicationRegistry, job);
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
      if (!certificate.staging) await domainRegistry.attachCertificate(certificate.domainId, certificate.id);
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
export async function reconcileCompletedJob({ domainRegistry, certificateRegistry, applicationRegistry, job }) {
  try {
    await applyReconciliation({ domainRegistry, certificateRegistry, applicationRegistry, job });
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

export const jobReconciliationInternals = Object.freeze({ safeReconciliationCode });
