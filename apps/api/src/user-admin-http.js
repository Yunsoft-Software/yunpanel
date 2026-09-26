import { AuthError } from './auth-error.js';
import { handleHostingAccountAdmin, isHostingAccountPath } from './hosting-account-http.js';

function pagination(query) {
  for (const key of query.keys()) {
    if (!['limit', 'offset'].includes(key) || query.getAll(key).length !== 1 || !/^\d+$/.test(query.get(key))) {
      throw new AuthError('invalid_pagination', 'Use one numeric limit and offset.');
    }
  }
  return { limit: query.has('limit') ? Number(query.get('limit')) : 50, offset: query.has('offset') ? Number(query.get('offset')) : 0 };
}

/** Called only AFTER the shared HTTP session, Origin/CSRF and role boundary.
 * Hosting-account subroutes derive live Owner/reseller scope in their own store;
 * generic user administration still repeats Owner/MFA authorization on writes.
 */
export async function handleUserAdmin({ request, response, pathname, query, store, rawToken, requireManagement, readJson, json }) {
  if (isHostingAccountPath(pathname)) {
    return handleHostingAccountAdmin({ request, response, pathname, query, store, rawToken, requireManagement, readJson, json });
  }
  const collection = pathname === '/api/users';
  const match = /^\/api\/users\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  if (!collection && !match) throw new AuthError('not_found', 'Account route not found.', 404);
  if (collection && request.method === 'GET') {
    return json(response, 200, { data: store.users.list(rawToken, requireManagement, pagination(query)) });
  }
  if (collection && request.method === 'POST') {
    const body = await readJson(request);
    const user = await store.users.create(rawToken, requireManagement, body);
    return json(response, 201, { data: { user, sessionRevoked: false } });
  }
  if (match && ['PATCH', 'DELETE'].includes(request.method)) {
    const body = await readJson(request);
    let patchBody = body;
    if (request.method === 'PATCH' && body && Object.hasOwn(body, 'password')) {
      const hasher = store.hashPassword || (store.users && store.users.hashPassword);
      if (typeof hasher === 'function') {
        const passwordHash = await hasher(body.password);
        patchBody = { ...body, passwordHash };
        delete patchBody.password;
      }
    }
    const user = request.method === 'PATCH' ? store.users.update(rawToken, requireManagement, match[1], patchBody)
      : store.users.remove(rawToken, requireManagement, match[1], body);
    // No Set-Cookie here: a delayed self-edit response must not delete a newer
    // login cookie. The session-aware browser client clears only its own state.
    return json(response, 200, { data: { ...(user ? { user } : { deleted: true }), sessionRevoked: !store.getSession(rawToken) } });
  }
  response.setHeader('allow', collection ? 'GET, POST' : 'PATCH, DELETE');
  throw new AuthError('method_not_allowed', 'Unsupported account operation.', 405);
}
