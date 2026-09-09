# Authentication — implementation and deployment

The authentication implementation provides local Owner setup, login/logout, persistent user sessions, password changes, session revocation and local password recovery. TOTP setup/login, recovery codes and local MFA reset are integrated; see [mfa.md](mfa.md) for their operation and schema upgrade. **HTTPS management now requires Owner MFA enrollment**; unenrolled users first receive a self-service session and a setup workspace. See [owner-mfa-policy.md](owner-mfa-policy.md) for the current access rule, upgrade prerequisites and validation limits. User administration, the agentless/root backend and terminal remain incomplete. Keep the existing IP restriction until the remaining security release gate in `plan.md` is satisfied.

## Runtime and entry points

Use Node.js **24.11.1 or newer** with native `node:crypto` Argon2 and `node:sqlite`, and npm 11+. The package pre-install check rejects a runtime without these capabilities. Install the workspace dependencies, including the pinned OTPAuth dependency, before building a candidate.

Start the API through `apps/api/src/index.js`. It creates an authenticated HTTP listener around `app.js`, which composes the domain route and `core-app.js`. Do not publish `createApp().listen()` or the core handler directly: these internal factories retain their older guards for operation compatibility, not as alternative public authentication boundaries.

The network entry point no longer accepts `YUNPANEL_ADMIN_BOOTSTRAP_TOKEN` for management. The web gateway forwards the user's cookie and CSRF header; it does not inject administrator credentials. A fresh in-process compatibility value is passed only between the authenticated listener and the old handlers. It is not a configured credential or an additional public authentication method. Remove that compatibility adapter when refactoring the core handlers for the agentless milestone.

Exact legacy enrollment/heartbeat/command/result/environment routes still use their existing agent credentials until that migration. Browser-origin/cookie requests cannot use them and the web gateway does not proxy them. Agent secrets have not been retired. No WebSocket/terminal listener is enabled.

## Configuration before upgrading an existing host

This is not an automatic live deployment. Back up configuration/state and confirm independent SSH/provider-console access before changing the test host. Preserve the existing `YUNPANEL_SECRET_MASTER_KEY` and configure it in the API environment before upgrading: required MFA enrollment cannot complete without the key, and HTTPS management remains locked. Do not replace a working key to satisfy the prerequisite. Deploy matching API and web assets after the `todo.md` T1c package checks.

Set `YUNPANEL_PUBLIC_ORIGIN` to the same **exact** public origin in both the API and web service environments, for example `https://cryptoraichu.website` without a trailing slash. The API requires this in production and refuses to start with a missing or non-HTTPS origin. The old gateway's origin setting alone is not enough. Keep `YUNPANEL_ALLOWED_CLIENT_IPS`, the loopback listeners and the current Nginx access policy.

The current packaged API still runs as `yunpanel` with writes allowed under `/var/lib/yunpanel/control-plane`. Configure an absolute `YUNPANEL_AUTH_DB` such as `/var/lib/yunpanel/control-plane/auth/auth.sqlite` in the API environment. Use exactly the same path for the local CLI. Without an override, the database is placed in `auth/auth.sqlite` alongside `YUNPANEL_SERVER_STORE`.

The auth directory must be owned by the API service identity with mode `0700`; the database must be a regular non-symlink file with mode `0600`. The service creates a missing private directory/database. It deliberately refuses unsafe ownership/permissions rather than changing unrelated directories. Do not choose a path outside the existing unit's `ReadWritePaths`, run the CLI as a different file owner, or solve this with recursive chmod/chown. The future root-backend migration must explicitly preserve/migrate the auth database too.

The package includes `/usr/lib/yunpanel/scripts/auth.mjs`. Build, install and test the candidate package in the test environment before publishing any APT release. Existing application state, env/master keys, certificates, vhosts and agent units are not migrated by these authentication changes. MFA adds auth schema version 2: preserve a consistent pre-upgrade backup and review the rollback restrictions in `mfa.md` before the first upgraded start. The required-MFA policy does not change that schema.

## Initial Owner

After configuring the API's database path, generate a single-use setup token locally as the current service user:

```bash
sudo -u yunpanel env YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs setup-token
```

Use the emitted token in the panel's initial-setup form, choose a username and a password of at least 12 characters, then sign in. On HTTPS, complete the required authenticator setup and save its recovery codes before entering management. The token expires after ten minutes; issuing another replaces the previous one. Once an account exists, setup cannot create another account. There is no default password or public registration. Never paste the setup token/password into Git, tickets, public logs or URLs.

For repository development, run `npm run dev` and open `http://127.0.0.1:5173`. In another terminal at the repository root use:

```bash
npm run auth -- setup-token
```

The npm command runs in the API workspace so its default relative state path matches `dev:api`. If overriding the API's store/database environment, provide the same override to the CLI. `.env.example` is a template, not an automatically loaded production secret file. Explicit development loopback HTTP uses a separate non-Secure cookie and does not require enrollment; already enrolled accounts still need their second factor at login. Production always uses HTTPS and the Secure cookie. Development mode combined with an HTTPS origin does not bypass required MFA.

## Recovery and session management

The account dialog supports changing the password, ending individual sessions and configuring MFA. Password changes end all sessions for that user. The HTTP API also provides `POST /api/auth/logout-all`.

Local password recovery does not require mail:

```bash
sudo -u yunpanel env YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs reset-password <username>
```

Replace `<username>` with the actual account name. The CLI asks for a hidden password and confirmation on a terminal, or reads a password from stdin for controlled automation. Never pass the password as a command-line argument. SQLite transactions let recovery invalidate active sessions without restarting the API. This is local administrator recovery, not an unauthenticated HTTP password-reset endpoint. Password recovery does not remove MFA; use the separately confirmed local `reset-mfa` procedure in `mfa.md` when the second factor is lost. After factor removal, a subsequent password login cannot manage the HTTPS panel until re-enrollment succeeds.

## Session/security behavior

- Passwords use salted Argon2id: 64 MiB, three passes, one lane. KDF concurrency is bounded.
- Random 256-bit session/setup tokens are stored only as SHA-256 digests; CSRF values are derived from the session and held in browser memory, not localStorage.
- Production session cookie: `__Host-yunpanel_session`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Strict`, no Domain attribute. The separate MFA challenge cookie does not grant a management session.
- Session lifetime: 30-minute idle limit and 12-hour absolute limit. Background GET polling does not extend idle time; explicit user activity and accepted mutations can extend it, never beyond the absolute limit. The UI includes an expiry warning and idle-extension action.
- Browser session generations reject obsolete responses after login/logout/MFA rotation. Generic 401 responses do not delete a possibly newer cookie; explicit logout revokes state and clears cookies.
- Login attempts are limited by account, network peer and a global cap in persistent SQLite state. Caller-provided forwarding headers are not accepted as authenticated client identities. Behind the gateway the peer bucket is shared; the per-account bucket remains separate.
- Mutations require the exact Origin and session CSRF header. Login/setup and MFA challenge requests require the exact Origin. Anonymous management returns 401. Non-Owner management returns 403 until resource-scoped Read Only permissions are implemented. Unenrolled Owners receive `403 mfa_enrollment_required` for HTTPS management while exact self-service routes remain available.
- Auth events store action/actor/time, not passwords, cookies or raw tokens. Connecting them and management job actors to the full audit UI remains planned work.

Back up SQLite consistently: stop the API and CLI writers before copying, or use SQLite's supported online-backup mechanism. Do not copy only `auth.sqlite` while WAL writes are active. Protect the backup as credential material. Restore/rollback must be tested on a separate copy; restoring an old auth snapshot can restore old passwords/sessions, so revoke/recover before opening it to users.

## Validation records and current limits

The original authentication increment recorded **42 focused passing tests** on Node 24.11.1: 16 auth-store tests, 13 HTTP-boundary tests, two separate-process CLI tests, six browser-client unit tests and five gateway tests. That historical record also included JavaScript/JSX/shell syntax checks and a disposable local CLI smoke test. It did not establish a complete Express/deploy regression or live-server acceptance and is not a claim that those tests were rerun after subsequent changes.

The earlier consolidation and MFA UI record in `mfa.md` describes **27 focused tests on Node 22.16.0** and four JSX syntax checks; the second reconciliation is in `mfa-merge.md`. The current required-policy increment's **40 focused passing tests** and exact exclusions are recorded in `owner-mfa-policy.md`. Its local HTTP tests use controlled stores; the expanded native auth-store/gateway enrollment scenarios could not be run in the source subset. The required application runtime has not been lowered, and historical counts are not added together as a full regression result.

Production React build, rendered-browser/keyboard/responsive tests, native/full-workspace `npm run check`, complete Express-operation regressions, Debian package installation, live HTTPS, SSH access and deployment to `cryptoraichu.website` remain explicit tasks in `todo.md`. No GitHub Actions were added or used.
