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
- There is no generic `force-success`, `force-failed`, mutation retry or journal-clear escape hatch.

Recommended packaged control-plane paths:

```text
YUNPANEL_SERVER_STORE=/var/lib/yunpanel/control-plane/server-registry.json
YUNPANEL_DOMAIN_STORE=/var/lib/yunpanel/control-plane/domain-registry.json
YUNPANEL_JOB_STORE=/var/lib/yunpanel/control-plane/job-registry.json
YUNPANEL_CERTIFICATE_STORE=/var/lib/yunpanel/control-plane/certificate-registry.json
YUNPANEL_APPLICATION_STORE=/var/lib/yunpanel/control-plane/application-registry.json
YUNPANEL_APPLICATION_ENVIRONMENT_STORE=/var/lib/yunpanel/control-plane/application-environment-registry.json
YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite
```

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

The backup procedure, fixed source allowlist, modes and restore boundary are defined in `docs/local-migration-backup.md`. The ownership CLI verifies the same snapshot again immediately before invoking its mutation.

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

### Node deploy, rollback and restart

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-deploy <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-rollback <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-restart <server-id> <job-id> --confirm
```

Each path requires its private job-bound success receipt plus exact application desired-state and fresh read-only Node/systemd/health evidence for the expected release, service, port and health path. Environment secrets are not stored in recovery receipts and the Node mutation is never blindly repeated.

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

Drain work, stop API + agent, resolve durable recovery, create the verified snapshot, and run `status` again. Continue only when:

- `apiActive=false`
- `agentActive=false`
- `activeJobs=0`
- `recoveryJobs=0`
- hostname is exact
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

## Path B — bootstrap a fresh agentless local server

Use this path only when there is no enrolled server identity that must be preserved.

### B1. Complete the common pre-mutation sequence

API and agent must be stopped and the global queue/recovery state must be clear. Create and re-verify a snapshot as described above.

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

## Verification after either path

Verify service ownership first:

```bash
systemctl is-active yunpanel-api.service
systemctl is-active yun-agent.service || true
```

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

3. Create and re-verify a **new** snapshot of the current local-owned state with `local-migration-backup.mjs create --confirm` and `verify`.
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

`release --confirm` is not available for a fresh Path B local-only record because no legacy agent credential exists; the command fails `agent_credentials_unavailable` rather than inventing one.

There is intentionally no blind automatic archive extraction. Restoring files from the verified snapshot remains a separate package/test-host acceptance item in `todo.md` and must use staged extraction/link/ownership validation before it can become an automated rollback primitive.

If any migration/recovery command reports an active service, active queue, recovery journal, hostname mismatch, invalid/outside state path, invalid backup or unreadable host evidence, do not bypass the guard. Resolve the discrepancy from independent console access and the verified snapshot.

Complete `T-LOCAL-EXECUTOR`, `T-SERVICES`, `T-DATABASE`, `T-LIVE` and `T-MIGRATION` in `todo.md` on an isolated supported host before calling either path production-ready.
