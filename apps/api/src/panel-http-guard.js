import { readOnlyPermission } from './panel-access.js';

function pathname(request) {
  try {
    return new URL(request.originalUrl ?? request.url ?? '/', 'http://yunpanel.internal').pathname;
  } catch {
    return '';
  }
}

function deny(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

/**
 * Defense-in-depth guard for the internal Express application.
 *
 * The public authentication listener must derive request.auth from the live
 * session/MFA policy before dispatching management requests. Network headers,
 * cookies and bearer values are deliberately ignored here so mounting the core
 * app directly never creates a second authentication boundary.
 */
export function requirePanelRouteAccess(request, response, next) {
  const auth = request.auth;
  if (!auth?.user || !auth?.access || !auth?.security) {
    return deny(response, 401, 'unauthorized', 'Authenticated panel context is required.');
  }

  if (
    auth.user.role === 'owner'
    && auth.access.mode === 'management'
    && auth.security.managementAllowed === true
    && Array.isArray(auth.access.permissions)
    && auth.access.permissions.includes('*')
  ) {
    return next();
  }

  if (auth.user.role === 'read_only' && auth.access.mode === 'read_only') {
    const permission = readOnlyPermission(request.method, pathname(request));
    if (permission && Array.isArray(auth.access.permissions) && auth.access.permissions.includes(permission)) {
      return next();
    }
  }

  return deny(response, 403, 'forbidden', 'This account cannot access that panel operation.');
}
