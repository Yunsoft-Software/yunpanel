import { databaseCredentialRegistryInternals } from './database-credential-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const CREATE_FIELDS = new Set(['privileges', 'confirmation']);
const REVISION_FIELDS = new Set(['expectedRevision', 'confirmation']);
const GRANT_FIELDS = new Set(['expectedRevision', 'privileges', 'confirmation']);
const APPLY_FIELDS = new Set([
  'expectedCredentialRevision', 'expectedBindingRevision', 'expectedDesiredStateSha256', 'confirmation',
]);
const FINALIZE_FIELDS = new Set(['expectedRevision', 'deleteJobId', 'confirmation']);

export class DatabaseCredentialHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DatabaseCredentialHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new DatabaseCredentialHttpError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new DatabaseCredentialHttpError('database_credential_query_invalid', 'Database credential operation does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountDatabaseCredentialRoutes(app, {
  registry,
  databaseBindingRegistry,
  databaseCredentialRegistry,
  databaseCredentialApplyService,
  jobRegistry,
  ensureDatabaseIdle,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || typeof app.patch !== 'function' || typeof app.delete !== 'function') {
    throw new Error('Express application is required');
  }
  if (!registry || typeof registry.getServer !== 'function'
    || !databaseBindingRegistry || typeof databaseBindingRegistry.getBinding !== 'function'
    || !databaseCredentialRegistry || typeof databaseCredentialRegistry.createCredential !== 'function'
    || typeof databaseCredentialRegistry.getCredential !== 'function'
    || typeof databaseCredentialRegistry.getForBinding !== 'function'
    || typeof databaseCredentialRegistry.setPrivileges !== 'function'
    || typeof databaseCredentialRegistry.rotatePassword !== 'function'
    || typeof databaseCredentialRegistry.deleteCredential !== 'function'
    || !databaseCredentialApplyService || typeof databaseCredentialApplyService.previewApply !== 'function'
    || typeof databaseCredentialApplyService.queueApply !== 'function'
    || typeof databaseCredentialApplyService.previewDelete !== 'function'
    || typeof databaseCredentialApplyService.queueDelete !== 'function'
    || !jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof ensureDatabaseIdle !== 'function') {
    throw new Error('Database credential route dependencies are invalid');
  }

  async function server(serverId) {
    const current = await registry.getServer(serverId);
    if (!current) throw new DatabaseCredentialHttpError('server_not_found', 'Server not found', 404);
    return current;
  }

  async function binding(serverId, bindingId) {
    const current = await server(serverId);
    const value = await databaseBindingRegistry.getBinding(bindingId);
    if (!value || value.serverId !== current.id) {
      throw new DatabaseCredentialHttpError('database_binding_not_found', 'Database binding not found', 404);
    }
    return Object.freeze({ server: current, binding: value });
  }

  async function credential(serverId, credentialId) {
    const current = await server(serverId);
    const value = await databaseCredentialRegistry.getCredential(credentialId);
    if (!value || value.serverId !== current.id) {
      throw new DatabaseCredentialHttpError('database_credential_not_found', 'Database credential not found', 404);
    }
    const currentBinding = await databaseBindingRegistry.getBinding(value.databaseBindingId);
    if (!currentBinding || currentBinding.serverId !== current.id) {
      throw new DatabaseCredentialHttpError('database_credential_binding_drift', 'Database credential binding is unavailable', 409);
    }
    return Object.freeze({ server: current, credential: value, binding: currentBinding });
  }

  app.get('/api/servers/:serverId/database-bindings/:bindingId/credential-create-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const state = await binding(request.params.serverId, request.params.bindingId);
    await ensureDatabaseIdle(jobRegistry, state.server.id);
    if (await databaseCredentialRegistry.getForBinding(state.binding.id)) {
      throw new DatabaseCredentialHttpError('database_credential_exists', 'Database binding already has a credential', 409);
    }
    const username = databaseCredentialRegistryInternals.usernameFor(state.binding.id);
    return response.json({ data: {
      databaseBindingId: state.binding.id,
      databaseName: state.binding.databaseName,
      username,
      host: 'localhost',
      defaultPrivileges: [...databaseCredentialRegistryInternals.defaultPrivileges],
      confirmation: `create-database-credential:${state.binding.id}:${username}`,
      sideEffects: false,
    } });
  }));

  app.get('/api/servers/:serverId/database-bindings/:bindingId/credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const state = await binding(request.params.serverId, request.params.bindingId);
    return response.json({ data: await databaseCredentialRegistry.getForBinding(state.binding.id) });
  }));

  app.post('/api/servers/:serverId/database-bindings/:bindingId/credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const state = await binding(request.params.serverId, request.params.bindingId);
    const body = exactBody(request.body, CREATE_FIELDS, 'database_credential_create_input_invalid');
    await ensureDatabaseIdle(jobRegistry, state.server.id);
    const created = await databaseCredentialRegistry.createCredential({
      databaseBindingId: state.binding.id,
      privileges: body.privileges,
      confirmation: body.confirmation,
    });
    return response.status(201).json({
      data: created,
      sideEffects: { databaseChanged: false, requiresApply: true },
    });
  }));

  app.patch('/api/servers/:serverId/database-credentials/:credentialId/grants', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const state = await credential(request.params.serverId, request.params.credentialId);
    const body = exactBody(request.body, GRANT_FIELDS, 'database_credential_grants_input_invalid');
    await ensureDatabaseIdle(jobRegistry, state.server.id);
    const updated = await databaseCredentialRegistry.setPrivileges(state.credential.id, body);
    return response.json({
      data: updated,
      sideEffects: { databaseChanged: false, requiresApply: true },
    });
  }));

  app.post('/api/servers/:serverId/database-credentials/:credentialId/password/rotate', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const state = await credential(request.params.serverId, request.params.credentialId);
    const body = exactBody(request.body, REVISION_FIELDS, 'database_credential_rotate_input_invalid');
    await ensureDatabaseIdle(jobRegistry, state.server.id);
    const updated = await databaseCredentialRegistry.rotatePassword(state.credential.id, body);
    return response.json({
      data: updated,
      sideEffects: { databaseChanged: false, requiresApply: true },
    });
  }));

  app.get('/api/servers/:serverId/database-credentials/:credentialId/apply-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    await credential(request.params.serverId, request.params.credentialId);
    return response.json({ data: await databaseCredentialApplyService.previewApply(request.params.credentialId) });
  }));

  app.post('/api/servers/:serverId/database-credentials/:credentialId/apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    await credential(request.params.serverId, request.params.credentialId);
    const body = exactBody(request.body, APPLY_FIELDS, 'database_credential_apply_input_invalid');
    const queued = await databaseCredentialApplyService.queueApply({ credentialId: request.params.credentialId, ...body });
    return response.status(202).json({ data: queued });
  }));

  app.get('/api/servers/:serverId/database-credentials/:credentialId/delete-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    await credential(request.params.serverId, request.params.credentialId);
    return response.json({ data: await databaseCredentialApplyService.previewDelete(request.params.credentialId) });
  }));

  app.post('/api/servers/:serverId/database-credentials/:credentialId/delete', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    await credential(request.params.serverId, request.params.credentialId);
    const body = exactBody(request.body, APPLY_FIELDS, 'database_credential_delete_input_invalid');
    const queued = await databaseCredentialApplyService.queueDelete({ credentialId: request.params.credentialId, ...body });
    return response.status(202).json({ data: queued });
  }));

  app.delete('/api/servers/:serverId/database-credentials/:credentialId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const state = await credential(request.params.serverId, request.params.credentialId);
    const body = exactBody(request.body, FINALIZE_FIELDS, 'database_credential_finalize_input_invalid');
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
      || state.credential.revision !== body.expectedRevision) {
      throw new DatabaseCredentialHttpError('database_credential_revision_conflict', 'Database credential changed; refresh and retry', 409);
    }
    await ensureDatabaseIdle(jobRegistry, state.server.id);
    const job = await jobRegistry.getJob(body.deleteJobId);
    if (!job || job.status !== 'succeeded' || job.operation !== 'database.credential.delete'
      || job.serverId !== state.server.id || job.resourceType !== 'database'
      || job.resourceId !== state.binding.databaseName
      || job.result?.databaseCredentialId !== state.credential.id
      || job.result?.databaseBindingId !== state.binding.id
      || job.result?.credentialRevision !== state.credential.revision
      || job.result?.bindingRevision !== state.binding.revision
      || job.result?.deleted !== true || job.result?.sideEffects !== true) {
      throw new DatabaseCredentialHttpError('database_credential_delete_evidence_missing', 'A matching successful database credential delete job is required', 409);
    }
    const expectedConfirmation = `finalize-database-credential-delete:${state.credential.id}:${state.credential.revision}:${job.id}`;
    if (body.confirmation !== expectedConfirmation) {
      throw new DatabaseCredentialHttpError('database_credential_confirmation_mismatch', 'Database credential delete finalization confirmation does not match', 409);
    }
    const deleted = await databaseCredentialRegistry.deleteCredential(state.credential.id, {
      expectedRevision: state.credential.revision,
      confirmation: `delete-database-credential:${state.credential.id}:${state.credential.revision}`,
    });
    return response.json({ data: { ...deleted, finalizedFromJobId: job.id }, sideEffects: { databaseChanged: false } });
  }));
}

export const databaseCredentialHttpInternals = Object.freeze({
  createFields: Object.freeze([...CREATE_FIELDS]),
  grantFields: Object.freeze([...GRANT_FIELDS]),
  revisionFields: Object.freeze([...REVISION_FIELDS]),
  applyFields: Object.freeze([...APPLY_FIELDS]),
  finalizeFields: Object.freeze([...FINALIZE_FIELDS]),
  exactBody,
  emptyQuery,
});
