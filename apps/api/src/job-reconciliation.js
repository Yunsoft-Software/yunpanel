import { OPERATIONS } from '@yunpanel/protocol';
import { reconcileApplicationPassengerMigration } from './application-passenger-migration-reconciliation.js';
import { acknowledgeAutomaticJobReconciliation } from './durable-job-registry.js';

const SAFE_ERROR_CODE = /^[a-z0-9_.-]{1,80}$/;

export const LIFECYCLE_STAGES = Object.freeze({
  SAVED: 'saved',
  APPLYING: 'applying',
  VERIFYING: 'verifying',
  OUTCOME: 'outcome',
});

export const LIFECYCLE_OUTCOMES = Object.freeze({
  SUCCEEDED: 'succeeded',
  PARTIAL: 'partial',
  FAILED: 'failed',
});

/**
 * Unified lifecycle state evaluator across components (mailbox, DNS, SSL, runtime, services).
 * A desired record alone must not generate active or healthy status until execution, application,
 * and live verification succeed. Unifies the save -> apply -> live verification -> outcome model.
 */
export function evaluateLifecycleState({
  resourceType,
  desired,
  applied = null,
  verified = null,
  sideEffects = null,
  error = null,
} = {}) {
  if (!desired) {
    throw new Error('desired state is required');
  }

  // 1. Error / Failure check
  if (error) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.OUTCOME,
      status: LIFECYCLE_OUTCOMES.FAILED,
      outcome: LIFECYCLE_OUTCOMES.FAILED,
      pendingApply: false,
      pendingVerification: false,
      active: false,
      healthy: false,
      partial: false,
      error: typeof error === 'object' ? error.message ?? String(error) : String(error),
      sideEffects: sideEffects ?? null,
    });
  }

  // 2. Saved (Pending Apply) check
  const isApplied = applied !== null && applied !== false && applied?.status !== 'pending' && applied?.status !== 'applying';
  const isApplying = applied?.status === 'applying';

  if (isApplying) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.APPLYING,
      status: 'applying',
      outcome: null,
      pendingApply: false,
      pendingVerification: false,
      active: false,
      healthy: false,
      partial: false,
      sideEffects: null,
    });
  }

  if (!isApplied) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.SAVED,
      status: 'pending_apply',
      outcome: null,
      pendingApply: true,
      pendingVerification: false,
      active: false,
      healthy: false,
      partial: false,
      sideEffects: null,
    });
  }

  // Check version/revision match if applicable
  if (desired.revision !== undefined && applied.revision !== undefined && applied.revision < desired.revision) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.SAVED,
      status: 'pending_apply',
      outcome: null,
      pendingApply: true,
      pendingVerification: false,
      active: false,
      healthy: false,
      partial: false,
      sideEffects: null,
    });
  }

  // Check DNS serial if applicable
  if (desired.serial !== undefined && applied.serial !== undefined && applied.serial < desired.serial) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.SAVED,
      status: 'pending_apply',
      outcome: null,
      pendingApply: true,
      pendingVerification: false,
      active: false,
      healthy: false,
      partial: false,
      sideEffects: null,
    });
  }

  // Check applied failure or unhealthy state
  if (applied?.status === 'failed' || applied?.failed === true) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.OUTCOME,
      status: LIFECYCLE_OUTCOMES.FAILED,
      outcome: LIFECYCLE_OUTCOMES.FAILED,
      pendingApply: false,
      pendingVerification: false,
      active: false,
      healthy: false,
      partial: false,
      error: applied.error ?? `${resourceType ?? 'Resource'} operation failed`,
      sideEffects: sideEffects ?? null,
    });
  }

  if (applied?.healthy === false) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.OUTCOME,
      status: LIFECYCLE_OUTCOMES.FAILED,
      outcome: LIFECYCLE_OUTCOMES.FAILED,
      pendingApply: false,
      pendingVerification: false,
      active: false,
      healthy: false,
      partial: false,
      error: resourceType === 'application'
        ? 'Application health check failed'
        : (resourceType === 'service' ? 'Service health check failed' : `${resourceType ?? 'Resource'} health check failed`),
      sideEffects: sideEffects ?? null,
    });
  }

  if (typeof verified === 'object' && verified !== null && verified.satisfied === false) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.OUTCOME,
      status: LIFECYCLE_OUTCOMES.FAILED,
      outcome: LIFECYCLE_OUTCOMES.FAILED,
      pendingApply: false,
      pendingVerification: false,
      active: false,
      healthy: false,
      partial: false,
      error: verified.reason ?? 'Live verification failed',
      sideEffects: sideEffects ?? null,
    });
  }

  // 3. Verifying check
  const isVerified = verified === true || (typeof verified === 'object' && verified !== null && verified.satisfied === true && verified.verified !== false);
  const isVerifying = verified === 'verifying' || (typeof verified === 'object' && verified?.status === 'verifying');

  if (isVerifying || verified === null || verified === false || (typeof verified === 'object' && verified !== null && verified.verified === false && !verified.partial)) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.VERIFYING,
      status: 'pending_verification',
      outcome: null,
      pendingApply: false,
      pendingVerification: true,
      active: false,
      healthy: false,
      partial: false,
      sideEffects: null,
    });
  }

  // 4. Outcome check
  const hasSideEffectFailure = Boolean(
    sideEffects && (
      sideEffects.status === 'partial' ||
      sideEffects.status === 'failed' ||
      sideEffects.mailIdentity?.status === 'partial' ||
      sideEffects.mailIdentity?.status === 'failed' ||
      sideEffects.reload?.status === 'partial' ||
      sideEffects.reload?.status === 'failed' ||
      sideEffects.failed === true
    )
  ) || (typeof verified === 'object' && verified !== null && verified.partial === true);

  if (hasSideEffectFailure) {
    return Object.freeze({
      resourceType: resourceType ?? 'unknown',
      stage: LIFECYCLE_STAGES.OUTCOME,
      status: LIFECYCLE_OUTCOMES.PARTIAL,
      outcome: LIFECYCLE_OUTCOMES.PARTIAL,
      pendingApply: false,
      pendingVerification: false,
      active: false,
      healthy: false,
      partial: true,
      sideEffects: sideEffects ?? (typeof verified === 'object' ? verified : null),
      error: sideEffects?.mailIdentity?.error ?? sideEffects?.reload?.error ?? sideEffects?.error ?? (typeof verified === 'object' ? verified.error : null),
    });
  }

  const active = resourceType === 'mailbox' ? desired.enabled === true : true;
  return Object.freeze({
    resourceType: resourceType ?? 'unknown',
    stage: LIFECYCLE_STAGES.OUTCOME,
    status: LIFECYCLE_OUTCOMES.SUCCEEDED,
    outcome: LIFECYCLE_OUTCOMES.SUCCEEDED,
    pendingApply: false,
    pendingVerification: false,
    active,
    healthy: true,
    partial: false,
    sideEffects: sideEffects ?? null,
  });
}

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

function staticDomainStageError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function markEnvironmentApplied(applicationEnvironmentRegistry, job, releaseId) {
  if (!applicationEnvironmentRegistry || typeof applicationEnvironmentRegistry.markApplied !== 'function') return;
  if (![
    OPERATIONS.APP_NODE_DEPLOY, OPERATIONS.APP_NODE_RESTART, OPERATIONS.APP_NODE_ROLLBACK,
    OPERATIONS.APP_PYTHON_DEPLOY, OPERATIONS.APP_PYTHON_RESTART, OPERATIONS.APP_PYTHON_ROLLBACK,
  ].includes(job.operation)) return;
  await applicationEnvironmentRegistry.markApplied({
    applicationId: job.resourceId,
    revision: job.result?.environmentRevision ?? 0,
    releaseId,
  });
}

async function reconcileApplicationJob(
  applicationRegistry,
  applicationEnvironmentRegistry,
  job,
  runtimeBindingRegistry = null,
) {
  const application = await applicationRegistry.getApplication(job.resourceId);
  if (!application) return;

  if (job.status === 'failed') {
    if (application.activeDeploymentId !== job.id) return;
    await applicationRegistry.markFailed(job.resourceId, job.id, job.error?.code ?? 'application_operation_failed');
    return;
  }

  if (job.operation === OPERATIONS.APP_STATIC_DEPLOY || job.operation === OPERATIONS.APP_NODE_DEPLOY || job.operation === OPERATIONS.APP_PYTHON_DEPLOY) {
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
    if (job.operation === OPERATIONS.APP_STATIC_DEPLOY && runtimeBindingRegistry
      && typeof runtimeBindingRegistry.getBinding === 'function'
      && typeof runtimeBindingRegistry.activate === 'function') {
      const binding = await runtimeBindingRegistry.getBinding(job.resourceId);
      if (binding && binding.adapter === 'static' && binding.releaseId !== job.result?.releaseId) {
        await runtimeBindingRegistry.activate({
          applicationId: binding.applicationId,
          serverId: binding.serverId,
          adapter: 'static',
          state: binding.state,
          sourceOperationId: job.id,
          releaseId: job.result.releaseId,
          websiteId: binding.websiteId,
          websiteRevision: binding.websiteRevision,
          domains: binding.domains,
          staticTarget: binding.staticTarget,
        }, { expectedRevision: binding.revision });
      }
    }
    await markEnvironmentApplied(applicationEnvironmentRegistry, job, job.result.releaseId);
    return;
  }

  if (job.operation === OPERATIONS.APP_STATIC_ROLLBACK || job.operation === OPERATIONS.APP_NODE_ROLLBACK || job.operation === OPERATIONS.APP_PYTHON_ROLLBACK) {
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
    if (job.operation === OPERATIONS.APP_STATIC_ROLLBACK && runtimeBindingRegistry
      && typeof runtimeBindingRegistry.getBinding === 'function'
      && typeof runtimeBindingRegistry.activate === 'function') {
      const binding = await runtimeBindingRegistry.getBinding(job.resourceId);
      if (binding && binding.adapter === 'static' && binding.releaseId !== job.result?.releaseId) {
        await runtimeBindingRegistry.activate({
          applicationId: binding.applicationId,
          serverId: binding.serverId,
          adapter: 'static',
          state: binding.state,
          sourceOperationId: job.id,
          releaseId: job.result.releaseId,
          websiteId: binding.websiteId,
          websiteRevision: binding.websiteRevision,
          domains: binding.domains,
          staticTarget: binding.staticTarget,
        }, { expectedRevision: binding.revision });
      }
    }
    await markEnvironmentApplied(applicationEnvironmentRegistry, job, job.result.releaseId);
    return;
  }

  if (job.operation === OPERATIONS.APP_NODE_RESTART || job.operation === OPERATIONS.APP_PYTHON_RESTART) {
    await markEnvironmentApplied(applicationEnvironmentRegistry, job, job.result.releaseId);
  }
}

async function reconcileMailDomainJob(mailDomainRegistry, job) {
  if (![OPERATIONS.MAIL_CONFIG_APPLY, OPERATIONS.MAIL_CONFIG_ROLLBACK].includes(job.operation)
    || job.status === 'failed') return;
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof mailDomainRegistry.transitionLocalStatus !== 'function') {
    const error = new Error('Mail-domain reconciliation registry is unavailable');
    error.code = 'mail_domain_reconciliation_unavailable';
    throw error;
  }
  if (job.operation === OPERATIONS.MAIL_CONFIG_ROLLBACK) {
    const expectedRevision = job.payload?.expectedCurrentRevision;
    const currentStatus = job.payload?.currentStatus;
    const targetStatus = job.result?.targetStatus;
    const statusChanged = ['disabled', 'enabled'].includes(currentStatus)
      && ['disabled', 'enabled'].includes(targetStatus)
      && currentStatus !== targetStatus;
    const resultingRevision = expectedRevision + (statusChanged ? 1 : 0);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1
      || job.payload?.previousRevision !== expectedRevision - (statusChanged ? 1 : 0)
      || job.payload?.targetStatus !== targetStatus
      || job.result?.mailDomainId !== job.resourceId || job.payload?.mailDomainId !== job.resourceId
      || job.result?.expectedCurrentRevision !== expectedRevision
      || job.result?.currentStatus !== currentStatus) {
      const error = new Error('Mail-domain rollback reconciliation identity is invalid');
      error.code = 'mail_domain_reconciliation_invalid';
      throw error;
    }
    const current = await mailDomainRegistry.getMailDomain(job.resourceId);
    if (!current || current.managementMode !== 'local') {
      const error = new Error('Mail-domain rollback reconciliation target is unavailable');
      error.code = 'mail_domain_reconciliation_target_unavailable';
      throw error;
    }
    if (current.status === targetStatus && current.revision === resultingRevision) return;
    if (!statusChanged || current.revision !== expectedRevision || current.status !== currentStatus) {
      const error = new Error('Mail-domain state changed before rollback reconciliation');
      error.code = 'mail_domain_reconciliation_conflict';
      throw error;
    }
    await mailDomainRegistry.transitionLocalStatus(job.resourceId, {
      expectedRevision,
      status: targetStatus,
    });
    return;
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
    sourceOperationId: binding.sourceOperationId,
    releaseId: binding.releaseId,
    websiteId: binding.websiteId,
    websiteRevision: binding.websiteRevision,
    domains,
    passengerTarget: binding.passengerTarget,
  }, { expectedRevision: binding.revision });
}

async function reconcileStaticDomainStageBinding({
  job,
  domain,
  applicationRegistry,
  websiteRegistry,
  runtimeBindingRegistry,
}) {
  if (job.payload?.targetType !== 'static') return null;
  if (!applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !runtimeBindingRegistry || typeof runtimeBindingRegistry.getBinding !== 'function'
    || typeof runtimeBindingRegistry.activate !== 'function') {
    return null;
  }
  if (!domain?.websiteId || domain.id !== job.resourceId || domain.serverId !== job.serverId) {
    return null;
  }

  const website = await websiteRegistry.getWebsite(domain.websiteId);
  if (!website || website.serverId !== domain.serverId || website.runtimeType !== 'static' || !website.applicationId) {
    return null;
  }
  const [application, binding] = await Promise.all([
    applicationRegistry.getApplication(website.applicationId),
    runtimeBindingRegistry.getBinding(website.applicationId),
  ]);
  if (!application || application.type !== 'static' || application.serverId !== domain.serverId) {
    staticDomainStageError('static_domain_stage_runtime_drift', 'Static Application changed before Domain stage reconciliation');
  }
  if (binding && binding.adapter !== 'static') return null;
  if (binding && (binding.serverId !== domain.serverId
    || binding.applicationId !== application.id || binding.websiteId !== website.id
    || binding.websiteRevision !== website.revision || binding.releaseId !== application.currentReleaseId)) {
    staticDomainStageError(
      'static_domain_stage_runtime_drift',
      'Static runtime authority changed before Domain stage reconciliation',
    );
  }

  if (job.payload.target?.root !== (binding?.staticTarget?.documentRoot ?? website.documentRoot)) {
    staticDomainStageError(
      'static_domain_stage_target_drift',
      'Static Domain stage target does not match current runtime authority',
    );
  }
  if (!binding) {
    if (!application.currentReleaseId) return null;
    return runtimeBindingRegistry.activate({
      applicationId: application.id,
      serverId: application.serverId,
      adapter: 'static',
      state: 'active',
      sourceOperationId: job.id,
      releaseId: application.currentReleaseId,
      websiteId: website.id,
      websiteRevision: website.revision,
      domains: [{
        domainId: domain.id,
        desiredRevision: domain.desiredRevision,
        nginxChecksum: job.result.checksum,
      }],
      staticTarget: {
        publishRoot: `/var/www/yunpanel/apps/${application.id}`,
        documentRoot: website.documentRoot,
        user: website.unixUser,
        group: website.unixUser,
      },
    }, { expectedRevision: 0 });
  }
  const previousEvidence = binding.domains.find((entry) => entry.domainId === domain.id);
  if (previousEvidence && previousEvidence.desiredRevision > domain.desiredRevision) {
    staticDomainStageError(
      'static_domain_stage_revision_drift',
      'Static Domain stage revision moved behind runtime binding evidence',
    );
  }

  const domains = binding.domains.some((entry) => entry.domainId === domain.id)
    ? binding.domains.map((entry) => entry.domainId === domain.id ? {
      domainId: entry.domainId,
      desiredRevision: domain.desiredRevision,
      nginxChecksum: job.result.checksum,
    } : {
      domainId: entry.domainId,
      desiredRevision: entry.desiredRevision,
      nginxChecksum: entry.nginxChecksum,
    })
    : [...binding.domains, {
      domainId: domain.id,
      desiredRevision: domain.desiredRevision,
      nginxChecksum: job.result.checksum,
    }];

  return runtimeBindingRegistry.activate({
    applicationId: binding.applicationId,
    serverId: binding.serverId,
    adapter: 'static',
    state: binding.state,
    sourceOperationId: binding.sourceOperationId,
    releaseId: binding.releaseId,
    websiteId: binding.websiteId,
    websiteRevision: binding.websiteRevision,
    domains,
    staticTarget: binding.staticTarget,
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
  mailServiceIdentityRegistry = null,
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
      return { reconciled: true, outcome: 'succeeded' };
    }
    await reconcileApplicationJob(applicationRegistry, applicationEnvironmentRegistry, job, runtimeBindingRegistry);
    return { reconciled: true, outcome: 'succeeded' };
  }

  if (job.resourceType === 'mail_domain') {
    await reconcileMailDomainJob(mailDomainRegistry, job);
    return { reconciled: true, outcome: 'succeeded' };
  }

  if (job.resourceType === 'domain') {
    if (job.status === 'failed') {
      await domainRegistry.markFailed(job.resourceId, job.error?.code ?? 'agent_job_failed');
      return { reconciled: true, outcome: 'failed' };
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
      await reconcileStaticDomainStageBinding({
        job,
        domain,
        applicationRegistry,
        websiteRegistry,
        runtimeBindingRegistry,
      });
      return { reconciled: true, outcome: 'succeeded' };
    }
    if (job.operation === OPERATIONS.DOMAIN_ACTIVATE) {
      await domainRegistry.markApplied(job.resourceId, { checksum: job.result.checksum });
    }
    return { reconciled: true, outcome: 'succeeded' };
  }

  if (job.resourceType === 'certificate') {
    if (job.status === 'failed') {
      if (job.payload?.dryRun === true) {
        await certificateRegistry.setState(job.resourceId, 'active');
        return { reconciled: true, outcome: 'succeeded' };
      }
      await certificateRegistry.markFailed(job.resourceId, job.error?.code ?? 'certificate_operation_failed');
      return { reconciled: true, outcome: 'failed' };
    }
    if (job.operation === OPERATIONS.SSL_ISSUE || job.operation === OPERATIONS.SSL_RENEW) {
      const isRenewal = job.operation === OPERATIONS.SSL_RENEW;
      if (isRenewal && job.result?.dryRun === true) {
        await certificateRegistry.setState(job.resourceId, 'active');
        return { reconciled: true, outcome: 'succeeded', dryRun: true };
      }
      const certificate = await certificateRegistry.markActive(job.resourceId, job.result, { renewal: isRenewal });
      if (!isRenewal && !certificate.staging && (certificate.purpose ?? 'web') === 'web') {
        await domainRegistry.attachCertificate(certificate.domainId, certificate.id, { domains: certificate.domains });
        await certificateRegistry.commitSelection(certificate.id);
      }

      let reloadOutcome = null;
      if (job.result?.reloadOutcome && typeof certificateRegistry.recordReloadOutcome === 'function') {
        await certificateRegistry.recordReloadOutcome(certificate.id, job.result.reloadOutcome);
        reloadOutcome = job.result.reloadOutcome;
      }

      // Handle post-SSL mail identity assignment side-effects without swallowing errors
      let mailIdentityOutcome = null;
      if (mailServiceIdentityRegistry) {
        try {
          if (typeof mailServiceIdentityRegistry.getForServer === 'function') {
            const binding = await mailServiceIdentityRegistry.getForServer(certificate.serverId);
            const coversHostname = binding && (
              binding.webDomainId === certificate.domainId
              || binding.hostname === certificate.certName
              || certificate.domains?.includes(binding.hostname)
            );
            if (binding && coversHostname && typeof mailServiceIdentityRegistry.bind === 'function') {
              await mailServiceIdentityRegistry.bind({
                serverId: binding.serverId,
                webDomainId: binding.webDomainId,
                expectedRevision: binding.revision,
              });
            }
          }
        } catch (mailIdentityError) {
          mailIdentityOutcome = {
            service: 'mail_identity',
            status: 'partial',
            stage: 'identity_assignment',
            error: mailIdentityError.message ?? 'Mail service identity assignment failed',
          };
          if (certificateRegistry && typeof certificateRegistry.recordReloadOutcome === 'function') {
            await certificateRegistry.recordReloadOutcome(certificate.id, mailIdentityOutcome);
          }
        }
      }

      if (mailIdentityOutcome || (reloadOutcome && reloadOutcome.status !== 'succeeded')) {
        return {
          reconciled: true,
          outcome: 'partial',
          status: 'partial',
          partial: true,
          sideEffects: {
            mailIdentity: mailIdentityOutcome,
            reload: reloadOutcome,
          },
        };
      }

      return { reconciled: true, outcome: 'succeeded', status: 'succeeded' };
    }
  }

  return { reconciled: true, outcome: 'succeeded' };
}

/**
 * Apply a completed job to its desired-state registry without coupling that
 * state transition to the transport that executed the operation. Reconciliation
 * failures are recorded on the resource where possible, then raised as a safe
 * control-plane failure so HTTP/local callers cannot report false success.
 * Automatic durable reconciliation is acknowledged only after this transition
 * succeeds; failed reconciliation therefore remains visible in recovery state.
 * Swallowed side effects such as post-SSL mail identity assignment failures are
 * surfaced as visible partial results rather than treating the operation as
 * completely successful.
 */
export async function reconcileCompletedJob({
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  applicationEnvironmentRegistry = null,
  websiteRegistry = null,
  runtimeBindingRegistry = null,
  mailDomainRegistry = null,
  mailServiceIdentityRegistry = null,
  job,
}) {
  let reconciliationResult = null;
  try {
    reconciliationResult = await applyReconciliation({
      domainRegistry,
      certificateRegistry,
      applicationRegistry,
      applicationEnvironmentRegistry,
      websiteRegistry,
      runtimeBindingRegistry,
      mailDomainRegistry,
      mailServiceIdentityRegistry,
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
  if (reconciliationResult?.outcome === 'partial') {
    return {
      reconciled: true,
      outcome: 'partial',
      status: 'partial',
      partial: true,
      sideEffects: reconciliationResult.sideEffects ?? null,
      error: null,
    };
  }
  return { reconciled: true, outcome: 'succeeded', status: 'succeeded', error: null };
}

export const jobReconciliationInternals = Object.freeze({
  safeReconciliationCode,
  reconcileMailDomainJob,
  reconcilePassengerDomainStageBinding,
  reconcileStaticDomainStageBinding,
  applyReconciliation,
  evaluateLifecycleState,
  LIFECYCLE_STAGES,
  LIFECYCLE_OUTCOMES,
});
