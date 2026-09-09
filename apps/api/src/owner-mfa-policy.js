import { AuthError } from './auth-error.js';
import { describePanelAccess } from './panel-access.js';

/** Evaluate live factor state, not client fields or a cached login-time role. */
export function createOwnerMfaPolicy({ store, required = true }) {
  if (typeof required !== 'boolean') throw new TypeError('MFA policy must be a boolean');

  function describe(session) {
    if (!session) return null;
    const owner = session.user?.role === 'owner';
    let enrolled = false;
    if (owner && required) {
      enrolled = store.mfa.enabled(session.user.id);
      if (typeof enrolled !== 'boolean') throw new Error('MFA enrollment state is unavailable');
    }
    // The optional development policy does not inspect crypto state. Login still
    // requires a second factor whenever the underlying account has one enrolled.
    return describePanelAccess({
      ...session,
      security: {
        ownerMfaRequired: owner && required,
        enrollmentRequired: owner && required && !enrolled,
        managementAllowed: owner && (!required || enrolled),
      },
    });
  }

  function requireManagement(session) {
    const current = describe(session);
    if (!current) throw new AuthError('unauthorized', 'Sign in to continue.', 401);
    if (current.user.role !== 'owner') throw new AuthError('forbidden', 'Owner access is required.', 403);
    if (current.security.enrollmentRequired) {
      throw new AuthError('mfa_enrollment_required', 'Set up two-factor authentication before managing this server.', 403);
    }
    return current;
  }

  return { describe, requireManagement };
}
