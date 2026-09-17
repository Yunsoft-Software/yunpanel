import { OPERATIONS } from '@yunpanel/protocol';
import { sanitizeDatabaseJobResult } from './database-job-result.js';
import { JobRegistryError } from './job-registry.js';
import { mountDatabaseRestoreRoutes } from './database-restore-http.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { RegistryError } from './server-registry.js';

const DATABASE_OPERATIONS = new Set([
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.DATABASE_CREATE,
  OPERATIONS.DATABASE_DELETE,
  OPERATIONS.DATABASE_BACKUP,
  OPERATIONS.DATABASE_RESTORE,
  OPERATIONS.DATABASE_CREDENTIAL_APPLY,
  OPERATIONS.DATABASE_CREDENTIAL_DELETE,
]);
const INVENTORY_OPERATIONS = new Set([
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.DATABASE_CREATE,
  OPERATIONS.DATABASE_DELETE,
]);
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export class DatabaseHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DatabaseHttpError';
    this.code = code;
    this.status = status;
  }
}

function requireDatabaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value) || RESERVED_DATABASES.has(value.toLowerCase())) {
    throw new DatabaseHttpError('invalid_database_name', 'Database name is invalid');
  }
  return value;
}

function exactConfirmationBody(body, expected, action) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof body.confirmation !== 'string') {
    throw new DatabaseHttpError('database_confirmation_input_invalid', 'Request must contain exactly confirmation');
  }
  if (body.confirmation !== expected) {
    throw new DatabaseHttpError('database_confirmation_required', `Confirm database ${action} with ${expected}`);
  }
  return body.confirmation;
}

async function requireServer(registry, serverId) {
  const server = await registry.getServer(serverId);
  if (!server) throw new RegistryError('server_not_found', 'Server not found', 404);
  return server;
}

async function ensureDatabaseIdle(jobRegistry, serverId) {
  const jobs = await jobRegistry.listJobs({ serverId });
  if (jobs.some((job) => DATABASE_OPERATIONS.has(job.operation) && (job.status === 'queued' || job.status === 'running'))) {
    throw new JobRegistryError('database_job_conflict', 'Another database operation is already queued or running', 409);
  }
}

function copyInventory(result) {
  return {
    engine: result.engine,
    version: result.version,
    databases: result.databases.map((database) => ({ ...database })),
  };
}

async function latestDatabaseSnapshot(jobRegistry, serverId) {
  const jobs = (await jobRegistry.listJobs({ serverId, status: 'succeeded' }))
    .filter((job) => INVENTORY_OPERATIONS.has(job.operation));
  let inspectIndex = -1;
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    if (jobs[index].operation === OPERATIONS.DATABASE_INSPECT) {
      inspectIndex = index;
      break;
    }
  }
  if (inspectIndex < 0) return null;

  const base = jobs[inspectIndex];
  const inventory = copyInventory(base.result);
  let latest = base;
  for (const job of jobs.slice(inspectIndex + 1)) {
    if (job.operation === OPERATIONS.DATABASE_CREATE) {
      const database = { ...job.result.database };
      const existingIndex = inventory.databases.findIndex((entry) => entry.name === database.name);
      if (existingIndex >= 0) inventory.databases[existingIndex] = database;
      else inventory.databases.push(database);
      inventory.engine = job.result.engine;
      inventory.version = job.result.version;
      latest = job;
    } else if (job.operation === OPERATIONS.DATABASE_DELETE) {
      inventory.databases = inventory.databases.filter((entry) => entry.name !== job.result.database.name);
      inventory.engine = job.result.engine;
      inventory.version = job.result.version;
      latest = job;
    }
  }
  inventory.databases.sort((left, right) => left.name.localeCompare(right.name));
  return {
    ...inventory,
    snapshot: {
      jobId: latest.id,
      refreshedAt: latest.finishedAt ?? latest.createdAt,
    },
  };
}

async function liveDatabaseInventory(databaseInventoryProvider, serverId) {
  try {
    const inventory = sanitizeDatabaseJobResult(
      { operation: OPERATIONS.DATABASE_INSPECT, payload: {} },
      await databaseInventoryProvider(serverId),
    );
    return Object.freeze({ ...inventory, live: true });
  } catch {
    throw new DatabaseHttpError(
      'database_inventory_unavailable',
      'Live database inventory could not be read from the local server',
      503,
    );
  }
}

async function attachDatabaseOwnership(inventory, {
  serverId,
  databaseBindingRegistry,
  databaseCredentialRegistry,
}) {
  if (!databaseBindingRegistry) return inventory;
  let bindings;
  let credentials;
  try {
    [bindings, credentials] = await Promise.all([
      databaseBindingRegistry.listBindings({ serverId }),
      databaseCredentialRegistry
        ? databaseCredentialRegistry.listCredentials({ serverId })
        : Promise.resolve([]),
    ]);
  } catch {
    throw new DatabaseHttpError(
      'database_ownership_state_unavailable',
      'Database Website ownership state could not be read',
      503,
    );
  }
  if (!Array.isArray(bindings) || !Array.isArray(credentials)) {
    throw new DatabaseHttpError(
      'database_ownership_state_unavailable',
      'Database Website ownership state is invalid',
      503,
    );
  }
  const bindingIds = new Set(bindings.map((binding) => binding?.id));
  const bindingNames = new Set(bindings.map((binding) => binding?.databaseName?.toLowerCase()));
  if (bindings.some((binding) => !binding || typeof binding !== 'object'
    || typeof binding.id !== 'string' || typeof binding.databaseName !== 'string'
    || binding.serverId !== serverId
    || typeof binding.websiteId !== 'string' || typeof binding.applicationId !== 'string'
    || typeof binding.unixUser !== 'string' || !Number.isSafeInteger(binding.revision) || binding.revision < 1)
    || credentials.some((credential) => !credential || typeof credential !== 'object'
      || typeof credential.id !== 'string' || typeof credential.databaseBindingId !== 'string'
      || credential.serverId !== serverId || !bindingIds.has(credential.databaseBindingId)
      || typeof credential.username !== 'string' || credential.host !== 'localhost'
      || !Array.isArray(credential.privileges) || credential.privileges.some((entry) => typeof entry !== 'string')
      || !Number.isSafeInteger(credential.revision) || credential.revision < 1
      || typeof credential.passwordUpdatedAt !== 'string')
    || bindingIds.size !== bindings.length || bindingNames.size !== bindings.length
    || new Set(credentials.map((credential) => credential.databaseBindingId)).size !== credentials.length) {
    throw new DatabaseHttpError(
      'database_ownership_state_unavailable',
      'Database Website ownership state is invalid',
      503,
    );
  }
  const bindingByName = new Map(bindings.map((binding) => [binding.databaseName.toLowerCase(), binding]));
  const credentialByBinding = new Map(credentials.map((credential) => [credential.databaseBindingId, credential]));
  const liveNames = new Set(inventory.databases.map((database) => database.name.toLowerCase()));
  return Object.freeze({
    ...inventory,
    databases: Object.freeze(inventory.databases.map((database) => {
      const binding = bindingByName.get(database.name.toLowerCase()) ?? null;
      const credential = binding ? credentialByBinding.get(binding.id) ?? null : null;
      return Object.freeze({
        ...database,
        ownership: binding ? Object.freeze({
          bindingId: binding.id,
          websiteId: binding.websiteId,
          applicationId: binding.applicationId,
          unixUser: binding.unixUser,
          revision: binding.revision,
          credential: credential ? Object.freeze({
            id: credential.id,
            username: credential.username,
            host: credential.host,
            privileges: Object.freeze([...credential.privileges]),
            revision: credential.revision,
            passwordUpdatedAt: credential.passwordUpdatedAt,
          }) : null,
        }) : null,
      });
    })),
    ownership: Object.freeze({
      bindingCount: bindings.length,
      credentialCount: credentials.length,
      missingDatabaseBindingCount: bindings.filter((binding) => !liveNames.has(binding.databaseName.toLowerCase())).length,
    }),
  });
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountDatabaseRoutes(app, {
  registry,
  jobRegistry,
  databaseBindingRegistry = null,
  databaseCredentialRegistry = null,
  databaseInventoryProvider = null,
}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.delete !== 'function') {
    throw new Error('Express application is required');
  }
  if (!registry || typeof registry.getServer !== 'function') throw new Error('Server registry is required');
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function') throw new Error('Job registry is required');
  if (databaseBindingRegistry !== null && typeof databaseBindingRegistry.getByDatabase !== 'function') {
    throw new Error('Database binding registry is invalid');
  }
  if (databaseCredentialRegistry !== null && (!databaseBindingRegistry
    || typeof databaseBindingRegistry.listBindings !== 'function'
    || typeof databaseCredentialRegistry.listCredentials !== 'function')) {
    throw new Error('Database credential registry is invalid');
  }
  if (databaseInventoryProvider !== null && typeof databaseInventoryProvider !== 'function') {
    throw new Error('Database inventory provider is invalid');
  }

  app.get('/api/servers/:serverId/databases', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    response.set('Cache-Control', 'no-store');
    if (databaseInventoryProvider) {
      const inventory = await liveDatabaseInventory(databaseInventoryProvider, server.id);
      return response.json({ data: await attachDatabaseOwnership(inventory, {
        serverId: server.id,
        databaseBindingRegistry: typeof databaseBindingRegistry?.listBindings === 'function'
          ? databaseBindingRegistry
          : null,
        databaseCredentialRegistry,
      }) });
    }
    const snapshot = await latestDatabaseSnapshot(jobRegistry, server.id);
    const inventory = snapshot ?? { engine: null, version: null, databases: null, snapshot: null };
    return response.json({ data: snapshot && typeof databaseBindingRegistry?.listBindings === 'function'
      ? await attachDatabaseOwnership(inventory, {
        serverId: server.id,
        databaseBindingRegistry,
        databaseCredentialRegistry,
      })
      : inventory });
  }));

  app.post('/api/servers/:serverId/databases/inspect', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    await ensureDatabaseIdle(jobRegistry, server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: OPERATIONS.DATABASE_INSPECT,
      operation: OPERATIONS.DATABASE_INSPECT,
      payload: {},
      resourceType: 'database',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
  }));

  app.post('/api/servers/:serverId/databases', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    const name = requireDatabaseName(request.body?.name);
    if (request.body?.confirmation !== `create:${name}`) {
      throw new DatabaseHttpError('database_confirmation_required', `Confirm database creation with create:${name}`);
    }
    await ensureDatabaseIdle(jobRegistry, server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: OPERATIONS.DATABASE_CREATE,
      operation: OPERATIONS.DATABASE_CREATE,
      payload: { name },
      resourceType: 'database',
      resourceId: name,
    });
    return response.status(202).json({ data: job });
  }));

  app.post('/api/servers/:serverId/databases/:name/backup', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    const name = requireDatabaseName(request.params.name);
    exactConfirmationBody(request.body, `backup:${name}`, 'backup');
    await ensureDatabaseIdle(jobRegistry, server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: OPERATIONS.DATABASE_BACKUP,
      operation: OPERATIONS.DATABASE_BACKUP,
      payload: { databaseName: name },
      resourceType: 'database',
      resourceId: name,
    });
    return response.status(202).json({ data: job });
  }));

  if (typeof jobRegistry.getJob === 'function') {
    mountDatabaseRestoreRoutes(app, { registry, jobRegistry });
  }

  app.delete('/api/servers/:serverId/databases/:name', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    const name = requireDatabaseName(request.params.name);
    if (request.body?.confirmation !== `delete:${name}`) {
      throw new DatabaseHttpError('database_confirmation_required', `Confirm database deletion with delete:${name}`);
    }
    if (databaseBindingRegistry) {
      let binding;
      try { binding = await databaseBindingRegistry.getByDatabase({ serverId: server.id, databaseName: name }); }
      catch {
        throw new DatabaseHttpError('database_binding_state_unavailable', 'Database ownership state could not be verified', 503);
      }
      if (binding) {
        throw new DatabaseHttpError(
          'database_binding_exists',
          'Unbind the database from its Website before deleting the schema',
          409,
        );
      }
    }
    await ensureDatabaseIdle(jobRegistry, server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: OPERATIONS.DATABASE_DELETE,
      operation: OPERATIONS.DATABASE_DELETE,
      payload: { name },
      resourceType: 'database',
      resourceId: name,
    });
    return response.status(202).json({ data: job });
  }));
}

export const databaseHttpInternals = Object.freeze({
  requireDatabaseName,
  exactConfirmationBody,
  ensureDatabaseIdle,
  latestDatabaseSnapshot,
  liveDatabaseInventory,
  attachDatabaseOwnership,
});
