const SITE_SCOPED_GATEWAY_PATHS = Object.freeze({
  phpmyadmin: '/api/phpmyadmin-gateway-access',
  pgadmin: '/api/pgadmin-gateway-access',
  elfinder: '/api/elfinder-gateway-access',
});

// Website-scoped vendor sessions may reach their per-request session authorizer.
// This policy only selects the panel authorization class. Each gateway must
// still prove its own server-derived target/session state before proxy access.
export function requireToolGatewaySession(policy, session, gateway) {
  const siteScoped = typeof gateway?.id === 'string'
    && SITE_SCOPED_GATEWAY_PATHS[gateway.id] === gateway.accessPath;
  if (siteScoped) {
    if (['site_manager', 'reseller', 'customer'].includes(session?.user?.role)) {
      return policy.requireSiteManagement(session);
    }
    return policy.requireManagement(session);
  }
  return policy.requireManagement(session);
}
