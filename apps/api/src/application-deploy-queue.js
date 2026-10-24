import { OPERATIONS } from '@yunpanel/protocol';
import { ApplicationValidationError, normalizeGitDeploymentTarget } from '@yunpanel/shared';
import { capturePassengerReleaseSnapshot } from './passenger-release-snapshot.js';
import { ApplicationRegistryError } from './application-registry.js';
import { isNewlyEnqueuedJob, JobRegistryError } from './job-registry.js';

export function createApplicationDeployQueue({
  applicationRegistry,
  applicationEnvironmentRegistry,
  jobRegistry,
  websiteRegistry = null, domainRegistry = null, runtimeBindingRegistry = null, localServerId = null, siteMutationLock = null,
} = {}) {
  if (!applicationRegistry || !applicationEnvironmentRegistry || !jobRegistry) {
    throw new TypeError('Application deploy queue dependencies are required');
  }

  async function queueApplicationDeployUnlocked({ applicationId, gitTarget = null, idempotencyKey = null } = {}) {
    let application = await applicationRegistry.getApplication(applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);

    let normalizedTarget;
    try { normalizedTarget = normalizeGitDeploymentTarget(gitTarget, { defaultBranch: application.branch }); }
    catch (error) {
      if (error instanceof ApplicationValidationError) throw new ApplicationRegistryError(error.code, error.message);
      throw error;
    }

    if (application.runtimeAdapter === 'passenger' && idempotencyKey !== null) {
      const existing = await jobRegistry.getJobForIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.serverId !== application.serverId || existing.resourceId !== application.id || existing.operation !== OPERATIONS.APP_NODE_PASSENGER_DEPLOY
          || JSON.stringify(existing.payload?.gitTarget) !== JSON.stringify(normalizedTarget)) throw new JobRegistryError('job_idempotency_conflict', 'Job key already belongs to different work', 409);
        if (['queued','running'].includes(existing.status) && application.activeDeploymentId !== existing.id) throw new ApplicationRegistryError('deployment_state_conflict', 'Application active operation does not match replayed work', 409);
        return { application, job: existing, replayed: true };
      }
    }

    if (idempotencyKey === null) {
      const jobs = await jobRegistry.listJobs({ resourceType: 'application', resourceId: application.id });
      if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
        throw new JobRegistryError('application_job_conflict', 'An application operation is already queued or running', 409);
      }
      if (application.activeDeploymentId) {
        throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);
      }
    }

    let operation;
    let type;
    let payload;
    if (application.type === 'static') {
      operation = OPERATIONS.APP_STATIC_DEPLOY;
      type = 'app.static.deploy';
      payload = {
        applicationId: application.id,
        repositoryUrl: application.repositoryUrl,
        branch: application.branch,
        gitTarget: normalizedTarget,
        build: application.build,
        retention: application.retention,
      };
    } else if (application.type === 'node') {
      const environment = await applicationEnvironmentRegistry.environmentStatus(application.id);
      operation = application.runtimeAdapter === 'passenger' ? OPERATIONS.APP_NODE_PASSENGER_DEPLOY : OPERATIONS.APP_NODE_DEPLOY;
      type = operation;
      payload = {
        applicationId: application.id,
        repositoryUrl: application.repositoryUrl,
        branch: application.branch,
        gitTarget: normalizedTarget,
        runtime: application.runtime,
        retention: application.retention,
        environmentRevision: environment.savedRevision,
      };
      if (application.runtimeAdapter === 'passenger') {
        const snapshot = await capturePassengerReleaseSnapshot({ application, websiteRegistry, domainRegistry, runtimeBindingRegistry,
          applicationRegistry, applicationEnvironmentRegistry, localServerId });
        payload = { ...payload, ...snapshot.payload, previousReleaseId: application.currentReleaseId };
      }
    } else if (application.type === 'python') {
      const environment = await applicationEnvironmentRegistry.environmentStatus(application.id);
      operation = OPERATIONS.APP_PYTHON_DEPLOY;
      type = 'app.python.deploy';
      payload = {
        applicationId: application.id,
        repositoryUrl: application.repositoryUrl,
        branch: application.branch,
        gitTarget: normalizedTarget,
        runtime: application.runtime,
        retention: application.retention,
        environmentRevision: environment.savedRevision,
      };
    } else {
      throw new ApplicationRegistryError('unsupported_application_type', 'Application type is not deployable', 409);
    }

    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type,
      operation,
      payload,
      resourceType: 'application',
      resourceId: application.id,
      idempotencyKey,
    });
    const created = isNewlyEnqueuedJob(job) !== false;
    if (!created) {
      application = await applicationRegistry.getApplication(application.id);
      if (['queued', 'running'].includes(job.status)) {
        if (application.activeDeploymentId && application.activeDeploymentId !== job.id) {
          throw new ApplicationRegistryError('deployment_state_conflict', 'Application deployment state conflicts with the idempotent job', 409);
        }
        if (!application.activeDeploymentId) application = await applicationRegistry[application.runtimeAdapter === 'passenger' ? 'markPassengerDeploying' : 'markDeploying'](application.id, job.id);
      }
      return { application, job, replayed: true };
    }

    try {
      application = await applicationRegistry[application.runtimeAdapter === 'passenger' ? 'markPassengerDeploying' : 'markDeploying'](application.id, job.id);
      return { application, job, replayed: false };
    } catch (error) {
      await jobRegistry.cancel(job.id).catch(() => {});
      throw error;
    }
  }
  return async function queueApplicationDeploy(input = {}) {
    const application = await applicationRegistry.getApplication(input.applicationId);
    if (application?.runtimeAdapter !== 'passenger') return queueApplicationDeployUnlocked(input);
    if (typeof siteMutationLock?.withApplicationLock !== 'function') throw new ApplicationRegistryError('passenger_release_lock_unavailable', 'Passenger deploy lock is unavailable', 503);
    return siteMutationLock.withApplicationLock(application.id, () => queueApplicationDeployUnlocked(input));
  };
}
