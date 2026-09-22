import { AuthError } from './auth-error.js';

// The legacy phpMyAdmin proxy keeps a separate SQL session cookie. Merely
// accepting a panel role here is NOT enough: after switching panel accounts in
// the same browser that cookie could still represent the previous SQL account.
// Keep the existing Owner gate until the proxy can bind every vendor request to
// the current panel session AND its current Website assignment. A scoped signon
// capability protects issuance, but does not supply this ongoing binding.
export function requireToolGatewaySession(policy, session, gateway) {
  if (gateway?.id === 'phpmyadmin'
    && gateway.accessPath === '/api/phpmyadmin-gateway-access'
    && session?.user?.role === 'site_manager') {
    policy.requireSiteManagement(session);
    throw new AuthError('phpmyadmin_site_session_binding_required',
      'Site phpMyAdmin access requires a panel-bound SQL session. Database controls remain available in the website workspace.', 403);
  }
  return policy.requireManagement(session);
}
