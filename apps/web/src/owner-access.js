/** Unknown policy metadata must not render privileged views (e.g. mixed builds). */
export function ownerAccess(session) {
  const security = session?.security;
  if (!security || typeof security.ownerMfaRequired !== 'boolean'
    || typeof security.enrollmentRequired !== 'boolean' || typeof security.managementAllowed !== 'boolean') return 'unknown';
  if (session?.user?.role !== 'owner') return 'denied';
  if (security.enrollmentRequired) return 'enrollment';
  return security.managementAllowed ? 'management' : 'denied';
}

/** Enrollment remains visible after session rotation until codes are acknowledged. */
export function enrollmentCanContinue({ session, busy = false, sensitive = false }) {
  return ownerAccess(session) === 'management' && !busy && !sensitive;
}
