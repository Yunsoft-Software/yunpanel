// A gateway session grants access to the phpMyAdmin UI, never a SQL account.
// Database access still requires the Website-bound, short-lived signon handoff.
export function requireToolGatewaySession(policy, session, gateway) {
  const assigned = session?.user?.websiteIds;
  const sitePhpMyAdmin = gateway?.id === 'phpmyadmin'
    && gateway.accessPath === '/api/phpmyadmin-gateway-access'
    && session?.user?.role === 'site_manager'
    && Array.isArray(assigned) && assigned.length > 0
    && assigned.every((id) => typeof id === 'string' && id.length > 0);
  if (sitePhpMyAdmin) {
    const authorized = policy.requireSiteManagement(session);
    if (authorized?.access?.mode === 'site_management'
      && authorized.security?.managementAllowed === true) return authorized;
  }
  // Owner MFA, read-only rejection and all other tool policies are unchanged.
  return policy.requireManagement(session);
}
