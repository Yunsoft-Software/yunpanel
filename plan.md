# YunPanel Development Plan

## 1. Product vision

YunPanel is a Yunsoft-focused hosting and server management panel designed to replace the parts of Plesk that Yunsoft actually uses in day-to-day operations.

The first objective is not feature parity with Plesk. The first objective is to safely manage Yunsoft production workloads from one interface with a predictable deployment and rollback model.

Primary workloads:

- Node.js applications,
- existing Passenger-based Node.js applications,
- systemd-managed Node.js applications,
- React/Vite/static build deployments,
- Docker and Docker Compose deployments,
- domains, SSL, reverse proxy,
- MySQL/MariaDB,
- Git repositories and deployments,
- cron jobs,
- environment variables,
- logs and metrics,
- backups and restores,
- mailboxes and Roundcube.

Initial support target:

- Ubuntu 24.04 LTS,
- Nginx,
- Node.js LTS,
- systemd,
- optional Passenger compatibility,
- Docker Engine + Docker Compose,
- MySQL/MariaDB,
- Let's Encrypt/ACME,
- Postfix + Dovecot + Rspamd,
- Roundcube.

## Living-plan rule

`plan.md` and `todo.md` are living engineering sources. They must be updated in the same development cycle as the code they describe. Completed code, newly discovered external validation work, failed real-server validation and scope changes must not be left for a later documentation cleanup pass.

Current implementation checkpoint — 2026-09-09:

- repository/control-plane/agent foundations are implemented,
- read-only server inventory and enrollment flows are implemented in code,
- domain/Nginx/ACME control-plane flows are implemented in code,
- static release/deploy/rollback foundations are implemented,
- Node/systemd deployment, guarded rollback, guarded restart and process-status flows are implemented,
- normalized Node runtime state is idempotent so custom startup files/scripts survive control-plane round trips,
- managed deploy/restart/rollback locks return their cleanup-tracked promises so failed operations do not leak unhandled rejections, failed Node rollback restores the previous environment transaction only once, and both static and Node rollback are bound to the control-plane current release before any server mutation,
- static deployments explicitly restore traversable shared build/web directory modes after creation so the privileged agent's restrictive umask cannot lock out dedicated application users or Nginx,
- ACME issuance explicitly restores the shared challenge-root mode after creation so the agent's restrictive umask cannot make HTTP-01 files unreadable by Nginx,
- externally observed completed job state is held behind the in-process reconciliation barrier so the related domain/application/certificate state is settled before API job reads return,
- protected Node runtime environments are implemented with a separate AES-256-GCM store, masked admin metadata, authenticated just-in-time agent delivery and atomic root-protected systemd EnvironmentFile materialization,
- secure log transport/redaction and the environment/log operator UI remain active Milestone 4 work,
- the dedicated test host was backed up and upgraded from Ubuntu 22.04.5 LTS to Ubuntu 24.04.5 LTS; network persistence, reboot recovery, Nginx, Node.js, systemd, control-plane, agent and managed application/vhost health were revalidated on the target platform,
- `cryptoraichu.website` is active through the real YunPanel domain workflow with an externally trusted Let's Encrypt certificate, HTTP-to-HTTPS redirect and successful ACME staging plus renewal dry-runs; a client-IP-restricted loopback gateway exposes the current dashboard without exposing privileged admin API routes.
- Debian package infrastructure now installs versioned YunPanel code, web assets and hardened systemd units while preserving `/etc/yunpanel` configuration and `/var/lib/yunpanel` runtime state; fixed-scope protocol/API/agent jobs inspect the `yunpanel` APT candidate and upgrade only that package before scheduling a delayed API/web/agent restart.

---

# 2. Core architectural principles

## 2.1 Control plane and privileged agent separation

YunPanel must be split into at least two trust domains.

### Control plane

Responsibilities:

- React frontend,
- normal backend/API,
- authentication,
- RBAC,
- persistence,
- job scheduling,
- audit logging,
- deployment metadata,
- application/domain/database/mail models,
- communicating with server agents.

The control-plane backend must NOT run as root.

### `yun-agent`

A separate privileged daemon installed on managed servers.

Responsibilities:

- read server health/inventory,
- safely write validated service configuration,
- create/delete application directories,
- manage Unix users/groups where required,
- manage systemd services,
- manage Nginx sites,
- issue/renew certificates,
- execute controlled deployment steps,
- manage Docker/Compose,
- manage database provisioning through dedicated adapters,
- manage backup/restore commands,
- manage mail service configuration,
- execute explicit privileged operations only.

The agent must expose named operations rather than arbitrary shell execution.

Example:

```text
server.inspect
server.services
app.prepare
app.deploy
app.restart
app.stop
app.rollback
domain.create
domain.update
domain.delete
proxy.validate
proxy.reload
ssl.issue
ssl.renew
docker.deploy
docker.restart
database.create
database.user.create
backup.run
backup.restore
mailbox.create
mailbox.update
mailbox.delete
```

## 2.2 Adapter-based infrastructure

Infrastructure integrations must be behind adapters.

Suggested modules:

```text
adapters/
  nginx/
  systemd/
  passenger/
  docker/
  mysql/
  ssl/
  mail/
  backup/
  metrics/
```

This prevents business logic from becoming tightly coupled to shell commands and makes migration/testing easier.

## 2.3 Desired state vs actual state

Where possible YunPanel should store desired state and reconcile it with the real server.

Examples:

- expected domain -> actual Nginx config,
- expected app service -> actual systemd state,
- expected Docker project -> actual compose/container state,
- expected SSL certificate -> actual certificate metadata.

The UI should explicitly show drift rather than silently assuming the database is correct.

---

# 3. Repository structure proposal

Initial repository layout:

```text
/
  apps/
    web/                 # React frontend, JS/JSX only
    api/                 # Node.js API/control plane
    agent/               # privileged yun-agent daemon
  packages/
    shared/              # shared schemas/constants, JavaScript only
    config-templates/    # nginx/systemd/mail templates
    protocol/            # API <-> agent operation definitions
  scripts/
  docs/
  agents.md
  plan.md
  todo.md
```

A monorepo is preferred initially because frontend, API and agent protocol will evolve together. Avoid introducing complexity such as microservices until operational need exists.

---

# 4. Frontend plan

Frontend requirements:

- React,
- JavaScript/JSX only,
- no TypeScript,
- responsive administration UI,
- dense but readable server/operator interface,
- no decorative complexity that slows operations.

## 4.1 Global navigation

Suggested navigation:

```text
Dashboard
Servers
Applications
Domains
Databases
Docker
Mail
Backups
Jobs
Audit Log
Settings
```

## 4.2 Dashboard

Show at minimum:

- total servers,
- reachable/unreachable servers,
- CPU/RAM/disk/load,
- running/stopped/failed apps,
- failed deployments,
- expiring SSL certificates,
- failed backups,
- unhealthy containers,
- recent service incidents,
- current/queued jobs.

## 4.3 Application detail

Tabs:

```text
Overview
Deployments
Environment
Domains
Database
Files
Logs
Cron Jobs
Backups
Metrics
Settings
```

Application overview should show:

- runtime type,
- repo and branch,
- current release,
- deploy status,
- process/container state,
- primary domain,
- latest deployment,
- health check result,
- resource usage.

---

# 5. Authentication and RBAC

## Phase requirements

- local administrator authentication,
- secure session handling,
- password reset flow,
- optional 2FA after core system is stable,
- roles and permissions,
- audit log.

Initial role suggestions:

- Owner
- Administrator
- Developer
- Operator
- Read Only

Permission groups:

```text
servers.read
servers.manage
apps.read
apps.deploy
apps.manage
domains.manage
ssl.manage
databases.manage
mail.manage
backups.manage
users.manage
settings.manage
audit.read
```

Privileged actions must be checked both at API authorization level and agent operation level.

---

# 6. Server enrollment

## 6.1 Installation model

A new server should be enrolled using a controlled installer.

Target flow:

1. install required system packages,
2. create YunPanel system user/group,
3. install `yun-agent`,
4. create secure service configuration,
5. provision agent identity/credential,
6. start agent as a systemd service,
7. register server in control plane,
8. run capability detection,
9. show readiness report.

## 6.2 Server capability detection

Detect:

- OS and version,
- CPU/RAM/storage,
- Nginx,
- Apache if present,
- Passenger if present,
- Node.js versions,
- npm,
- Docker,
- Docker Compose,
- MySQL/MariaDB,
- Postfix,
- Dovecot,
- Rspamd,
- Roundcube,
- certbot or selected ACME client,
- firewall state,
- relevant ports.

The first version should not automatically mutate every missing dependency. It should distinguish:

- installed and compatible,
- installed but incompatible,
- missing but auto-installable,
- manual action required.

---

# 7. Application model

Application types:

## 7.1 Static

Fields:

- name,
- server,
- repo,
- branch,
- root/work directory,
- install command,
- build command,
- output directory,
- environment variables,
- primary domain,
- aliases,
- health check URL/file,
- deployment retention count.

Deployment approach:

```text
/releases/<release-id>
/current -> /releases/<release-id>
```

Suggested flow:

1. clone/fetch repo,
2. checkout exact commit,
3. install dependencies,
4. build,
5. validate output directory,
6. create release,
7. switch symlink atomically,
8. validate Nginx,
9. reload if necessary,
10. health check,
11. mark deployment successful,
12. retain old releases for rollback.

## 7.2 Node.js

Preferred new application model:

- Node.js runtime,
- systemd process management,
- Nginx reverse proxy.

Fields:

- repo,
- branch,
- Node version,
- package manager,
- install command,
- build command,
- start command,
- working directory,
- port strategy,
- environment variables,
- health check endpoint,
- restart policy.

Release flow:

1. fetch source,
2. checkout commit,
3. install,
4. build,
5. create release,
6. generate/update unit,
7. start new release,
8. health check,
9. switch proxy/release,
10. stop previous release where applicable,
11. rollback automatically on failure.

Current runtime safety additions:

- release/service identities are derived and validated rather than supplied as arbitrary commands,
- manual restart is bound to the expected active release and followed by localhost health verification,
- manual rollback atomically changes `current`, restarts the deterministic service and restores the prior release if the target is unhealthy,
- process status reads only deterministic YunPanel Node units and returns bounded systemd/process metadata,
- stale `current` symlink state is treated as drift instead of silently operating on the wrong release,
- custom application environment values are validated separately from runtime-owned keys,
- secret environment values are encrypted at rest and are not embedded in generic job payload/history,
- deploy/restart/rollback fetch the effective environment just in time through the authenticated agent channel and atomically rewrite the root-protected systemd EnvironmentFile before service activation.

## 7.3 Passenger compatibility

This exists to migrate existing Plesk-managed applications with minimal friction.

Support should be implemented as an adapter rather than as the primary runtime.

Store:

- application root,
- startup file,
- Node version,
- environment,
- Passenger settings,
- domain mapping.

Migration goal is compatibility first; future conversion to systemd can be offered later.

## 7.4 Docker / Docker Compose

Fields:

- repo,
- branch,
- compose path,
- environment variables,
- build/pull mode,
- exposed service,
- internal port,
- public domain mapping,
- volumes,
- backup inclusion,
- health checks.

Flow:

1. fetch repo,
2. validate compose config,
3. resolve environment,
4. pull/build images,
5. start project,
6. validate service health,
7. update Nginx proxy,
8. preserve previous deploy metadata,
9. rollback where technically possible.

---

# 8. Git integration

Initial goal:

- GitHub repository URL support,
- SSH deploy keys or secure repository credentials,
- branch selection,
- manual deploy,
- exact commit recording,
- pull/fetch status,
- deploy history.

Do not implement GitHub Actions.

Later optional features:

- webhook-triggered deploy,
- deploy on branch push,
- protected production deploy approval,
- preview deployment support.

Webhook deploys should enter YunPanel's own job queue, not GitHub Actions.

---

# 9. Domain and Nginx management

Domain fields:

- FQDN,
- application/static target,
- aliases,
- redirect rules,
- HTTPS mode,
- certificate,
- canonical domain,
- proxy settings,
- optional custom headers,
- optional custom safe snippets.

Required safeguards:

- strict FQDN validation,
- duplicate ownership detection,
- template-driven config,
- config written to staging path first,
- `nginx -t` before activation/reload,
- rollback previous config on failure,
- atomic file replacement,
- audit log.

Custom raw Nginx config must not be an unrestricted default feature in V1.

---

# 10. SSL / ACME

V1:

- Let's Encrypt certificates,
- issue certificate,
- renew certificate,
- expiry tracking,
- automatic renewal scheduling,
- domain validation readiness checks,
- renewal failure alerts.

Track:

- domains covered,
- issuer,
- issue date,
- expiration date,
- renewal state,
- last renewal attempt,
- failure reason.

Later:

- wildcard certificate support,
- DNS-01 providers,
- uploaded custom certificates.

---

# 11. Database management

Initial target: MySQL/MariaDB.

V1 features:

- create database,
- delete database with confirmation,
- create database user,
- rotate password,
- grant user to database,
- show size/metadata,
- backup database,
- restore database,
- optional phpMyAdmin link later if required.

Security:

- do not expose root credentials to UI,
- use agent/server-side protected credentials,
- generated database passwords should be strong,
- secrets masked after creation where practical,
- destructive restore requires clear confirmation and pre-restore backup option.

---

# 12. Environment variable management

Features:

- per-application variables,
- masked secrets,
- plain non-secret values,
- environment groups later,
- edit history metadata,
- restart/redeploy indicator after change.

Requirements:

- secrets must not appear in normal logs,
- secret values should not be returned by list APIs unnecessarily,
- exports must require explicit privileged action,
- deployment logs must redact known secrets.

Current status:

- application environment names/values have a bounded shared validation policy and YunPanel-owned runtime keys cannot be overridden,
- secret variables are stored in a separate AES-256-GCM registry using a control-plane master key; normal application/job registries do not contain plaintext secrets,
- normal admin list responses expose secret metadata without returning the plaintext value,
- enrolled agents may materialize environment only for Node applications assigned to their own server,
- production agent-to-control-plane transport requires HTTPS,
- Node deploy/restart/rollback fetch the effective environment just in time so secret values are not persisted in command envelopes or generic job history,
- systemd services consume `/etc/yunpanel/apps/<application-id>.env`; the directory is `0700`, the file is atomically written as `0600`, and secrets are not embedded in unit text or command arguments,
- environment operator UI, edit-history/audit metadata, apply/restart indication and production master-key rotation/recovery procedures remain to be completed/validated.

---

# 13. Cron and scheduled jobs

V1:

- list jobs by application,
- create/update/delete cron definitions,
- enable/disable,
- choose execution user,
- working directory,
- environment,
- command from validated application context,
- last run metadata where observable,
- execution log capture where possible.

Avoid providing unrestricted root cron command creation from the normal application UI.

---

# 14. Logs

Sources:

- application stdout/stderr,
- systemd journal,
- Nginx access/error logs,
- Docker logs,
- deployment logs,
- agent logs,
- backup logs,
- selected mail logs.

V1 UI:

- recent logs,
- filter/search,
- service selector,
- download raw log segment later,
- live tail where safe.

Security:

- redact configured secrets,
- enforce per-resource permission checks,
- prevent arbitrary filesystem log reads,
- do not persist raw application/journal output inside generic job results because application logs may contain credentials or tokens,
- design log transport as bounded, resource-scoped and redacted before exposing it to the control plane/UI.

---

# 15. Backups and restore

Backup is a core feature, not a late add-on.

## 15.1 Backup model

Backup may contain:

- application files,
- selected persistent storage,
- database dump,
- environment metadata/secrets according to policy,
- Nginx/domain metadata,
- Docker volume data,
- deployment manifest,
- mail data when mail support is enabled.

Track:

- source application/server,
- backup type,
- start/end time,
- status,
- size,
- destination,
- checksum/verification,
- retention,
- encryption state.

## 15.2 Targets

Initial options to evaluate:

- local disk,
- S3-compatible object storage,
- remote SSH/SFTP repository,
- Restic repository.

Restic is a strong candidate because of encryption, deduplication and multiple backend support.

## 15.3 Restore requirements

- explicit restore preview,
- identify files/database/volumes that will be replaced,
- pre-restore backup option,
- progress job,
- validation after restore,
- audit record.

---

# 16. Docker volume backup strategy

Unlike simple container lifecycle management, YunPanel must explicitly understand persistent data.

For each Docker project record:

- named volumes,
- bind mounts,
- excluded transient volumes,
- backup policy,
- consistency strategy.

Database containers may require application-aware dump before filesystem/volume backup.

Never treat `docker compose up` metadata alone as a complete backup.

---

# 17. Mail system

Mail should be implemented after core hosting/deployment is stable because it has a larger operational/security surface.

Target stack:

- Postfix,
- Dovecot,
- Rspamd,
- Roundcube,
- DKIM,
- SPF guidance,
- DMARC guidance.

V1 mail features:

- mail domain,
- mailbox,
- password reset,
- quota,
- aliases,
- forwarding,
- enable/disable,
- Roundcube link,
- basic mail service health.

Later:

- catch-all,
- autoresponder,
- spam thresholds,
- DKIM rotation,
- mailing lists if ever needed.

Mail DNS records must be shown clearly and validated where possible.

---

# 18. Roundcube integration

Roundcube is not reimplemented.

YunPanel should:

- install/configure or detect Roundcube,
- generate webmail domain configuration,
- provide SSO only if a secure integration is deliberately designed later,
- otherwise link users to the standard Roundcube login,
- monitor availability.

---

# 19. File manager

V1 should be conservative.

Features:

- browse application-owned paths only,
- create folder,
- upload,
- download,
- rename,
- delete,
- edit small text/config files only if safe,
- permissions display,
- file size/date.

Security:

- jailed root path per app,
- path traversal protection,
- symlink escape protection,
- upload limits,
- no arbitrary `/etc` browsing,
- no root filesystem browser.

---

# 20. Monitoring and health

Server metrics:

- CPU,
- RAM,
- disk,
- load,
- uptime,
- network basics,
- inode usage,
- relevant service states.

Application health:

- process state,
- health endpoint,
- last deploy,
- recent failures,
- restart count where available.

Node process status implementation currently exposes bounded deterministic metadata only: expected release/service identity, systemd load/active/sub state, restart count, main PID and localhost health result. Raw journal/env output is deliberately excluded.

Infrastructure health:

- Nginx,
- Docker,
- MySQL,
- mail services,
- backup service,
- certificate state,
- agent connectivity.

Do not build a full Prometheus/Grafana replacement initially. Provide operationally useful metrics first; deeper integrations can come later.

---

# 21. Job system

Long-running operations must be asynchronous.

Job types:

- deploy,
- rollback,
- build,
- restart,
- status refresh,
- backup,
- restore,
- SSL issue/renew,
- Docker operations,
- database operations,
- migration/import.

Each job should store:

- id,
- type,
- target resource,
- status,
- queued/start/end timestamps,
- actor,
- server,
- current step,
- structured result,
- error code/message,
- log reference.

Secret material must not be embedded in generic job payload/result/history records. Operations that require protected environment values should resolve them through a dedicated authenticated secret-delivery path at execution time.

Concurrency control:

- one destructive deploy per app,
- avoid concurrent restore + deploy,
- avoid conflicting application deploy/restart/rollback/status snapshots,
- avoid conflicting domain config writes,
- serialized Nginx config activation,
- serialized package/system mutations where necessary.

---

# 22. Audit log

Audit events include:

- login/logout,
- user/role changes,
- deployment started/completed/failed,
- rollback,
- environment changes,
- domain creation/deletion,
- certificate action,
- database creation/deletion/restore,
- backup deletion/restore,
- mailbox changes,
- server enrollment/removal,
- privileged agent operations.

Record:

- actor,
- action,
- resource type/id,
- timestamp,
- server,
- source IP where appropriate,
- safe metadata,
- success/failure.

Never put plaintext passwords or secrets into audit records.

---

# 23. Plesk migration strategy

Migration must be incremental. Do not attempt a one-shot full Plesk replacement.

## Stage A — Inventory only

Build scripts/tools that inspect a Plesk server and produce migration manifests for:

- domains,
- Node apps,
- Passenger settings,
- static sites,
- databases,
- Docker projects,
- mail domains/mailboxes,
- certificates,
- cron jobs,
- document roots.

No destructive changes.

## Stage B — Import metadata

Import selected application/domain records into YunPanel while Plesk still controls them.

Display them as external/Plesk-managed resources.

## Stage C — Migrate low-risk static sites

Move static React/build sites first.

Validate:

- domain,
- SSL,
- Nginx config,
- files,
- rollback path.

## Stage D — Migrate systemd-compatible Node apps

Migrate non-critical apps first.

Preserve:

- env,
- database access,
- logs,
- startup command,
- health checks,
- SSL/domain behavior.

## Stage E — Passenger compatibility apps

Support apps that cannot yet move cleanly away from Passenger.

## Stage F — Docker workloads

Import compose/env/volume/backup knowledge and migrate carefully.

## Stage G — Mail

Mail moves last, after DNS and backup/restore are proven.

Plesk should remain available as the rollback reference until each migrated service has survived a defined production observation period.

---

# 24. Security hardening roadmap

V1 hard requirements:

- authentication,
- RBAC,
- CSRF protections where relevant,
- secure cookies/session handling,
- rate limiting,
- secret encryption at rest for sensitive material,
- agent mutual authentication,
- command/argument allowlisting,
- safe filesystem roots,
- audit logs,
- destructive confirmations,
- service config validation before reload,
- backup before dangerous changes where applicable.

V1.5/V2:

- TOTP/2FA,
- IP allowlists for panel access,
- hardware/security key option later,
- short-lived agent credentials,
- credential rotation,
- server enrollment approval,
- signed installer/release verification,
- anomaly alerts,
- optional bastion/private network model.

---

# 25. Milestone roadmap

## Milestone 0 — Repository and architecture foundation

Goal: establish the rules and skeleton without performing server mutations.

Tasks:

- [x] Create `agents.md`.
- [x] Create `plan.md`.
- [x] Create `todo.md`.
- [x] Create monorepo folder structure.
- [x] Initialize root package workspace.
- [x] Create React frontend in JavaScript/JSX.
- [x] Create Node.js API skeleton.
- [x] Create agent skeleton.
- [x] Create shared operation protocol package.
- [x] Add local lint/test scripts without GitHub Actions.
- [x] Add basic developer setup documentation.

Exit criteria:

- frontend starts,
- API starts,
- agent starts unprivileged in development mode,
- all three can communicate in mocked/local mode,
- no GitHub Actions exist.

## Milestone 1 — Read-only server management

Goal: safely connect a server and inspect it before adding mutation capabilities.

Tasks:

- [x] server model,
- [x] secure enrollment token flow,
- [x] agent authentication,
- [x] server heartbeat,
- [x] CPU/RAM/disk/load inventory,
- [x] installed service/runtime detection,
- [x] systemd service state inspection,
- [x] Docker/container inventory,
- [x] Nginx site inventory,
- [x] MySQL/MariaDB detection,
- [x] dashboard server cards,
- [x] connectivity/error states.

Exit criteria:

- a Ubuntu 24.04 server can be enrolled,
- dashboard accurately displays its state,
- no arbitrary shell endpoint exists.

Real Ubuntu exit validation remains tracked in `todo.md` until a reachable test host is available.

## Milestone 2 — Domains, Nginx and SSL

Goal: safely host a basic site through YunPanel.

Tasks:

- [x] domain model,
- [x] Nginx adapter,
- [x] Nginx templates,
- [x] config staging,
- [x] config validation,
- [x] atomic activation,
- [x] domain UI,
- [x] redirects/aliases foundations,
- [x] ACME adapter,
- [x] Let's Encrypt issuance flow,
- [x] expiry monitor,
- [x] auto-renew job,
- [x] rollback/protection against invalid config activation.

Exit criteria:

- a domain can be added,
- valid Nginx config is generated,
- HTTPS works,
- invalid config cannot replace working config.

Real DNS/Nginx/ACME exit validation remains tracked in `todo.md`.

## Milestone 3 — Static deployments

Goal: migrate first low-risk production sites away from Plesk.

Tasks:

- [x] application model,
- [x] Git repository fields,
- [x] release directory model,
- [x] structured install/build configuration,
- [x] static output validation,
- [x] atomic current symlink,
- [x] deployment jobs,
- [ ] deployment logs,
- [x] rollback,
- [x] health/output checks,
- [x] React application UI foundation.

Exit criteria:

- Git repo -> build -> HTTPS domain deploy works,
- failed deploy leaves previous release serving,
- one-click rollback works.

Real server end-to-end exit validation remains tracked in `todo.md`.

## Milestone 4 — Node.js/systemd deployments

Goal: replace most Plesk Passenger usage for new apps.

Tasks:

- [x] Node runtime settings,
- [x] systemd adapter,
- [x] generated units,
- [x] protected runtime environment / user secret store backend and agent materialization,
- [x] process status backend,
- [x] safe restart,
- [x] reverse proxy integration foundation,
- [x] health-check-based deployment,
- [ ] logs with bounded secret redaction/transport,
- [ ] environment UI,
- [x] deployment rollback.

Exit criteria:

- production-like Node app can be deployed and restarted,
- current release survives failed new release,
- logs are visible,
- env secrets are protected.

Code-level deploy/restart/rollback/status and protected runtime-environment flows are implemented. Real Ubuntu/systemd permission/secret validation, production master-key lifecycle, logs and environment UI remain tracked continuously in `todo.md` and this milestone.

## Milestone 5 — Passenger compatibility

Goal: support existing applications that cannot immediately move to systemd.

Tasks:

- [ ] inspect current Plesk Passenger config,
- [ ] define Passenger application model,
- [ ] generate compatible config,
- [ ] Node version integration,
- [ ] startup file support,
- [ ] restart behavior,
- [ ] migration importer,
- [ ] rollback documentation.

Exit criteria:

- selected existing Passenger app can be managed without Plesk owning its runtime configuration.

## Milestone 6 — Docker/Compose

Goal: operate Docker projects safely from YunPanel.

Tasks:

- [ ] Docker project model,
- [ ] compose validation,
- [ ] image pull/build,
- [ ] start/stop/restart,
- [ ] logs,
- [ ] service health,
- [ ] Nginx target selection,
- [ ] env management,
- [ ] volume inventory,
- [ ] backup inclusion policy,
- [ ] deploy history.

Exit criteria:

- compose project can deploy and serve behind HTTPS,
- persistent volumes are visible and backup policy is explicit.

## Milestone 7 — MySQL/MariaDB

Goal: remove daily database provisioning dependency on Plesk.

Tasks:

- [ ] database inventory,
- [ ] create/delete database,
- [ ] create database user,
- [ ] permissions/grants,
- [ ] password rotation,
- [ ] size/status,
- [ ] database backup,
- [ ] database restore,
- [ ] audit trail.

Exit criteria:

- database lifecycle works without exposing root credentials.

## Milestone 8 — Backups and disaster recovery

Goal: prove that a server/application can be recovered before broader Plesk migration.

Tasks:

- [ ] backup adapter,
- [ ] Restic evaluation/implementation,
- [ ] local target,
- [ ] S3-compatible target,
- [ ] retention policies,
- [ ] app file backup,
- [ ] DB dump integration,
- [ ] Docker volume backup,
- [ ] config metadata backup,
- [ ] restore preview,
- [ ] restore job,
- [ ] verification/checksum,
- [ ] failed backup alerts.

Exit criteria:

- a test app can be destroyed and restored successfully from backup,
- restoration procedure is documented and repeatable.

## Milestone 9 — Cron, files and operational tooling

Tasks:

- [ ] cron manager,
- [ ] jailed file manager,
- [ ] application logs,
- [ ] Nginx logs,
- [ ] Docker logs,
- [ ] live tail,
- [ ] basic process metrics,
- [ ] disk alerts,
- [ ] service status actions,
- [ ] job history.

Exit criteria:

- normal daily admin operations no longer require SSH for common tasks.

## Milestone 10 — Mail and Roundcube

Goal: replace Plesk mail management only after hosting core is stable.

Tasks:

- [ ] mail stack detection/install plan,
- [ ] mail domain model,
- [ ] Postfix integration,
- [ ] Dovecot integration,
- [ ] Rspamd integration,
- [ ] mailbox lifecycle,
- [ ] aliases/forwarding,
- [ ] quota,
- [ ] DKIM,
- [ ] SPF/DMARC helper,
- [ ] Roundcube integration,
- [ ] mail backup/restore,
- [ ] mail logs/service health.

Exit criteria:

- test domain sends/receives correctly,
- DKIM/SPF/DMARC validation is clean,
- mailbox restore procedure is tested.

## Milestone 11 — Plesk migration tooling

Tasks:

- [ ] read-only Plesk inventory script,
- [ ] static site importer,
- [ ] Node/Passenger importer,
- [ ] DB importer,
- [ ] Docker metadata importer,
- [ ] domain/SSL importer,
- [ ] cron importer,
- [ ] mail inventory/import strategy,
- [ ] migration reports,
- [ ] per-app rollback checklist.

Exit criteria:

- migration can be performed per resource rather than as a risky full-server cutover.

## Milestone 12 — Production hardening

Tasks:

- [ ] 2FA,
- [ ] secret rotation,
- [ ] agent credential rotation,
- [ ] IP restrictions,
- [ ] security review,
- [ ] destructive-operation review,
- [ ] recovery drills,
- [ ] concurrent job conflict tests,
- [ ] resource exhaustion tests,
- [ ] audit coverage review,
- [ ] installer upgrade path,
- [ ] YunPanel self-update strategy.

Exit criteria:

- new Yunsoft server can be provisioned without installing Plesk,
- primary workload types have tested backup and rollback paths,
- operating team can recover from failed deploy/config/backup scenarios.

---

# 26. Estimated timeline

Given the current Yunsoft development pace and a narrow Ubuntu-focused scope:

### Weeks 1–2

- repository skeleton,
- React UI,
- API,
- agent protocol,
- server enrollment/read-only inventory,
- initial domain/Nginx foundation.

### Weeks 3–4

- static deployments,
- Node/systemd deployment,
- Git integration,
- env management,
- SSL,
- logs,
- rollback.

At the end of this period YunPanel should be usable for selected non-critical static/Node workloads.

### Weeks 5–6

- Docker,
- databases,
- stronger backup system,
- cron,
- monitoring,
- file tooling,
- migration helpers.

### Weeks 7–8

- production hardening,
- Passenger compatibility,
- backup/restore drills,
- selected Plesk migration.

### Weeks 9–12

- mail + Roundcube,
- migration expansion,
- security hardening,
- operational polish,
- new-server-without-Plesk readiness.

These are engineering targets, not promises. Mail, production recovery, privilege isolation and real migration edge cases may extend the final hardening phase.

---

# 27. Definition of the first useful release

YunPanel V0.1 is useful when all of the following are true:

- React admin UI works without TypeScript,
- server can be enrolled,
- server resource state is visible,
- domains can be managed,
- Let's Encrypt SSL works,
- static app can deploy from Git,
- Node app can deploy under systemd,
- deploy logs are visible,
- environment variables can be managed safely,
- deployment rollback works,
- basic backups work,
- no GitHub Actions are used.

# 28. Definition of Plesk-replacement readiness for Yunsoft

YunPanel can be considered ready to replace Plesk on a new Yunsoft server when:

- static, Node and Docker production workloads are stable,
- domain/Nginx/SSL lifecycle is proven,
- database lifecycle is proven,
- backup and restore are tested end-to-end,
- mail is proven if that server requires mail,
- monitoring and failure visibility are adequate,
- privileged agent boundaries have been reviewed,
- at least one recovery drill has been completed,
- at least several real projects have operated successfully without Plesk control,
- all server-side manual prerequisites are documented in `todo.md` or completed.
