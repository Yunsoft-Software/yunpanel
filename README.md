# YunPanel

YunPanel is Yunsoft's website-centric hosting and server control plane for Node.js, static, Docker, database, domain, SSL, backup and mail workloads without depending on a full Plesk installation.

The project is intentionally scoped around Yunsoft production needs rather than full Plesk feature parity.

## Current architecture

The management entry point is a routed React workspace with dashboard, server management, website/domain hierarchy, site detail tabs, application/environment controls, tracked jobs and Owner/Read Only access boundaries.

The privileged execution target is now the local `yunpanel-api` runtime rather than a separate agent. A server can be created directly as a credentialless local-only identity or an existing enrolled server can be migrated to local ownership with guarded CLI tooling. When local execution is enabled, the API maintains the server's inventory, systemd-service, Docker and Nginx snapshots directly from `@yunpanel/host-runtime` and consumes the durable job queue locally.

The old `yun-agent` package/service and its enrollment/heartbeat/command/result transport are still retained temporarily for tested migration rollback compatibility. They are not the default development workflow, and the web UI no longer offers enrollment-token provisioning as the normal server setup path. Do not remove the retained daemon/package compatibility surface until the real migration and rollback gates in `todo.md` pass.

**The complete hosting target is not implemented yet.** Site routes still rely on the existing domain/application model instead of the planned persistent Website identity. Files, cron, backup, terminal, full Docker lifecycle and mail management remain incomplete where their real backends are missing.

See [plan.md](plan.md) for remaining implementation work, [todo.md](todo.md) for supported-runtime/browser/package/real-host acceptance, and [agents.md](agents.md) for binding development rules. Completed tasks leave the task lists; implementation history stays in Git. Unless explicitly requested otherwise, work directly on `main` in small commits. Do not add GitHub Actions.

## Authentication and privilege boundary

Local Owner setup, login/logout, persistent sessions, password changes/recovery, TOTP enrollment, MFA login/recovery and Owner-protected user administration are wired to the API and React entry points. The workspace remains inside `AuthGate`; the web gateway does not inject a shared administrator bearer token.

HTTPS management requires Owner MFA enrollment. Password-only sessions may complete their own setup/recovery but cannot enter privileged management. Origin/CSRF enforcement, persistent login throttling, session generation, idle/absolute expiry and revocation remain part of the control-plane boundary.

The packaged privilege model is intentional:

- `yunpanel-web.service` is unprivileged and sandboxed away from control-plane secrets/state.
- `yunpanel-api.service` is the privileged host control plane and may run as root for fixed, structured host administration.
- Static Git/npm/build/artifact work runs as a deterministic dedicated `yunapp-*` user.
- Node Git/npm/build and the generated Node systemd service run as the deterministic application user, not root; the service uses `NoNewPrivileges`, an empty capability set and restricted writable paths.
- Future site cron, file-manager and site terminal work must keep the site-user boundary.
- Only the explicitly Owner-protected Server terminal target may become a root interactive surface after the WebSocket/session/MFA/audit release gates are complete.

Do not replace structured operations with an unauthenticated generic shell or make site workloads inherit API root privilege.

## Implemented foundations

- React/JavaScript/JSX routed management UI with site breadcrumbs, URL-backed list state, parent/child domain context, shared controls and dirty-form protection on implemented advanced forms.
- Dashboard and server views based on persisted inventory rather than fabricated metrics; unavailable values remain unknown.
- Owner/Read Only route and HTTP boundaries, initial Owner setup, native Argon2id hashing, private SQLite session/user persistence and mandatory Owner MFA for HTTPS management.
- Explicit domain/subdomain parent references, aliases, Nginx stage/activate and ACME issue/renew foundations.
- Static deploy/rollback and Node deploy/restart/status/rollback with dedicated application users, health checks and guarded rollback behavior.
- AES-256-GCM application environment storage, masked metadata and execution-time secret materialization without putting plaintext environment values into generic job records.
- Managed-service inspect/install/start/stop/restart support for the current allowlisted host services.
- MySQL/MariaDB local-socket inventory and database create/delete job flows with result sanitization.
- Durable queued/running/terminal job persistence with versioned private recovery sidecar state. Terminal-but-unreconciled work survives restart and blocks new mutations until reconciled.
- Root-only packaged recovery inspection and terminal reconciliation tooling. Side-effect-free running `system.packages.inspect` and `database.inspect` jobs have an explicit `recover-readonly` path; unknown outcomes for mutating jobs remain fail-closed.
- Credentialless fresh local server bootstrap plus guarded existing-server `status/bind/release` migration tooling.
- Agentless local snapshots for host inventory, allowlisted systemd services, Docker and Nginx.
- Debian packaging for API, restricted web gateway and the temporarily retained legacy agent compatibility service.

## Development

Requirements:

- Node.js **24.11.1+**, including native Argon2 and SQLite.
- npm **11+**.

Install and start the default development stack:

```bash
npm install
npm run dev
```

`npm run dev` starts only the web app on `127.0.0.1:5173` and API on `127.0.0.1:3001`. It does **not** start `yun-agent`. The legacy daemon can still be started explicitly with `npm run dev:agent` when a compatibility or rollback test actually needs it.

Local privileged execution is opt-in through `YUNPANEL_LOCAL_SERVER_ID`; do not invent a server identity just to make jobs run. Follow [docs/local-runtime-migration.md](docs/local-runtime-migration.md) for the guarded fresh-create and existing-server migration paths.

Create the first Owner from another terminal at the repository root:

```bash
npm run auth -- setup-token
```

No default credentials are created. Follow [docs/mfa.md](docs/mfa.md) and [docs/authentication.md](docs/authentication.md) for the current auth setup and recovery rules.

Run validation with:

```bash
npm run check
```

Historical commits have passed full supported-Node and package acceptance, but that does not prove the current tree. `todo.md` records the current full-check, browser, Ubuntu package and live acceptance gates that must be rerun after the recent agentless/recovery changes.

## Local ownership and durable recovery

The packaged ownership tools are intentionally fail-closed. Fresh local bootstrap and existing-agent migration are separate operations:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs create --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs status <server-uuid>
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs bind <server-uuid> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs release <server-uuid> --confirm
```

Before ownership changes, inspect durable recovery:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
```

Terminal reconciliation never re-runs the host operation. `recover-readonly` may re-run only explicitly allowlisted side-effect-free inspection operations. Mutating jobs with unknown host outcome must remain blocked until an operation-specific external proof mechanism exists.

The exact migration/recovery sequence and rollback rules live in [docs/local-runtime-migration.md](docs/local-runtime-migration.md).

## Debian package and release gates

Runtime state belongs under `/var/lib/yunpanel`; configuration and secrets belong under `/etc/yunpanel`. Production control-plane state is constrained below `/var/lib/yunpanel/control-plane`. Preserve the existing `YUNPANEL_SECRET_MASTER_KEY` across upgrades and use the dedicated rotation procedure rather than editing it in place.

Build candidates only after a clean supported-runtime check:

```bash
npm install
npm run check
./scripts/build-deb.sh <new-version>
```

A repository commit is not a live deployment. Before replacing the currently accepted package, verify the new `.deb` contents, fresh agentless bootstrap, existing-host migration, recovery tools, root API/web sandbox, auth state ownership, hosted workload continuity and rollback on an isolated Ubuntu host as specified in `todo.md`.

No package publication, migration or live deployment occurs merely by updating this repository.

## More documentation

- [docs/development.md](docs/development.md) — current agentless development workflow and retained compatibility path.
- [docs/local-runtime-migration.md](docs/local-runtime-migration.md) — fresh bootstrap, existing-server migration, durable recovery and rollback.
- [docs/website-workspace.md](docs/website-workspace.md) — current workspace routes and limitations.
- [docs/owner-mfa-policy.md](docs/owner-mfa-policy.md) — HTTPS Owner MFA requirements.
- [docs/secret-master-key-rotation.md](docs/secret-master-key-rotation.md) — key rotation and rollback procedure.
