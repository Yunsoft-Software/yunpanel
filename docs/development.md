# Local development

## Prerequisites

YunPanel targets Node.js 24.11.1+ and npm 11+. The frontend is React with JavaScript/JSX only; TypeScript is intentionally forbidden by repository policy.

Install dependencies from the repository root:

```bash
npm install
```

## Default development services

```bash
npm run dev
```

The default launcher is agentless and starts only:

| Service | Address | Purpose |
| --- | --- | --- |
| Web | `http://127.0.0.1:5173` | React operator interface |
| API | `http://127.0.0.1:3001` | control-plane API and optional local executor |

Vite proxies `/api/*` requests to the API during development.

The privileged local executor is opt-in. Without `YUNPANEL_LOCAL_SERVER_ID`, the API starts normally but does not claim local host jobs. Use the guarded local-runtime bootstrap/migration tooling before assigning a real server identity; do not invent a server UUID or bypass the hostname/ownership checks.

## Retained legacy agent development

The legacy `yun-agent` remains available only for compatibility and migration/rollback validation while the acceptance gates in `todo.md` are open. It is not started by `npm run dev`.

Start it explicitly when a legacy test actually requires it:

```bash
npm run dev:agent
```

The retained daemon uses `YUN_AGENT_HOST`, `YUN_AGENT_PORT`, `YUN_AGENT_MODE` and `YUN_AGENT_TOKEN` for its local read-only HTTP surface, plus the `YUNPANEL_CONTROL_PLANE_URL` / enrollment / identity settings for the old outbound control-plane transport. Fresh agentless development does not need those values.

Production must never rely on the development fallback agent token. The retained transport is temporary compatibility infrastructure; new host functionality belongs in `@yunpanel/host-runtime` and the local executor.

## Application environment encryption

User-defined application secrets are stored separately from normal application metadata and generic job history. Secret values are encrypted at rest with AES-256-GCM and are materialized at execution time only when a Node deploy, restart or rollback needs them.

Configure a 32-byte master key through `YUNPANEL_SECRET_MASTER_KEY`. The value may be a 64-character hexadecimal string or base64 encoding of exactly 32 bytes.

Generate a development key with Node.js:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Then export it before starting the API:

```bash
export YUNPANEL_SECRET_MASTER_KEY='<generated-64-character-hex-value>'
```

Rules:

- never commit the master key,
- never place it in `plan.md`, `todo.md`, logs or screenshots,
- secret writes fail closed when no master key is configured,
- existing encrypted secrets cannot be decrypted with a different key,
- production key backup/rotation is an explicit secret-management procedure,
- local Node deploy/restart/rollback materializes environment values directly from the application environment registry at execution time,
- retained legacy-agent materialization exists only for rollback compatibility while that transport remains installed,
- secret values are not included in generic deployment/restart/rollback job payloads or result records,
- managed runtime keys `NODE_ENV`, `HOST`, `PORT` and `YUNPANEL_APPLICATION_ID` cannot be overridden by application environment input.

The default application environment registry file is `.data/application-environment-registry.json`. Override it with `YUNPANEL_APPLICATION_ENVIRONMENT_STORE` when required. The state file is mode `0600`; secret records contain ciphertext, IV and authentication tag rather than plaintext values.

Managed Node applications receive their effective environment in:

```text
/etc/yunpanel/apps/<application-id>.env
```

The environment file is root-protected, while the generated Node systemd service runs as the deterministic dedicated `yunapp-*` application user rather than root.

## Useful entry points

API health:

```text
GET http://127.0.0.1:3001/api/health
```

The retained development compatibility inspection route is:

```text
GET http://127.0.0.1:3001/api/dev/agent/inspect
```

Despite its legacy route name, it no longer makes a loopback request to `yun-agent`; it reads the same local host inventory implementation used by the agentless runtime. It remains disabled with a 404 outside development mode and will be removed with the rest of the legacy naming surface.

Protected application environment metadata:

```text
GET    /api/applications/:applicationId/environment
PUT    /api/applications/:applicationId/environment/:key
DELETE /api/applications/:applicationId/environment/:key
```

Secret variables are returned as metadata only; plaintext values are not returned by the normal admin list API.

## Local ownership and recovery tools

Fresh agentless server identity creation, existing-agent migration and durable recovery have separate guarded CLIs. The source checkout may exercise their pure logic in tests, but packaged ownership mutation is root-only and must follow `docs/local-runtime-migration.md`.

Important boundaries:

- `local-runtime create --confirm` is for a fresh credentialless local-only identity,
- `status/bind/release` preserves the existing enrolled identity during migration/rollback,
- `job-recovery status` is read-only,
- terminal reconciliation does not re-run the host mutation,
- `recover-readonly` is limited to explicitly allowlisted side-effect-free inspections,
- unknown outcomes for mutating jobs must not be guessed or automatically retried.

## Validation

Run repository policy validation:

```bash
npm run lint
```

It enforces critical project rules including:

- no `.ts` or `.tsx` files,
- no `typescript` package dependency,
- no `.github/workflows` directory.

Run Node tests:

```bash
npm test
```

Build all buildable workspaces:

```bash
npm run build
```

Run all checks together:

```bash
npm run check
```

Do not describe the current tree as fully checked merely because an older commit passed. `todo.md` records which Node 24, package, browser and real-host acceptances still need to be rerun for the current source.

## Privilege boundary

The packaged architecture deliberately separates control-plane privilege from site workload privilege:

- `yunpanel-web.service` remains unprivileged and sandboxed from control-plane secrets/state,
- packaged `yunpanel-api.service` is the privileged host control plane and may run as root for fixed allowlisted host administration,
- generic arbitrary command execution is not an internal replacement for structured host operations,
- static Git/npm/build/artifact work runs through a dedicated deterministic `yunapp-*` user,
- Node Git/npm/build runs as the dedicated application user and the generated systemd service uses the same user with `NoNewPrivileges`, an empty capability set and restricted writable paths,
- future site cron, file-manager and site terminal work must preserve the dedicated site-user boundary,
- only the explicitly Owner-protected Server terminal target may become a root interactive surface after its authentication/WebSocket/audit release gates are complete.

Do not add plaintext secret persistence, arbitrary filesystem escape, unrestricted Nginx snippets or unauthenticated/root socket surfaces.

## Real-server validation

Code-level tests do not replace Ubuntu/systemd validation. `todo.md` is the living list for tests that require a supported Node runtime, real managed host, DNS, package upgrade/rollback, browser or Plesk state. When a server-side requirement or test result changes, update `todo.md` in the same development cycle and keep `plan.md` limited to remaining implementation work.
