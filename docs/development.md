# Local development

## Prerequisites

YunPanel currently targets Node.js 24 and npm 11. The frontend is React with JavaScript/JSX only; TypeScript is intentionally forbidden by repository policy.

Install dependencies from the repository root:

```bash
npm install
```

## Start all development services

```bash
npm run dev
```

This launches:

| Service | Address | Purpose |
| --- | --- | --- |
| Web | `http://127.0.0.1:5173` | React operator interface |
| API | `http://127.0.0.1:3001` | normal control-plane API |
| Agent | `http://127.0.0.1:4010` | local development agent |

Vite proxies `/api/*` requests to the API during development.

## Development agent authentication

The development process uses a deliberately development-only fallback token when `YUN_AGENT_TOKEN` is not set. The fallback token must never be accepted as a production deployment credential.

Outside development mode the agent requires explicit protected identity/credentials and the control-plane link requires HTTPS. Enrolled agents authenticate all heartbeat, command, result and application-environment requests with their server-scoped agent credential.

Example local override:

```bash
export YUN_AGENT_TOKEN='replace-with-a-random-local-token'
npm run dev
```

The local direct agent API binds to `127.0.0.1` by default. Managed-server mutations are restricted to allowlisted operations; there is no arbitrary shell endpoint.

## Application environment encryption

User-defined application secrets are stored separately from the normal application registry and generic job history. Secret values are encrypted at rest with AES-256-GCM and are materialized to the managed agent only when a Node deploy, restart or rollback needs them.

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
- production key backup/rotation must be treated as an operational secret-management procedure,
- the agent receives materialized environment values only over its authenticated control-plane channel; production control-plane URLs must use HTTPS,
- secret values are not included in generic deployment/restart/rollback job payloads or result records,
- managed runtime keys `NODE_ENV`, `HOST`, `PORT` and `YUNPANEL_APPLICATION_ID` cannot be overridden by application environment input.

The default application environment registry file is `.data/application-environment-registry.json`. Override it with `YUNPANEL_APPLICATION_ENVIRONMENT_STORE` when required. The state file is written with mode `0600`; secret records contain ciphertext, IV and authentication tag rather than plaintext values.

On managed Node servers the agent atomically materializes the effective environment into:

```text
/etc/yunpanel/apps/<application-id>.env
```

The directory is created with mode `0700` and the EnvironmentFile with mode `0600`. systemd units reference that file rather than embedding secrets in unit text or command arguments.

## Useful endpoints

API health:

```text
GET http://127.0.0.1:3001/api/health
```

Agent health:

```text
GET http://127.0.0.1:4010/health
```

Development API-to-agent inspection:

```text
GET http://127.0.0.1:3001/api/dev/agent/inspect
```

The last endpoint is disabled with a 404 when `NODE_ENV=production`.

Protected application environment metadata:

```text
GET    /api/applications/:applicationId/environment
PUT    /api/applications/:applicationId/environment/:key
DELETE /api/applications/:applicationId/environment/:key
```

Secret variables are returned as metadata only; their plaintext value is not returned by the normal admin list API.

## Validation

Run repository policy validation:

```bash
npm run lint
```

This currently enforces critical project rules including:

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

## Security boundary

The API and frontend are the control plane and must not run as root. Root-required server mutations are implemented only as explicit allowlisted `yun-agent` operations with structured validation and deterministic service/path identities.

Do not add generic shell execution, arbitrary filesystem access, unrestricted Nginx snippets, a root terminal endpoint, or plaintext secret persistence in generic resource/job records.

## Real-server validation

Code-level tests do not replace Ubuntu/systemd validation. `todo.md` is the living list for tests that require a real managed server, DNS, Plesk state or production-like infrastructure. When a server-side requirement or test result changes, update `todo.md` in the same development cycle as the corresponding code and keep `plan.md` synchronized as well.
