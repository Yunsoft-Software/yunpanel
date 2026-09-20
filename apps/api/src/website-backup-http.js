import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteBackupSetError } from './website-backup-set.js';

export class WebsiteBackupHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteBackupHttpError';
    this.code = code;
    this.status = status;
  }
}

export function isWebsiteBackupHttpError(error) {
  return error instanceof WebsiteBackupHttpError || error instanceof WebsiteBackupSetError;
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

export function mountWebsiteBackupRoutes(app, {
  websiteBackupSetProvider,
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
}
