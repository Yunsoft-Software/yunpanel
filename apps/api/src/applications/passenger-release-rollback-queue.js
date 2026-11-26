import { OPERATIONS } from '@yunpanel/protocol';
import { normalizePassengerNodeRollbackSpec } from '@yunpanel/shared';
import { capturePassengerReleaseSnapshot, passengerReleaseError } from './passenger-release-snapshot.js';

export function createPassengerReleaseRollbackQueue(dependencies) {
  const { applicationRegistry, jobRegistry } = dependencies;
  async function queueUnlocked({ application, releaseId }) {
    if (application.activeDeploymentId) throw passengerReleaseError('deployment_in_progress');
    const target = application.releases.find(r => r.releaseId === releaseId);
    if (!target || !target.runtime || !target.commitSha || target.releaseId === application.currentReleaseId) throw passengerReleaseError('rollback_release_unknown');
    const snapshot = await capturePassengerReleaseSnapshot({ ...dependencies, application });
    const payload = normalizePassengerNodeRollbackSpec({ ...snapshot.payload, releaseId, currentReleaseId: application.currentReleaseId,
      commitSha: target.commitSha, runtime: target.runtime, releaseConfigurationRevision: target.configurationRevision });
    const job = await jobRegistry.enqueue({ serverId: application.serverId, operation: OPERATIONS.APP_NODE_PASSENGER_ROLLBACK,
      type: OPERATIONS.APP_NODE_PASSENGER_ROLLBACK, payload, resourceType: 'application', resourceId: application.id });
    try { return { application: await applicationRegistry.markPassengerRollingBack(application.id, job.id, releaseId), job }; }
    catch (error) { await jobRegistry.cancel(job.id).catch(() => {}); throw error; }
  }
  return async input => {
    if (typeof dependencies.siteMutationLock?.withApplicationLock !== 'function') throw passengerReleaseError('passenger_release_lock_unavailable');
    return dependencies.siteMutationLock.withApplicationLock(input.application.id, async () => queueUnlocked({ ...input,
      application: await applicationRegistry.getApplication(input.application.id) }));
  };
}
