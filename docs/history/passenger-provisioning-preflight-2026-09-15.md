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

No password, cookie, token, key, private environment value, or provider response was recorded.
