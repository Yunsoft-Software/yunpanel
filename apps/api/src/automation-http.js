import express from 'express';

// Key-only machine API under /api/automation. It never sees a panel session: the
// auth entry refuses cookies and browser origins before routing here.
export function createAutomationHandler({ apiKeyStore, mountRoutes = () => {} } = {}) {
  if (!apiKeyStore || typeof apiKeyStore.authenticate !== 'function') throw new Error('Automation API requires the API key store');
  const app = express();
  app.disable('x-powered-by');
  app.use(async (request, response, next) => {
    try {
      const header = request.headers.authorization;
      const key = typeof header === 'string' && header.startsWith('Bearer ') ? await apiKeyStore.authenticate(header.slice(7)) : null;
      if (!key) return response.status(401).json({ error: { code: 'unauthorized', message: 'A valid API key is required.' } });
      request.apiKey = key;
      return next();
    } catch (error) { return next(error); }
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/automation/whoami', (request, response) => response.json({ data: { id: request.apiKey.id, name: request.apiKey.name, scope: request.apiKey.scope } }));
  mountRoutes(app);
  app.use((request, response) => response.status(404).json({ error: { code: 'not_found', message: 'Not found.' } }));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 600 ? error.status
      : error instanceof SyntaxError ? 400 : 500;
    const code = status === 500 ? 'automation_failed' : (typeof error?.code === 'string' ? error.code : 'invalid_request');
    return response.status(status).json({ error: { code, message: status === 500 ? 'The operation failed.' : error.message } });
  });
  return app;
}
