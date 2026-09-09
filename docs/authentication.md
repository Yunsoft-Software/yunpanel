# Authentication — implementation and deployment

This increment adds local Owner setup, login/logout, persistent user sessions, password changes, session revocation and local password recovery. It does **not** implement TOTP, user administration, the agentless/root backend, a terminal, or the website hierarchy. Keep the existing IP restriction until the remaining security release gate in `plan.md` is satisfied.

## Runtime and entry points

Use Node.js **24.11.1 or newer** with native `node:crypto` Argon2 and `node:sqlite`, and npm 11+. The package pre-install check rejects a runtime without these capabilities. The focused tests were run on Node 24.11.1; SQLite prints an experimental-feature warning on that runtime.

Start the API through `apps/api/src/index.js`. It creates an authenticated HTTP listener around the existing application handlers. Do not publish `createApp().listen()` directly: `app.js` remains an internal handler factory and still has its older guard for compatibility with existing operation tests.

The deployed management API no longer accepts `YUNPANEL_ADMIN_BOOTSTRAP_TOKEN`. The web gateway forwards the user's cookie and CSRF header; it does not inject administrator credentials. A fresh in-process compatibility value is passed only between the authenticated listener and the old handlers. It is not a configured credential or an additional public authentication method. Remove that compatibility adapter when refactoring the core handlers for the agentless milestone.

Exact legacy enrollment/heartbeat/command/result/environment routes still use their existing agent credentials until that migration. Browser-origin/cookie requests cannot use them and the web gateway does not proxy them. Agent secrets have not been retired. No WebSocket/terminal listener is enabled.

## Configuration before upgrading an existing host

This is not an automatic live deployment. Back up configuration/state and confirm independent SSH/provider-console access before changing the test host.

Set `YUNPANEL_PUBLIC_ORIGIN` to the same **exact** public origin in both the API and web service environments, for example `https://cryptoraichu.website` without a trailing slash. The API now requires this in production and refuses to start with a missing or non-HTTPS origin. The old gateway's origin setting alone is not enough. Keep `YUNPANEL_ALLOWED_CLIENT_IPS`, the loopback listeners and the current Nginx access policy.

The current packaged API still runs as `yunpanel` with writes allowed under `/var/lib/yunpanel/control-plane`. Configure an absolute `YUNPANEL_AUTH_DB` such as `/var/lib/yunpanel/control-plane/auth/auth.sqlite` in the API environment. Use exactly the same path for the local CLI. Without an override, the database is placed in `auth/auth.sqlite` alongside `YUNPANEL_SERVER_STORE`.

The auth directory must be owned by the API service identity with mode `0700`; the database must be a regular non-symlink file with mode `0600`. The service creates a missing private directory/database. It deliberately refuses unsafe ownership/permissions rather than changing unrelated directories. Do not choose a path outside the existing unit's `ReadWritePaths`, run the CLI as a different file owner, or solve this with recursive chmod/chown. The future root-backend migration must explicitly preserve/migrate the auth database too.

The package includes `/usr/lib/yunpanel/scripts/auth.mjs`. Build, install and test the candidate package in the test environment before publishing any APT release. Existing application state, env/master keys, certificates, vhosts and agent units are not migrated by this auth increment.

## Initial Owner

After configuring the API's database path, generate a single-use setup token locally as the current service user:

```bash
sudo -u yunpanel env YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs setup-token
```

Use the emitted token in the panel's initial-setup form, choose a username and a password of at least 12 characters, then sign in. The token expires after ten minutes; issuing another replaces the previous one. Once an account exists, setup cannot create another account. There is no default password or public registration. Never paste the setup token/password into Git, tickets, public logs or URLs.

For repository development, run `npm run dev` and open `http://127.0.0.1:5173`. In another terminal at the repository root use:

```bash
npm run auth -- setup-token
```

The npm command runs in the API workspace so its default relative state path matches `dev:api`. If overriding the API's store/database environment, provide the same override to the CLI. `.env.example` is a template, not an automatically loaded production secret file. Development loopback HTTP uses a separate non-Secure cookie; production always uses HTTPS and the Secure cookie.

## Recovery and session management

The account dialog supports changing the password and ending individual sessions. Password changes end all sessions for that user. The HTTP API also provides `POST /api/auth/logout-all`.

Local recovery does not require mail:

```bash
sudo -u yunpanel env YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs reset-password <username>
```

Replace `<username>` with the actual account name. The CLI asks for a hidden password and confirmation on a terminal, or reads a password from stdin for controlled automation. Never pass the password as a command-line argument. SQLite transactions let recovery invalidate active sessions without restarting the API. This is local administrator recovery, not an unauthenticated HTTP password-reset endpoint.

## Session/security behavior

- Passwords use salted Argon2id: 64 MiB, three passes, one lane. KDF concurrency is bounded.
- Random 256-bit session/setup tokens are stored only as SHA-256 digests; CSRF values are derived from the session and held in browser memory, not localStorage.
- Production cookie: `__Host-yunpanel_session`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Strict`, no Domain attribute.
- Session lifetime: 30-minute idle limit and 12-hour absolute limit. Background GET polling does not extend idle time; explicit user activity and accepted mutations can extend it, never beyond the absolute limit.
- Login attempts are limited by account, network peer and a global cap in persistent SQLite state. Caller-provided forwarding headers are not accepted as authenticated client identities. Behind the gateway the peer bucket is shared; the per-account bucket remains separate.
- Mutations require the exact Origin and session CSRF header. Login/setup require the exact Origin and bounded JSON. Anonymous management returns 401. Non-Owner management returns 403 until resource-scoped Read Only permissions are implemented.
- Auth events store action/actor/time, not passwords, cookies or raw tokens. Connecting them and management job actors to the full audit UI remains planned work.

Back up SQLite consistently: stop the API and CLI writers before copying, or use SQLite's supported online-backup mechanism. Do not copy only `auth.sqlite` while WAL writes are active. Protect the backup as credential material. Restore/rollback must be tested on a separate copy; restoring an old auth snapshot can restore old passwords/sessions, so revoke/recover before opening it to users.

## Validation performed in this development environment

On Node 24.11.1, **42 focused tests passed**: 16 auth-store tests (run in bounded batches), 13 HTTP-boundary tests, two separate-process CLI tests, six browser-client unit tests and five gateway tests. Coverage includes setup expiry/reuse/concurrency, hashing, private persistence, session rotation/expiry/revocation, password recovery, throttling, Origin/CSRF, anonymous access, browser transport restrictions and a real HTTP login/logout round trip through gateway plus auth listener. The downstream application handler is a test double in these boundary tests; this is not a full Express/deploy regression run.

JavaScript syntax checks, JSX transpilation syntax checks and shell syntax checks passed. The root `npm run auth -- setup-token` workspace routing was smoke-tested with a disposable database/token. No credentials from these tests were committed.

**Not performed here:** dependency installation/full `npm run check`, production React build, rendered-browser/keyboard/responsive tests, real Express-operation regressions, Debian package installation, live HTTPS, SSH access or deployment to `cryptoraichu.website`. The constrained environment had a source subset and a suitable Node runtime, not the complete installed workspace. These remain explicit tasks in `todo.md`. No GitHub Actions were added or used.
