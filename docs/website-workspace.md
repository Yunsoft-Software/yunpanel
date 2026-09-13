# Website workspace — current backend and panel boundary

YunPanel now has a real persistent Website resource and a routed Website workspace. Visual redesign/layout/styling/component polish is still a later phase, but implemented hosting capabilities are no longer represented as placeholder tabs: the workspace consumes real authenticated API contracts and explicit resource relationships.

## Persistent Website resource

YunPanel keeps Website identity separate from hostname/domain records.

Core Website contracts include:

- `GET /api/websites`
- `GET /api/websites/:websiteId`
- `GET /api/websites/:websiteId/domains`
- `POST /api/websites`
- `POST /api/websites/:websiteId/update-preview`
- `PATCH /api/websites/:websiteId`
- `GET /api/docker/workloads`
- `GET /api/docker/workloads/:dockerWorkloadId`
- `POST /api/docker/workloads`
- `GET /api/websites/migration/preview`
- `GET /api/websites/migration/status`
- `POST /api/websites/migration/bind`
- `POST /api/websites/migration/finalize`
- `POST /api/websites/migration/rollback`

Website state is stored separately through `YUNPANEL_WEBSITE_STORE`. Migration enforcement state is stored through `YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE`. Production startup validates persisted Website server/Application/Docker-workload foreign keys before accepting managed Domain state.

The Website ID is not a Domain ID. Backend relationships use explicit foreign keys rather than permanent server/port/root heuristics.

## Website resource hierarchy in the panel

The Website detail route is the primary hosting workspace. It exposes real linked-resource state instead of fabricated capability cards.

Current Website-linked surfaces include:

- Domain/subdomain hierarchy and SSL/certificate state.
- Static or Node Application identity, runtime/configuration, environment, deploy history and process controls.
- Local file manager, Node/Nginx logs and Website-scoped terminal for supported static/Node sites.
- Explicit database relationships.
- Explicit mail-domain/mailbox relationships.
- Explicit external Docker workload relationships.
- Managed Docker/Compose project relationships.
- Job/resource navigation so queued and completed operations can return to the affected resource.

Database, mail and Managed Compose relationships are not inferred from hostname, port or filesystem coincidence. Missing/unavailable dependency providers remain explicit rather than being guessed.

## Application runtime and deployment

Node Application runtime settings use Owner-only `POST /api/applications/:applicationId/configuration-preview` and `POST /api/applications/:applicationId/configuration`. Apply requires the exact desired revision, preview digest and typed confirmation. The managed port is immutable in this flow because it is part of Website/Nginx routing identity.

Node major, direct-file or package-script startup, npm/pnpm/yarn, production/development mode and a validated release-contained document root are configurable. A deployed Application retains its separate `activeRuntime` until a successful deploy applies desired settings; restart, status and rollback use the active or release-specific snapshot rather than silently applying pending configuration.

Owner-only `POST /api/applications/:applicationId/process` accepts exactly `enable`, `disable`, `start` or `stop` plus release-bound confirmation. It queues the active release/runtime snapshot, never a pending desired runtime or arbitrary shell command. Start waits for health and returns an unhealthy service to stopped state. Persisted running process jobs can be recovered only when exact Application intent plus current systemd/health state proves the requested idempotent final state.

Managed Node runtime routes support maintained Node 22/24 LTS lines. Runtime installation verifies the official release checksum and writes only the version-specific `/opt/yunpanel/node-runtimes` tree. Deploy/build/systemd PATH use the selected site major without replacing YunPanel's packaged Node runtime.

Static and Node deploys accept an explicit branch, tag or immutable 40-character commit target. Git fetch runs as the deterministic `yunapp-*` site user and release history retains requested target and resolved commit separately.

Per-Application GitHub webhooks verify the untouched request-body SHA-256 signature, exact repository/configured branch and full pushed commit before entering the shared durable deploy flow. Delivery IDs are private idempotency keys and concurrent work on the same resource is locked by the persistent job registry. GitHub Actions are not used.

Deployment credentials support masked GitHub token or SSH deploy-key metadata backed by the AES-256-GCM master-key store. Credential material is excluded from normal Application environment reads, durable job results and common audit metadata.

Application environment supports single-key edits plus strict `.env` merge/replace import with optimistic revision and typed replacement confirmation. Public environment metadata contains only safe revision/apply metadata; plaintext values do not enter generic job records.

## External Docker workload tracking

External Docker workload records remain explicit `external` tracking resources and begin `unverified`. Creating such a record does not claim that YunPanel inspected Compose, started a container or changed Nginx. A Docker Website binds one explicit same-server workload ID; its loopback proxy target is derived from that workload and one workload cannot be attached to multiple Websites.

This external tracking model is intentionally separate from Managed Docker/Compose projects.

## Managed Docker / Compose

Managed Compose is now a real backend and panel surface rather than a future placeholder.

Implemented source capabilities include:

- Validated Compose desired-state with encrypted project environment and registry credential handling.
- Durable lifecycle, recovery and operation history.
- Service-scoped runtime health and bounded logs.
- Restart-safe Website binding and a validated loopback Nginx target resolved from current Compose state.
- Secret-free actionable diagnosis and Website/Domain impact relationships.
- Real Docker project list/detail UI.
- Storage inventory derived from validated Compose state.

Compose storage metadata distinguishes:

- named volumes,
- project-contained bind mounts,
- arbitrary host bind mounts,
- ephemeral/tmpfs-style storage.

The normalized storage inventory is persisted with project desired-state and shown in the Docker project detail UI. Ephemeral storage is not a backup candidate. Arbitrary host bind paths are explicitly identified and are not automatically admitted into future backups. The remaining Docker storage work is to connect safe named-volume/project-bind policy to the general versioned backup/restore product.

## Mail workspace

Managed mail now has a routed panel workspace backed by real API operations. The current UI exposes mail-domain management, mailbox/alias surfaces, managed configuration apply, DKIM controls/diagnostics, runtime/service operations, queue/log inspection and Roundcube-related state where supported.

Mail configuration and data mutations remain guarded durable operations with secret-safe public results and operation-specific recovery rather than generic retry/force-success behavior. Real Ubuntu/Postfix/Dovecot/Rspamd/DNS/outbound-delivery acceptance remains in `todo.md`; source implementation is not treated as proof that a live provider/host acceptance gate passed.

## Domain relationship and IDN

Domain records may persist `websiteId`. `GET /api/websites/:websiteId/domains` reads only that explicit field; it does not infer membership from hostname, parent suffix, proxy port or application root.

Legacy Domain state without the field opens as `websiteId=null`. A one-way registry primitive can bind an unbound legacy Domain to one same-server Website without changing its current Nginx desired/applied revision. Rebinding is guarded by explicit preview/migration semantics rather than heuristics.

Shared hostname validation canonicalizes IDN input to ASCII punycode. Unicode/punycode equivalents therefore collide as the same hostname/alias and hierarchy comparisons use one canonical form.

## Website update and rebind

`POST /api/websites/:websiteId/update-preview` accepts only a `changes` object. Name, application/runtime binding and proxy target are the update fields. Application-backed roots and Unix users are re-derived from the selected same-server Application; caller-controlled roots/users remain impossible and one Application cannot be attached to multiple Websites.

The preview binds proposed state to the current Website revision and to a SHA-256 digest of explicitly linked Domain traffic/certificate metadata. It reports whether later Domain restage is required but does not itself change Domain target, Nginx, certificate or live traffic. `PATCH /api/websites/:websiteId` requires that exact revision, digest and typed confirmation. Website or linked-Domain drift rejects apply before mutation.

Switching an application-backed Website to proxy is explicit. Docker transitions likewise require an exact external Docker workload identity; transitions away must explicitly clear it. Proxy hosts accept canonical IP/DNS names only, not URL schemes or paths.

Guarded site-create supports existing Application, new static/Node Application, explicit external Docker workload and external proxy sources. The result persists Website/Domain relationships but does not fabricate DNS, certificate, mail or external-container side effects.

## Migration preview, bind and enforcement

`GET /api/websites/migration/preview` is Owner-only and read-only. It examines persisted Domain/Website/Application state and reports deterministic migration decisions without mutation. Static legacy targets match applications only by exact managed web root; Node targets match only same-server loopback proxy plus exact current port. Ambiguous or unresolved state stays explicit.

`POST /api/websites/migration/bind` requires Domain/Website UUIDs, the exact current preview digest and typed confirmation. The server recomputes current state before mutation; stale or different plans fail closed and a retry of the same completed binding is idempotent.

`GET /api/websites/migration/status` returns the current policy beside a fresh preview. Policy starts in `compatibility`. `POST /api/websites/migration/finalize` can switch to `enforced` only when every managed Domain is explicitly bound. In enforced mode new managed Domain creation requires a same-server `websiteId`.

`POST /api/websites/migration/rollback` requires the exact enforced digest and returns policy to compatibility mode without rewriting Domain traffic, certificates, releases or Application state. Migration-only binding rollback uses its own durable ledger/receipt and is not a general Domain unbind operation.

The remaining Website migration gap is the explicit create/bind path for live external-proxy Domain records that are still unbound; automatic inference remains forbidden.

## Job presentation and navigation

The jobs workspace is wired to real resources. Job rows/details can resolve safe resource links and show lifecycle stage/progress rather than fabricated percentages. Result metadata is allowlisted, diagnosis/error codes are bounded, and deploy/runtime logs are redacted and bounded. There is no generic force-success or blind mutation retry UI.

## Authentication/access boundary

All Website management enters through the authenticated API listener. Owner management requires normal session/MFA/Origin/CSRF policy. Read Only accounts may inspect only their permitted resource GET/HEAD surfaces; privileged Website, migration, job and destructive mutations remain Owner-only.

Caller input cannot set managed `documentRoot` or `unixUser`; those values are derived from managed Application identity.

## Remaining product work

The Website/Application/Domain foundation, Domain hierarchy, site-create, local files/logs/terminal, Managed Compose, managed mail and job-resource presentation are implemented in source. The highest-value remaining product gaps are tracked only in `plan.md`:

- Docker storage backup policy integration.
- General backup/restore backend and panel UI.
- Cron/Scheduled Tasks backend and panel UI.
- Metric history, alert/event model and notification center.
- The remaining explicit external-proxy Domain migration path and dependency-provider links as backup/cron registries arrive.
- Migration live-apply/rollback acceptance followed by physical legacy-agent removal.
- Final enterprise UI/UX, responsive and accessibility polish.
- Plesk read-only importer, intentionally kept as the final development item.

## Design status

The current React workspace is functional and resource-linked, but final enterprise visual polish is still deferred until the remaining backend modules are closed. Security behavior, authenticated routing, stale privileged-data handling and destructive confirmation are not visual polish and remain mandatory.

## Validation

Current full Node24/workspace, browser, package persistence, real Ubuntu/Compose/mail/provider acceptance, migration/rollback and live service checks are tracked in `todo.md`. Repository code or source tests are not evidence that the current tree passed those real-environment gates. GitHub Actions are not used.
