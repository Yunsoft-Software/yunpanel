import express from 'express';

export const ownerManagementContext = Object.freeze({
  user: Object.freeze({ id: 'test-owner', username: 'test-owner', role: 'owner' }),
  security: Object.freeze({ ownerMfaRequired: true, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
});

export const readOnlyManagementContext = Object.freeze({
  user: Object.freeze({ id: 'test-reader', username: 'test-reader', role: 'read_only' }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: false }),
  access: Object.freeze({
    mode: 'read_only',
    permissions: Object.freeze(['servers.read', 'applications.read', 'domains.read', 'certificates.read']),
  }),
});

/**
 * Direct-core tests need a server-derived auth context without reintroducing a
 * network credential. The wrapper exists only in test code and mounts before
 * the real app, matching createAuthenticatedApi's request.auth handoff.
 */
export function withPanelContext(app, context = ownerManagementContext) {
  const outer = express();
  outer.disable('x-powered-by');
  outer.use((request, _response, next) => {
    request.auth = context;
    next();
  });
  outer.use(app);
  return outer;
}
