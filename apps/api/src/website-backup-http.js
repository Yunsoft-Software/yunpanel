import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteBackupSetError } from './website-backup-set.js';
import { isWebsiteBackupError } from './website-backup-service.js';

export class WebsiteBackupHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteBackupHttpError';
    this.code = code;
    this.status = status;
  }
}

export function isWebsiteBackupHttpError(error) {
  return error instanceof WebsiteBackupHttpError
    || error instanceof WebsiteBackupSetError
    || isWebsiteBackupError(error);
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

export function mountWebsiteBackupRoutes(app, {
  websiteBackupSetProvider,
  websiteBackupService = null,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new Error('Express application is required');
  }
  if (!websiteBackupSetProvider || typeof websiteBackupSetProvider.getWebsiteBackupSet !== 'function') {
    throw new Error('Website backup set provider is required');
  }

  app.get('/api/websites/:websiteId/backup-set', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const backupSet = await websiteBackupSetProvider.getWebsiteBackupSet({
      websiteId: request.params.websiteId,
      serverId: localServerId,
    });
    return response.json({ data: backupSet });
  }));

  if (websiteBackupService) {
    app.post('/api/websites/:websiteId/backup/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const { repositoryId } = request.body ?? {};
      const preview = await websiteBackupService.previewBackup({
        websiteId: request.params.websiteId,
        repositoryId,
      });
      return response.json({ data: preview });
    }));

    app.post('/api/websites/:websiteId/backup', requireOwner, asyncRoute(async (request, response) => {
      const {
        repositoryId,
        expectedPreviewDigest,
        confirmation,
        tags,
      } = request.body ?? {};

      const result = await websiteBackupService.executeBackup({
        websiteId: request.params.websiteId,
        repositoryId,
        expectedPreviewDigest,
        confirmation,
        tags,
      });

      return response.status(201).json({ data: result });
    }));
  }
}

