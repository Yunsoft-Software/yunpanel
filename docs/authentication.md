# Authentication — implementation and deployment

The authentication implementation provides local Owner setup, login/logout, persistent user sessions, password changes, session revocation and local password recovery. TOTP setup/login, recovery codes and local MFA reset are integrated but optional; see [mfa.md](mfa.md) for their operation and schema upgrade. HTTPS management requires Owner enrollment by default; an explicit `YUNPANEL_OWNER_MFA_REQUIRED=false` setting permits password-only Owner management on the authorized development/test host. See [owner-mfa-policy.md](owner-mfa-policy.md) for the earlier mandatory-policy implementation and validation limits. Account administration is implemented in the API and Settings → Users workspace; see [user-administration.md](user-administration.md) for its contract, additive schema and outstanding native/browser acceptance. Scoped Read Only inventory access is implemented for servers, applications, domains and certificates; sensitive reads and mutations remain blocked. The root-owned agentless backend and authenticated Owner/site terminal are implemented; retained migration/rollback compatibility and the real-host/browser acceptance listed in `todo.md` are not complete. Keep the existing IP restriction until those security release gates are satisfied.

## Runtime and entry points

Use Node.js **24.11.1 or newer** with native `node:crypto` Argon2 and `node:sqlite`, and npm 11+. The package pre-install check rejects a runtime without these capabilities. Install the workspace dependencies, including the pinned OTPAuth dependency, before building a candidate.

Start the API through `apps/api/src/index.js`. It creates the authenticated HTTP listener around `app.js`, which composes the domain route and `core-app.js`. Browser management requests are authenticated and authorized there first; the listener then attaches the server-derived `request.auth` context consumed again by the internal Express management guards. A raw `createApp().listen()` does not gain a management authentication path: management routes fail closed when `request.auth` is absent. Still do not publish that internal factory directly because it does not own session cookies, Origin/CSRF validation, MFA login/enrollment or the public authentication lifecycle.

The old `bootstrap-auth.js`, `YUNPANEL_ADMIN_BOOTSTRAP_TOKEN` management path and in-process compatibility bearer have been removed. The web gateway forwards the user's cookie and CSRF header; it does not inject administrator credentials. Core/domain management authorization ignores bearer headers and depends on the verified in-memory `request.auth` context. An attacker-supplied `Authorization` header therefore cannot substitute for a panel session or elevate a Read Only account.

New enrollment and the legacy enrollment endpoint are retired. On a locally owned Server, retained heartbeat/command/result/environment routes are unreachable and return `404 agent_transport_removed`; their implementation and pre-existing agent credential state remain only for guarded migration rollback until the acceptance gates permit physical removal. Browser-origin/cookie requests cannot use that compatibility transport and the web gateway does not proxy it. The one enabled browser upgrade is exact `/api/terminal`; it repeats the HTTP cookie, proxy-peer, Origin, Owner and MFA checks and additionally requires a short-lived session-bound capability.

## Configuration before upgrading an existing host

This is not an automatic live deployment. Back up configuration/state and confirm independent SSH/provider-console access before changing the test host. Preserve the existing `YUNPANEL_SECRET_MASTER_KEY` and configure it in the API environment before upgrading: required MFA enrollment cannot complete without the key, and HTTPS management remains locked. Do not replace a working key merely to satisfy the prerequisite. When an intentional key rotation is required, rotate MFA and application secrets together with [secret-master-key-rotation.md](secret-master-key-rotation.md); changing the environment variable alone makes existing encrypted state unreadable. Deploy matching API and web assets after the `todo.md` package checks.

Set `YUNPANEL_PUBLIC_ORIGIN` to the same **exact** public origin in the private API environment (`/etc/yunpanel/control-plane/api.env`) and the restricted gateway environment (`/etc/yunpanel/web/web.env`), for example `https://server.cryptoraichu.website` without a trailing slash. The API requires this in production and refuses to start with a missing or non-HTTPS origin. `YUNPANEL_OWNER_MFA_REQUIRED` accepts only `true` or `false` and defaults to `true`; the authorized `.28` development/test host uses `false`. This does not disable password login, session checks, Origin/CSRF, rate limits or the IP allowlist. Keep `YUNPANEL_ALLOWED_CLIENT_IPS`, any non-default `YUNPANEL_API_HOST`/`YUNPANEL_API_PORT` gateway settings, the loopback listeners and the current Nginx access policy in the gateway environment. The web unit does not load the API environment.

The public Nginx proxy must forward WebSocket upgrades to the restricted web gateway. Its read/send timeout must also be at least the terminal's four-hour absolute lifetime so Nginx does not silently replace YunPanel's authenticated idle/lifetime policy with the default proxy timeout:

```nginx
location / {
  proxy_pass http://127.0.0.1:4300;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 4h;
  proxy_send_timeout 4h;
}
```

Do not proxy `/api/terminal` directly to the privileged API listener. The web gateway is the public WebSocket boundary and repeats the allowlist, exact Origin, forwarding identity and session checks before it reaches the API.

Packaged installs generate `/etc/yunpanel/control-plane/proxy.env` as a root-owned `0600` API environment and mirror its token into the root-owned `0600` `/etc/yunpanel/control-plane/proxy.token`. The restricted web service receives that second file through a read-only systemd credential; the token is not placed in the web process environment and the service cannot read control-plane configuration or state. The web gateway removes caller-supplied forwarding headers, resolves exactly one client address from an explicitly trusted immediate proxy (`YUNPANEL_TRUSTED_PROXY_IPS`, loopback by default), and authenticates that address to the API with the scoped credential. The API rejects standard forwarding headers and invalid, unsigned or non-single-hop client metadata. This token only authenticates the local gateway hop; it is not a user session or management bearer credential.

Open tabs coordinate session rotation with a same-origin `BroadcastChannel` that carries only an opaque invalidation signal—never cookies, CSRF values or session data. Login, logout, password/MFA rotation, an unauthorized active request and even an unknown response after a dispatched session mutation make other tabs re-read the HttpOnly cookie. Back-forward-cache restoration does the same through `pageshow`; background polling and server-provided idle/absolute deadlines remain the final reconciliation path.

The packaged API runs as `root` and keeps control-plane state below `/var/lib/yunpanel/control-plane`. Configure an absolute `YUNPANEL_AUTH_DB` such as `/var/lib/yunpanel/control-plane/auth/auth.sqlite` in the API environment. Use exactly the same path for the local CLI. Without an override, the database is placed in `auth/auth.sqlite` alongside `YUNPANEL_SERVER_STORE`.

The auth directory must be root-owned with mode `0700`; the database must be a root-owned regular non-symlink file with mode `0600`. Packaged startup has a narrow migration for the legacy private auth directory and SQLite sidecars; it refuses symlinks, foreign ownership and unsafe modes rather than recursively changing unrelated state. Run the CLI as root against the same database path.

The package includes `/usr/lib/yunpanel/scripts/auth.mjs`. Build, install and test the candidate package in the test environment before publishing any APT release. Existing application state, env/master keys, certificates, vhosts and agent units are not migrated by these authentication changes. MFA adds auth schema version 2: preserve a consistent pre-upgrade backup and review the rollback restrictions in `mfa.md` before the first upgraded start. The required-MFA policy does not change that schema.

## Initial Owner

After configuring the API's database path, generate a single-use setup token locally as root:

```bash
sudo env YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs setup-token
```

Use the emitted token in the panel's initial-setup form, choose a username and a password of at least 12 characters, then sign in. Where `YUNPANEL_OWNER_MFA_REQUIRED=true`, complete authenticator setup and save its recovery codes before entering management; do not enable 2FA on the `.28` development/test host unless the user explicitly reverses that decision. The token expires after ten minutes; issuing another replaces the previous one. Once an account exists, setup cannot create another account. There is no default password or public registration. Never paste the setup token/password into Git, tickets, public logs or URLs.

For repository development, run `npm run dev` and open `http://127.0.0.1:5173`. In another terminal at the repository root use:

```bash
npm run auth -- setup-token
```

The npm command runs in the API workspace so its default relative state path matches `dev:api`. If overriding the API's store/database environment, provide the same override to the CLI. `.env.example` is a template, not an automatically loaded production secret file. Explicit development loopback HTTP uses a separate non-Secure cookie and does not require enrollment; already enrolled accounts still need their second factor at login. Production always uses HTTPS and the Secure cookie. Development mode combined with an HTTPS origin does not bypass MFA unless the explicit optional-policy setting is `false`.

## Recovery and session management

The account dialog supports changing the password, ending individual sessions and configuring MFA. Password changes end all sessions for that user. The HTTP API also provides `POST /api/auth/logout-all`.

Local password recovery does not require mail:

```bash
sudo env YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs reset-password <username>
```

Replace `<username>` with the actual account name. The CLI asks for a hidden password and confirmation on a terminal, or reads a password from stdin for controlled automation. Never pass the password as a command-line argument. SQLite transactions let recovery invalidate active sessions without restarting the API. This is local administrator recovery, not an unauthenticated HTTP password-reset endpoint. Password recovery does not remove MFA; use the separately confirmed local `reset-mfa` procedure in `mfa.md` when the second factor is lost. After factor removal, re-enrollment is required only when `YUNPANEL_OWNER_MFA_REQUIRED=true`. An already enrolled account still requires its second factor at login even if the policy is optional; local recovery must clear enrollment when password-only login is intentionally selected.

## Session/security behavior

- Passwords use salted Argon2id: 64 MiB, three passes, one lane. KDF concurrency is bounded.
- Random 256-bit session/setup tokens are stored only as SHA-256 digests; CSRF values are derived from the session and held in browser memory, not localStorage.
- Production session cookie: `__Host-yunpanel_session`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Strict`, no Domain attribute. The separate MFA challenge cookie does not grant a management session.
- Session lifetime: 30-minute idle limit and 12-hour absolute limit. Background GET polling does not extend idle time; explicit user activity and accepted mutations can extend it, never beyond the absolute limit. The UI includes an expiry warning and idle-extension action.
- Browser session generations reject obsolete responses after login/logout/MFA rotation. Generic 401 responses do not delete a possibly newer cookie; explicit logout revokes state and clears cookies.
- Login attempts are limited by account, network peer and a global cap in persistent SQLite state. Caller-provided forwarding headers are not accepted as authenticated client identities. Behind the gateway the peer bucket is shared; the per-account bucket remains separate.
- Mutations require the exact Origin and session CSRF header. Login/setup and MFA challenge requests require the exact Origin. Anonymous management returns 401. HTTPS Owners without enrolled MFA receive `403 mfa_enrollment_required` only when `YUNPANEL_OWNER_MFA_REQUIRED=true`; explicit optional policy allows a password-authenticated Owner session to manage the host.
- Read Only sessions receive server-derived `access.mode = read_only` plus explicit `servers.read`, `applications.read`, `domains.read` and `certificates.read` capabilities. Only exact GET/HEAD collection and one-level detail routes for those inventories cross the management boundary. Jobs, user administration, application environment/status, nested system inspection and all mutations remain 403. The web workspace mounts dedicated Read Only inventory views and suppresses management polling/actions, but the API authorization boundary remains authoritative.
- Capability metadata is never accepted from browser input. Unknown/malformed access metadata and a Read Only wildcard fail closed; Owner management still requires the server-derived Owner/MFA policy.
- Core/domain management guards consume only `request.auth`; bearer headers are not management credentials. The remaining bearer-token parser in `core-app.js` is limited to the explicitly isolated rollback-compatible agent transport and cannot reach a locally owned Server.
- Auth events store action/actor/time, not passwords, cookies or raw tokens. The Owner-only audit screen reads the common bounded audit store with actor/action/outcome/resource/time filters and pagination; management job terminal outcomes retain their original actor through private job links. Read Only access remains denied by the backend.

Back up SQLite consistently: stop the API and CLI writers before copying, or use SQLite's supported online-backup mechanism. Do not copy only `auth.sqlite` while WAL writes are active. Protect the backup as credential material. Restore/rollback must be tested on a separate copy; restoring an old auth snapshot can restore old passwords/sessions, so revoke/recover before opening it to users.

## Validation records and current limits

The original authentication increment recorded **42 focused passing tests** on Node 24.11.1: 16 auth-store tests, 13 HTTP-boundary tests, two separate-process CLI tests, six browser-client unit tests and five gateway tests. That historical record also included JavaScript/JSX/shell syntax checks and a disposable local CLI smoke test. It did not establish a complete Express/deploy regression or live-server acceptance and is not a claim that those tests were rerun after subsequent changes.

The earlier consolidation and MFA UI record in `mfa.md` describes **27 focused tests on Node 22.16.0** and four JSX syntax checks; the second reconciliation is in `mfa-merge.md`. The required-policy increment's **40 focused passing tests** and exact exclusions are recorded in `owner-mfa-policy.md`. Its local HTTP tests use controlled stores; the expanded native auth-store/gateway enrollment scenarios could not be run in the source subset. The required application runtime has not been lowered, and historical counts are not added together as a full regression result.

The scoped Read Only increment was additionally exercised as a reconstructed source subset on Node 22.16.0: 11 focused panel-access, Owner-MFA capability, HTTP-boundary and client-policy tests passed. This does not establish native/full-workspace, React render, production build or live HTTPS acceptance; those checks remain in `todo.md` T-ACCESS/T-RUNTIME.

After removing the bootstrap/in-process bearer adapter, the current `panel-access` plus `panel-http-guard` source subset was exercised on Node 22.16.0: **7/7 focused policy/guard tests passed**. The repository still requires Node 24.11.1+, and the updated Express flow tests plus the real authenticated-listener-to-core boundary test have not been run as a full workspace in this session. Keep that acceptance open in `todo.md`.

The secret master-key rotation core, CLI, rollback checks and focused tests are present, but the rotation test file has not been run in the required Node 24/full-workspace environment in this session. Follow `docs/secret-master-key-rotation.md` and `todo.md` T-KEY before any production rotation.

Production React build, rendered-browser/keyboard/responsive tests, native/full-workspace `npm run check`, complete Express-operation regressions, Debian package installation, live HTTPS, SSH access and deployment to `cryptoraichu.website` remain explicit tasks in `todo.md`. No GitHub Actions were added or used.
