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
import { WebsiteMigrationBindError } from './website-migration-bind.js';
import { WebsiteMigrationCreateError } from './website-migration-create.js';
import { mountWebsiteMigrationRoutes } from './website-migration-http.js';
import { createWebsiteMigrationLedger, WebsiteMigrationLedgerError } from './website-migration-ledger.js';
import { createWebsiteMigrationPolicyStore, WebsiteMigrationPolicyError } from './website-migration-policy.js';
import { WebsiteMigrationPreviewError } from './website-migration-preview.js';
import { WebsiteMigrationRollbackError } from './website-migration-rollback.js';
import { createWebsiteRegistry, WebsiteRegistryError } from './website-registry.js';

export { API_VERSION } from './core-app.js';

export function createApp({
  registry = createServerRegistry(),
  jobRegistry = createJobRegistry(),
  applicationRegistry = createApplicationRegistry(),
  websiteRegistry = createWebsiteRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
    getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
  }),
  websiteMigrationPolicy = createWebsiteMigrationPolicyStore(),
  migrationLedger = createWebsiteMigrationLedger(),
  domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
    getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
    websiteBindingRequired: () => websiteMigrationPolicy.snapshot().websiteBindingRequired,
  }),
  environment = process.env.NODE_ENV,
  ...options
} = {}) {
  const core = createCoreApp({ ...options, registry, domainRegistry, jobRegistry, applicationRegistry, environment });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.post('/api/domains', requirePanelRouteAccess, createDomainHandler(domainRegistry));
  mountWebsiteRoutes(app, { websiteRegistry, domainRegistry });
  mountWebsiteMigrationRoutes(app, {
    websiteRegistry,
    domainRegistry,
    applicationRegistry,
    websiteMigrationPolicy,
    migrationLedger,
  });
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
      || error instanceof WebsiteMigrationBindError
      || error instanceof WebsiteMigrationCreateError
      || error instanceof WebsiteMigrationLedgerError
      || error instanceof WebsiteMigrationPolicyError
      || error instanceof WebsiteMigrationPreviewError
      || error instanceof WebsiteMigrationRollbackError
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
