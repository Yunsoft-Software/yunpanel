function validSecurity(session) {
  const security = session?.security;
  return security && typeof security.ownerMfaRequired === 'boolean'
    && typeof security.enrollmentRequired === 'boolean' && typeof security.managementAllowed === 'boolean';
}

function validAccess(session) {
  const access = session?.access;
  return access && ['management', 'read_only', 'self_service'].includes(access.mode)
    && Array.isArray(access.permissions) && access.permissions.every((permission) => typeof permission === 'string');
}

/** Unknown policy metadata must not render privileged views (e.g. mixed builds). */
export function ownerAccess(session) {
  if (!validSecurity(session) || !validAccess(session)) return 'unknown';
  if (session?.user?.role === 'read_only') {
    return session.access.mode === 'read_only' && !session.access.permissions.includes('*') ? 'read_only' : 'denied';
  }
  if (session?.user?.role !== 'owner') return 'denied';
  if (session.security.enrollmentRequired) return 'enrollment';
  return session.security.managementAllowed && session.access.mode === 'management' && session.access.permissions.includes('*') ? 'management' : 'denied';
}

export function panelPermission(session, permission) {
  if (typeof permission !== 'string' || !permission || !validSecurity(session) || !validAccess(session)) return false;
  const access = ownerAccess(session);
  if (access === 'management') return true;
  return access === 'read_only' && permission !== '*' && session.access.permissions.includes(permission);
}

/** Enrollment remains visible after session rotation until codes are acknowledged. */
export function enrollmentCanContinue({ session, busy = false, sensitive = false }) {
  return ownerAccess(session) === 'management' && !busy && !sensitive;
}
