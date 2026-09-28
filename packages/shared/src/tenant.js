/**
 * @fileoverview Tenant and hosting account domain models, roles, and boundary rules for YunPanel.
 * Supports: Owner -> optional single Reseller -> Customer -> Website.
 * Preserves backward compatibility with legacy site_manager roles and direct site grants.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const TENANT_ROLES = Object.freeze({
  OWNER: 'owner',
  RESELLER: 'reseller',
  CUSTOMER: 'customer',
  SITE_MANAGER: 'site_manager',
  READ_ONLY: 'read_only',
});

export const ACCOUNT_KINDS = Object.freeze({
  RESELLER: 'reseller',
  CUSTOMER: 'customer',
});

export const SUPPORTED_ACCOUNT_KINDS = Object.freeze([
  ACCOUNT_KINDS.RESELLER,
  ACCOUNT_KINDS.CUSTOMER,
]);

export const SUPPORTED_TENANT_ROLES = Object.freeze([
  TENANT_ROLES.OWNER,
  TENANT_ROLES.RESELLER,
  TENANT_ROLES.CUSTOMER,
]);

export const ALL_SYSTEM_ROLES = Object.freeze([
  TENANT_ROLES.OWNER,
  TENANT_ROLES.RESELLER,
  TENANT_ROLES.CUSTOMER,
  TENANT_ROLES.SITE_MANAGER,
  TENANT_ROLES.READ_ONLY,
]);

export const SUPPORTED_ENTITY_TYPES = Object.freeze([
  'website',
  'domain',
  'application',
  'database',
  'mail_domain',
  'mailbox',
  'mail_alias',
  'job',
]);

export class TenantValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TenantValidationError';
    this.code = code;
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function isValidTenantIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

export function assertTenantIdentifier(value, fieldName = 'id') {
  if (!isValidTenantIdentifier(value)) {
    throw new TenantValidationError(
      'invalid_identifier',
      `${fieldName} must be a valid identifier (1-128 alphanumeric, underscore, or dash characters)`,
    );
  }
  return value;
}

export function isOwnerRole(role) {
  return role === TENANT_ROLES.OWNER;
}

export function isResellerRole(role) {
  return role === TENANT_ROLES.RESELLER;
}

export function isCustomerRole(role) {
  return role === TENANT_ROLES.CUSTOMER;
}

export function isSiteManagerRole(role) {
  return role === TENANT_ROLES.SITE_MANAGER;
}

export function isReadOnlyRole(role) {
  return role === TENANT_ROLES.READ_ONLY;
}

export function isResellerAccount(account) {
  return isPlainRecord(account) && account.kind === ACCOUNT_KINDS.RESELLER;
}

export function isCustomerAccount(account) {
  return isPlainRecord(account) && account.kind === ACCOUNT_KINDS.CUSTOMER;
}

/**
 * Normalizes and validates a Reseller hosting account record.
 * A reseller cannot have a parent reseller (no reseller nesting / sub-resellers).
 */
export function normalizeResellerAccount(record) {
  if (!isPlainRecord(record)) {
    throw new TenantValidationError('invalid_reseller_record', 'Reseller record must be a plain object.');
  }

  const id = assertTenantIdentifier(record.id, 'id');

  if (record.kind !== ACCOUNT_KINDS.RESELLER) {
    throw new TenantValidationError('invalid_reseller_kind', 'Reseller record kind must be "reseller".');
  }

  if (record.resellerId !== null && record.resellerId !== undefined) {
    throw new TenantValidationError('nested_reseller_not_supported', 'Reseller cannot have a parent reseller.');
  }

  if (typeof record.active !== 'boolean') {
    throw new TenantValidationError('invalid_reseller_active', 'Reseller active state must be a boolean.');
  }

  let maxCustomers = null;
  if (record.maxCustomers !== undefined && record.maxCustomers !== null) {
    if (!Number.isSafeInteger(record.maxCustomers) || record.maxCustomers < 0) {
      throw new TenantValidationError('invalid_reseller_limits', 'maxCustomers must be a non-negative integer or null.');
    }
    maxCustomers = record.maxCustomers;
  }

  let maxWebsites = null;
  if (record.maxWebsites !== undefined && record.maxWebsites !== null) {
    if (!Number.isSafeInteger(record.maxWebsites) || record.maxWebsites < 0) {
      throw new TenantValidationError('invalid_reseller_limits', 'maxWebsites must be a non-negative integer or null.');
    }
    maxWebsites = record.maxWebsites;
  }

  return Object.freeze({
    id,
    kind: ACCOUNT_KINDS.RESELLER,
    resellerId: null,
    active: record.active,
    ...(maxCustomers !== null ? { maxCustomers } : {}),
    ...(maxWebsites !== null ? { maxWebsites } : {}),
  });
}

/**
 * Normalizes and validates a Customer hosting account record.
 * A customer can belong to an assigned Reseller (resellerId: identifier) or directly to Owner (resellerId: null).
 * A customer cannot be their own reseller (resellerId !== id).
 */
export function normalizeCustomerAccount(record) {
  if (!isPlainRecord(record)) {
    throw new TenantValidationError('invalid_customer_record', 'Customer record must be a plain object.');
  }

  const id = assertTenantIdentifier(record.id, 'id');

  if (record.kind !== ACCOUNT_KINDS.CUSTOMER) {
    throw new TenantValidationError('invalid_customer_kind', 'Customer record kind must be "customer".');
  }

  let resellerId = null;
  if (record.resellerId !== null && record.resellerId !== undefined) {
    resellerId = assertTenantIdentifier(record.resellerId, 'resellerId');
    if (resellerId === id) {
      throw new TenantValidationError('invalid_customer_parent', 'Customer cannot be its own reseller.');
    }
  }

  if (typeof record.active !== 'boolean') {
    throw new TenantValidationError('invalid_customer_active', 'Customer active state must be a boolean.');
  }

  return Object.freeze({
    id,
    kind: ACCOUNT_KINDS.CUSTOMER,
    resellerId,
    active: record.active,
  });
}

/**
 * Validates a hosting account record based on kind.
 */
export function normalizeHostingAccount(record, expectedKind = null) {
  if (!isPlainRecord(record)) {
    throw new TenantValidationError('invalid_hosting_record', 'Hosting account record must be a plain object.');
  }

  if (expectedKind && record.kind !== expectedKind) {
    throw new TenantValidationError(
      'kind_mismatch',
      `Expected hosting account kind "${expectedKind}", but got "${record.kind}".`,
    );
  }

  if (record.kind === ACCOUNT_KINDS.RESELLER) {
    return normalizeResellerAccount(record);
  }
  if (record.kind === ACCOUNT_KINDS.CUSTOMER) {
    return normalizeCustomerAccount(record);
  }

  throw new TenantValidationError('unknown_account_kind', `Unknown hosting account kind: "${record.kind}".`);
}

/**
 * Validates a Website ownership projection record { id, customerId }.
 */
export function normalizeWebsiteOwnership(record, { allowUnassigned = false } = {}) {
  if (!isPlainRecord(record)) {
    throw new TenantValidationError('invalid_website_record', 'Website record must be a plain object.');
  }

  const id = assertTenantIdentifier(record.id, 'id');
  let customerId = null;
  if (record.customerId !== null && record.customerId !== undefined) {
    customerId = assertTenantIdentifier(record.customerId, 'customerId');
  } else if (!allowUnassigned) {
    throw new TenantValidationError('invalid_identifier', 'customerId must be a valid identifier');
  }

  return Object.freeze({
    id,
    customerId,
  });
}

/**
 * Creates a normalized Tenant Context from an actor session or user object.
 * Maps:
 * - Owner: { type: 'owner', isGlobal: true, actorId }
 * - Reseller: { type: 'reseller', isGlobal: false, actorId, resellerId: null, tenantId: actorId }
 * - Customer: { type: 'customer', isGlobal: false, actorId, customerId: actorId, resellerId, isDirectOwner: resellerId === null, tenantId: resellerId ?? actorId }
 * - Legacy site_manager without hosting: { type: 'legacy_site_manager', isGlobal: false, actorId, websiteIds }
 */
export function createTenantContext(actor) {
  if (!isPlainRecord(actor) || actor.id === undefined || actor.id === null) {
    throw new TenantValidationError('invalid_actor', 'Actor must be a valid object with an id.');
  }

  const actorId = assertTenantIdentifier(actor.id, 'actor.id');
  const role = actor.role;

  if (isOwnerRole(role)) {
    return Object.freeze({
      type: 'owner',
      isGlobal: true,
      actorId,
      active: actor.active !== false,
    });
  }

  if (isReadOnlyRole(role)) {
    return Object.freeze({
      type: 'read_only',
      isGlobal: true,
      actorId,
      active: actor.active !== false,
    });
  }

  const hosting = actor.hosting ?? null;
  const kind = hosting?.kind ?? (role === 'reseller' ? 'reseller' : role === 'customer' ? 'customer' : null);

  if (kind === ACCOUNT_KINDS.RESELLER) {
    return Object.freeze({
      type: 'reseller',
      isGlobal: false,
      actorId,
      tenantId: actorId,
      resellerId: null,
      active: actor.active !== false,
      websiteIds: Array.isArray(actor.websiteIds) ? Object.freeze([...actor.websiteIds]) : Object.freeze([]),
    });
  }

  if (kind === ACCOUNT_KINDS.CUSTOMER) {
    const resellerId = hosting?.resellerId ?? null;
    return Object.freeze({
      type: 'customer',
      isGlobal: false,
      actorId,
      customerId: actorId,
      resellerId,
      isDirectOwner: resellerId === null,
      tenantId: resellerId ?? actorId,
      active: actor.active !== false,
      websiteIds: Array.isArray(actor.websiteIds) ? Object.freeze([...actor.websiteIds]) : Object.freeze([]),
    });
  }

  if (isSiteManagerRole(role)) {
    return Object.freeze({
      type: 'legacy_site_manager',
      isGlobal: false,
      actorId,
      active: actor.active !== false,
      websiteIds: Array.isArray(actor.websiteIds) ? Object.freeze([...actor.websiteIds]) : Object.freeze([]),
    });
  }

  throw new TenantValidationError('unsupported_tenant_role', `Unsupported role for tenant context: "${role}".`);
}

/**
 * Resolves the tenant scope of an entity.
 * Every entity (Website, Domain, Application, Database, MailDomain, Mailbox, Job)
 * maps to a Website, which in turn maps to a Customer and optional Reseller.
 */
export function resolveEntityTenantScope({
  entityType,
  entity,
  websiteLookup = null,
  customerLookup = null,
  domainLookup = null,
  mailDomainLookup = null,
} = {}) {
  if (!entityType || !SUPPORTED_ENTITY_TYPES.includes(entityType)) {
    throw new TenantValidationError('unsupported_entity_type', `Unsupported entity type: "${entityType}".`);
  }
  if (!isPlainRecord(entity)) {
    throw new TenantValidationError('invalid_entity_record', 'Entity must be a valid plain object.');
  }

  let websiteId = null;
  let customerId = null;

  if (entityType === 'website') {
    websiteId = entity.id;
    customerId = entity.customerId ?? null;
  } else if (entityType === 'domain') {
    websiteId = entity.websiteId ?? null;
  } else if (entityType === 'application') {
    websiteId = entity.websiteId ?? null;
    if (!websiteId && typeof websiteLookup === 'function') {
      const site = websiteLookup({ applicationId: entity.id });
      websiteId = site?.id ?? null;
    }
  } else if (entityType === 'database') {
    websiteId = entity.websiteId ?? null;
  } else if (entityType === 'mail_domain') {
    if (entity.websiteId) {
      websiteId = entity.websiteId;
    } else if (entity.webDomainId && typeof domainLookup === 'function') {
      const dom = domainLookup(entity.webDomainId);
      websiteId = dom?.websiteId ?? null;
    }
  } else if (entityType === 'mailbox' || entityType === 'mail_alias') {
    if (entity.websiteId) {
      websiteId = entity.websiteId;
    } else if (entity.mailDomainId && typeof mailDomainLookup === 'function') {
      const md = mailDomainLookup(entity.mailDomainId);
      if (md?.websiteId) {
        websiteId = md.websiteId;
      } else if (md?.webDomainId && typeof domainLookup === 'function') {
        const dom = domainLookup(md.webDomainId);
        websiteId = dom?.websiteId ?? null;
      }
    }
  } else if (entityType === 'job') {
    websiteId = entity.payload?.websiteId ?? (entity.resourceType === 'website' ? entity.resourceId : null);
    if (!websiteId && entity.payload?.mailDomainId && typeof mailDomainLookup === 'function') {
      const md = mailDomainLookup(entity.payload.mailDomainId);
      if (md?.websiteId) {
        websiteId = md.websiteId;
      } else if (md?.webDomainId && typeof domainLookup === 'function') {
        const dom = domainLookup(md.webDomainId);
        websiteId = dom?.websiteId ?? null;
      }
    }
  }

  // Resolve customerId if we have a websiteId and lookup
  if (websiteId && !customerId && typeof websiteLookup === 'function') {
    const site = websiteLookup(websiteId);
    if (site?.customerId) customerId = site.customerId;
  }

  let resellerId = null;
  let isDirectOwner = false;
  if (customerId && typeof customerLookup === 'function') {
    const cust = customerLookup(customerId);
    if (cust) {
      resellerId = cust.resellerId ?? null;
      isDirectOwner = cust.resellerId === null;
    }
  }

  return Object.freeze({
    entityType,
    entityId: entity.id ?? null,
    websiteId,
    customerId,
    resellerId,
    isDirectOwner,
  });
}

/**
 * Asserts whether an actor has authority to access an entity within the tenant boundary.
 *
 * Rules:
 * 1. Owner has global access (including repair of inactive accounts/sites).
 * 2. Reseller can access self and direct-child customer entities.
 *    Reseller is strictly forbidden from accessing other resellers or direct Owner customers.
 * 3. Customer can only access their own entities.
 * 4. Legacy site_manager access is scoped by allowed websiteIds.
 * 5. Inactive reseller or customer denies tenant access (fail-closed).
 */
export function assertTenantAccess({ actor, entityScope }) {
  if (!isPlainRecord(actor)) {
    throw new TenantValidationError('invalid_actor', 'Actor must be a valid object.');
  }
  if (!isPlainRecord(entityScope)) {
    throw new TenantValidationError('invalid_entity_scope', 'Entity scope must be a valid object.');
  }

  const context = createTenantContext(actor);

  // Owner and Read-Only have global inspection/management capability
  if (context.isGlobal) {
    return true;
  }

  if (context.active !== true) {
    throw new TenantValidationError('tenant_actor_inactive', 'Inactive account cannot access tenant resources.');
  }

  // Reseller boundary enforcement
  if (context.type === 'reseller') {
    // If the entity has a websiteId, context.websiteIds control is mandatory
    if (entityScope.websiteId) {
      // Must not belong to another reseller
      if (entityScope.resellerId && entityScope.resellerId !== context.actorId) {
        throw new TenantValidationError(
          'tenant_boundary_forbidden',
          'This resource is outside your reseller tenant boundary.',
        );
      }
      // Direct Owner customers (resellerId === null) are strictly forbidden to resellers
      if (entityScope.customerId && entityScope.resellerId === null) {
        throw new TenantValidationError(
          'tenant_boundary_forbidden',
          'This resource is outside your reseller tenant boundary.',
        );
      }
      if (entityScope.isDirectOwner) {
        throw new TenantValidationError(
          'tenant_boundary_forbidden',
          'This resource is outside your reseller tenant boundary.',
        );
      }
      // Must be present in reseller's allowed websiteIds
      if (!context.websiteIds?.includes(entityScope.websiteId)) {
        throw new TenantValidationError(
          'tenant_boundary_forbidden',
          'This resource is outside your reseller tenant boundary.',
        );
      }
      return true;
    }

    // If the entity is a hosting account matching self:
    if (entityScope.entityType === 'account' && entityScope.entityId === context.actorId) {
      return true;
    }

    // Direct child customer account (when no websiteId):
    if (entityScope.customerId && entityScope.resellerId === context.actorId) {
      return true;
    }
    if (entityScope.entityType === 'account' && entityScope.resellerId === context.actorId) {
      return true;
    }

    throw new TenantValidationError(
      'tenant_boundary_forbidden',
      'This resource is outside your reseller tenant boundary.',
    );
  }

  // Customer boundary enforcement
  if (context.type === 'customer') {
    // If the entity has a websiteId, context.websiteIds control is mandatory
    if (entityScope.websiteId) {
      // Must be present in customer's allowed websiteIds
      if (!context.websiteIds?.includes(entityScope.websiteId)) {
        throw new TenantValidationError(
          'tenant_boundary_forbidden',
          'This resource is outside your customer tenant boundary.',
        );
      }
      // If customerId is present, it must match self
      if (entityScope.customerId && entityScope.customerId !== context.actorId) {
        throw new TenantValidationError(
          'tenant_boundary_forbidden',
          'This resource is outside your customer tenant boundary.',
        );
      }
      return true;
    }

    // Self account:
    if (entityScope.entityType === 'account' && entityScope.entityId === context.actorId) {
      return true;
    }

    // Must match own customerId (when no websiteId):
    if (entityScope.customerId && entityScope.customerId === context.actorId) {
      return true;
    }

    throw new TenantValidationError(
      'tenant_boundary_forbidden',
      'This resource is outside your customer tenant boundary.',
    );
  }

  // Legacy site_manager backward compatibility
  if (context.type === 'legacy_site_manager') {
    if (entityScope.websiteId && context.websiteIds?.includes(entityScope.websiteId)) {
      return true;
    }
    throw new TenantValidationError(
      'tenant_boundary_forbidden',
      'This resource is outside your site permissions.',
    );
  }

  throw new TenantValidationError('tenant_boundary_forbidden', 'Access denied.');
}

/**
 * Filters an array of items by the actor's tenant boundary.
 */
export function filterByTenantBoundary(items, actor, resolveScopeFn) {
  if (!Array.isArray(items)) return [];
  const context = createTenantContext(actor);
  if (context.isGlobal) {
    return [...items];
  }

  return items.filter((item) => {
    try {
      const scope = typeof resolveScopeFn === 'function' ? resolveScopeFn(item) : item;
      assertTenantAccess({ actor, entityScope: scope });
      return true;
    } catch {
      return false;
    }
  });
}
