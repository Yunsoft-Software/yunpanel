# MFA — integration, recovery and validation

## Repository consolidation

The existing `work/mfa-authentication` branch was merged into `main` through PR #1 using a normal two-parent merge, commit `70f8c154b229de3b784505a227314080fd8f305f`. Its parents are the previous main head `ad844934a11290afef8cf56fd2e33151019b80cb` and the MFA branch head `c519c016db5ec4a2a6587110234e7048d65c803f`. Both histories are retained, including main's domain hierarchy work and all four MFA commits. No squash, rebase, force push, or new branch was used. The old branch reference was not deleted. Subsequent development is directly on `main`, as required by `agents.md`. The later reconciliation is recorded in `mfa-merge.md`.

## Implemented behavior

The merged backend supports encrypted TOTP enrollment, password-plus-factor login, one-use recovery codes, factor removal, recovery-code regeneration and local MFA reset. The frontend connects these endpoints through `LoginForm.jsx`, `MfaSettings.jsx`, `AccountDialog.jsx`, `OwnerEnrollment.jsx` and `AuthGate.jsx`. The current mandatory HTTPS management policy and its separate validation record are in [owner-mfa-policy.md](owner-mfa-policy.md).

A password-only MFA response for an already enrolled account is a challenge, not a logged-in session. The browser shows a separate code step; either the authenticator's six-digit code or an unused recovery code completes it. The challenge expires after five minutes. Cancelling it returns to password login. Its credential is stored in an HttpOnly cookie, not in JavaScript state, a URL, or localStorage. An unenrolled Owner instead receives a self-service session and must complete enrollment before accessing HTTPS management.

In the required Owner setup workspace or **Hesabım / İki adımlı doğrulama**, an authenticated user confirms the current password before starting enrollment. Enter the displayed setup key manually into an authenticator using time-based codes: six digits, 30 seconds. The pending setup expires after ten minutes and must be confirmed by a valid code. No external QR/image service receives the key; this implementation does not include QR rendering.

Enabling MFA or regenerating recovery codes rotates the current session and revokes other sessions. Ten recovery codes are shown once; the user must acknowledge saving them before closing the account dialog normally or continuing from the enrollment workspace. Codes and the setup key remain only in component memory. The backend stores recovery-code digests, not plaintext codes, and atomically consumes them. TOTP counter tracking rejects replayed codes.

Disabling MFA requires the password and a current TOTP/recovery proof, revokes sessions and signs the user out. Replacing an authenticator currently means disabling it, signing in again and enrolling the replacement. HTTPS management requires current Owner enrollment, including after local MFA reset; only explicit loopback HTTP development is exempt. Terminal WebSockets use the same live MFA policy and are closed on MFA/password/session/role/user revocation. Keep the existing IP restriction and do not expose a privileged/root release until the package and migration acceptance gates pass.

## Session integration

The browser distinguishes complete sessions from partial/malformed login replies. In-memory generations reject responses from an obsolete session, and security transitions pause new background session requests. This prevents a delayed response from restoring a logged-out session or clearing a newly rotated CSRF value. Generic unauthorized responses no longer emit cookie deletion, because a late old request could otherwise erase a newer browser cookie; explicit logout still clears cookies and revokes the session.

The UI warns during the last two minutes before the earlier idle/absolute deadline, offers an explicit extension for idle expiry, and requires another login at absolute expiry. Background reads do not extend idle time. Native browser, multiple-tab and interrupted-response behavior must still pass the real-browser checks in `todo.md`.

## Configuration and database upgrade

Use the repository's required Node.js 24.11.1+ and npm 11+ with the API dependency `otpauth` pinned to 9.5.2. Install the full workspace before building a package; copying the new source files without installing its dependency is not a supported upgrade.

MFA uses `YUNPANEL_SECRET_MASTER_KEY`, encoded as 64 hexadecimal characters or base64 for 32 bytes. Do not replace an existing application-environment master key merely to enable MFA: retain it, make a protected recovery copy and use the same configured value in the API. The MFA encryption key is separately derived; encrypted secrets are bound to the account. Missing/unusable keys block secret decryption/enrollment rather than silently disabling verification. An unenrolled Owner cannot bypass HTTPS management restrictions because the key is missing. Key rotation tooling remains pending.

The auth store supports schema version 2 and adds its MFA tables on initialization. The required-MFA policy introduces no further schema migration. Back up the auth database consistently before the first upgraded start: stop API/CLI writers or use a supported SQLite backup mechanism, and account for WAL state. Do not copy only the main database file during writes. Keep an independent console/SSH recovery path. The old schema-1 package cannot be assumed to accept schema 2; rollback needs a compatible application/state snapshot. Do not manually decrement `PRAGMA user_version`. Restoring an older snapshot can restore old passwords and sessions, so recovery/revocation must precede reopening access.

The packaged API runs as root; retain the exact auth database path and master key. See `authentication.md` for exact HTTPS-origin configuration, narrow legacy ownership migration and private database ownership. No agent, vhost, certificate, application release or live server is migrated merely by changing MFA state.

## Local recovery

Password recovery and MFA recovery are separate operations. On a host using the documented default packaged layout:

```bash
sudo env YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs reset-mfa <username> --confirm
```

Replace `<username>` with the affected account. This requires local root filesystem authority, not public HTTP access. The command removes the account's factor, recovery codes, pending challenges and sessions; it does not change the password. It deliberately does not require decryption with a lost key. Keep the panel network restriction in place, restore/configure the correct key, sign in and re-enroll the authenticator. The next password login remains self-service-only until enrollment succeeds. Changing the password alone does not remove MFA. Never record real keys, cookies, passwords, setup tokens or recovery codes in Git or test evidence.

## Validation in the consolidation/UI increment — 2026-09-09

This is the earlier consolidation record, not a rerun of all tests after the later required-policy changes. See `mfa-merge.md` and `owner-mfa-policy.md` for the subsequent validation records.

The following command passed **27 tests, 0 failed, 0 skipped** on the available Node 22.16.0 runtime:

```bash
node --test \
  apps/web/test/session-race.test.js \
  apps/web/test/session-transition.test.js \
  apps/web/test/auth-protocol.test.js \
  apps/api/test/mfa-cookie-boundary.test.js
```

Coverage: nine stale-response/session tests, two transition-lock tests, ten login/MFA/proof/deadline protocol tests and six real loopback HTTP tests. The HTTP tests use a controlled auth/MFA-store double and a downstream handler double. They verify cookie, Origin, CSRF and challenge boundaries; they do not exercise native Argon2, persistent SQLite, OTPAuth cryptography or the complete Express application.

All four changed/new JSX screens passed syntax transpilation. That is not a production React build or rendered accessibility/responsive test. Tests ran against a local source subset because network dependency installation and a supported Node 24 runtime were unavailable. The project's runtime requirement was not lowered.

The earlier backend-MFA tests were preserved by the merge but were not rerun in that increment. Full `npm run check`, real crypto/persistence and CLI regressions, React browser tests, Debian installation/rollback and live HTTPS/SSH validation remain pending in `todo.md` T1a/T1b/T1c. There was no deployment to `cryptoraichu.website` and no GitHub Actions execution.
