import { createDatabaseDumpManager } from '@yunpanel/host-runtime';
import {
  createDatabaseBackupOperationsService,
  DatabaseBackupOperationsError,
} from './database-backup-operations.js';
import { JobRegistryError } from './job-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { RegistryError } from './server-registry.js';

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export class DatabaseRestoreHttpError extends JobRegistryError {
  constructor(code, message, status = 400) {
    super(code, message, status);
    this.name = 'DatabaseRestoreHttpError';
  }
}

function requireDatabaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value) || RESERVED_DATABASES.has(value.toLowerCase())) {
    throw new DatabaseRestoreHttpError('invalid_database_name', 'Database name is invalid');
  }
  return value;
}

function restorePreviewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof body.backupId !== 'string') {
    throw new DatabaseRestoreHttpError('database_restore_preview_input_invalid', 'Request must contain exactly backupId');
  }
  return Object.freeze({ backupId: body.backupId });
}

function restoreApplyBody(body) {
  const fields = ['backupId', 'expectedPreviewDigest', 'expectedBackupSha256', 'confirmation'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.length
    || fields.some((field) => typeof body[field] !== 'string')) {
    throw new DatabaseRestoreHttpError(
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
      throw new DatabaseRestoreHttpError(error.code, error.message, error.status ?? 400);
    }
    throw error;
  }
}

function resolveOperationsService(databaseBackupOperationsService, jobRegistry) {
  if (databaseBackupOperationsService !== null) {
    if (typeof databaseBackupOperationsService?.previewRestore !== 'function'
      || typeof databaseBackupOperationsService?.queueRestore !== 'function') {
      throw new Error('Database backup operations service is invalid');
    }
    return databaseBackupOperationsService;
  }
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function') {
    throw new Error('Database restore job registry is required');
  }
  return createDatabaseBackupOperationsService({
    backupManager: createDatabaseDumpManager(),
    jobRegistry,
  });
}

export function mountDatabaseRestoreRoutes(app, {
  registry,
  jobRegistry = null,
  databaseBackupOperationsService = null,
}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!registry || typeof registry.getServer !== 'function') throw new Error('Server registry is required');
  const operations = resolveOperationsService(databaseBackupOperationsService, jobRegistry);

  app.post('/api/servers/:serverId/databases/:name/restore-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    const databaseName = requireDatabaseName(request.params.name);
    const body = restorePreviewBody(request.body);
    const preview = await callOperation(operations, 'previewRestore', {
      serverId: server.id,
      databaseName,
      backupId: body.backupId,
    });
    return response.json({ data: preview });
  }));

  app.post('/api/servers/:serverId/databases/:name/restore', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    const databaseName = requireDatabaseName(request.params.name);
    const body = restoreApplyBody(request.body);
    const queued = await callOperation(operations, 'queueRestore', {
      serverId: server.id,
      databaseName,
      ...body,
    });
    return response.status(202).json({ data: queued });
  }));
}

export const databaseRestoreHttpInternals = Object.freeze({
  requireDatabaseName,
  restorePreviewBody,
  restoreApplyBody,
  resolveOperationsService,
});
