import { requirePanelRouteAccess } from './panel-http-guard.js';

const BIND_FIELDS = new Set(['websiteId', 'applicationId', 'confirmation']);
const UNBIND_FIELDS = new Set(['expectedRevision', 'confirmation']);

export class DatabaseBindingHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DatabaseBindingHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new DatabaseBindingHttpError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new DatabaseBindingHttpError('database_binding_query_invalid', 'Database binding operation does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountDatabaseBindingRoutes(app, {
  registry,
  jobRegistry,
  databaseBindingRegistry,
  databaseCredentialRegistry = null,
  requireDatabaseName,
  ensureDatabaseIdle,
  latestDatabaseSnapshot,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.delete !== 'function') {
    throw new Error('Express application is required');
  }
  if (!registry || typeof registry.getServer !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function'
    || !databaseBindingRegistry || typeof databaseBindingRegistry.bindDatabase !== 'function'
    || typeof databaseBindingRegistry.unbindDatabase !== 'function'
    || typeof databaseBindingRegistry.getBinding !== 'function'
    || typeof databaseBindingRegistry.listBindings !== 'function'
    || (databaseCredentialRegistry !== null && typeof databaseCredentialRegistry.getForBinding !== 'function')
    || typeof requireDatabaseName !== 'function' || typeof ensureDatabaseIdle !== 'function'
    || typeof latestDatabaseSnapshot !== 'function') {
    throw new Error('Database binding route dependencies are invalid');
  }

  async function server(serverId) {
    const found = await registry.getServer(serverId);
    if (!found) throw new DatabaseBindingHttpError('server_not_found', 'Server not found', 404);
    return found;
  }

  app.get('/api/servers/:serverId/database-bindings', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const current = await server(request.params.serverId);
    return response.json({ data: await databaseBindingRegistry.listBindings({ serverId: current.id }) });
  }));

  app.post('/api/servers/:serverId/databases/:name/bind', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const current = await server(request.params.serverId);
    const name = requireDatabaseName(request.params.name);
    const body = exactBody(request.body, BIND_FIELDS, 'database_binding_input_invalid');
    await ensureDatabaseIdle(jobRegistry, current.id);
    const snapshot = await latestDatabaseSnapshot(jobRegistry, current.id);
    if (!snapshot || !Array.isArray(snapshot.databases)) {
      throw new DatabaseBindingHttpError(
        'database_inventory_required',
        'Refresh database inventory before binding a database',
        409,
      );
    }
    if (!snapshot.databases.some((database) => database.name === name)) {
      throw new DatabaseBindingHttpError('database_not_found', 'Database was not found in the latest verified inventory', 404);
    }
    const binding = await databaseBindingRegistry.bindDatabase({
      serverId: current.id,
      databaseName: name,
      websiteId: body.websiteId,
      applicationId: body.applicationId,
      confirmation: body.confirmation,
    });
    return response.status(201).json({ data: binding, sideEffects: { databaseChanged: false } });
  }));

  app.delete('/api/servers/:serverId/database-bindings/:bindingId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const current = await server(request.params.serverId);
    const body = exactBody(request.body, UNBIND_FIELDS, 'database_unbind_input_invalid');
    const binding = await databaseBindingRegistry.getBinding(request.params.bindingId);
    if (!binding || binding.serverId !== current.id) {
      throw new DatabaseBindingHttpError('database_binding_not_found', 'Database binding not found', 404);
    }
    await ensureDatabaseIdle(jobRegistry, current.id);
    if (databaseCredentialRegistry) {
      let credential;
      try { credential = await databaseCredentialRegistry.getForBinding(binding.id); }
      catch {
        throw new DatabaseBindingHttpError('database_credential_state_unavailable', 'Database credential state could not be verified', 503);
      }
      if (credential) {
        throw new DatabaseBindingHttpError(
          'database_binding_credential_exists',
          'Delete the managed database credential before unbinding the database',
          409,
        );
      }
    }
    const result = await databaseBindingRegistry.unbindDatabase(binding.id, body);
    return response.json({ data: result, sideEffects: { databaseChanged: false } });
  }));
}

export const databaseBindingHttpInternals = Object.freeze({
  bindFields: Object.freeze([...BIND_FIELDS]),
  unbindFields: Object.freeze([...UNBIND_FIELDS]),
  exactBody,
  emptyQuery,
});
