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

The privileged local executor is opt-in. Without `YUNPANEL_LOCAL_SERVER_ID`, the API starts normally but does not claim local host jobs. Use the guarded local-runtime bootstrap/migration tooling before assigning a real server identity; do not invent a server UUID or bypass hostname/ownership checks.

## Retained legacy agent development

The legacy `yun-agent` remains available only for compatibility and migration/rollback validation while the real-host acceptance gates in `todo.md` are open. It is not started by `npm run dev`.

Start it explicitly only when a rollback/compatibility test requires an already-existing legacy identity:

```bash
npm run dev:agent
```

The retained daemon uses `YUN_AGENT_HOST`, `YUN_AGENT_PORT`, `YUN_AGENT_MODE` and `YUN_AGENT_TOKEN` for its old local read-only HTTP surface. Existing enrolled rollback identities may additionally use `YUNPANEL_CONTROL_PLANE_URL`, `YUN_AGENT_IDENTITY_FILE`, `YUN_AGENT_HEARTBEAT_MS` and `YUN_AGENT_COMMAND_POLL_MS` for the retained heartbeat/command/environment/result channel.

New enrollment is retired. `YUNPANEL_ENROLLMENT_TOKEN`, `/api/servers/enroll` and first-enrollment client behavior must not be reintroduced. If the retained agent has no existing identity file, its control-plane link fails closed instead of attempting enrollment.

Production must never rely on the development fallback agent token. New host functionality belongs in `@yunpanel/host-runtime` and the local executor; the retained daemon exists only until migration + rollback acceptance permits its removal.

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
- Node enable/disable/start/stop uses the active release runtime snapshot and does not materialize application secrets,
- Node 22/24 site runtimes install under `/opt/yunpanel/node-runtimes`; site deploy/build/systemd PATH uses the selected major while `/usr/local/bin/node` remains the panel runtime,
- deploy requests may select an exact branch, tag or full commit SHA; the queued target is bounded metadata and the resolved target is recorded with the release,
- private GitHub tokens and unencrypted SSH deploy keys use the same encrypted Application secret store but are hidden from application environment list/materialization; token askpass and temporary SSH key material exist only for Git clone/fetch,
- retained legacy-agent materialization exists only for rollback compatibility while that transport remains installed,
- secret values are not included in generic deployment/restart/rollback job payloads or result records; only the bounded environment revision is carried with Node work,
- managed runtime keys `NODE_ENV`, `HOST`, `PORT` and `YUNPANEL_APPLICATION_ID` cannot be overridden by application environment input.

The default application environment registry file is `.data/application-environment-registry.json`. Override it with `YUNPANEL_APPLICATION_ENVIRONMENT_STORE` when required. The state file is mode `0600`; application environment secrets, internal deployment credentials and GitHub webhook secrets contain ciphertext, IV and authentication tag rather than plaintext values. Deployment credentials and webhook secrets are reserved internal records and never enter the hosted process environment.

Cloudflare DNS-01 and record-management credentials use the same root key but a separate `.data/dns-provider-credential-registry.json` store, configurable with `YUNPANEL_DNS_CREDENTIAL_STORE`. Public reads expose only provider/configuration metadata. For certificate work the token is decrypted only by the local root executor, written to a private temporary Certbot credentials file beneath `/run/yunpanel/acme-credentials`, and removed after issue/renew. For record work it is materialized only for the bounded HTTPS provider adapter and never copied into job payload/result/recovery/audit/log/URL state. The Debian package depends on `python3-certbot-dns-cloudflare`; real provider validation remains an Ubuntu acceptance item.

Owner-only `POST /api/dns-zones/:dnsZoneId/readiness/refresh` accepts exactly `{ "expectedRevision": <positive integer> }`. It reads public A/AAAA/CNAME evidence with a bounded resolver timeout, matches canonical addresses against the linked managed Server inventory and reports separate routing, HTTP-01 and DNS-01 readiness. The lifecycle revision changes only after that evidence is collected and the caller's revision still matches. This route does not mutate external DNS; real resolver and dual-stack acceptance remains in `todo.md`.

Owner-only `POST /api/dns-zones/:dnsZoneId/records/preview` and `/records/apply` manage canonical A/AAAA/CNAME records through Cloudflare. Apply requires the exact current preview digest and typed confirmation, then creates a durable resource-locked local job; provider snapshot or credential/zone revision drift fails before queueing. A successful record job does not update readiness because public propagation remains separately observed.

Docker Website identity tracking uses `.data/docker-workload-registry.json` or `YUNPANEL_DOCKER_WORKLOAD_STORE`. The current API is deliberately limited to `GET /api/docker/workloads`, `GET /api/docker/workloads/:dockerWorkloadId` and Owner-only `POST /api/docker/workloads`. A create request must declare `managementMode=external` and an exact same-server loopback host/port/WebSocket target; the response explicitly reports that no container or Nginx change occurred. Managed Compose lifecycle is not implemented by this tracking endpoint.

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

There is no `/api/dev/agent/inspect` compatibility route anymore. Development inventory should use the same local host/runtime paths as production code; do not add a loopback agent backdoor.

Protected application environment metadata:

```text
GET    /api/applications/:applicationId/environment
GET    /api/applications/:applicationId/environment/status
PUT    /api/applications/:applicationId/environment/:key
DELETE /api/applications/:applicationId/environment/:key
POST   /api/applications/:applicationId/environment/import
```

Secret variables are returned as metadata only; plaintext values are not returned by the normal admin list API. The import route accepts exact `content`, `mode`, `secret`, `expectedRevision` and `confirmation` fields. `content` is a bounded strict `KEY=value` dotenv subset; duplicate/reserved/multiline values fail before mutation. Merge requires `confirmation: null`; replace requires `replace-environment:<application-id>:<saved-revision>`. Each real edit/import creates one saved revision with added/updated/deleted counts.

Environment status remains `saved_on_disk` until a Node deploy, restart or rollback materializes that exact queued revision and its successful job reconciles to the exact running release. Job-time materialization rejects revision drift; environment and deploy-credential mutations are blocked while Application work is queued/running.

## Local ownership and recovery tools

Fresh agentless server creation, existing-enrolled migration, rollback rehearsal and durable recovery use separate guarded CLIs. Packaged ownership mutation is root-only.

Before ownership mutation, create and rehearse the exact rollback snapshot:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs verify /var/backups/yunpanel/migration-<timestamp>
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs preview /var/backups/yunpanel/migration-<timestamp>
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs stage /var/backups/yunpanel/migration-<timestamp> --confirm
```

`preview` and `stage` are non-live. They validate the archive/link/type graph, `yunapp-*` Unix identity drift and private staged extraction without applying files to live `/etc` or `/var/lib`.

Ownership commands:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs create --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs status <server-uuid>
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs bind <server-uuid> --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs release <server-uuid> --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
```

After local ownership is configured and the API is started with the legacy agent inactive, run the read-only post-migration gate:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs validate <server-uuid>
```

`validate` checks exact local binding/hostname, current API runtime version, API active + agent inactive systemd state, idle queue, clear durable recovery, fresh local inventory/services snapshot and loopback `/api/health` success.

Durable recovery starts with:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
```

Terminal reconciliation does not re-run a host mutation. Running recovery is limited to reviewed operation-specific paths: side-effect-free package/service/database/Node status re-inspection, evidence/receipt-backed host operations, and exact idempotent Cloudflare record post-condition recovery. There is no generic force-success, force-failed, blind mutation retry or manual journal-clear path.

See `docs/local-runtime-migration.md` for the exact commands and evidence requirements.

## Local log API

Log reads are sensitive Owner-management operations and remain unavailable for Read Only accounts, remote legacy-agent records or a panel without an active local-server binding. Supported routes are:

```text
GET /api/applications/:applicationId/logs/node
GET /api/servers/:serverId/logs/:serviceId
GET /api/jobs/:jobId/logs/deploy
```

Append `/stream` for a finite NDJSON snapshot or `/download` for a bounded `text/plain` attachment. This is not an open-ended SSE tail. `serviceId` accepts the managed service catalog, `yunpanel-api`, `yunpanel-web`, `nginx-access` or `nginx-error`; arbitrary systemd units and filesystem paths are never accepted.

Query fields are exact: `since`, `until`, `level`, `q`, `cursor` and `limit`. The default range is 24 hours and a single request cannot exceed 30 days, 200 entries or the reader byte cap; deploy downloads may request at most 1,000 already-bounded private entries. Do not put secrets into `q` or any URL. Journal cursors, Nginx byte cursors and deploy sequence cursors are source-specific and fail closed when malformed or stale.

Deploy output is stored beside the durable job registry under private `0700`/`0600` paths. Each job retains at most 1,000 entries and 512 KiB; global retention is 30 days and 500 job files. ANSI/control characters, common credential assignments, Authorization values, authenticated URLs, GitHub tokens, JWTs and private-key blocks are redacted before persistence or response. This defense does not make application logs an appropriate place to print secrets.

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
- site file-manager workers run through fixed arguments as the deterministic `yunapp-*` user and remain confined to the canonical active release,
- site terminals run through fixed `runuser` arguments as their deterministic `yunapp-*` user and managed current-release directory,
- only the HTTP-authenticated, MFA-complete Owner may exchange a short-lived session capability for the local Server root PTY; logout, password/MFA/role/user changes close live sessions.

Do not add plaintext secret persistence, arbitrary filesystem escape, unrestricted Nginx snippets or unauthenticated/root socket surfaces.

## Real-server validation

Code-level tests do not replace Ubuntu/systemd validation. `todo.md` is the living list for tests that require a supported Node runtime, real managed host, DNS, package upgrade/rollback, browser or Plesk state. When a server-side requirement or test result changes, update `todo.md` in the same development cycle and keep `plan.md` limited to remaining implementation work.
