import express from 'express';
import { createApp as createManagementApp } from './management-app.js';
import { createSiteResourceBoundary, needsSiteResourceJson } from './site-resource-boundary.js';
export * from './management-app.js';

// Authentication/CSRF are still supplied by createAuthenticatedApi. The inner
// application is unchanged; this layer only restricts site resource ownership.
export function createApp(options = {}) {
  const inner = createManagementApp(options);
  const app = express();
  app.disable('x-powered-by');
  const smallJson = express.json({ limit: '64kb' });
  app.use((request, response, next) => {
    if (needsSiteResourceJson(request)) return smallJson(request, response, next);
    // Do not consume binary uploads, text edits or their existing size limits.
    return next();
  });
  app.use(createSiteResourceBoundary(options));
  app.use(inner);
  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 503;
    return response.status(status).json({ error: { code: status === 413 ? 'request_body_too_large' : status === 400 ? 'invalid_json' : 'site_scope_unavailable', message: 'Site request could not be processed.' } });
  });
  return app;
}
