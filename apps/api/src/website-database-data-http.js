import { createDatabaseDumpManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createDatabaseBackupOperationsService,
  DatabaseBackupOperationsError,
} from './database-backup-operations.js';
import { JobRegistryError } from './job-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const BACKUP_FIELDS = new Set(['expectedBindingRevision', 'confirmation']);
const RESTORE_PREVIEW_FIELDS = new Set(['backupId', 'expectedBindingRevision']);
const RESTORE_APPLY_FIELDS = new Set([
  'backupId', 'expectedBindingRevision', 'expectedPreviewDigest', 'expectedBackupSha256', 'confirmation',
]);

export class WebsiteDatabaseDataHttpError extends JobRegistryError {
  constructor(code, message, status = 400) {
    super(code, message, status);
    this.name = 'WebsiteDatabaseDataHttpError';
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new WebsiteDatabaseDataHttpError(
      'website_database_data_query_invalid',
      'Website database data operation does not accept query parameters',
    );
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((field) => !fields.has(field))) {
    throw new WebsiteDatabaseDataHttpError(
      code,
      `Request must contain exactly ${[...fields].join(', ')}`,
    );
  }
  if (!Number.isSafeInteger(body.expectedBindingRevision) || body.expectedBindingRevision < 1) {
    throw new WebsiteDatabaseDataHttpError(
      'website_database_binding_revision_invalid',
      'A positive expectedBindingRevision is required',
    );
  }
  return body;
}

function requireStrings(body, fields, code) {
  if (fields.some((field) => typeof body[field] !== 'string' || body[field].length < 1)) {
    throw new WebsiteDatabaseDataHttpError(code, 'Website database data request contains an invalid string field');
  }
  return body;
}

function validDatabaseName(value) {
  return typeof value === 'string'
    && DATABASE_NAME_PATTERN.test(value)
    && !RESERVED_DATABASES.has(value.toLowerCase());
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function resolveOperationsService(databaseBackupOperationsService, jobRegistry) {
  if (databaseBackupOperationsService !== null) {
    if (typeof databaseBackupOperationsService?.previewRestore !== 'function'
      || typeof databaseBackupOperationsService?.queueRestore !== 'function') {
      throw new Error('Website database backup operations service is invalid');
    }
    return databaseBackupOperationsService;
  }
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function') {
    throw new Error('Website database restore job registry is required');
  }
  return createDatabaseBackupOperationsService({
    backupManager: createDatabaseDumpManager(),
    jobRegistry,
  });
}

async function callOperation(service, method, input) {
  try {
    return await service[method](input);
  } catch (error) {
    if (error instanceof DatabaseBackupOperationsError) {
      throw new WebsiteDatabaseDataHttpError(error.code, error.message, error.status ?? 400);
    }
    throw error;
  }
}

export function mountWebsiteDatabaseDataRoutes(app, {
  registry,
  websiteRegistry,
  databaseBindingRegistry,
  jobRegistry,
  ensureDatabaseIdle,
  databaseBackupOperationsService = null,
} = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!registry || typeof registry.getServer !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !databaseBindingRegistry || typeof databaseBindingRegistry.getBinding !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function'
    || typeof ensureDatabaseIdle !== 'function') {
    throw new Error('Website database data route dependencies are invalid');
  }
  const operations = resolveOperationsService(databaseBackupOperationsService, jobRegistry);

  async function resolveScope({ serverId, websiteId, bindingId, expectedBindingRevision }) {
    const server = await registry.getServer(serverId);
    if (!server) {
      throw new WebsiteDatabaseDataHttpError('server_not_found', 'Server not found', 404);
    }
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || website.serverId !== server.id) {
      throw new WebsiteDatabaseDataHttpError('website_not_found', 'Website not found', 404);
    }

    let binding;
    try { binding = await databaseBindingRegistry.getBinding(bindingId); }
    catch {
      throw new WebsiteDatabaseDataHttpError(
        'website_database_binding_unavailable',
        'Website database binding could not be read',
        503,
      );
    }
    if (!binding) {
      throw new WebsiteDatabaseDataHttpError('database_binding_not_found', 'Database binding not found', 404);
    }
    if (!binding.id || typeof binding.id !== 'string' || binding.id !== bindingId
      || typeof binding.serverId !== 'string' || typeof binding.websiteId !== 'string'
      || !validDatabaseName(binding.databaseName)
      || !Number.isSafeInteger(binding.revision) || binding.revision < 1
      || typeof binding.unixUser !== 'string' || binding.unixUser.length < 1) {
      throw new WebsiteDatabaseDataHttpError(
        'website_database_binding_state_invalid',
        'Website database binding state is invalid',
        503,
      );
    }
    if (binding.serverId !== server.id || binding.websiteId !== website.id) {
      throw new WebsiteDatabaseDataHttpError('database_binding_not_found', 'Database binding not found', 404);
    }
    if (binding.applicationId !== website.applicationId) {
      throw new WebsiteDatabaseDataHttpError(
        'website_database_binding_ownership_drift',
        'Database binding ownership no longer matches the Website',
        409,
      );
    }
    if (binding.revision !== expectedBindingRevision) {
      throw new WebsiteDatabaseDataHttpError(
        'website_database_binding_revision_conflict',
        'Database binding changed before the data operation',
        409,
      );
    }

    return Object.freeze({
      serverId: server.id,
      websiteId: website.id,
      applicationId: website.applicationId,
      databaseBindingId: binding.id,
      bindingRevision: binding.revision,
      databaseName: binding.databaseName,
    });
  }

  function publicScope(scope) {
    return Object.freeze({
      serverId: scope.serverId,
      websiteId: scope.websiteId,
      applicationId: scope.applicationId,
      databaseBindingId: scope.databaseBindingId,
      bindingRevision: scope.bindingRevision,
      databaseName: scope.databaseName,
    });
  }

  const prefix = '/api/servers/:serverId/websites/:websiteId/database-bindings/:bindingId';

  app.post(`${prefix}/backup`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = requireStrings(
      exactBody(request.body, BACKUP_FIELDS, 'website_database_backup_input_invalid'),
      ['confirmation'],
      'website_database_backup_input_invalid',
    );
    const scope = await resolveScope({
      ...request.params,
      expectedBindingRevision: body.expectedBindingRevision,
    });
    const expectedConfirmation = `backup-website-database:${scope.databaseBindingId}:${scope.bindingRevision}`;
    if (body.confirmation !== expectedConfirmation) {
      throw new WebsiteDatabaseDataHttpError(
        'website_database_backup_confirmation_invalid',
        'Website database backup confirmation is invalid',
        409,
      );
    }
    await ensureDatabaseIdle(jobRegistry, scope.serverId);
    const job = await jobRegistry.enqueue({
      serverId: scope.serverId,
      type: OPERATIONS.DATABASE_BACKUP,
      operation: OPERATIONS.DATABASE_BACKUP,
      payload: {
        databaseName: scope.databaseName,
        websiteId: scope.websiteId,
        databaseBindingId: scope.databaseBindingId,
        expectedBindingRevision: scope.bindingRevision,
      },
      resourceType: 'database',
      resourceId: scope.databaseName,
    });
    return response.status(202).json({ data: { scope: publicScope(scope), job } });
  }));

  app.post(`${prefix}/restore-preview`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = requireStrings(
      exactBody(request.body, RESTORE_PREVIEW_FIELDS, 'website_database_restore_preview_input_invalid'),
      ['backupId'],
      'website_database_restore_preview_input_invalid',
    );
    const scope = await resolveScope({
      ...request.params,
      expectedBindingRevision: body.expectedBindingRevision,
    });
    const preview = await callOperation(operations, 'previewRestore', {
      serverId: scope.serverId,
      databaseName: scope.databaseName,
      backupId: body.backupId,
      ownership: {
        websiteId: scope.websiteId,
        databaseBindingId: scope.databaseBindingId,
        expectedBindingRevision: scope.bindingRevision,
      },
    });
    response.set('Cache-Control', 'no-store');
    return response.json({ data: { ...preview, scope: publicScope(scope) } });
  }));

  app.post(`${prefix}/restore`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = requireStrings(
      exactBody(request.body, RESTORE_APPLY_FIELDS, 'website_database_restore_input_invalid'),
      ['backupId', 'expectedPreviewDigest', 'expectedBackupSha256', 'confirmation'],
      'website_database_restore_input_invalid',
    );
    const scope = await resolveScope({
      ...request.params,
      expectedBindingRevision: body.expectedBindingRevision,
    });
    const queued = await callOperation(operations, 'queueRestore', {
      serverId: scope.serverId,
      databaseName: scope.databaseName,
      backupId: body.backupId,
      expectedPreviewDigest: body.expectedPreviewDigest,
      expectedBackupSha256: body.expectedBackupSha256,
      confirmation: body.confirmation,
      ownership: {
        websiteId: scope.websiteId,
        databaseBindingId: scope.databaseBindingId,
        expectedBindingRevision: scope.bindingRevision,
      },
    });
    return response.status(202).json({ data: { ...queued, scope: publicScope(scope) } });
  }));

  return Object.freeze({ resolveScope });
}

export const websiteDatabaseDataHttpInternals = Object.freeze({
  backupFields: Object.freeze([...BACKUP_FIELDS]),
  restorePreviewFields: Object.freeze([...RESTORE_PREVIEW_FIELDS]),
  restoreApplyFields: Object.freeze([...RESTORE_APPLY_FIELDS]),
  emptyQuery,
  exactBody,
  validDatabaseName,
  resolveOperationsService,
});
