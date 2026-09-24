import { OPERATIONS } from '@yunpanel/protocol';
import { verifyWebsitePhpToolAction } from './website-php-tool-action.js';
import { jobPublicView } from './job-registry.js';

export class WebsitePhpToolActionServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsitePhpToolActionServiceError';
    this.code = code;
    this.status = status;
  }
}

export function createWebsitePhpToolActionService({
  websitePhpToolsService,
  jobRegistry,
  authorizeActor,
  withApplicationLock,
} = {}) {
  if (!websitePhpToolsService || typeof websitePhpToolsService.getActionPreview !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function'
    || typeof authorizeActor !== 'function' || typeof withApplicationLock !== 'function') {
    throw new WebsitePhpToolActionServiceError(
      'website_php_action_service_dependencies_invalid',
      'PHP tool action service dependencies are invalid',
      500,
    );
  }

  async function preview(websiteId, actionId) {
    return websitePhpToolsService.getActionPreview(websiteId, actionId);
  }

  async function queue(websiteId, input, actor) {
    const current = await preview(websiteId, input?.actionId);
    const action = verifyWebsitePhpToolAction(current, input);
    const firstActor = await authorizeActor(actor, current.websiteId);
    if (!firstActor || firstActor.sessionId !== actor?.sessionId || firstActor.userId !== actor?.userId
      || firstActor.role !== actor?.role) {
      throw new WebsitePhpToolActionServiceError(
        'website_php_action_actor_forbidden',
        'Live panel access changed before the action could be queued',
        403,
      );
    }

    return withApplicationLock(current.applicationId, async () => {
      const lockedCurrent = await preview(websiteId, input?.actionId);
      verifyWebsitePhpToolAction(lockedCurrent, input);
      const lockedActor = await authorizeActor(actor, lockedCurrent.websiteId);
      if (!lockedActor || lockedActor.sessionId !== firstActor.sessionId || lockedActor.userId !== firstActor.userId
        || lockedActor.role !== firstActor.role
        || lockedCurrent.applicationId !== current.applicationId || lockedCurrent.serverId !== current.serverId) {
        throw new WebsitePhpToolActionServiceError(
          'website_php_action_actor_forbidden',
          'Live panel access or Website binding changed before enqueue',
          403,
        );
      }

      const jobs = await jobRegistry.listJobs({
        serverId: lockedCurrent.serverId,
        resourceType: 'application',
        resourceId: lockedCurrent.applicationId,
      });
      if (!Array.isArray(jobs)) {
        throw new WebsitePhpToolActionServiceError(
          'website_php_action_jobs_unavailable',
          'Application jobs could not be verified',
          503,
        );
      }
      if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
        throw new WebsitePhpToolActionServiceError(
          'website_php_action_job_conflict',
          'Another Application operation is already queued or running',
          409,
        );
      }

      const payload = Object.freeze({
        websiteId: lockedCurrent.websiteId,
        applicationId: lockedCurrent.applicationId,
        unixUser: lockedCurrent.unixUser,
        expectedWebsiteRevision: lockedCurrent.websiteRevision,
        actorSessionId: lockedActor.sessionId,
        actorUserId: lockedActor.userId,
        actorRole: lockedActor.role,
        actionId: lockedCurrent.actionId,
        previewDigest: lockedCurrent.previewDigest,
        confirmation: lockedCurrent.confirmation,
      });
      const job = await jobRegistry.enqueue({
        serverId: lockedCurrent.serverId,
        type: OPERATIONS.WEBSITE_PHP_ACTION,
        operation: OPERATIONS.WEBSITE_PHP_ACTION,
        payload,
        resourceType: 'application',
        resourceId: lockedCurrent.applicationId,
        idempotencyKey: `website.php.action:${lockedCurrent.applicationId}:${lockedCurrent.actionId}:${lockedCurrent.previewDigest}:${lockedActor.sessionId}`,
      });
      return Object.freeze({
        action: Object.freeze({
          tool: action.tool,
          actionId: lockedCurrent.actionId,
          websiteId: lockedCurrent.websiteId,
          applicationId: lockedCurrent.applicationId,
          websiteRevision: lockedCurrent.websiteRevision,
        }),
        job: jobPublicView(job),
      });
    });
  }

  return Object.freeze({ preview, queue });
}
