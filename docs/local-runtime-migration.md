# YunPanel local runtime migration and bootstrap

This runbook covers two explicit paths into the privileged in-process `yunpanel-api` local runtime:

1. migrate an existing server already enrolled through the retained `yun-agent`, or
2. create a fresh agentless local server record without generating enrollment or agent credentials.

Both paths remain fail-closed until the package/test-host acceptance in `todo.md` is complete. Do not use either path on the only production copy of a host.

## Common requirements

- Use the packaged Node runtime at `/usr/local/bin/node` and run packaged migration/recovery CLIs as root.
- Keep independent SSH/provider-console access throughout migration and rollback.
- Production control-plane stores must use absolute paths below `/var/lib/yunpanel/control-plane`.
- Do not change `YUNPANEL_SECRET_MASTER_KEY` as part of execution-ownership migration.
- Do not proceed while a `queued` or `running` job exists or durable recovery is unresolved.
- Every `create`, `bind` or `release` ownership mutation requires an already-created, re-verified snapshot below `/var/backups/yunpanel`.
- Before an ownership mutation on a migration/rollback host, run the non-destructive restore `preview` and private `stage` rehearsal for that exact snapshot; neither command mutates live `/etc`, `/var/lib`, Unix identities or services.
- After starting the local API, run the read-only `local-runtime.mjs validate <server-uuid>` gate before any functional validation or additional mutation.
- There is no generic `force-success`, `force-failed`, mutation retry or journal-clear escape hatch.

Recommended packaged control-plane paths:

```text
YUNPANEL_SERVER_STORE=/var/lib/yunpanel/control-plane/server-registry.json
YUNPANEL_DOMAIN_STORE=/var/lib/yunpanel/control-plane/domain-registry.json
YUNPANEL_JOB_STORE=/var/lib/yunpanel/control-plane/job-registry.json
YUNPANEL_CERTIFICATE_STORE=/var/lib/yunpanel/control-plane/certificate-registry.json
YUNPANEL_APPLICATION_STORE=/var/lib/yunpanel/control-plane/application-registry.json
YUNPANEL_WEBSITE_STORE=/var/lib/yunpanel/control-plane/website-registry.json
YUNPANEL_DOCKER_WORKLOAD_STORE=/var/lib/yunpanel/control-plane/docker-workload-registry.json
YUNPANEL_DNS_HOSTING_STORE=/var/lib/yunpanel/control-plane/dns-hosting-registry.json
YUNPANEL_DNS_CREDENTIAL_STORE=/var/lib/yunpanel/control-plane/dns-provider-credential-registry.json
YUNPANEL_MAIL_DOMAIN_STORE=/var/lib/yunpanel/control-plane/mail-domain-registry.json
YUNPANEL_APPLICATION_ENVIRONMENT_STORE=/var/lib/yunpanel/control-plane/application-environment-registry.json
YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite
```

Custom certificate material is derived from `YUNPANEL_CERTIFICATE_STORE` and stored in the sibling `custom-certificates/<certificate-uuid>` directory. On the packaged layout this is `/var/lib/yunpanel/control-plane/custom-certificates`; preserve that directory together with the versioned certificate registry during backup, migration, upgrade and rollback.

`YUNPANEL_DNS_CREDENTIAL_STORE` contains only encrypted DNS-provider tokens, but it is inseparable from the matching `YUNPANEL_SECRET_MASTER_KEY`. Preserve and rotate it with the application secret store and auth database; never expose it to `yunpanel-web.service`.

Packaged migration/recovery tooling rejects relevant state paths outside the control-plane root instead of copying or mutating unknown state automatically.

## Required pre-mutation sequence

### 1. Drain work

Let every legitimate running host mutation reach a terminal state. Cancel only unwanted queued work through the normal authenticated management path. Do not kill a host mutation just to make migration proceed.

Inspect durable recovery:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
```

Possible states include:

- `clear`: no unresolved durable work.
- `execution_state_unknown`: at least one persisted job is still `running`.
- `reconciliation_required`: a terminal job still needs resource reconciliation.
- `mixed_recovery_required`: running and terminal unresolved work are mixed.

Resolve only with the operation-specific procedures below. Missing evidence means unresolved, not failed.

### 2. Stop both command consumers

```bash
sudo systemctl stop yunpanel-api.service yun-agent.service
```

All recovery and ownership mutation commands require the command consumers stopped. The migration preflight re-checks systemd state immediately before mutation.

### 3. Make recovery clear

Run status again after the consumers are stopped:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
```

Do not change ownership until there are no unresolved running/reconciliation records for the target migration.

### 4. Create and verify the rollback snapshot

With command consumers stopped and durable work resolved, create the pre-mutation snapshot:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm
```

Copy the exact printed snapshot path, then explicitly re-verify it:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs verify /var/backups/yunpanel/migration-<timestamp>
```

The backup procedure and fixed source allowlist are defined in `docs/local-migration-backup.md`. The ownership CLI verifies the same snapshot again immediately before invoking its mutation.

### 5. Preview and stage the rollback snapshot

Before changing execution ownership, run the non-destructive restore preview on the same snapshot:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs preview /var/backups/yunpanel/migration-<timestamp>
```

`preview` re-validates the archive member/type/link graph, compares current restore targets, and compares managed `yunapp-*` UID/GID/home/shell/group identity state. `/etc/passwd` and `/etc/group` are identity references only; preview never proposes overwriting them.

Then prove that the verified archive can be materialized only into the private staging root:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs stage /var/backups/yunpanel/migration-<timestamp> --confirm
```

A successful `stage` must report `validated=true`, `destructive=false` and `liveMutation=false`. It uses `/var/backups/yunpanel/.restore-staging`, `--no-same-owner` and `--no-same-permissions`, validates the extracted member/link graph, and does not modify live `/etc`, `/var/lib`, services or Unix accounts. A successful stage is a rollback rehearsal only; there is still no live restore/apply command.

If preview reports identity drift, type drift, unsafe archive/link metadata, or staging fails, do not proceed with ownership mutation until the discrepancy is understood from independent console access.

## Durable recovery commands

All commands below require the exact server/job identity, the current OS hostname to match the server registry, API + legacy agent stopped, and the specific evidence described. They complete the original durable job; they do not create a replacement job.

### Terminal reconciliation only

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs reconcile <server-id> <job-id> --confirm
```

This re-applies saved terminal result reconciliation only and never re-runs the host operation.

### Read-only running jobs

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-readonly <server-id> <job-id> --confirm
```

Allowlisted read-only operations are:

- `system.packages.inspect` — empty payload.
- `system.services.inspect` — exact private persisted payload, including optional service identity.
- `database.inspect` — empty payload.
- `app.node.status` — exact private persisted application/release/runtime payload.

The payload-backed operations read execution intent only from the private job store; public job responses remain payload-free. Probe failure or context drift leaves recovery unresolved.

### Domain stage and activation

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-domain-stage <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-domain-activate <server-id> <job-id> --confirm
```

`domain.stage` requires the deterministic staged Nginx render/checksum to match. `domain.activate` requires the successful-reload receipt plus the exact active config checksum. Recovery never reloads Nginx again.

### Static deploy and rollback

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-static-deploy <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-static-rollback <server-id> <job-id> --confirm
```

Static deploy requires its private receipt, `current -> releases/<job-id>` and a real release directory. Static rollback requires the exact persisted rollback intent plus retained real source/target release directories and `current` pointing at the requested rollback target. Stale/missing filesystem evidence is rejected.

### Node deploy, rollback, restart and process state

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-deploy <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-rollback <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-restart <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-process <server-id> <job-id> --confirm
```

Deploy, rollback and restart require their private job-bound success receipt plus exact Application state and fresh read-only Node/systemd/health evidence for the expected release, service, port and health path. Process enable/disable/start/stop is idempotent and instead requires exact private action/release/active-runtime intent plus fresh final-state evidence; recovery never replays `systemctl`. Environment secrets are not stored in recovery receipts or process jobs.

### Managed Node runtime installation

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-runtime-install <server-id> <job-id> --confirm
```

Runtime inventory is safely repeatable through `recover-readonly`. Installation recovery never downloads or extracts again: exact private major intent must match a fresh `/opt/yunpanel/node-runtimes/v<major>` inventory, and the packaged `/usr/local/bin/node` identity must remain valid.

### Database create and delete

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-database-create <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-database-delete <server-id> <job-id> --confirm
```

Create requires the exact queued schema name to exist in a fresh local-socket inventory. Delete requires its private deletion receipt and a fresh inventory proving the same schema is still absent under the same engine. Raw SQL/socket paths/credentials are not persisted as evidence.

### Managed-service control/install/restart

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-service-control <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-service-mutation <server-id> <job-id> --confirm
```

Start/stop use exact private intent plus fresh systemd/package inspection. Install/restart additionally require the private success receipt and safe-state digest to match current package/unit state. Recovery never re-runs `apt-get` or `systemctl restart`.

### YunPanel package upgrade

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-system-upgrade <server-id> <job-id> --confirm
```

The private receipt preserves the historical previous/current transition. Fresh package inspection must still match the recorded installed/candidate/update state. Recovery does not re-run package upgrade or restart scheduling.

### Certificate issue and renewal

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-certificate <server-id> <job-id> --confirm
```

The handler derives `ssl.issue` versus `ssl.renew` from private persisted job intent. Staging issue and renew dry-run require the exact private success receipt. Production issue/renew additionally require current managed X.509 fingerprint and validity metadata to match the receipt. Certbot is never invoked by recovery.

Receipt directories and files used by these recovery paths are root-protected and carry only operation-specific, bounded metadata; generic payload/result/env/secret material is not accepted.

## Path A — migrate an existing enrolled server

Use this path when the existing server UUID and legacy agent credential must remain available as a rollback bridge.

### A1. Inspect the exact existing identity

Before stopping the services, identify the exact existing server UUID:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs status <server-uuid>
```

`status` is read-only. It verifies the registry hostname against `os.hostname()` and reports API/agent state, active jobs and durable recovery count without changing ownership.

### A2. Complete the common pre-mutation sequence

Drain work, stop API + agent, resolve durable recovery, create/re-verify the snapshot, complete `preview` + private `stage`, and run `status` again. Continue only when:

- `apiActive=false`
- `agentActive=false`
- `activeJobs=0`
- `recoveryJobs=0`
- hostname is exact
- the snapshot verifies cleanly
- restore preview is non-destructive and archive/identity checks are understood
- the private stage validates without touching live state
- printed state paths are the intended packaged files.

### A3. Bind the preserved identity

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs bind <server-uuid> --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
```

The command re-verifies the backup and re-runs service/job/recovery/hostname preflight before mutation. Repeating a successful bind for the exact already-local host is idempotent.

Put the exact printed ID in `/etc/yunpanel/control-plane/api.env`:

```text
YUNPANEL_LOCAL_SERVER_ID=<server-uuid>
```

Do not replace the existing server UUID with a new record during migration.

### A4. Disable legacy execution and start local API

```bash
sudo systemctl disable yun-agent.service
sudo systemctl start yunpanel-api.service
```

Do not start `yun-agent.service` while that server registry record is `executionMode=local`. Retained legacy heartbeat/command/environment/result routes are expected to reject a locally owned server with `server_managed_locally`.

### A5. Validate the local runtime before functional tests

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs validate <server-uuid>
```

`validate` is read-only and does not require a backup argument. It succeeds only when the exact registry identity is locally owned on the current OS hostname, `yunpanel-api.service` is exactly `active`, `yun-agent.service` is exactly `inactive`, queued/running and recovery job counts are zero, a current local inventory/services snapshot exists, the inventory hostname/mode is exact, the snapshot runtime version matches the packaged API version, and loopback `GET /api/health` returns HTTP 200 with `status=ok`. A stale older API process must therefore fail validation even if systemd reports it active.

If validation fails, do not continue to functional mutations and do not re-enable the agent while the registry remains locally owned. Diagnose the failed invariant from independent console access.

## Path B — bootstrap a fresh agentless local server

Use this path only when there is no enrolled server identity that must be preserved.

### B1. Complete the common pre-mutation sequence

API and agent must be stopped and the global queue/recovery state must be clear. Create/re-verify the snapshot and complete its non-destructive `preview` + private `stage` rehearsal as described above.

### B2. Create the local-only identity

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs create --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
```

The command re-verifies the backup, checks stopped consumers plus global queued/running/recovery state, uses `os.hostname()`, and creates one server record directly in `executionMode=local`. It does not issue an enrollment token or agent token.

Copy the exact printed value into `/etc/yunpanel/control-plane/api.env`:

```text
YUNPANEL_LOCAL_SERVER_ID=<printed-server-uuid>
```

A fresh local-only record has no usable legacy agent credential and cannot be released back to agent mode.

### B3. Keep agent disabled and start API

```bash
sudo systemctl disable yun-agent.service
sudo systemctl start yunpanel-api.service
```

No `/etc/yunpanel/agent/agent.env`, enrollment token or agent credential is required for the fresh local identity.

### B4. Validate the fresh local runtime

Use the exact UUID printed by `create`:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs validate <printed-server-uuid>
```

The same exact local-ownership, systemd, durable queue/recovery, snapshot, package-version and loopback HTTP health gates from Path A apply. Do not proceed to functional mutations until this command reports `validation=passed`.

## Verification after either path

The packaged validation command is the first post-start gate:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs validate <server-uuid>
```

A passing result reports `executionMode=local`, `connectivity=online`, `apiState=active`, `agentState=inactive`, `apiHealth=true`, `apiHealthStatus=200`, zero active/recovery jobs, and present inventory/services snapshots. It does not expose credentials or file contents.

Then verify through the authenticated panel/backend, in this order:

1. server connectivity and local host inventory,
2. allowlisted systemd service, Docker and Nginx snapshots,
3. package/service/database read-only inspection,
4. one low-risk managed mutation on the isolated test host,
5. static and Node deploy/status/restart/rollback,
6. SSL issue/test/renew and DB create/drop,
7. package inspection/upgrade behavior required by `todo.md`.

If durable recovery appears at any point, stop creating new work and use `job-recovery status` before deciding the next action.

The root API may adopt an existing private legacy auth directory/SQLite files below `/var/lib/yunpanel/control-plane/auth`. Unsafe modes, symlinks, foreign owners or control-plane-external auth paths must remain fail-closed.

## Rollback for Path A only

Do not release ownership while local work is active or durable recovery is unresolved.

1. Drain local work and resolve durable recovery conservatively.
2. Stop both services:

```bash
sudo systemctl stop yunpanel-api.service yun-agent.service
```

3. Create and re-verify a **new** snapshot of the current local-owned state. Run `preview` and `stage` for that exact rollback snapshot before changing ownership again.
4. Remove `YUNPANEL_LOCAL_SERVER_ID` from `/etc/yunpanel/control-plane/api.env` only while both services remain stopped.
5. Release the preserved enrolled identity:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs release <server-uuid> --backup-dir /var/backups/yunpanel/migration-<rollback-timestamp> --confirm
```

6. Re-enable/start the retained agent only after release succeeds:

```bash
sudo systemctl enable yun-agent.service
sudo systemctl start yunpanel-api.service yun-agent.service
```

7. Verify agent heartbeat, exact server identity, queue behavior, auth, hosted sites, certificates and releases.

`release <server-uuid> --backup-dir <snapshot> --confirm` is not available for a fresh Path B local-only record because no legacy agent credential exists; the command fails `agent_credentials_unavailable` rather than inventing one.

Private staged extraction is available only as a non-live rehearsal under `/var/backups/yunpanel/.restore-staging`. There is intentionally no live archive apply/restore command. Promoting staged files into live `/etc`, `/var/lib`, Nginx, certificate or systemd state remains a separate package/test-host acceptance item in `todo.md` and must define per-target replacement, ownership/mode/ACL/xattr verification, Unix identity policy, pre-apply backup and deterministic rollback first.

If any migration/recovery command reports an active service, active queue, recovery journal, hostname mismatch, invalid/outside state path, invalid backup, unsafe archive/link metadata, unexplained Unix identity drift or unreadable host evidence, do not bypass the guard. Resolve the discrepancy from independent console access and the verified snapshot.

Complete `T-LOCAL-EXECUTOR`, `T-SERVICES`, `T-DATABASE`, `T-LIVE` and `T-MIGRATION` in `todo.md` on an isolated supported host before calling either path production-ready.
