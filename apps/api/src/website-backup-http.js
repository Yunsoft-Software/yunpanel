import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteBackupSetError } from './website-backup-set.js';
import { isWebsiteBackupError } from './website-backup-service.js';
import { WebsiteBackupBrowserError } from './website-backup-browser.js';
import {
  createWebsiteBackupOperationService,
  isWebsiteBackupOperationError,
  WebsiteBackupOperationServiceError,
} from './website-backup-operation-service.js';
import {
  createWebsiteBackupOperationRegistry,
  WebsiteBackupOperationRegistryError,
} from './website-backup-operation-registry.js';
import { WebsiteRestoreError } from './website-restore-service.js';

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
    || isWebsiteBackupError(error)
    || error instanceof WebsiteBackupBrowserError
    || isWebsiteBackupOperationError(error)
    || error instanceof WebsiteBackupOperationServiceError
    || error instanceof WebsiteBackupOperationRegistryError
    || error instanceof WebsiteRestoreError;
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
  websiteBackupBrowser = null,
  websiteBackupOperationService = null,
  websiteRestoreService = null,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new Error('Express application is required');
  }
  if (!websiteBackupSetProvider || typeof websiteBackupSetProvider.getWebsiteBackupSet !== 'function') {
    throw new Error('Website backup set provider is required');
  }

  if (websiteBackupBrowser) {
    app.get('/api/websites/:websiteId/backups', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const result = await websiteBackupBrowser.browse(request.params.websiteId);
      return response.json({ data: result });
    }));
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

  const resolvedOperationService = websiteBackupOperationService ?? (
    websiteBackupService
      ? createWebsiteBackupOperationService({
        registry: createWebsiteBackupOperationRegistry(),
        websiteBackupService,
        websiteRestoreService,
      })
      : null
  );

  if (resolvedOperationService) {
    app.post('/api/websites/:websiteId/backup-operations', requireOwner, asyncRoute(async (request, response) => {
      const {
        kind,
        repositoryId,
        snapshotId,
        expectedPreviewDigest,
        confirmation,
        tags,
        healthPath,
        timeoutSeconds,
      } = request.body ?? {};

      if (!kind || !['backup', 'restore'].includes(kind)) {
        throw new WebsiteBackupHttpError('invalid_operation_kind', "kind must be 'backup' or 'restore'", 400);
      }

      const actor = {
        sessionId: request.auth?.id,
        userId: request.auth?.user?.id,
        role: request.auth?.user?.role,
      };

      let operation;
      if (kind === 'backup') {
        operation = await resolvedOperationService.queueBackup({
          websiteId: request.params.websiteId,
          repositoryId,
          expectedPreviewDigest,
          confirmation,
          tags,
          actor,
        });
      } else {
        operation = await resolvedOperationService.queueRestore({
          websiteId: request.params.websiteId,
          repositoryId,
          snapshotId,
          expectedPreviewDigest,
          confirmation,
          healthPath,
          timeoutSeconds,
          actor,
        });
      }

      return response.status(202).json({ data: operation });
    }));

    app.post('/api/websites/:websiteId/backup/queue', requireOwner, asyncRoute(async (request, response) => {
      const {
        repositoryId,
        expectedPreviewDigest,
        confirmation,
        tags,
      } = request.body ?? {};

      const operation = await resolvedOperationService.queueBackup({
        websiteId: request.params.websiteId,
        repositoryId,
        expectedPreviewDigest,
        confirmation,
        tags,
        actor: {
          sessionId: request.auth?.id,
          userId: request.auth?.user?.id,
          role: request.auth?.user?.role,
        },
      });

      return response.status(202).json({ data: operation });
    }));

    app.post('/api/websites/:websiteId/restore/queue', requireOwner, asyncRoute(async (request, response) => {
      const {
        repositoryId,
        snapshotId,
        expectedPreviewDigest,
        confirmation,
        healthPath,
        timeoutSeconds,
      } = request.body ?? {};

      const operation = await resolvedOperationService.queueRestore({
        websiteId: request.params.websiteId,
        repositoryId,
        snapshotId,
        expectedPreviewDigest,
        confirmation,
        healthPath,
        timeoutSeconds,
        actor: {
          sessionId: request.auth?.id,
          userId: request.auth?.user?.id,
          role: request.auth?.user?.role,
        },
      });

      return response.status(202).json({ data: operation });
    }));

    app.get('/api/websites/:websiteId/backup-operations', requireOwner, asyncRoute(async (request, response) => {
      const operations = await resolvedOperationService.listOperations({
        websiteId: request.params.websiteId,
      });
      return response.json({ data: operations });
    }));

    app.get('/api/websites/:websiteId/backup-operations/:operationId', requireOwner, asyncRoute(async (request, response) => {
      const operation = await resolvedOperationService.getOperation(request.params.operationId);
      if (operation.websiteId !== request.params.websiteId.toLowerCase()) {
        throw new WebsiteBackupHttpError('website_backup_operation_not_found', 'Operation not found for this website', 404);
      }
      return response.json({ data: operation });
    }));
  }
}
