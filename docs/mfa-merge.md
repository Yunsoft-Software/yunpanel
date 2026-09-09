# Final MFA branch reconciliation — 2026-09-09

This supplements `mfa.md` with the second merge and its final focused validation. The original four MFA commits were merged in `70f8c154`. During integration, the existing `work/mfa-authentication` branch advanced by six more commits to `9832003e11d84cf7e92ddb615ce7657ca790338b`. This reconciliation uses two parents: current main `777bc09302302529b3f0c3ac284595901b12e30b` and that exact branch head. No new branch, force update, squash or history rewrite is used. The original source and all commits remain reachable through the merge parents.

## Resolution of overlapping work

- Keep main's mounted MFA-aware `AuthGate`/`AccountDialog`, domain hierarchy and completed stale-401 cookie correction. The older branch's note that these were unmounted/unfixed describes its own snapshot, not the merged main implementation.
- Combine both session-client contracts into one in-memory generation/CSRF/transition model. Preserve `sessionVersion`, `sessionTransitionPending`, `beginSessionTransition` and the branch's `sessionGeneration`, `isSessionChangePending`, `changesSession` and `session_superseded` behavior. Stale responses carry both the abort name used by main and the code used by the branch. Login and verification now also use serialized session-changing requests.
- Preserve the six branch `session-rotation.test.js` tests byte-for-byte (blob `c2b707ed4ca63657be25c22bad5875c576e01a67`) and run them alongside main's tests.
- Keep the stricter mounted LoginForm, proof validation, cancellation, pending-request cleanup and expiry handling; incorporate method reset and disabled autofill for recovery-code input. No second login form is mounted.
- Preserve the branch's MfaPanel prop contract as an adapter to the single MfaSettings implementation, including disabled/busy/recovery-visibility callbacks. Merge its expired-enrollment reset, unavailable-key guidance and additional translated error codes. Shared styling remains in the mounted `mfa.css` rather than running two independent factor UIs.
- Keep the current README, authentication runbook, remaining-work plan and `todo.md` T1b, which already include the branch's outstanding native-runtime, device/browser, schema/key recovery and public-root MFA-policy gates. Completed mounting/cookie fixes are not re-added as open implementation work.
- Preserve the branch author's original report, including its test qualifications and previously blocked writes, verbatim at `history/mfa-branch-9832003.md`. That file is an archived pre-merge report, not current deployment instructions. Its compatibility-bridge tests were not run by this reconciliation and no bridge is a product dependency.

## Final focused verification

**33 tests passed, 0 failed, 0 skipped**, using the available Node 22.16.0 and the merged source subset:

```bash
node --test \
  apps/web/test/session-race.test.js \
  apps/web/test/session-transition.test.js \
  apps/web/test/session-rotation.test.js \
  apps/web/test/auth-protocol.test.js \
  apps/api/test/mfa-cookie-boundary.test.js
```

This is the earlier 27-test set plus the six preserved branch client tests, not a claim that all historical/backend tests were rerun. Client tests use controlled fetch responses; the six loopback HTTP tests use auth-store and downstream-handler doubles. Native Node 24 Argon2, OTPAuth/SQLite integration, the full Express application, dependency installation, Vite production build, real React/browser layout and Ubuntu packaging were not validated by this set. JSX syntax checks cover the five screen/adapter modules only.

Keep the real-environment work in `todo.md` T1a/T1b/T3a open. Test correct server/authenticator clock synchronization without widening TOTP tolerance; confirm password plus unused recovery code when the encryption key is unavailable. For a lost factor-changing response, reauthenticate and inspect actual state rather than blindly repeating a mutation. The controls exist in code but still need real device/browser acceptance.

No live server was accessed or deployed, no agent/root migration or terminal was introduced, and no GitHub Actions were added or invoked. Future work stays on main unless the user explicitly requests another branch.
