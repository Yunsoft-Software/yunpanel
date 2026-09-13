import { BackupPlanError } from './backup-plan.js';
import { BackupResourceProviderError } from './backup-resource-provider.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const BODY_KEYS = new Set(['serverId', 'selectedResourceIdentities']);

export class BackupHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupHttpError';
    this.code = code;
    this.status = status;
  }
}

function previewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length < 1 || Object.keys(body).length > BODY_KEYS.size
    || Object.keys(body).some((key) => !BODY_KEYS.has(key))
    || typeof body.serverId !== 'string' || !UUID_PATTERN.test(body.serverId)) {
    throw new BackupHttpError(
      'backup_preview_input_invalid',
      'Backup preview requires serverId and optionally selectedResourceIdentities',
    );
  }
  if (Object.hasOwn(body, 'selectedResourceIdentities')
    && body.selectedResourceIdentities !== null
    && !Array.isArray(body.selectedResourceIdentities)) {
    throw new BackupHttpError(
      'backup_preview_input_invalid',
      'selectedResourceIdentities must be an array or null',
    );
  }
  return Object.freeze({
    serverId: body.serverId.toLowerCase(),
    selectedResourceIdentities: body.selectedResourceIdentities ?? null,
  });
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountBackupRoutes(app, {
  backupResourceProvider = null,
  backupResourceProviderForRequest = null,
} = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  const staticProviderValid = backupResourceProvider && typeof backupResourceProvider.preview === 'function';
  if (!staticProviderValid && typeof backupResourceProviderForRequest !== 'function') {
    throw new Error('Backup resource provider is required');
  }

  app.post('/api/backups/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const input = previewBody(request.body);
    const provider = staticProviderValid
      ? backupResourceProvider
      : await backupResourceProviderForRequest(request);
    if (!provider || typeof provider.preview !== 'function') {
      throw new BackupHttpError('backup_preview_unavailable', 'Backup preview provider is unavailable', 503);
    }
    const preview = await provider.preview(input);
    return response.json({ data: preview });
  }));
}

export function isBackupHttpError(error) {
  return error instanceof BackupHttpError
    || error instanceof BackupResourceProviderError
    || error instanceof BackupPlanError;
}

export const backupHttpInternals = Object.freeze({ previewBody });
