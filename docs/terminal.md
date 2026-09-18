# Terminal security and runtime

> Current source status — 2026-09-18: on-demand ttyd is the primary terminal path for managed Server and Website terminals. The previous custom `node-pty` + embedded xterm path remains only as a migration fallback until the real Ubuntu/browser/TUI acceptance gates in `todo.md` T-TOOLS pass. Do not add new product features to the legacy PTY path.

## IntegratedToolGateway boundary

Terminal is now part of the reusable IntegratedToolGateway policy together with phpMyAdmin and elFinder.

The shared descriptor pins:

- tool id `ttyd`;
- audience `terminal`;
- public prefix `/tools/ttyd`;
- live access gate `/api/ttyd-gateway-access`;
- access mode `session` rather than owner-only;
- private socket root `/run/yunpanel/ttyd`.

Session-bound tools do not receive a generic Owner-only 204 access decision. The API requires an exact tool session id plus the current Owner management session. If no session-specific authorizer is wired, the gateway fails closed.

## Capability to ttyd session

The browser still begins with the existing authenticated and CSRF-protected terminal capability request:

`POST /api/panel/terminal/capabilities`

The capability is short-lived, single-use and bound to one Owner session/user plus one exact Server or Website target.

The browser then converts that capability into an on-demand ttyd session using:

`POST /api/panel/terminal/ttyd-sessions`

The request body contains exactly the capability. The API consumes the capability in the same Owner session/user and starts the ttyd session for the capability's already-resolved target. Caller-selected shell commands, executable paths, Unix users, cwd values, socket paths or ttyd flags are not accepted.

The public response contains only:

- protocol/audience;
- random session UUID;
- verified target;
- same-origin base path `/tools/ttyd/<sessionId>/`;
- expiry.

It does not expose the private Unix socket, internal authorization header or raw capability.

An explicit Owner-bound close endpoint exists:

`DELETE /api/panel/terminal/ttyd-sessions/:sessionId`

It accepts no mutable close arguments and only terminates a session owned by the current Owner session/user.

## Package and distro service policy

YunPanel uses the Ubuntu ttyd package but does not use the distro's long-running ttyd service as a public daemon.

The runtime manager:

- inspects `/usr/bin/ttyd` as a root-owned, non-group/world-writable regular file;
- verifies `ttyd --version` output;
- masks `ttyd.service` before package installation;
- installs only the allowlisted `ttyd` package with `--no-install-recommends` when missing;
- masks the distro service again with `--now` after installation;
- requires the distro unit to remain masked and inactive.

This prevents a default TCP ttyd service from appearing outside YunPanel's authenticated gateway lifecycle.

## One-shot private session process

Every ttyd terminal session receives a unique private Unix socket:

`/run/yunpanel/ttyd/<sessionId>.sock`

The socket root must be root-owned, group `yunpanel`, mode `02770`. The session socket must resolve to the restricted web gateway identity and mode `0660` before the session is returned to the browser.

ttyd is started with fixed source-controlled policy including:

- `--interface <private Unix socket>`;
- `--socket-owner yunpanel:yunpanel`;
- `--writable`;
- `--check-origin`;
- `--max-clients 1`;
- `--once`;
- `--signal 1`;
- fixed cwd;
- fixed base path `/tools/ttyd/<sessionId>`;
- fixed reverse-proxy auth header contract;
- terminal type `xterm-256color`.

No ttyd TCP port, Basic Auth credential, URL token or caller-supplied command flag is used.

## Server and Website identity

Server terminals are fixed to:

- user `root`;
- cwd `/root`;
- `/bin/bash --login`.

Website terminals support managed `static`, `node` and `php` Websites with a deterministic `yunapp-*` identity.

The terminal target resolver validates the managed current release path and resolves the current symlink to an exact UUID release beneath the same application root. PHP Website document root `.../current/public` is converted server-side to shell cwd `.../current`; caller input cannot select a different cwd.

For Website ttyd sessions the ttyd daemon itself drops privileges with its native `--uid` and `--gid` options to the exact managed Website account. The child shell is fixed `/bin/bash --noprofile --norc -i`. The legacy node-pty fallback still uses the older runuser path, but both paths reuse the same target/account/release resolver.

The terminal environment is a fixed secret-free allowlist (`HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, locale/color metadata). Control-plane secrets are not inherited.

## Public HTTP/WebSocket proxy

The restricted YunPanel web service is the only public browser gateway. It accepts only paths shaped as:

`/tools/ttyd/<uuid>/...`

Malformed, traversal-like or non-UUID ttyd paths are rejected instead of falling through to the SPA.

Before deriving a private socket path, the web gateway asks `/api/ttyd-gateway-access` with internal proxy identity plus the path-derived session UUID. The API verifies that the exact ttyd session belongs to the current live Owner session/user.

Browser-supplied internal headers are stripped, including tool-session, tool-transport and ttyd-auth headers. The gateway injects its own fixed ttyd reverse-proxy authorization header only after API authorization.

Panel cookies, CSRF values and internal proxy credentials are not forwarded into ttyd.

HTTP and WebSocket requests use the same private session socket. WebSocket requests must also match the configured panel Origin so ttyd's native `--check-origin` policy remains meaningful.

## Live reauthorization and cleanup

A successful HTTP page load does not mark a ttyd terminal as connected. The 60-second startup deadline is cleared only after the authenticated WebSocket path is authorized.

Active ttyd WebSockets are reauthorized through the session-bound API access gate every 15 seconds. If Owner authentication, role/MFA authority or session ownership no longer validates, the public and upstream WebSocket are destroyed.

Unused capabilities and one-shot sessions are tied to the common live-session registry. Logout/session revocation terminates the ttyd process group. Explicit close, startup timeout, absolute lifetime, server shutdown and process failure also enter the bounded cleanup path.

Process termination sends SIGHUP and then bounded SIGKILL fallback. Session socket files are removed after process exit.

Default source limits are five concurrent ttyd sessions per Owner, twenty globally, 60 seconds to establish the first WebSocket and four hours absolute session lifetime.

## Browser UI

The reusable TerminalPanel now presents ttyd as the primary action for both Server root terminals and managed Website terminals.

The browser never places the terminal capability in a URL. It exchanges the capability for the validated ttyd session through the normal authenticated API, stores only the returned public session metadata in component state, and embeds the same-origin `/tools/ttyd/<sessionId>/` page.

Closing the ttyd terminal explicitly calls the Owner-bound DELETE session endpoint. Route/component disposal also attempts cleanup.

The old embedded xterm/node-pty terminal remains visible only as a **Legacy gömülü terminal** migration fallback. It must be removed after real ttyd acceptance rather than extended.

## Legacy node-pty fallback

The old path is still packaged and wired in parallel:

- `POST /api/panel/terminal/capabilities`;
- WebSocket `/api/terminal`;
- custom JSON input/resize/output protocol;
- root/site node-pty process manager;
- embedded xterm.js UI.

It remains subject to existing Owner/session/revocation/output-limit controls, but it is no longer the target terminal product.

## Acceptance gate

Source contracts and source-level tests are not proof that ttyd works correctly on the real package/browser/PTY stack.

`todo.md` T-TOOLS remains authoritative for:

- Ubuntu package/version/service masking;
- absence of public ttyd TCP listeners;
- Unix socket ownership/mode;
- Website UID/GID drop;
- root terminal behavior;
- Ctrl+C/Ctrl+D, Unicode/IME, resize, vim/top/full-screen TUI behavior;
- parallel sessions and one-shot disconnect cleanup;
- wrong Origin/cookie/MFA/role/session rejection;
- live logout/revoke behavior;
- package upgrade/restart behavior;
- final removal of node-pty/xterm.

GitHub Actions were not used for this development pass.
