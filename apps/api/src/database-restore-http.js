import { DatabaseBackupOperationsError } from './database-backup-operations.js';
import { DatabaseHttpError, databaseHttpInternals } from './database-http.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { RegistryError } from './server-registry.js';

function restorePreviewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof body.backupId !== 'string') {
    throw new DatabaseHttpError('database_restore_preview_input_invalid', 'Request must contain exactly backupId');
  }
  return Object.freeze({ backupId: body.backupId });
}

function restoreApplyBody(body) {
  const fields = ['backupId', 'expectedPreviewDigest', 'expectedBackupSha256', 'confirmation'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.length
    || fields.some((field) => typeof body[field] !== 'string')) {
    throw new DatabaseHttpError(
      'database_restore_input_invalid',
      'Request must contain exactly backupId, expectedPreviewDigest, expectedBackupSha256 and confirmation',
    );
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, body[field]])));
}

async function requireServer(registry, serverId) {
  const server = await registry.getServer(serverId);
  if (!server) throw new RegistryError('server_not_found', 'Server not found', 404);
  return server;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

async function callOperation(service, method, input) {
  try {
    return await service[method](input);
  } catch (error) {
    if (error instanceof DatabaseBackupOperationsError) {
      throw new DatabaseHttpError(error.code, error.message, error.status ?? 400);
    }
    throw error;
  }
}

export function mountDatabaseRestoreRoutes(app, { registry, databaseBackupOperationsService }) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!registry || typeof registry.getServer !== 'function') throw new Error('Server registry is required');
  if (!databaseBackupOperationsService
    || typeof databaseBackupOperationsService.previewRestore !== 'function'
    || typeof databaseBackupOperationsService.queueRestore !== 'function') {
    throw new Error('Database backup operations service is required');
  }

  app.post('/api/servers/:serverId/databases/:name/restore-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    const databaseName = databaseHttpInternals.requireDatabaseName(request.params.name);
    const body = restorePreviewBody(request.body);
    const preview = await callOperation(databaseBackupOperationsService, 'previewRestore', {
      serverId: server.id,
      databaseName,
      backupId: body.backupId,
    });
    return response.json({ data: preview });
  }));

  app.post('/api/servers/:serverId/databases/:name/restore', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    const databaseName = databaseHttpInternals.requireDatabaseName(request.params.name);
    const body = restoreApplyBody(request.body);
    const queued = await callOperation(databaseBackupOperationsService, 'queueRestore', {
      serverId: server.id,
      databaseName,
      ...body,
    });
    return response.status(202).json({ data: queued });
  }));
}

export const databaseRestoreHttpInternals = Object.freeze({
  restorePreviewBody,
  restoreApplyBody,
});
