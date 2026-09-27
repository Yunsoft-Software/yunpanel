import { AuthError } from './auth-error.js';

// phpMyAdmin is the only integrated vendor session that can be opened from a
// Website-scoped account. The public gateway must still prove the vendor cookie
// through the session authorizer on every request; this policy only chooses the
// correct panel authorization class before that per-request binding check runs.
export function requireToolGatewaySession(policy, session, gateway) {
  if (gateway?.id === 'phpmyadmin'
    && gateway.accessPath === '/api/phpmyadmin-gateway-access') {
    if (session?.user?.role === 'site_manager') {
      return policy.requireSiteManagement(session);
    }
    return policy.requireManagement(session);
  }
  return policy.requireManagement(session);
}
