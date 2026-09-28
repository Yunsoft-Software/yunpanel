import { AuthError } from './auth-error.js';
import {
  TENANT_ROLES,
  ACCOUNT_KINDS,
  normalizeResellerAccount,
  normalizeCustomerAccount,
  normalizeHostingAccount,
  normalizeWebsiteOwnership,
  createTenantContext,
  resolveEntityTenantScope,
  assertTenantAccess as sharedAssertTenantAccess,
  filterByTenantBoundary,
  assertTenantIdentifier,
} from '@yunpanel/shared';

export class TenantBoundaryError extends AuthError {
  constructor(code = 'tenant_boundary_forbidden', message = 'This resource is outside your tenant boundary.', status = 403) {
    super(code, message, status);
    this.name = 'TenantBoundaryError';
  }
}

const denied = (code = 'tenant_boundary_forbidden', message = 'This resource is outside your tenant boundary.') =>
  new TenantBoundaryError(code, message, 403);

const invalid = (message = 'A current, explicit account relationship is required.') =>
  new AuthError('invalid_reseller_record', message, 400);

/**
 * Extracts and normalizes the actor tenant classification from request.auth or a user object.
 */
export function extractActorTenant(authOrUser) {
  const user = authOrUser?.user ?? authOrUser;
  if (!user || typeof user !== 'object') {
    throw new AuthError('unauthorized', 'Authentication required.', 401);
  }

  const role = user.role;
  const hosting = user.hosting ?? null;
  const actorId = user.id;
  const active = user.active !== false;
  const websiteIds = Array.isArray(user.websiteIds) ? Object.freeze([...user.websiteIds]) : Object.freeze([]);

  const isOwner = role === TENANT_ROLES.OWNER;
  const isReadOnly = role === TENANT_ROLES.READ_ONLY;
  const isReseller = hosting?.kind === ACCOUNT_KINDS.RESELLER || role === TENANT_ROLES.RESELLER;
  const isCustomer = hosting?.kind === ACCOUNT_KINDS.CUSTOMER || role === TENANT_ROLES.CUSTOMER;
  const isLegacySiteManager = role === TENANT_ROLES.SITE_MANAGER && !isReseller && !isCustomer;
  const isDirectOwnerCustomer = isCustomer && hosting?.resellerId === null;

  return Object.freeze({
    actorId,
    role,
    kind: isReseller ? ACCOUNT_KINDS.RESELLER : isCustomer ? ACCOUNT_KINDS.CUSTOMER : null,
    resellerId: isCustomer ? (hosting?.resellerId ?? null) : null,
    customerId: isCustomer ? actorId : null,
    isOwner,
    isReadOnly,
    isReseller,
    isCustomer,
    isDirectOwnerCustomer,
    isLegacySiteManager,
    isGlobal: isOwner || isReadOnly,
    active,
    websiteIds,
  });
}

/**
 * Asserts that a Customer belongs to the given Reseller's tenant boundary.
 * Prevents cross-tenant access to another reseller's customer or a direct Owner customer.
 */
export function assertCustomerBelongsToReseller({ actor, customer, reseller = null }) {
  const actorTenant = extractActorTenant(actor);
  if (actorTenant.isOwner) return; // Owner can manage all customers

  if (!actorTenant.isReseller) {
    throw denied('tenant_boundary_forbidden', 'Only Owner or the assigned Reseller may manage customer accounts.');
  }

  if (!actorTenant.active) {
    throw denied('tenant_actor_inactive', 'Inactive reseller cannot perform account operations.');
  }

  const normalizedCustomer = normalizeCustomerAccount(customer);
  if (normalizedCustomer.resellerId === null) {
    // Direct Owner customer cannot be managed by any reseller
    throw denied('tenant_boundary_forbidden', 'Direct Owner customers are outside reseller tenant boundary.');
  }

  if (normalizedCustomer.resellerId !== actorTenant.actorId) {
    // Customer belongs to another reseller
    throw denied('tenant_boundary_forbidden', 'This customer belongs to another reseller.');
  }

  if (reseller !== null) {
    const normalizedReseller = normalizeResellerAccount(reseller);
    if (normalizedReseller.id !== actorTenant.actorId || !normalizedReseller.active) {
      throw denied('tenant_boundary_forbidden', 'Parent reseller is invalid or inactive.');
    }
  }
}

/**
 * Asserts that a Website belongs to the actor's tenant boundary.
 */
export function assertWebsiteBelongsToTenant({ actor, website, customer = null, reseller = null }) {
  const actorTenant = extractActorTenant(actor);
  if (actorTenant.isOwner) return; // Owner can access/repair any website

  if (!actorTenant.active) {
    throw denied('tenant_actor_inactive', 'Inactive account cannot access tenant resources.');
  }

  if (!website || typeof website !== 'object') {
    throw denied('invalid_website_record', 'Website must be a valid object.');
  }

  const websiteId = website.id;
  if (!websiteId) {
    throw denied('invalid_identifier', 'Website must have a valid id.');
  }

  // Legacy site_manager only requires websiteIds membership, regardless of customer assignment
  if (actorTenant.isLegacySiteManager) {
    if (!actorTenant.websiteIds.includes(websiteId)) {
      throw denied('tenant_boundary_forbidden', 'This website is not granted to this site manager.');
    }
    return;
  }

  const normalizedWebsite = normalizeWebsiteOwnership(website);

  if (actorTenant.isCustomer) {
    if (normalizedWebsite.customerId !== actorTenant.actorId) {
      throw denied('tenant_boundary_forbidden', 'This website belongs to another customer.');
    }
    if (!actorTenant.websiteIds.includes(normalizedWebsite.id)) {
      throw denied('tenant_boundary_forbidden', 'This website is not attached to your account.');
    }
    return;
  }

  if (actorTenant.isReseller) {
    if (customer !== null) {
      const normalizedCustomer = normalizeCustomerAccount(customer);
      if (normalizedCustomer.id !== normalizedWebsite.customerId) {
        throw denied('tenant_boundary_forbidden', 'Website customer ID does not match supplied customer.');
      }
      if (normalizedCustomer.resellerId !== actorTenant.actorId) {
        throw denied('tenant_boundary_forbidden', 'This website belongs to another tenant.');
      }
    }
    if (!actorTenant.websiteIds.includes(normalizedWebsite.id)) {
      throw denied('tenant_boundary_forbidden', 'This website is outside your reseller tenant boundary.');
    }
    return;
  }

  throw denied();
}

/**
 * Validates tenant boundary for any entity (Website, Domain, Application, Database, MailDomain, Mailbox, Job).
 */
export function assertEntityTenantBoundary({
  actor,
  entityType = 'website',
  entityId = null,
  websiteId = null,
  customerId = null,
  resellerId = undefined,
}) {
  const actorTenant = extractActorTenant(actor);
  if (actorTenant.isOwner || actorTenant.isReadOnly) return true;

  if (!actorTenant.active) {
    throw denied('tenant_actor_inactive', 'Inactive account cannot access tenant resources.');
  }

  if (actorTenant.isCustomer) {
    if (customerId && customerId !== actorTenant.actorId) {
      throw denied('tenant_boundary_forbidden', 'This entity belongs to another customer.');
    }
    if (websiteId && !actorTenant.websiteIds.includes(websiteId)) {
      throw denied('tenant_boundary_forbidden', 'This entity is outside your customer tenant scope.');
    }
    if (!websiteId && entityType === 'account' && entityId && entityId !== actorTenant.actorId) {
      throw denied('tenant_boundary_forbidden', 'This entity is outside your customer tenant scope.');
    }
    return true;
  }

  if (actorTenant.isReseller) {
    // Reseller accessing self account
    if (entityType === 'account' && entityId === actorTenant.actorId) {
      return true;
    }

    // Direct Owner resources have resellerId === null and must be explicitly rejected
    if (resellerId === null) {
      throw denied('tenant_boundary_forbidden', 'Direct Owner resources are outside reseller tenant boundary.');
    }

    // Foreign reseller entity rejected
    if (resellerId && resellerId !== actorTenant.actorId) {
      throw denied('tenant_boundary_forbidden', 'This entity belongs to another reseller.');
    }

    // Website-scoped entity must be in reseller's allowed websiteIds
    if (websiteId) {
      if (!actorTenant.websiteIds.includes(websiteId)) {
        throw denied('tenant_boundary_forbidden', 'This entity is outside your reseller tenant boundary.');
      }
      return true;
    }

    // If there is no websiteId, must belong to reseller's direct-child customer
    if (resellerId === actorTenant.actorId) {
      return true;
    }

    throw denied('tenant_boundary_forbidden', 'This entity is outside your reseller tenant boundary.');
  }

  if (actorTenant.isLegacySiteManager) {
    if (websiteId && !actorTenant.websiteIds.includes(websiteId)) {
      throw denied('tenant_boundary_forbidden', 'This entity is outside your site permissions.');
    }
    if (!websiteId) {
      throw denied('tenant_boundary_forbidden', 'This entity is outside your site permissions.');
    }
    return true;
  }

  throw denied();
}

/**
 * Filters a collection of resources, ensuring no foreign tenant metadata or items leak into responses.
 */
export function sanitizeTenantCollection(items, actor, scopeExtractor = (item) => item) {
  if (!Array.isArray(items)) return [];
  const actorTenant = extractActorTenant(actor);
  if (actorTenant.isOwner || actorTenant.isReadOnly) {
    return [...items];
  }

  return items.filter((item) => {
    try {
      const scope = scopeExtractor(item);
      assertEntityTenantBoundary({
        actor: actorTenant,
        entityType: scope.entityType ?? 'website',
        entityId: scope.entityId ?? scope.id ?? null,
        websiteId: scope.websiteId ?? (scope.entityType === 'website' ? scope.id : null),
        customerId: scope.customerId ?? null,
        resellerId: scope.resellerId !== undefined ? scope.resellerId : undefined,
      });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Creates an Express middleware for tenant boundary enforcement.
 */
export function createTenantBoundaryMiddleware(options = {}) {
  const { websiteRegistry, customerLookup, websiteLookup } = options;

  return async function tenantBoundaryMiddleware(request, response, next) {
    const auth = request.auth;
    if (!auth || !auth.user) return next();

    try {
      const actorTenant = extractActorTenant(auth);
      if (actorTenant.isGlobal) return next();

      if (!actorTenant.active) {
        throw denied('tenant_actor_inactive', 'Inactive account cannot access tenant resources.');
      }

      const url = new URL(request.originalUrl ?? request.url, 'http://panel.internal');
      const path = url.pathname.replace(/\/$/, '');
      const method = request.method;

      // Plesk permission boundaries for non-global accounts
      if (/^\/api\/(?:panel\/settings|settings(?:\/|$))/.test(path)) {
        throw denied('tenant_boundary_forbidden', 'Global server settings are outside tenant boundary.');
      }

      if (/^\/api\/(?:system\/packages|system\/upgrade)/.test(path)
        || /^\/api\/servers\/[^/]+\/(?:system\/packages|system\/upgrade|services|node-runtimes)/.test(path)) {
        throw denied('tenant_boundary_forbidden', 'Server package and service management is outside tenant boundary.');
      }

      if (/^\/api\/backups(?:\/|$)/.test(path)) {
        throw denied('tenant_boundary_forbidden', 'Global backup management is outside tenant boundary.');
      }

      if (method === 'POST' && (path === '/api/websites' || path === '/api/applications')) {
        throw denied('tenant_boundary_forbidden', 'Direct top-level website or application creation is outside tenant boundary.');
      }

      if (/^\/api\/servers\/[^/]+\/databases(?:\/|$)/.test(path)) {
        throw denied('tenant_boundary_forbidden', 'Server-level database administration is outside tenant boundary.');
      }

      if (/^\/api\/users(?:\/|$)/.test(path) && !path.startsWith('/api/users/hosting/accounts')) {
        throw denied('tenant_boundary_forbidden', 'User administration is outside tenant boundary.');
      }

      // Customer collection
      if (path === '/api/customers' || path === '/api/customers/') {
        if (actorTenant.isCustomer || actorTenant.isLegacySiteManager) {
          throw denied('tenant_boundary_forbidden', 'Customer collection is outside tenant scope.');
        }
      }

      // Check customer route parameter
      const customerMatch = /^\/api\/customers\/([^/]+)(?:\/|$)/.exec(path);
      if (customerMatch) {
        const targetCustomerId = customerMatch[1];
        if (actorTenant.isReseller) {
          if (typeof customerLookup !== 'function') {
            throw new TenantBoundaryError(
              'tenant_boundary_dependency_unavailable',
              'Customer lookup dependency is required for tenant validation.',
              503,
            );
          }
          let customer;
          try {
            customer = await customerLookup(targetCustomerId);
          } catch (err) {
            if (err instanceof AuthError) throw err;
            throw new TenantBoundaryError(
              'tenant_boundary_dependency_unavailable',
              'Customer lookup is unavailable.',
              503,
            );
          }
          if (!customer) {
            response.setHeader?.('Cache-Control', 'no-store');
            return response.status(404).json({ error: { code: 'customer_not_found', message: 'Customer not found.' } });
          }
          assertCustomerBelongsToReseller({ actor: auth.user, customer });
        } else if (actorTenant.isCustomer) {
          if (targetCustomerId !== actorTenant.actorId) {
            throw denied('tenant_boundary_forbidden', 'This customer is outside your tenant boundary.');
          }
        } else {
          // Unauthorized roles (such as legacy site_manager) cannot access customer management routes
          throw denied('tenant_boundary_forbidden', 'You do not have permission to access customer resources.');
        }
      }

      // Check website route parameter
      const websiteMatch = /^\/api\/websites\/([^/]+)(?:\/|$)/.exec(path);
      if (websiteMatch) {
        const targetWebsiteId = websiteMatch[1];
        if (!actorTenant.websiteIds.includes(targetWebsiteId)) {
          throw denied('tenant_boundary_forbidden', 'This website is outside your tenant boundary.');
        }
      }

      const serverWebsiteMatch = /^\/api\/servers\/[^/]+\/websites\/([^/]+)(?:\/|$)/.exec(path);
      if (serverWebsiteMatch) {
        const targetWebsiteId = serverWebsiteMatch[1];
        if (!actorTenant.websiteIds.includes(targetWebsiteId)) {
          throw denied('tenant_boundary_forbidden', 'This website is outside your tenant boundary.');
        }
      }

      // Domain creation website validation
      if (method === 'POST' && path === '/api/domains') {
        const websiteId = request.body?.websiteId;
        if (!websiteId || !actorTenant.websiteIds.includes(websiteId)) {
          throw denied('tenant_boundary_forbidden', 'Domain must be created within an assigned website in your tenant.');
        }
      }

      // Audit query validation
      if (path === '/api/audit' || path.startsWith('/api/audit/')) {
        if (actorTenant.isLegacySiteManager) {
          throw denied('tenant_boundary_forbidden', 'Site manager cannot access audit history.');
        }
        const query = url.searchParams;
        const queriedActorId = query.get('actorId');
        if (queriedActorId) {
          if (actorTenant.isCustomer && queriedActorId !== actorTenant.actorId) {
            throw denied('tenant_boundary_forbidden', 'Cannot query audit history for foreign actor.');
          }
          if (actorTenant.isReseller && queriedActorId !== actorTenant.actorId) {
            if (typeof customerLookup === 'function') {
              let cust = null;
              try {
                cust = await Promise.resolve(customerLookup(queriedActorId));
              } catch {
                cust = null;
              }
              if (!cust || cust.resellerId !== actorTenant.actorId) {
                throw denied('tenant_boundary_forbidden', 'Cannot query audit history for foreign actor.');
              }
            } else {
              throw denied('tenant_boundary_forbidden', 'Cannot query audit history for foreign actor.');
            }
          }
        }
        const queriedResourceType = query.get('resourceType');
        const queriedResourceId = query.get('resourceId');
        if (queriedResourceType && queriedResourceId) {
          if (queriedResourceType === 'website') {
            if (!actorTenant.websiteIds.includes(queriedResourceId)) {
              throw denied('tenant_boundary_forbidden', 'Cannot query audit history for foreign website.');
            }
          } else if (queriedResourceType === 'customer') {
            if (actorTenant.isCustomer && queriedResourceId !== actorTenant.actorId) {
              throw denied('tenant_boundary_forbidden', 'Cannot query audit history for foreign customer.');
            }
            if (actorTenant.isReseller) {
              if (typeof customerLookup === 'function') {
                let cust = null;
                try {
                  cust = await Promise.resolve(customerLookup(queriedResourceId));
                } catch {
                  cust = null;
                }
                if (!cust || cust.resellerId !== actorTenant.actorId) {
                  throw denied('tenant_boundary_forbidden', 'Cannot query audit history for foreign customer.');
                }
              } else {
                throw denied('tenant_boundary_forbidden', 'Cannot query audit history for foreign customer.');
              }
            }
          } else if (!['domain', 'mailbox', 'database', 'application'].includes(queriedResourceType)) {
            throw denied('tenant_boundary_forbidden', `Cannot query audit history for ${queriedResourceType}.`);
          }
        }
      }

      return next();
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 403;
      response.setHeader?.('Cache-Control', 'no-store');
      return response.status(status).json({
        error: {
          code: error.code ?? 'tenant_boundary_forbidden',
          message: error.message || 'This resource is outside your tenant boundary.',
        },
      });
    }
  };
}

export {
  normalizeResellerAccount,
  normalizeCustomerAccount,
  normalizeHostingAccount,
  normalizeWebsiteOwnership,
  createTenantContext,
  resolveEntityTenantScope,
  sharedAssertTenantAccess,
  filterByTenantBoundary,
};
