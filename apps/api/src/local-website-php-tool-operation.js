import { verifyWebsitePhpToolAction } from './website-php-tool-action.js';

const JOB_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class LocalWebsitePhpToolOperationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'LocalWebsitePhpToolOperationError';
    this.code = code;
    this.status = status;
  }
}

function executionContext(payload, execution) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || typeof execution.jobId !== 'string' || !JOB_ID.test(execution.jobId)
    || typeof execution.serverId !== 'string' || !UUID.test(execution.serverId)
    || execution.resourceType !== 'application'
    || execution.resourceId !== payload.applicationId) {
    throw new LocalWebsitePhpToolOperationError(
      'website_php_action_execution_invalid',
      'PHP tool execution context does not match the queued Application',
    );
  }
  return execution;
}

export function createLocalWebsitePhpToolOperation({ websitePhpToolsService } = {}) {
  if (!websitePhpToolsService
    || typeof websitePhpToolsService.getActionPreview !== 'function'
    || typeof websitePhpToolsService.runWpCli !== 'function'
    || typeof websitePhpToolsService.runComposer !== 'function') {
    throw new LocalWebsitePhpToolOperationError(
      'website_php_action_dependencies_invalid',
      'PHP tool local operation dependencies are invalid',
      503,
    );
  }

  async function execute(payload, execution) {
    const context = executionContext(payload, execution);
    const preview = await websitePhpToolsService.getActionPreview(payload.websiteId, payload.actionId);
    if (preview.serverId !== context.serverId
      || preview.applicationId !== payload.applicationId
      || preview.unixUser !== payload.unixUser
      || preview.websiteRevision !== payload.expectedWebsiteRevision
      || preview.previewDigest !== payload.previewDigest
      || preview.confirmation !== payload.confirmation) {
      throw new LocalWebsitePhpToolOperationError(
        'website_php_action_stale',
        'PHP tool action changed after it was queued',
      );
    }

    const action = verifyWebsitePhpToolAction(preview, {
      actionId: payload.actionId,
      expectedWebsiteRevision: payload.expectedWebsiteRevision,
      previewDigest: payload.previewDigest,
      confirmation: payload.confirmation,
    });
    const result = action.tool === 'wp-cli'
      ? await websitePhpToolsService.runWpCli(payload.websiteId, action)
      : await websitePhpToolsService.runComposer(payload.websiteId, action);
    if (!result || result.success !== true || result.exitCode !== 0) {
      throw new LocalWebsitePhpToolOperationError(
        'website_php_action_failed',
        'PHP tool action did not complete successfully',
        502,
      );
    }
    return Object.freeze({
      version: 1,
      websiteId: payload.websiteId,
      applicationId: payload.applicationId,
      unixUser: payload.unixUser,
      actionId: payload.actionId,
      websiteRevision: payload.expectedWebsiteRevision,
      previewDigest: payload.previewDigest,
      completed: true,
      sideEffects: true,
    });
  }

  return Object.freeze({ execute });
}

export const localWebsitePhpToolOperationInternals = Object.freeze({ executionContext });
