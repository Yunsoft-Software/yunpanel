import express from 'express';
import { createApp as createCoreApp } from './core-app.js';
import { createBootstrapAdminGuard, resolveBootstrapAdminToken } from './bootstrap-auth.js';
import { createDomainRegistry, DomainRegistryError } from './domain-registry.js';
import { createDomainHandler } from './domain-http.js';

export { API_VERSION } from './core-app.js';

// Preserve the existing core operations while extracting feature routes.
// Production still enters through createAuthenticatedApi in index.js; this
// factory opens no listener and does not replace session/CSRF/Owner checks.
export function createApp({
  domainRegistry = createDomainRegistry(),
  environment = process.env.NODE_ENV,
  adminToken,
  ...options
} = {}) {
  const token = adminToken === undefined ? resolveBootstrapAdminToken({ environment }) : adminToken;
  const core = createCoreApp({ ...options, domainRegistry, environment, adminToken: token });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.post('/api/domains', createBootstrapAdminGuard({ token }), createDomainHandler(domainRegistry));
  app.use(core);
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof DomainRegistryError) {
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
