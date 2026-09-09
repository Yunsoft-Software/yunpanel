# MFA increment — draft, not ready to deploy

## Current implementation and merge blockers

The MFA backend is implemented: password-verified login challenges, TOTP enrollment/verification, replay protection, single-use recovery codes, authenticated factor changes, and explicitly confirmed local MFA recovery. OTPAuth is pinned to 9.5.2. The existing host/agent privilege model is unchanged.

`LoginForm.jsx`, `MfaPanel.jsx`, shared messages/styles and the session-generation client are prepared, but **the current `AuthGate.jsx` does not mount the new components yet**. Its previous login form still assumes a successful password response contains a full session. An MFA-enrolled account instead receives HTTP 202 and must complete the new verification step. **Do not enable MFA on a live account or merge/deploy this draft until that UI connection and its browser tests are completed.**

During this development pass, the connector safety gate blocked two additional writes: the `AuthGate.jsx` integration and a follow-up change to `auth-http.js` intended to stop stale unauthorized responses from expiring a newer cookie. Neither blocked write is part of this branch. They were not retried through an alternate write mechanism. The remaining work is tracked in `plan.md` and `todo.md`.

The client generation guard only protects JavaScript state. It does not undo a `Set-Cookie` header processed by a browser. The existing server-side cookie-expiration race therefore remains a merge blocker; passing client unit tests are not proof that the complete race is fixed.

MFA is enforced for **enrolled** accounts. A policy requiring enrollment for all Owners before root/terminal management is not implemented here. User administration, resource-scoped Read Only access, the agentless backend, terminal, complete audit UI and live-connection revocation remain separate plan work. Keep existing network restrictions.

## Configuration and database migration

The production runtime remains Node.js 24.11.1+ with native Argon2/SQLite and npm 11+. No fallback password implementation was added to the product.

Use the API's existing `YUNPANEL_SECRET_MASTER_KEY`: exactly 32 bytes encoded as 64 hex characters or canonical padded base64. MFA derives a separate encryption key using HKDF-SHA256, then stores TOTP secrets with AES-256-GCM and user-bound authenticated data. Missing keys cannot create a new enrollment; wrong keys cannot decrypt an existing authenticator. Never put the real key in Git, browser configuration, command arguments or logs.

The API adds MFA tables to the same private auth SQLite database and sets its schema version to **2**. Existing users and sessions are preserved; pending enrollment records are tied to their initiating session. Use the same database path and current service identity for API and CLI. The existing packaged service is still `yunpanel`, with private state under `/var/lib/yunpanel/control-plane`.

**Back up before opening the database with this version.** The previous auth-store implementation accepts only schema version 1, so reverting application files alone is not a supported downgrade. Restore a consistent matching pre-migration auth snapshot and package, or implement/test an explicit downgrade. Do not lower `PRAGMA user_version` on a live database as a workaround. Account for old passwords, sessions and recovery codes reappearing when an older snapshot is restored; revoke sessions and recover credentials before reopening access.

Use a supported SQLite backup process or stop all API/CLI writers before copying; do not copy only the main database while WAL writes are active. Preserve the matching master key separately and test recovery on a separate host/copy. Key rotation/re-encryption is not implemented by this increment.

## API behavior

For an account without MFA, password login retains the existing behavior. For an enrolled account, a correct password creates a five-minute challenge, not a management session. The production challenge cookie is `__Host-yunpanel_mfa`, `Secure`, `HttpOnly`, host-only, `Path=/`, `SameSite=Strict`, with `Max-Age=300`. Neither that token nor the full session token is returned in JSON.

`POST /api/auth/mfa/verify` takes `{code, method}` and uses the challenge cookie. `method` is `totp` or `recovery`. It requires the exact configured Origin and bounded JSON; submitting the challenge in a request body is not a substitute for the cookie. Success issues a fresh normal session and clears the challenge. `POST /api/auth/mfa/cancel` cancels the challenge with an exact Origin check. A challenge cookie cannot access the management API.

An authenticated session and normal CSRF protection are required for:

| Endpoint | Purpose |
|---|---|
| `GET /api/auth/mfa` | Enabled/key-configuration status and remaining recovery-code count; no secrets. |
| `POST /api/auth/mfa/enroll` | Verify current password; return a new pending authenticator secret/URI with ten-minute expiry. |
| `POST /api/auth/mfa/enroll/cancel` | Cancel the current session's pending enrollment. |
| `POST /api/auth/mfa/confirm` | Verify the pending TOTP, activate MFA, rotate the session and return ten recovery codes once. |
| `POST /api/auth/mfa/recovery` | Verify password plus TOTP/recovery proof, replace all recovery codes and rotate sessions. |
| `POST /api/auth/mfa/disable` | Verify password plus proof, remove the factor/codes and sign out every session. |

TOTP uses a six-digit SHA1 code, a 30-second step and a one-step clock window in either direction. A successful absolute time step is stored and cannot be used again, including the code used to confirm enrollment. Use the next code or an unused recovery code for another proof. Ensure the server and authenticator clocks are correct rather than widening the window to hide clock problems.

Each recovery code contains 128 random bits. Only user-scoped digests are stored; consumption is transactional. Regeneration retires all previous codes. A valid recovery code still works with the account password when the encryption key is unavailable; this is the deliberate second-factor recovery path, not a password-only fallback.

A login challenge allows five failed proofs. Persistent account, peer and global limits also apply, so obtaining another challenge does not reset the MFA attempt budget. The gateway currently shares the peer bucket across proxied clients; per-account throttling remains separate. Trusted-proxy improvements are still planned.

Enrollment completion and recovery-code regeneration revoke other sessions and return a new session for the initiating browser. Disabling MFA signs out all sessions. Password reset/change preserves the enrolled factor but invalidates pending MFA login/enrollment attempts and sessions. Auth audit records contain action/actor/time, not secrets or raw codes.

## Prepared UI — requires mounting before use

The separate login form handles password -> authenticator/recovery-code proof -> full session, cancellation and challenge expiry. The account component supports manual authenticator-key entry, confirmation, one-time recovery-code display, regeneration and password-plus-factor removal. QR rendering is not implemented; no secret is sent to a third-party QR service.

Wire these components into `AuthGate.jsx`, import `mfa.css`, and use `changesSession: true` for requests that issue/revoke sessions. Accept a full session only after verification; a `mfaRequired` response is not an authenticated user. Coordinate polling with `sessionGeneration()` and `isSessionChangePending()`, preserve the new session after rotation, refresh the session list, and avoid losing one-time codes through premature modal dismissal. These are pending integration requirements, not a claim about the currently rendered UI.

If a factor-changing response is lost after the server committed it, reauthenticate and inspect the actual factor state. Lost recovery codes cannot be retrieved; regenerate them using the authenticator or use the controlled local recovery procedure. Do not blindly retry a factor mutation as though it were a read.

## Local MFA recovery

The local command requires explicit confirmation and access as the owner of the private auth database:

```bash
sudo -u yunpanel env YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs reset-mfa <username> --confirm
```

For repository development with matching default paths:

```bash
npm run auth -- reset-mfa <username> --confirm
```

Replace `<username>` with the actual account. This removes the authenticator and recovery codes, revokes sessions/challenges, and leaves the password unchanged. Re-enroll after signing in once the UI integration is complete. The command deliberately does not decrypt a factor, so it also works when the configured MFA key is lost or malformed. It is a local administrative recovery capability, not an exposed HTTP endpoint. No default password or token is created.

## Validation in this pass — 2026-09-09

The container had Node **22.16.0**, not the required production runtime, and could not install the full repository dependencies. The tests used a reconstructed source subset. The OTPAuth Node bundle was read from the official 9.5.2 tag; its Git blob checksum matched `b50928077b204afffefc1a7a125bcf2c6007cecf`. This does not constitute a full dependency-install or supply-chain audit.

**25 tests passed directly on Node 22:** five crypto tests, fourteen MFA-store tests and six session-client rotation tests. Store fixtures use real SQLite and OTPAuth; only the pre-existing password verifier is doubled in the isolated MFA-store fixture. The crypto tests include the RFC 6238 SHA1 vector, authenticated encryption tampering/wrong-user rejection and recovery-code digests. The store tests cover replay, expiry, account/challenge limits, cross-session enrollment, persistent one-use recovery, revocation and async password-check races. Client tests use fetch doubles, not a rendered browser.

**8 additional tests passed with a compatibility bridge:** six HTTP/auth-store flow tests and two separate-process CLI tests. For these local runs only, an external test import hook supplied the missing Node 22 Argon2 function by calling Python's Argon2id implementation with the same parameters via stdin. SQLite, OTPAuth, HTTP and application auth code remained real; downstream management handlers in the HTTP tests are doubles. The bridge is outside the repository and is not a product dependency or a production fallback. These results are compatibility checks, **not native Node 24 validation**.

The final rerun used committed HTTP source, excluding the blocked cookie change. Repeated runs are not counted twice. Syntax checks passed for the new JavaScript and the two prepared JSX form components. The blocked `AuthGate.jsx` replacement was not committed and is not included in the delivered validation claim.

**Not performed:** native Node 24 Argon2 acceptance, full `npm run check`, full Express/deploy regression, production React build, rendered browser/accessibility/responsive tests, packaged Ubuntu install/upgrade, live HTTPS/SSH access, real authenticator-device testing, or deployment to the live panel. No GitHub Actions were added or invoked.
