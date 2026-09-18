import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DELETE_APPLY_FIELDS = new Set([
  'expectedBindingRevision',
  'expectedPreviewDigest',
  'expectedBackupId',
  'expectedBackupSha256',
  'confirmation',
]);
const DELETE_FINALIZE_FIELDS = new Set([
  'expectedBindingRevision',
  'deleteJobId',
  'confirmation',
]);
const ACTIVE_DATABASE_OPERATIONS = new Set([
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.DATABASE_CREATE,
  OPERATIONS.DATABASE_DELETE,
  OPERATIONS.DATABASE_BACKUP,
  OPERATIONS.DATABASE_RESTORE,
  OPERATIONS.DATABASE_CREDENTIAL_APPLY,
  OPERATIONS.DATABASE_CREDENTIAL_DELETE,
]);

export class WebsiteDatabaseDeleteHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteDatabaseDeleteHttpError';
    this.code = code;
    this.status = status;
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new WebsiteDatabaseDeleteHttpError(
      'website_database_delete_query_invalid',
      'Website database delete operation does not accept query parameters',
    );
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((field) => !fields.has(field))) {
    throw new WebsiteDatabaseDeleteHttpError(
      code,
      `Request must contain exactly ${[...fields].join(', ')}`,
    );
  }
  if (!Number.isSafeInteger(body.expectedBindingRevision) || body.expectedBindingRevision < 1) {
    throw new WebsiteDatabaseDeleteHttpError(
      'website_database_binding_revision_invalid',
      'A positive expectedBindingRevision is required',
    );
  }
  return body;
}

function validDatabaseName(value) {
  return typeof value === 'string'
    && DATABASE_NAME_PATTERN.test(value)
    && !RESERVED_DATABASES.has(value.toLowerCase());
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function backupEvidence(job, scope) {
  const result = job?.result;
  const payload = job?.payload;
  if (!job || job.serverId !== scope.serverId
    || job.operation !== OPERATIONS.DATABASE_BACKUP || job.status !== 'succeeded'
    || job.resourceType !== 'database' || job.resourceId !== scope.databaseName
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.databaseName !== scope.databaseName
    || payload.websiteId !== scope.websiteId
    || payload.databaseBindingId !== scope.databaseBindingId
    || payload.expectedBindingRevision !== scope.bindingRevision
    || !result || typeof result !== 'object' || Array.isArray(result)
    || result.version !== 1 || result.backupId !== job.id
    || result.databaseName !== scope.databaseName
    || !['mariadb', 'mysql'].includes(result.engine)
    || typeof result.databaseVersion !== 'string' || result.databaseVersion.length < 1
    || result.databaseVersion.length > 120
    || !SHA256_PATTERN.test(result.dumpSha256 ?? '')
    || !Number.isSafeInteger(result.dumpBytes) || result.dumpBytes < 1
    || typeof result.createdAt !== 'string' || !Number.isFinite(Date.parse(result.createdAt))
    || result.backedUp !== true || result.sideEffects !== true) return null;
  return Object.freeze({
    backupId: job.id,
    engine: result.engine,
    databaseVersion: result.databaseVersion,
    dumpSha256: result.dumpSha256,
    dumpBytes: result.dumpBytes,
    createdAt: new Date(result.createdAt).toISOString(),
  });
}

export function mountWebsiteDatabaseDeleteRoutes(app, {
  registry,
  websiteRegistry,
  databaseBindingRegistry,
  databaseCredentialRegistry,
  jobRegistry,
  databaseInventoryProvider,
  ensureDatabaseIdle,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!registry || typeof registry.getServer !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !databaseBindingRegistry || typeof databaseBindingRegistry.getBinding !== 'function'
    || typeof databaseBindingRegistry.unbindDatabase !== 'function'
    || !databaseCredentialRegistry || typeof databaseCredentialRegistry.getForBinding !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function'
    || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.enqueue !== 'function'
    || typeof databaseInventoryProvider !== 'function'
    || typeof ensureDatabaseIdle !== 'function') {
    throw new Error('Website database delete route dependencies are invalid');
  }

  async function resolveScope({ serverId, websiteId, bindingId, expectedBindingRevision = null }) {
    const server = await registry.getServer(serverId);
    if (!server) throw new WebsiteDatabaseDeleteHttpError('server_not_found', 'Server not found', 404);
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || website.serverId !== server.id) {
      throw new WebsiteDatabaseDeleteHttpError('website_not_found', 'Website not found', 404);
    }

    let binding;
    try { binding = await databaseBindingRegistry.getBinding(bindingId); }
    catch {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_binding_unavailable',
        'Website database binding could not be read',
        503,
      );
    }
    if (!binding) throw new WebsiteDatabaseDeleteHttpError('database_binding_not_found', 'Database binding not found', 404);
    if (binding.id !== bindingId || binding.serverId !== server.id || binding.websiteId !== website.id
      || binding.applicationId !== website.applicationId || !validDatabaseName(binding.databaseName)
      || typeof binding.unixUser !== 'string' || binding.unixUser.length < 1
      || !Number.isSafeInteger(binding.revision) || binding.revision < 1) {
      if (binding.serverId !== server.id || binding.websiteId !== website.id) {
        throw new WebsiteDatabaseDeleteHttpError('database_binding_not_found', 'Database binding not found', 404);
      }
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_binding_state_invalid',
        'Website database binding state is invalid',
        503,
      );
    }
    if (expectedBindingRevision !== null && binding.revision !== expectedBindingRevision) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_binding_revision_conflict',
        'Database binding changed before deletion',
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
      unixUser: binding.unixUser,
    });
  }

  async function inspectPreview(scope) {
    let credential;
    let jobs;
    let inventory;
    try {
      [credential, jobs, inventory] = await Promise.all([
        databaseCredentialRegistry.getForBinding(scope.databaseBindingId),
        jobRegistry.listJobs({ serverId: scope.serverId }),
        databaseInventoryProvider(scope.serverId),
      ]);
    } catch {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_state_unavailable',
        'Website database delete state could not be inspected',
        503,
      );
    }
    if (!Array.isArray(jobs) || !inventory || typeof inventory !== 'object'
      || !Array.isArray(inventory.databases)) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_state_invalid',
        'Website database delete state is invalid',
        503,
      );
    }

    if (credential && (credential.databaseBindingId !== scope.databaseBindingId
      || credential.serverId !== scope.serverId || credential.websiteId !== scope.websiteId
      || credential.databaseName !== scope.databaseName
      || typeof credential.id !== 'string' || typeof credential.username !== 'string'
      || !Number.isSafeInteger(credential.revision) || credential.revision < 1)) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_credential_invalid',
        'Website database credential state is inconsistent',
        503,
      );
    }

    const exists = inventory.databases.some((database) => database?.name === scope.databaseName);
    const backups = jobs
      .map((job) => backupEvidence(job, scope))
      .filter(Boolean)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const backup = backups[0] ?? null;
    const activeJobs = jobs
      .filter((job) => ACTIVE_DATABASE_OPERATIONS.has(job?.operation)
        && ['queued', 'running'].includes(job?.status))
      .map((job) => Object.freeze({ id: job.id, operation: job.operation, status: job.status }))
      .sort((left, right) => left.id.localeCompare(right.id));

    const blockers = [];
    if (!exists) blockers.push('database_not_found');
    if (credential) blockers.push('database_credential_exists');
    if (!backup) blockers.push('database_current_binding_backup_required');
    if (activeJobs.length) blockers.push('database_job_active');
    const readyToDelete = blockers.length === 0;
    const identity = Object.freeze({
      version: 1,
      operation: 'website_database_delete',
      scope: Object.freeze({
        serverId: scope.serverId,
        websiteId: scope.websiteId,
        applicationId: scope.applicationId,
        databaseBindingId: scope.databaseBindingId,
        bindingRevision: scope.bindingRevision,
        databaseName: scope.databaseName,
      }),
      exists,
      credential: credential ? Object.freeze({
        id: credential.id,
        username: credential.username,
        revision: credential.revision,
      }) : null,
      backup,
      activeJobs: Object.freeze(activeJobs),
      blockers: Object.freeze(blockers),
      readyToDelete,
    });
    const previewDigest = digest(identity);
    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation: readyToDelete
        ? `delete-website-database:${scope.databaseBindingId}:${scope.bindingRevision}:${previewDigest}`
        : null,
      sideEffects: false,
    });
  }

  async function currentPreview(params, expectedBindingRevision = null) {
    const scope = await resolveScope({ ...params, expectedBindingRevision });
    return inspectPreview(scope);
  }

  const prefix = '/api/servers/:serverId/websites/:websiteId/database-bindings/:bindingId';

  app.get(`${prefix}/delete-preview`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    response.set('Cache-Control', 'no-store');
    return response.json({ data: await currentPreview(request.params) });
  }));

  app.post(`${prefix}/delete`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, DELETE_APPLY_FIELDS, 'website_database_delete_input_invalid');
    if (typeof body.expectedPreviewDigest !== 'string' || !SHA256_PATTERN.test(body.expectedPreviewDigest)
      || typeof body.expectedBackupId !== 'string' || !JOB_ID_PATTERN.test(body.expectedBackupId)
      || typeof body.expectedBackupSha256 !== 'string' || !SHA256_PATTERN.test(body.expectedBackupSha256)
      || typeof body.confirmation !== 'string') {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_input_invalid',
        'Website database delete request contains invalid evidence',
      );
    }
    const preview = await currentPreview(request.params, body.expectedBindingRevision);
    if (!preview.readyToDelete || !preview.backup) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_not_ready',
        'Website database deletion is blocked by current state',
        409,
      );
    }
    if (preview.previewDigest !== body.expectedPreviewDigest
      || preview.backup.backupId !== body.expectedBackupId
      || preview.backup.dumpSha256 !== body.expectedBackupSha256) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_preview_stale',
        'Website database delete preview is stale',
        409,
      );
    }
    if (body.confirmation !== preview.confirmation) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_confirmation_invalid',
        'Website database delete confirmation is invalid',
        409,
      );
    }
    await ensureDatabaseIdle(jobRegistry, preview.scope.serverId);
    const job = await jobRegistry.enqueue({
      serverId: preview.scope.serverId,
      type: OPERATIONS.DATABASE_DELETE,
      operation: OPERATIONS.DATABASE_DELETE,
      payload: {
        name: preview.scope.databaseName,
        websiteId: preview.scope.websiteId,
        databaseBindingId: preview.scope.databaseBindingId,
        expectedBindingRevision: preview.scope.bindingRevision,
        backupId: preview.backup.backupId,
        expectedBackupSha256: preview.backup.dumpSha256,
      },
      resourceType: 'database',
      resourceId: preview.scope.databaseName,
    });
    return response.status(202).json({ data: {
      previewDigest: preview.previewDigest,
      backupId: preview.backup.backupId,
      backupSha256: preview.backup.dumpSha256,
      scope: preview.scope,
      job,
    } });
  }));

  app.post(`${prefix}/delete-finalize`, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, DELETE_FINALIZE_FIELDS, 'website_database_delete_finalize_input_invalid');
    if (typeof body.deleteJobId !== 'string' || !JOB_ID_PATTERN.test(body.deleteJobId)
      || typeof body.confirmation !== 'string') {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_finalize_input_invalid',
        'Website database delete finalization request is invalid',
      );
    }

    const server = await registry.getServer(request.params.serverId);
    if (!server) throw new WebsiteDatabaseDeleteHttpError('server_not_found', 'Server not found', 404);
    const website = await websiteRegistry.getWebsite(request.params.websiteId);
    if (!website || website.serverId !== server.id) {
      throw new WebsiteDatabaseDeleteHttpError('website_not_found', 'Website not found', 404);
    }

    let binding;
    let credential;
    let job;
    let inventory;
    try {
      [binding, credential, job, inventory] = await Promise.all([
        databaseBindingRegistry.getBinding(request.params.bindingId),
        databaseCredentialRegistry.getForBinding(request.params.bindingId),
        jobRegistry.getJob(body.deleteJobId),
        databaseInventoryProvider(server.id),
      ]);
    } catch {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_finalize_state_unavailable',
        'Website database delete finalization state could not be read',
        503,
      );
    }

    const payload = job?.payload;
    const result = job?.result;
    if (!job || job.status !== 'succeeded' || job.operation !== OPERATIONS.DATABASE_DELETE
      || job.serverId !== server.id || job.resourceType !== 'database'
      || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || !validDatabaseName(payload.name)
      || job.resourceId !== payload.name
      || payload.websiteId !== website.id
      || payload.databaseBindingId !== request.params.bindingId
      || payload.expectedBindingRevision !== body.expectedBindingRevision
      || typeof payload.backupId !== 'string' || !JOB_ID_PATTERN.test(payload.backupId)
      || typeof payload.expectedBackupSha256 !== 'string' || !SHA256_PATTERN.test(payload.expectedBackupSha256)
      || !result || typeof result !== 'object' || Array.isArray(result)
      || result.deleted !== true || result.database?.name !== payload.name) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_job_evidence_missing',
        'A matching successful Website database delete job is required',
        409,
      );
    }

    if (binding && (binding.id !== request.params.bindingId || binding.serverId !== server.id
      || binding.websiteId !== website.id || binding.applicationId !== website.applicationId
      || binding.databaseName !== payload.name || binding.revision !== body.expectedBindingRevision)) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_binding_drift',
        'Database binding no longer matches the successful delete job',
        409,
      );
    }
    if (credential) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_credential_exists',
        'Database credential must remain deleted before finalization',
        409,
      );
    }
    if (!inventory || typeof inventory !== 'object' || !Array.isArray(inventory.databases)) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_finalize_state_invalid',
        'Database inventory is invalid',
        503,
      );
    }
    if (inventory.databases.some((database) => database?.name === payload.name)) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_schema_present',
        'Database schema is still present; binding cannot be finalized',
        409,
      );
    }

    const expectedConfirmation =
      `finalize-website-database-delete:${request.params.bindingId}:${body.expectedBindingRevision}:${job.id}`;
    if (body.confirmation !== expectedConfirmation) {
      throw new WebsiteDatabaseDeleteHttpError(
        'website_database_delete_finalize_confirmation_invalid',
        'Website database delete finalization confirmation is invalid',
        409,
      );
    }

    if (!binding) {
      return response.json({ data: {
        id: request.params.bindingId,
        databaseName: payload.name,
        unbound: true,
        alreadyFinalized: true,
        finalizedFromJobId: job.id,
        backupId: payload.backupId,
        backupSha256: payload.expectedBackupSha256,
      }, sideEffects: { databaseChanged: false } });
    }

    const unbound = await databaseBindingRegistry.unbindDatabase(request.params.bindingId, {
      expectedRevision: body.expectedBindingRevision,
      confirmation: `unbind-database:${request.params.bindingId}:${body.expectedBindingRevision}`,
    });
    return response.json({ data: {
      ...unbound,
      alreadyFinalized: false,
      finalizedFromJobId: job.id,
      backupId: payload.backupId,
      backupSha256: payload.expectedBackupSha256,
    }, sideEffects: { databaseChanged: false } });
  }));

  return Object.freeze({ resolveScope, inspectPreview });
}

export const websiteDatabaseDeleteHttpInternals = Object.freeze({
  deleteApplyFields: Object.freeze([...DELETE_APPLY_FIELDS]),
  deleteFinalizeFields: Object.freeze([...DELETE_FINALIZE_FIELDS]),
  activeDatabaseOperations: Object.freeze([...ACTIVE_DATABASE_OPERATIONS]),
  emptyQuery,
  exactBody,
  validDatabaseName,
  digest,
  backupEvidence,
});
