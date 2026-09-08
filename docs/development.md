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
| Agent | `http://127.0.0.1:4010` | local read-only development agent |

Vite proxies `/api/*` requests to the API during development.

## Development agent authentication

The development process uses a deliberately development-only fallback token when `YUN_AGENT_TOKEN` is not set. The fallback token must never be accepted as a production deployment credential.

Outside development mode the agent refuses to start without `YUN_AGENT_TOKEN`. The API also requires an explicit agent token when `NODE_ENV=production`.

Example local override:

```bash
export YUN_AGENT_TOKEN='replace-with-a-random-local-token'
npm run dev
```

The agent binds to `127.0.0.1` by default. Future server enrollment will replace the development token model with server identities and stronger authenticated transport.

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

The API and frontend are the control plane and must not run as root. Root-required server mutations will eventually be implemented only as explicit allowlisted `yun-agent` operations.

Do not add generic shell execution, arbitrary filesystem access, unrestricted Nginx snippets or a root terminal endpoint.

## Production note

Milestone 0 is architecture scaffolding. Do not replace Plesk-managed production services with the current agent yet. Real server enrollment, authentication, inventory verification and mutation safeguards are introduced in later milestones.
