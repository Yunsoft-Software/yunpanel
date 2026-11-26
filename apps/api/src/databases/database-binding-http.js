import { randomUUID } from 'node:crypto';
import { isInfrastructureDatabase } from '@yunpanel/shared';
import { databaseCredentialRegistryInternals } from './database-credential-registry.js';
import { requirePanelRouteAccess } from '../http/panel-http-guard.js';

const BIND_FIELDS = new Set(['websiteId', 'applicationId', 'confirmation']);
const UNBIND_FIELDS = new Set(['expectedRevision', 'confirmation']);
const ALLOWED_PRIVILEGES = new Set(databaseCredentialRegistryInternals.allowedPrivileges);

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

export function createDatabaseMetadataMutation({ withApplicationLock = null, authorizeActor = null } = {}) {
  if (withApplicationLock !== null && typeof withApplicationLock !== 'function'
    || authorizeActor !== null && typeof authorizeActor !== 'function') {
    throw new Error('Database metadata mutation dependencies are invalid');
  }
  return async (request, resolve, action) => {
    const initial = await resolve();
    async function apply(scope) {
      if (authorizeActor && !await authorizeActor({
        sessionId: request.auth?.id, userId: request.auth?.user?.id, role: request.auth?.user?.role,
      }, scope.websiteId)) {
        throw new DatabaseBindingHttpError('site_scope_forbidden', 'Website access has changed', 403);
      }
      return action(scope);
    }
    if (!withApplicationLock) return apply(initial);
    if (!initial.applicationId) {
      throw new DatabaseBindingHttpError('database_metadata_scope_invalid', 'Database Application scope could not be verified', 409);
    }
    return withApplicationLock(initial.applicationId, async () => {
      const current = await resolve();
      if (current.serverId !== initial.serverId || current.websiteId !== initial.websiteId
        || current.applicationId !== initial.applicationId || current.unixUser !== initial.unixUser
        || current.bindingId !== initial.bindingId || current.bindingRevision !== initial.bindingRevision
        || current.databaseName !== initial.databaseName) {
        throw new DatabaseBindingHttpError('database_metadata_scope_changed', 'Database ownership changed; refresh and retry', 409);
      }
      return apply(current);
    });
  };
}

export function mountDatabaseBindingRoutes(app, {
  registry,
  websiteRegistry,
  jobRegistry,
  databaseBindingRegistry,
  databaseCredentialRegistry = null,
  requireDatabaseName,
  ensureDatabaseIdle,
  latestDatabaseSnapshot,
  withApplicationLock = null,
  authorizeActor = null,
  databaseQuotaCoordinator = null,
  reserveDatabaseQuota = null,
  finalizeDatabaseQuota = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.delete !== 'function') {
    throw new Error('Express application is required');
  }
  if (!registry || typeof registry.getServer !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function'
    || !databaseBindingRegistry || typeof databaseBindingRegistry.bindDatabase !== 'function'
    || typeof databaseBindingRegistry.unbindDatabase !== 'function'
    || typeof databaseBindingRegistry.getBinding !== 'function'
    || typeof databaseBindingRegistry.listBindings !== 'function'
    || (databaseCredentialRegistry !== null && (typeof databaseCredentialRegistry.getForBinding !== 'function'
      || typeof databaseCredentialRegistry.listCredentials !== 'function'))
    || (databaseQuotaCoordinator !== null && typeof databaseQuotaCoordinator.reserveAndRun !== 'function')
    || (reserveDatabaseQuota !== null && typeof reserveDatabaseQuota !== 'function')
    || (finalizeDatabaseQuota !== null && typeof finalizeDatabaseQuota !== 'function')
    || typeof requireDatabaseName !== 'function' || typeof ensureDatabaseIdle !== 'function'
    || typeof latestDatabaseSnapshot !== 'function') {
    throw new Error('Database binding route dependencies are invalid');
  }

  const mutate = createDatabaseMetadataMutation({ withApplicationLock, authorizeActor });

  async function server(serverId) {
    const found = await registry.getServer(serverId);
    if (!found) throw new DatabaseBindingHttpError('server_not_found', 'Server not found', 404);
    return found;
  }

  app.get('/api/servers/:serverId/database-bindings', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const current = await server(request.params.serverId);
    const bindings = await databaseBindingRegistry.listBindings({ serverId: current.id });
    return response.json({ data: bindings.filter((binding) => !isInfrastructureDatabase(binding?.databaseName)) });
  }));

  app.get('/api/servers/:serverId/websites/:websiteId/database-resources', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const current = await server(request.params.serverId);
    const website = await websiteRegistry.getWebsite(request.params.websiteId);
    if (!website || website.serverId !== current.id) {
      throw new DatabaseBindingHttpError('website_not_found', 'Website not found', 404);
    }
    let bindings;
    let credentials;
    try {
      [bindings, credentials] = await Promise.all([
        databaseBindingRegistry.listBindings({ serverId: current.id, websiteId: website.id }),
        databaseCredentialRegistry
          ? databaseCredentialRegistry.listCredentials({ serverId: current.id, websiteId: website.id })
          : Promise.resolve([]),
      ]);
    } catch {
      throw new DatabaseBindingHttpError(
        'website_database_state_unavailable',
        'Website database state could not be read',
        503,
      );
    }
    if (!Array.isArray(bindings) || !Array.isArray(credentials)) {
      throw new DatabaseBindingHttpError('website_database_state_unavailable', 'Website database state is invalid', 503);
    }
    const bindingById = new Map(bindings.map((binding) => [binding?.id, binding]));
    if (bindingById.size !== bindings.length || bindings.some((binding) => !binding || typeof binding !== 'object'
      || typeof binding.id !== 'string' || binding.serverId !== current.id
      || typeof binding.databaseName !== 'string' || binding.websiteId !== website.id
      || binding.applicationId !== website.applicationId || typeof binding.unixUser !== 'string'
      || !Number.isSafeInteger(binding.revision) || binding.revision < 1)
      || credentials.some((credential) => {
      const binding = bindingById.get(credential?.databaseBindingId);
      return !credential || typeof credential !== 'object' || typeof credential.id !== 'string'
        || !binding || credential.serverId !== current.id || credential.websiteId !== website.id
        || credential.databaseName !== binding.databaseName
        || credential.applicationId !== binding.applicationId
        || credential.siteUnixUser !== binding.unixUser || typeof credential.username !== 'string'
        || credential.host !== 'localhost' || !Array.isArray(credential.privileges)
        || credential.privileges.length < 1 || credential.privileges.length > ALLOWED_PRIVILEGES.size
        || credential.privileges.some((privilege) => !ALLOWED_PRIVILEGES.has(privilege))
        || new Set(credential.privileges).size !== credential.privileges.length
        || !Number.isSafeInteger(credential.revision) || credential.revision < 1
        || credential.passwordConfigured !== true || typeof credential.passwordUpdatedAt !== 'string';
    }) || new Set(credentials.map((credential) => credential.databaseBindingId)).size !== credentials.length) {
      throw new DatabaseBindingHttpError('website_database_state_unavailable', 'Website database state is inconsistent', 503);
    }
    const credentialByBinding = new Map(credentials.map((credential) => [credential.databaseBindingId, credential]));
    const databases = bindings
      .filter((binding) => !isInfrastructureDatabase(binding?.databaseName))
      .map((binding) => Object.freeze({
        binding: Object.freeze({
          id: binding.id,
          databaseName: binding.databaseName,
          websiteId: binding.websiteId,
          applicationId: binding.applicationId,
          unixUser: binding.unixUser,
          revision: binding.revision,
        }),
        credential: credentialByBinding.has(binding.id) ? Object.freeze({
          id: credentialByBinding.get(binding.id).id,
          username: credentialByBinding.get(binding.id).username,
          host: 'localhost',
          privileges: Object.freeze([...credentialByBinding.get(binding.id).privileges]),
          revision: credentialByBinding.get(binding.id).revision,
          passwordConfigured: true,
          passwordUpdatedAt: credentialByBinding.get(binding.id).passwordUpdatedAt,
        }) : null,
      }))
      .sort((left, right) => left.binding.databaseName.localeCompare(right.binding.databaseName));
    response.set('Cache-Control', 'no-store');
    return response.json({ data: {
      websiteId: website.id,
      applicationId: website.applicationId,
      databases,
    } });
  }));

  app.post('/api/servers/:serverId/databases/:name/bind', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const name = requireDatabaseName(request.params.name);
    if (isInfrastructureDatabase(name)) {
      throw new DatabaseBindingHttpError('invalid_database_name', 'Database name is invalid', 400);
    }
    const body = exactBody(request.body, BIND_FIELDS, 'database_binding_input_invalid');
    const binding = await mutate(request, async () => {
      const current = await server(request.params.serverId);
      const website = await websiteRegistry.getWebsite(body.websiteId);
      if (!website) throw new DatabaseBindingHttpError('website_not_found', 'Website not found', 404);
      if (website.serverId !== current.id) {
        throw new DatabaseBindingHttpError('database_binding_website_server_mismatch', 'Website belongs to a different server', 409);
      }
      return { serverId: current.id, websiteId: website.id, applicationId: website.applicationId, unixUser: website.unixUser };
    }, async (scope) => {
      await ensureDatabaseIdle(jobRegistry, scope.serverId);
      const snapshot = await latestDatabaseSnapshot(jobRegistry, scope.serverId);
      if (!snapshot || !Array.isArray(snapshot.databases)) {
        throw new DatabaseBindingHttpError('database_inventory_required', 'Refresh database inventory before binding a database', 409);
      }
      if (!snapshot.databases.some((database) => database.name === name)) {
        throw new DatabaseBindingHttpError('database_not_found', 'Database was not found in the latest verified inventory', 404);
      }
      const bindStep = () => databaseBindingRegistry.bindDatabase({
        serverId: scope.serverId,
        databaseName: name,
        websiteId: scope.websiteId,
        applicationId: body.applicationId ?? scope.applicationId,
        confirmation: body.confirmation,
      });
      if (databaseQuotaCoordinator) {
        return databaseQuotaCoordinator.reserveAndRun({
          websiteId: scope.websiteId,
          serverId: scope.serverId,
          databaseName: name,
          operationId: `db-bind:${randomUUID()}`,
        }, bindStep);
      }
      let reservation = null;
      let attached = false;
      try {
        if (typeof reserveDatabaseQuota === 'function') {
          const activeBindings = await databaseBindingRegistry.listBindings();
          reservation = await reserveDatabaseQuota({
            websiteId: scope.websiteId,
            serverId: scope.serverId,
            databaseName: name,
            operationId: `db-bind:${randomUUID()}`,
            activeBindings,
          });
        }
        const bound = await bindStep();
        if (reservation?.reserved && typeof finalizeDatabaseQuota === 'function') {
          await finalizeDatabaseQuota(reservation.operationId, 'attached');
          attached = true;
        }
        return bound;
      } catch (error) {
        if (reservation?.reserved && !attached && typeof finalizeDatabaseQuota === 'function') {
          try { await finalizeDatabaseQuota(reservation.operationId, 'released'); } catch {}
        }
        throw error;
      }
    });
    return response.status(201).json({ data: binding, sideEffects: { databaseChanged: false } });
  }));

  app.delete('/api/servers/:serverId/database-bindings/:bindingId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, UNBIND_FIELDS, 'database_unbind_input_invalid');
    const result = await mutate(request, async () => {
      const current = await server(request.params.serverId);
      const binding = await databaseBindingRegistry.getBinding(request.params.bindingId);
      if (!binding || binding.serverId !== current.id) {
        throw new DatabaseBindingHttpError('database_binding_not_found', 'Database binding not found', 404);
      }
      return { ...binding, bindingId: binding.id, bindingRevision: binding.revision };
    }, async (scope) => {
      await ensureDatabaseIdle(jobRegistry, scope.serverId);
      if (databaseCredentialRegistry) {
        let credential;
        try { credential = await databaseCredentialRegistry.getForBinding(scope.bindingId); }
        catch {
          throw new DatabaseBindingHttpError('database_credential_state_unavailable', 'Database credential state could not be verified', 503);
        }
        if (credential) {
          throw new DatabaseBindingHttpError(
            'database_binding_credential_exists', 'Delete the managed database credential before unbinding the database', 409,
          );
        }
      }
      return databaseBindingRegistry.unbindDatabase(scope.bindingId, body);
    });
    return response.json({ data: result, sideEffects: { databaseChanged: false } });
  }));
}

export const databaseBindingHttpInternals = Object.freeze({
  bindFields: Object.freeze([...BIND_FIELDS]),
  unbindFields: Object.freeze([...UNBIND_FIELDS]),
  exactBody,
  emptyQuery,
});
