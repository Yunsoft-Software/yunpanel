import { OPERATIONS } from '@yunpanel/protocol';
import { verifyWebsitePhpToolAction } from './website-php-tool-action.js';

export class WebsitePhpToolActionServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsitePhpToolActionServiceError';
    this.code = code;
    this.status = status;
  }
}

export function createWebsitePhpToolActionService({ websitePhpToolsService, jobRegistry } = {}) {
  if (!websitePhpToolsService || typeof websitePhpToolsService.getActionPreview !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function') {
    throw new WebsitePhpToolActionServiceError(
      'website_php_action_service_dependencies_invalid',
      'PHP tool action service dependencies are invalid',
      500,
    );
  }

  async function preview(websiteId, actionId) {
    return websitePhpToolsService.getActionPreview(websiteId, actionId);
  }

  async function queue(websiteId, input) {
    const current = await preview(websiteId, input?.actionId);
    const action = verifyWebsitePhpToolAction(current, input);
    const jobs = await jobRegistry.listJobs({
      serverId: current.serverId,
      resourceType: 'application',
      resourceId: current.applicationId,
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
      websiteId: current.websiteId,
      applicationId: current.applicationId,
      unixUser: current.unixUser,
      expectedWebsiteRevision: current.websiteRevision,
      actionId: current.actionId,
      previewDigest: current.previewDigest,
      confirmation: current.confirmation,
    });
    const job = await jobRegistry.enqueue({
      serverId: current.serverId,
      type: OPERATIONS.WEBSITE_PHP_ACTION,
      operation: OPERATIONS.WEBSITE_PHP_ACTION,
      payload,
      resourceType: 'application',
      resourceId: current.applicationId,
      idempotencyKey: `website.php.action:${current.applicationId}:${current.actionId}:${current.previewDigest}`,
    });
    return Object.freeze({
      action: Object.freeze({
        tool: action.tool,
        actionId: current.actionId,
        websiteId: current.websiteId,
        applicationId: current.applicationId,
        websiteRevision: current.websiteRevision,
      }),
      job,
    });
  }

  return Object.freeze({ preview, queue });
}
