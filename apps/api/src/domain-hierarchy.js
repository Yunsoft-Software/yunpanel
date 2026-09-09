export class DomainHierarchyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainHierarchyError';
    this.code = code;
    this.status = status;
  }
}

// Hostnames have already passed the shared FQDN normalizer. Parentage is
// explicit: neither public suffixes nor aliases are used to guess ownership.
export function validateDomainParent(domains, {
  id = null, serverId, primaryDomain, parentDomainId = null,
}) {
  if (parentDomainId === null) return null;
  if (typeof parentDomainId !== 'string' || !parentDomainId || parentDomainId.length > 128) {
    throw new DomainHierarchyError('invalid_parent_domain', 'Parent domain ID must be a non-empty string or null');
  }

  const byId = new Map(domains.map((domain) => [domain.id, domain]));
  const parent = byId.get(parentDomainId);
  if (!parent) {
    throw new DomainHierarchyError('parent_domain_not_found', 'Parent domain does not exist', 404);
  }

  const visited = new Set(id === null ? [] : [id]);
  let ancestor = parent;
  while (ancestor) {
    if (visited.has(ancestor.id)) {
      throw new DomainHierarchyError('domain_parent_cycle', 'Domain hierarchy cannot contain a cycle', 409);
    }
    visited.add(ancestor.id);
    if (ancestor.serverId !== serverId) {
      throw new DomainHierarchyError('parent_server_mismatch', 'Parent and subdomain must belong to the same server', 409);
    }
    const nextId = ancestor.parentDomainId ?? null;
    if (nextId === null) break;
    ancestor = byId.get(nextId);
    if (!ancestor) {
      throw new DomainHierarchyError('parent_domain_not_found', 'An ancestor domain does not exist', 409);
    }
  }

  // The leading dot matters: badexample.com is not below example.com.
  if (typeof primaryDomain !== 'string' || typeof parent.primaryDomain !== 'string'
    || !primaryDomain.endsWith(`.${parent.primaryDomain}`)) {
    throw new DomainHierarchyError('invalid_subdomain_parent', 'Subdomain must be below the selected primary domain');
  }
  return parent.id;
}

export function validateDomainHierarchy(domains) {
  const ids = new Set();
  for (const domain of domains) {
    if (!domain || typeof domain.id !== 'string' || !domain.id || ids.has(domain.id)) {
      throw new DomainHierarchyError('invalid_domain_hierarchy', 'Domain IDs must be present and unique', 409);
    }
    ids.add(domain.id);
  }
  for (const domain of domains) validateDomainParent(domains, domain);
}
