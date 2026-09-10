import express from 'express';
import { createApplicationRegistry } from './application-registry.js';
import { createApp as createCoreApp } from './core-app.js';
import { DatabaseHttpError, mountDatabaseRoutes } from './database-http.js';
import { createDomainRegistry, DomainRegistryError } from './domain-registry.js';
import { createDomainHandler } from './domain-http.js';
import { createJobRegistry, JobRegistryError } from './job-registry.js';
import { ManagedServiceHttpError, mountManagedServiceRoutes } from './managed-service-http.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { createServerRegistry, RegistryError } from './server-registry.js';
import { mountWebsiteRoutes } from './website-http.js';
import { createWebsiteRegistry, WebsiteRegistryError } from './website-registry.js';

export { API_VERSION } from './core-app.js';

// Preserve the existing core operations while extracting feature routes.
// Production still enters through createAuthenticatedApi in index.js. Directly
// mounting this factory does not create a second auth boundary because every
// management route requires a server-derived request.auth context.
export function createApp({
  registry = createServerRegistry(),
  domainRegistry = createDomainRegistry(),
  jobRegistry = createJobRegistry(),
  applicationRegistry = createApplicationRegistry(),
  websiteRegistry = createWebsiteRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
    getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
  }),
  environment = process.env.NODE_ENV,
  ...options
} = {}) {
  const core = createCoreApp({ ...options, registry, domainRegistry, jobRegistry, applicationRegistry, environment });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.post('/api/domains', requirePanelRouteAccess, createDomainHandler(domainRegistry));
  mountWebsiteRoutes(app, { websiteRegistry });
  mountManagedServiceRoutes(app, { registry, jobRegistry });
  mountDatabaseRoutes(app, { registry, jobRegistry });
  app.use(core);
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (
      error instanceof DatabaseHttpError
      || error instanceof DomainRegistryError
      || error instanceof RegistryError
      || error instanceof JobRegistryError
      || error instanceof ManagedServiceHttpError
      || error instanceof WebsiteRegistryError
    ) {
      return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    const invalidJson = error instanceof SyntaxError && error.status === 400;
    return response.status(invalidJson ? 400 : 500).json({
      error: {
        code: invalidJson ? 'invalid_json' : 'internal_error',
        message: invalidJson ? 'Invalid JSON body' : 'Unexpected server error',
      },
    });
  });
  return app;
}
