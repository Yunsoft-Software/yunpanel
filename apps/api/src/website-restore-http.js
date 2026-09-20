import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteRestoreError } from './website-restore-service.js';

export class WebsiteRestoreHttpError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'WebsiteRestoreHttpError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export function isWebsiteRestoreHttpError(error) {
  return error instanceof WebsiteRestoreHttpError || error instanceof WebsiteRestoreError;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      return next(error);
    }
  };
}

function requireOwner(request, response, next) {
  return requirePanelRouteAccess(request, response, () => {
    if (request.auth?.user?.role !== 'owner') {
      return response.status(403).json({
        error: { code: 'forbidden', message: 'Owner access is required.' },
      });
    }
    return next();
  });
}

export function mountWebsiteRestoreRoutes(app, {
  websiteRestoreService,
} = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!websiteRestoreService || typeof websiteRestoreService.previewRestore !== 'function'
    || typeof websiteRestoreService.executeRestore !== 'function') {
    throw new Error('Website restore service is required');
  }

  app.post('/api/websites/:websiteId/restore/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { repositoryId, snapshotId, healthPath, timeoutSeconds } = request.body ?? {};
    const preview = await websiteRestoreService.previewRestore({
      websiteId: request.params.websiteId,
      repositoryId,
      snapshotId,
      healthPath,
      timeoutSeconds,
    });
    return response.json({ data: preview });
  }));

  app.post('/api/websites/:websiteId/restore', requireOwner, asyncRoute(async (request, response) => {
    const {
      repositoryId,
      snapshotId,
      expectedPreviewDigest,
      confirmation,
      healthPath,
      timeoutSeconds,
    } = request.body ?? {};

    const result = await websiteRestoreService.executeRestore({
      websiteId: request.params.websiteId,
      repositoryId,
      snapshotId,
      expectedPreviewDigest,
      confirmation,
      healthPath,
      timeoutSeconds,
    });

    const statusCode = result.status === 'succeeded' ? 200 : 422;
    return response.status(statusCode).json({ data: result });
  }));
}
