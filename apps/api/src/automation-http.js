// Key-only machine API under /api/automation. The auth entry sends only these paths
// here, after refusing cookies and browser origins, so a key never reaches panel
// routes and a panel session never reaches automation routes.
const API_KEY = Symbol('yunpanel.apiKey');

export function automationKey(request) {
  return request?.[API_KEY] ?? null;
}

export function createAutomationHandler({ apiKeyStore } = {}) {
  if (!apiKeyStore || typeof apiKeyStore.authenticate !== 'function') throw new Error('Automation API requires the API key store');
  return async function authenticateAutomation(request, response, handler) {
    const header = request.headers.authorization;
    const key = typeof header === 'string' && header.startsWith('Bearer ') ? await apiKeyStore.authenticate(header.slice(7)) : null;
    if (!key) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid API key is required.' } }));
      return;
    }
    Object.defineProperty(request, API_KEY, { value: key, enumerable: false, configurable: false, writable: false });
    return handler(request, response);
  };
}

// Routes mounted inside the management app. They accept only key-authenticated requests.
export function requireAutomationKey(request, response, next) {
  if (automationKey(request) && !request.auth) return next();
  return response.status(401).json({ error: { code: 'unauthorized', message: 'A valid API key is required.' } });
}

export function mountAutomationRoutes(app) {
  app.get('/api/automation/whoami', requireAutomationKey, (request, response) => {
    const key = automationKey(request);
    return response.json({ data: { id: key.id, name: key.name, scope: key.scope } });
  });
}
