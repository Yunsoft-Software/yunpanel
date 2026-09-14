# Passenger/provisioning preflight — 2026-09-15

## Source gate

- `main` was fast-forwarded to `0b41c1c` before the fixes in this increment.
- Node `24.11.1` and npm `11.6.2` were used for a clean `npm ci` and `npm run check`.
- Repository policy validation, every workspace test, and the production Vite build passed.
- The test fixes preserve the production root ownership default for Passenger environment includes; non-root source tests inject their expected fixture owner explicitly.

## Ubuntu test-host preflight

- Only the repository-external `.local/test-server.env` target `157.180.11.28` was contacted. It is not the excluded `.44` Plesk host.
- The host reports Ubuntu `24.04`, `amd64`, system Node `v24.20.0`, Nginx `1.24.0`, and installed YunPanel package `0.3.0-2026091406`.
- `nginx -t` succeeded and `nginx.service` was active/enabled.
- `libnginx-mod-http-passenger`, `passenger-config`, and managed `/opt/yunpanel/node-runtimes/v22`/`v24` binaries were absent at preflight. No readiness claim was made for Passenger; installation and live Website acceptance remain in `todo.md`.

## Package upgrade and headed acceptance

- The source gate was repeated on Ubuntu/amd64 before building `yunpanel_0.3.0-2026091502_amd64.deb`; the artifact SHA-256 was verified before installation.
- The official migration backup completed and verified before upgrading from `0.3.0-2026091406` to `0.3.0-2026091502`. Selected Application, Website, Domain, runtime-binding, database, DNS and mail state hashes remained unchanged across the upgrade.
- A stale read-only service inspection job was recovered through the packaged recovery path before deployment. The repaired systemd inspection adapter now records missing units as `unknown`, and the durable job completed without replaying a mutation.
- The panel HTTPS origin returned `200`; Nginx, `yunpanel-api`, and `yunpanel-web` remained active, and `nginx -t` succeeded after deployment.
- Headed Owner login and the server terminal were exercised through the public same-origin gateway. The panel Nginx vhost was missing WebSocket forwarding headers and still used Nginx's default proxy timeout; its previous file was saved in the deployment rollback directory, the upgrade headers plus four-hour read/send timeouts were added behind an `nginx -t` gate, and Nginx was reloaded successfully.
- The headed terminal then connected as `root` in `/root`; `whoami`, `pwd`, and `node --version` returned `root`, `/root`, and `v24.20.0`. This proves the retained node-pty migration fallback only; ttyd replacement acceptance remains in `todo.md`.
- The live service inventory still reported Passenger, Roundcube, Postfix, Dovecot, Rspamd and Docker as absent. Their installation and end-to-end acceptance remain open and are not claimed by this report.

No password, cookie, token, key, private environment value, or provider response was recorded.
