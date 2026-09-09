# Required Owner MFA — current HTTPS access policy

## Behavior and upgrade impact

HTTPS management now requires an authenticated Owner with an enrolled factor. This applies to existing and newly created accounts, not just the future root terminal. A successful password login for an unenrolled Owner creates a **self-service session**, not permission to inspect or modify servers, applications, domains, jobs, environment variables or other management resources. Protected management requests return `403 mfa_enrollment_required` before the internal handler is called.

The only enrollment exemption is the existing explicit loopback HTTP development mode (`development: true` plus a localhost/loopback HTTP public origin). Setting development mode with an HTTPS origin does not bypass the policy. There is no production HTTP flag or browser-supplied header that disables it. This change does not create a root daemon, terminal, unrestricted shell endpoint or new agent channel.

`owner-mfa-policy.js` checks current factor state by account ID on every management request. It does not trust client-supplied security fields or a cached login-time flag. Missing/malformed enrollment state fails closed. Read Only accounts retain their existing denial of legacy Owner endpoints; resource-scoped read permissions and user administration are still planned work.

Session responses from login, verification, refresh, keep-alive and factor rotation include `security.ownerMfaRequired`, `security.enrollmentRequired` and `security.managementAllowed`. `GET /api/auth/security` exposes only the current authenticated account's policy state. Existing exact self-service routes (own session list, password change, enrollment, recovery and logout) remain accessible while management is locked. Future administrative auth routes must enforce the management policy too; do not add a generic `/api/auth/*` privileged bypass.

## UI and recovery

AuthGate mounts the Owner enrollment workspace instead of management children until the policy permits entry. Unknown/malformed metadata also keeps privileged views closed, so an old API/new frontend mixture cannot silently display management. The workspace reuses the existing MFA component. It remains mounted through session rotation until one-time recovery codes are acknowledged and the user explicitly continues; it is not keyed to the rotating session ID.

Local `reset-mfa` still revokes sessions and removes the factor. The next password login is restricted again until re-enrollment; local recovery is not an indefinite password-only management exception. MFA removal through the account screen similarly requires setup again before HTTPS management. Password-plus-recovery-code login to an already enrolled account remains a legitimate second factor, including recovery from an unavailable encryption key.

Before upgrading a host, preserve the **existing** `YUNPANEL_SECRET_MASTER_KEY`, configure it in the API service, and verify its protected recovery copy. Do not generate a replacement over a working key: that would affect encrypted application environments and TOTP secrets. If the key is missing, an unenrolled Owner can sign in and see the setup prerequisite but cannot access management. Keep independent SSH/provider-console access and the current IP restriction while satisfying the real-host acceptance checks. API and web assets must be deployed together after the complete package tests; this source commit is not deployment.

The auth schema is still version 2; this increment introduces no schema migration. Existing schema-2 backup/rollback restrictions in `mfa.md` continue to apply. The legacy authenticated agent transport remains unchanged until its separate removal; Owner cookies do not gain access to that transport.

## Validation — 2026-09-09

The final focused command passed **40 tests, 0 failed** on Node 22.16.0:

```bash
node --test --test-skip-pattern='real store setup' \
  apps/api/test/auth-http.test.js \
  apps/api/test/mfa-cookie-boundary.test.js \
  apps/api/test/owner-mfa-policy.test.js \
  apps/api/test/owner-mfa-http.test.js \
  apps/web/test/owner-access.test.js
```

Counts: six policy unit tests, six UI-selection/acknowledgement tests, ten new HTTP policy tests, twelve existing HTTP auth boundary regressions and six existing cookie boundary regressions. HTTP tests open real local sockets but deliberately use controlled auth/MFA-store and downstream-handler doubles. They do not prove native Argon2, SQLite/OTPAuth behavior, full Express routes, actual provider TLS or a rendered React application.

The real-store case in `auth-http.test.js` and the native gateway chain in `apps/web/test/server.test.js` were expanded to exercise password login -> denied management -> enrollment -> rotated session -> allowed management -> logout. **They were not validated here.** An initial attempt reached the native case in the reconstructed source subset and failed with `ERR_MODULE_NOT_FOUND`; the final command above explicitly excludes that case. The project requires Node 24.11.1+, while this container only had Node 22 and could not download the runtime or install the full workspace. No crypto fallback, Python bridge or runtime downgrade was added. Normal `npm run check` still runs the native tests without these local filters.

Both changed/new JSX entry screens passed syntax transpilation, and modified JavaScript/tests passed syntax checks. The original modified source copies were verified against their Git blob hashes before patching; the uploaded code/test blobs were checked against local tested file hashes. CSS is source-only, not visual acceptance. Existing unrelated tests were not claimed as rerun.

Pending acceptance is in `todo.md` T1c: native/full-workspace tests, a real enrolled authenticator, package/HTTPS upgrade, reset/re-enrollment, browser recovery-code preservation and responsive/keyboard behavior. No GitHub Actions, branch creation or live-host mutation occurred. Continue directly on main.
