import { timingSafeEqual } from 'node:crypto';

const DEVELOPMENT_ADMIN_TOKEN = 'development-admin-token';

export function resolveBootstrapAdminToken({ environment = process.env.NODE_ENV } = {}) {
  if (process.env.YUNPANEL_ADMIN_BOOTSTRAP_TOKEN) return process.env.YUNPANEL_ADMIN_BOOTSTRAP_TOKEN;
  if (environment === 'development') return DEVELOPMENT_ADMIN_TOKEN;
  return null;
}

function tokenMatches(headerValue, expectedToken) {
  if (!expectedToken || typeof headerValue !== 'string' || !headerValue.startsWith('Bearer ')) return false;

  const provided = Buffer.from(headerValue.slice(7));
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createBootstrapAdminGuard({ token }) {
  return function requireBootstrapAdmin(request, response, next) {
    if (!token) {
      return response.status(503).json({
        error: {
          code: 'bootstrap_admin_not_configured',
          message: 'Bootstrap management authentication is not configured',
        },
      });
    }

    if (!tokenMatches(request.headers.authorization, token)) {
      return response.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Management authentication failed',
        },
      });
    }

    return next();
  };
}
