# YunPanel

YunPanel is Yunsoft's website-centric hosting and server control plane for Node.js, static, Docker, database, domain, SSL, backup and mail workloads without depending on a full Plesk installation.

The project is intentionally scoped around Yunsoft production needs rather than full Plesk feature parity.

## Target and current architecture

The target is a Website-centric control plane around proven hosting services, not a second implementation of those services. YunPanel owns authentication, authorization, resource relationships, isolated site identities, durable orchestration, health/rollback and the same-origin gateway. Passenger, PHP-FPM, elFinder, ttyd, phpMyAdmin, Roundcube, PowerDNS, restic/rclone, Netdata, GoAccess and CrowdSec provide their established product functions. The binding decisions and boundaries are in [docs/architecture.md](docs/architecture.md).

The current management entry point is a routed React workspace with dashboard, one local-server view, website/domain hierarchy, site detail tabs, global application/environment controls, tracked jobs and Owner/Read Only access boundaries. Production requires one exact local Server identity; selectors and remote resource access are absent from both the UI and authenticated API.

The privileged execution target is the local `yunpanel-api` runtime rather than a separate privileged agent. A server can be created directly as a credentialless local-only identity or an existing enrolled server can be migrated to local ownership with guarded CLI tooling. When local execution is enabled, the API maintains host inventory, allowlisted systemd-service, Docker and Nginx snapshots directly from `@yunpanel/host-runtime` and consumes the durable job queue locally.

The old `yun-agent` package/service remains temporarily only as an offline rollback bridge for hosts that were enrolled before the agentless migration. New enrollment-token provisioning, the enrollment HTTP endpoint, the first-enrollment agent client path and its auth bypass are retired. Retained heartbeat/command/environment/result implementation is unreachable in production and returns `agent_transport_removed`; it will be deleted physically after real migration + rollback acceptance.

**The target architecture is partially implemented but is not product-complete.** Fresh hosted Website provisioning now has dedicated Unix identity/SFTP isolation, Passenger-oriented Node provisioning, PHP-FPM/static paths, local PowerDNS zone orchestration, SQL-backed virtual-mail source materialization and durable mail/DNS/DKIM building blocks. elFinder, ttyd and phpMyAdmin have protected vendor/gateway handoff source paths, and shared Roundcube has a revisioned `webmail.<domain>` mapping lifecycle. Existing direct-systemd Node, custom file-manager and node-pty paths remain only as migration fallbacks until real-host/browser acceptance permits removal. Fresh managed-HTTPS Website provisioning now uses the durable SSL issue/reconciliation queue with provisioning-operation certificate ownership, then re-stages Nginx with the active certificate and reconciles the new Domain revision from exact TLS host evidence. A server ACME account email is supplied through `YUNPANEL_ACME_EMAIL`; live Certbot/Nginx acceptance and reverse compensation remain open. Fresh local-mail provisioning now publishes authoritative `webmail.<domain>` DNS before ACME, issues a separate operation-owned `purpose: webmail` certificate, binds shared Roundcube only to that exact certificate evidence, and finishes with a required side-effect-free `mail_health` gate inside the same durable Website journal. That gate re-materializes the exact current mail config, re-runs Postfix/Dovecot/Rspamd readiness, verifies SMTP 25 + submission 587 + IMAP 143 listeners, and requires the current exact Roundcube HTTPS endpoint before Website readiness. Website Nginx owns the port-80 HTTP-01/redirect surface while Roundcube owns the mapped HTTPS server block. Real Ubuntu/mailbox-auth/public-network acceptance and autodiscover/autoconfig are still incomplete, along with Cron, restic/rclone backup, Netdata/GoAccess, CrowdSec, legacy cleanup and the final site-centric UI polish.

See [plan.md](plan.md) for remaining implementation work, [todo.md](todo.md) for supported-runtime/browser/package/real-host acceptance, [docs/architecture.md](docs/architecture.md) for the target product architecture, and [agents.md](agents.md) for binding development rules. Completed tasks leave the task lists; implementation history stays in Git. Unless explicitly requested otherwise, work directly on `main` in small commits. Do not add GitHub Actions.

## Authentication and privilege boundary

Local Owner setup, login/logout, persistent sessions, password changes/recovery, TOTP enrollment, MFA login/recovery and Owner-protected user administration are wired to the API and React entry points. The workspace remains inside `AuthGate`; the web gateway does not inject a shared administrator bearer token.

HTTPS management requires Owner MFA enrollment. Password-only sessions may complete their own setup/recovery but cannot enter privileged management. Origin/CSRF enforcement, persistent login throttling, session generation, idle/absolute expiry and revocation remain part of the control-plane boundary.

The packaged privilege model is intentional:

- `yunpanel-web.service` is unprivileged and sandboxed away from control-plane secrets/state.
- `yunpanel-api.service` is the privileged host control plane and may run as root for fixed, structured host administration.
- Static Git/npm/build/artifact work runs as a deterministic dedicated `yunapp-*` user.
- Node Git/npm/build and the generated Node systemd service run as the deterministic application user, not root; the service uses `NoNewPrivileges`, an empty capability set and restricted writable paths.
- Site file workers and site terminals run through fixed arguments as the deterministic `yunapp-*` account; future site cron work must keep the same boundary.
- The interactive terminal uses a real PTY over an exact same-origin WebSocket: site sessions run through their deterministic `yunapp-*` account and only an authenticated, MFA-complete Owner may open the local Server root terminal. Short-lived capabilities are session-bound; revocation closes live sockets and process groups.

Do not replace structured operations with an unauthenticated generic shell or make site workloads inherit API root privilege.

## Implemented foundations

- React/JavaScript/JSX routed management UI with site breadcrumbs, URL-backed list state, parent/child domain context, shared controls and dirty-form protection on implemented advanced forms.
- Dashboard and server views based on persisted inventory rather than fabricated metrics; unavailable values remain unknown.
- Owner/Read Only route and HTTP boundaries, initial Owner setup, native Argon2id hashing, private SQLite session/user persistence and mandatory Owner MFA for HTTPS management.
- Explicit domain/subdomain parent references, aliases, Nginx stage/activate and ACME issue/manual-renew/automatic-renewal foundations.
- Fresh managed-HTTPS Website provisioning owns the ACME certificate record by provisioning operation, reuses the durable `ssl.issue` job/receipt/reconciliation path, rejects foreign certificate ownership and follows attachment with an exact TLS Nginx stage/activate step. Restart can reconcile Domain staged/applied state from an already-active exact TLS checksum without replaying the host activation.
- Preview/confirmation-gated site creation for existing/new static or Node applications, explicitly tracked Docker workloads and external reverse proxies, with deterministic retry identities, backend-assigned managed Node ports and explicit `www` alias/child choices.
- Private Docker workload identity tracking for explicit same-server loopback endpoints. Records start `external/unverified`; Website binding, restart validation and impact inventory exist without pretending that Compose/container lifecycle or Nginx mutation ran.
- Separate persistent DNS-zone and mail-domain lifecycle identities: DNS remains explicit external/unverified tracking, while mail may also be explicit local/disabled state; neither implies provider publication or mail provisioning and neither is silently created by Website/hostname creation.
- Authenticated mailbox metadata CRUD for explicit local mail domains, with native bounded Argon2id hashing, AES-256-GCM encrypted hashes, optimistic revisions, typed deletion and hash-free Owner/Read Only responses. Managed-mail preview/apply now materializes the desired virtual-domain/mailbox/alias/sender-login state into a private SQLite lookup DB for Postfix/Dovecot with dedicated `vmail` storage and `yunpanel-mailauth` reader identity, plus backup/rollback evidence; real Ubuntu SMTP/IMAP acceptance remains open.
- Owner-only DNS readiness refresh with bounded A/AAAA/CNAME evidence, managed-Server address matching, independent HTTP-01/DNS-01 diagnosis and revision-guarded lifecycle observations; it inspects DNS but does not mutate provider records.
- Authored DNS/certificate/Nginx failure diagnosis with hostile-code fallback; public certificate and job responses omit every certificate material path while private recovery state retains exact local identity.
- Owner-only Cloudflare A/AAAA/CNAME preview/apply with canonical zone boundaries, exact provider snapshot/typed confirmation, encrypted execution-time credentials, durable local `dns_zone` jobs and idempotent uncertain-outcome recovery; successful writes do not fabricate propagation readiness.
- Local authoritative DNS has versioned zone templates, server DNS identity, PowerDNS zone create/re-apply/retirement primitives, DNSSEC lifecycle/rollover state and operation-owned rollback evidence; registrar/secondary/public-resolver acceptance remains a real-environment gate.
- Fresh local-mail Website provisioning reserves a disabled Mail Domain with no default mailbox/password, then source-plans operation-owned `mail_config → mail_dkim_key → mail_dns_reapply → webmail_certificate → mail_dkim_config → roundcube_mapping → mail_health` steps after the main Website certificate/TLS activation. DKIM key identity, authoritative desired-state publication, dedicated webmail ACME issuance, signing-config child jobs, shared Roundcube apply and the final source health postcondition are revision/digest/operation fenced and recoverable without blind mutation replay.
- Shared Roundcube source lifecycle uses one application/FPM/database with revisioned per-domain `webmail.<domain>` mappings, dedicated webmail-certificate coverage fences, Nginx desired state, DNS readiness gating and Domain-removal cleanup semantics. Fresh Website provisioning now issues/reconciles an independent operation-owned `purpose: webmail` certificate after authoritative DNS readiness and before mapping/apply, then blocks readiness on current mail-service/listener/Roundcube endpoint health; live Ubuntu/Certbot/Roundcube mailbox-auth/browser and delivery acceptance remain open.
- elFinder and ttyd replacement source paths use short-lived Owner handoff/session capabilities, same-origin gatewaying and per-Website Unix identity rather than public vendor listeners. Their real Ubuntu/browser acceptance must pass before the homegrown file-manager and node-pty fallbacks are removed.
- Revisioned per-site Nginx settings for bounded upload size, proxy timeout, WebSocket, SPA fallback, static-asset cache and validated response headers. Domain preview exposes an exact settings diff; durable stage/activate retains rendered-checksum, `nginx -t`, reload and previous-config rollback barriers.
- Owner-only Website/Domain move-delete impact previews that enumerate current hierarchy, Application/Docker binding, DNS-zone, mail-domain, mailbox, certificate and active-job dependencies and fail closed on backup/cron inventories that do not exist yet; no cascade or apply route is implied.
- Static deploy/rollback and Node deploy/restart/status/rollback with dedicated application users, health checks and guarded rollback behavior.
- Revisioned Node runtime configuration for startup file/npm script, npm/pnpm/yarn, production/development mode and release-contained document root; pending desired settings do not replace the active release snapshot before a successful deploy.
- Release-bound Node process enable/disable/start/stop through exact-confirmation durable jobs; unhealthy starts return to stopped state and interrupted idempotent controls require fresh systemd/health evidence before recovery.
- Managed Node 22/24 LTS inventory and checksum-verified atomic installation under `/opt/yunpanel/node-runtimes`; deploy, build lifecycle and systemd PATH use the selected site major without replacing YunPanel's packaged `/usr/local/bin/node` runtime.
- Static and Node deploys accept an explicit branch, tag or immutable 40-character commit target; Git fetch runs as the dedicated site user and the resolved target is retained with release history.
- Per-Application GitHub webhooks verify the raw-body SHA-256 signature, exact repository/configured branch and full pushed commit before queuing the shared durable deploy flow. Delivery IDs are private idempotency keys, and the persistent job registry locks concurrent work on the same resource; GitHub Actions are not used.
- Per-Application GitHub token or unencrypted SSH deploy-key credentials are AES-256-GCM encrypted by the existing master-key store, materialized only for clone/fetch and excluded from application env, job/recovery result and audit metadata.
- AES-256-GCM application environment storage, strict bounded `.env` merge/replace import, revisioned change metadata and explicit saved-on-disk versus applied-to-running-process state; plaintext values never enter generic job records.
- Owner-only local log backend for Node journals, allowlisted systemd units, Nginx access/error files and private deploy output. Queries have bounded time/entry/byte windows, server-side search/level filters, cursor paging, credential redaction, NDJSON snapshots and text downloads.
- Owner-only local static/Node file backend with site-user worker isolation, canonical active-release validation, permission metadata, bounded binary transfer, optimistic-lock text edits, atomic writes, confirmed deletion and fail-closed traversal/symlink handling.
- Owner-only audit screen backed by the common 90-day audit store, with actor/action/outcome/resource/time filters, bounded pagination and strict response-field validation; request bodies, secrets and terminal content remain outside audit records.
- Managed-service inspect/install/start/stop/restart support for the exact allowlisted host services, with bounded Postfix/Dovecot/Rspamd configuration health and package-only Roundcube/phpMyAdmin detection/install that never fabricates a systemd state or endpoint readiness.
- Deterministic phpMyAdmin PHP-FPM and Nginx templates pin a dedicated runtime identity, private temp/session paths, exact FPM socket and an internal Unix HTTP socket. Protected Website-scoped signon handoff and same-origin gateway source wiring are present without exposing a public phpMyAdmin TCP listener; real Chromium/Firefox and database-isolation acceptance remains open.
- MySQL/MariaDB local-socket inventory and database create/delete job flows with result sanitization.
- Durable queued/running/terminal job persistence with a versioned private recovery sidecar. Terminal-but-unreconciled and supported running-recovery state survives restart and blocks unsafe new work.
- Operation-specific running recovery for read-only package/service/database/Node status/runtime inspection, domain stage/activate, static deploy/rollback, Node deploy/rollback/restart/process/runtime install, database create/delete, managed-service mutations, YunPanel package upgrade, certificate issue/renew and Cloudflare DNS records. Recovery uses exact persisted intent plus host evidence/private receipts or the DNS adapter's idempotent provider post-condition; there is no generic force-success or blind mutation retry.
- Credentialless fresh local server bootstrap plus guarded existing-server `status/bind/release` migration tooling and post-migration `validate` health verification.
- Verified migration backup, non-destructive restore preview, archive member/type/link inspection, `yunapp-*` Unix identity drift comparison, metadata planning and private staged extraction. There is intentionally no live archive apply/restore command yet.
- Agentless local snapshots for host inventory, allowlisted systemd services, Docker and Nginx.
- Debian packaging for API, restricted web gateway and the temporarily retained legacy agent rollback service.

## Development

Requirements:

- Node.js **24.11.1+**, including native Argon2 and SQLite.
- npm **11+**.

Install and start the default development stack:

```bash
npm install
npm run dev
```

`npm run dev` starts only the web app on `127.0.0.1:5173` and API on `127.0.0.1:3001`. It does **not** start `yun-agent`. The legacy daemon can still be started explicitly with `npm run dev:agent` only for rollback/compatibility testing with an already-existing legacy identity.

Local privileged execution is opt-in through `YUNPANEL_LOCAL_SERVER_ID`; do not invent a server identity just to make jobs run. Follow [docs/local-runtime-migration.md](docs/local-runtime-migration.md) for guarded fresh-create and existing-server migration paths.

Create the first Owner from another terminal at the repository root:

```bash
npm run auth -- setup-token
```

No default credentials are created. Follow [docs/mfa.md](docs/mfa.md) and [docs/authentication.md](docs/authentication.md) for the current auth setup and recovery rules.

Run validation with:

```bash
npm run check
```

Historical commits have passed full supported-Node and package acceptance, but that does not prove the current tree. `todo.md` records the current full-check, browser, Ubuntu package and live acceptance gates that must be rerun after the recent agentless/recovery/migration changes.

## Local ownership, migration backup and durable recovery

Packaged ownership mutation is intentionally fail-closed. Before `create`, `bind` or `release`, both command consumers must be stopped, queued/running and durable-recovery work must be clear, and the exact migration snapshot must be verified.

Create and rehearse the rollback snapshot first:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs verify /var/backups/yunpanel/migration-<timestamp>
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs preview /var/backups/yunpanel/migration-<timestamp>
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs stage /var/backups/yunpanel/migration-<timestamp> --confirm
```

`preview` and `stage` do not mutate live `/etc`, `/var/lib`, Unix users/groups or services. Staging is restricted to `/var/backups/yunpanel/.restore-staging`; live apply remains disabled pending real-host acceptance.

Then use the ownership commands:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs create --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs status <server-uuid>
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs bind <server-uuid> --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs release <server-uuid> --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
```

After setting the exact `YUNPANEL_LOCAL_SERVER_ID`, disabling the legacy agent and starting the API, run:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs validate <server-uuid>
```

`validate` is read-only and checks exact local binding/hostname, `yunpanel-api.service=active`, `yun-agent.service=inactive`, idle queue, clear durable recovery, fresh online local snapshot, current API runtime version and loopback `/api/health` success.

Before ownership changes or uncertain-outcome recovery, inspect durable state:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
```

Terminal reconciliation never re-runs the host operation. Running recovery is restricted to the operation-specific commands documented in [docs/local-runtime-migration.md](docs/local-runtime-migration.md); each command uses a reviewed read-only inspection, exact host evidence/private receipt, or the DNS adapter's exact idempotent provider post-condition. Missing evidence or provider certainty means unresolved, not success or failure.

## Debian package and release gates

Runtime state belongs under `/var/lib/yunpanel`; configuration and secrets belong under `/etc/yunpanel`. Production control-plane state is constrained below `/var/lib/yunpanel/control-plane`. Preserve the existing `YUNPANEL_SECRET_MASTER_KEY` across upgrades and use the dedicated rotation procedure rather than editing it in place.

Build candidates only after a clean supported-runtime check:

```bash
npm ci
npm run check
./scripts/build-deb.sh <new-version>
```

A repository commit is not a live deployment. Before replacing the currently accepted package, verify the new `.deb` contents, fresh agentless bootstrap, existing-host migration, `local-runtime validate`, recovery tools, migration backup/preview/stage, root API/web sandbox, auth state ownership, hosted workload continuity and rollback on an isolated Ubuntu host as specified in `todo.md`.

No package publication, migration or live deployment occurs merely by updating this repository.

## More documentation

- [docs/development.md](docs/development.md) — current agentless development workflow and retained rollback compatibility path.
- [docs/architecture.md](docs/architecture.md) — target Website-centric, ready-service integration architecture and migration boundary.
- [docs/local-runtime-migration.md](docs/local-runtime-migration.md) — fresh bootstrap, existing-server migration, durable recovery and rollback.
- [docs/local-migration-backup.md](docs/local-migration-backup.md) — verified migration backup, restore preview and private staging boundary.
- [docs/website-workspace.md](docs/website-workspace.md) — current workspace routes and limitations.
- [docs/owner-mfa-policy.md](docs/owner-mfa-policy.md) — HTTPS Owner MFA requirements.
- [docs/terminal.md](docs/terminal.md) — PTY/WebSocket boundary, limits, audit policy and package requirements.
- [docs/site-files.md](docs/site-files.md) — local Website release boundary, file operations, limits and symlink policy.
- [docs/secret-master-key-rotation.md](docs/secret-master-key-rotation.md) — key rotation and rollback procedure.
