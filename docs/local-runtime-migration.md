# YunPanel local runtime migration and bootstrap

This runbook covers two explicit paths into the privileged in-process `yunpanel-api` local runtime:

1. migrate an existing server that is already enrolled through the retained `yun-agent`, or
2. create a fresh agentless local server record without generating enrollment or agent credentials.

Both paths are intentionally manual and fail-closed until the package/test-host acceptance in `todo.md` is complete. Do not use the first migration or fresh bootstrap on the only production copy of a host.

## Common preconditions

- Use the packaged Node runtime at `/usr/local/bin/node` and run packaged migration/recovery CLIs as root.
- Take and verify a rollback backup of `/etc/yunpanel`, `/var/lib/yunpanel`, auth SQLite state, master-key configuration, Nginx/vhost state, certificates and application releases.
- Confirm independent SSH/provider-console access.
- Production control-plane stores must use absolute paths below `/var/lib/yunpanel/control-plane`.
- Do not change `YUNPANEL_SECRET_MASTER_KEY` as part of ownership migration/bootstrap.

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

The packaged migration/recovery tooling rejects relevant state paths outside the control-plane root instead of copying or mutating unknown state automatically.

## Inspect durable recovery before ownership changes

Before changing execution ownership, inspect unresolved durable work:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
```

Possible recovery states include:

- `clear`: no recorded unresolved work.
- `execution_state_unknown`: at least one persisted job is still `running`; do not guess whether the host mutation happened and do not automatically retry it.
- `reconciliation_required`: a job is already terminal, but its saved result still needs to be applied to resource desired-state.
- `mixed_recovery_required`: running/terminal unresolved work is mixed; resolve each identity conservatively.

A terminal journal entry may be reconciled only after both command consumers are stopped:

```bash
sudo systemctl stop yunpanel-api.service yun-agent.service
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs reconcile <server-id> <job-id> --confirm
```

This command re-applies resource reconciliation only. It does **not** re-run the host operation.

## Running-job recovery rules

Every running recovery command requires the exact persisted server/job identity, the registered server hostname to match the current OS hostname, and both `yunpanel-api.service` and the retained `yun-agent.service` to be stopped. Public job responses do not expose execution payloads; payload-backed recovery reads the exact intent from the private persisted job store.

There is deliberately no generic `force-success`, `force-failed`, `retry-mutation` or manual journal-clear command. If operation-specific proof is absent or drifted, the job remains unresolved.

### Read-only inspection recovery

`recover-readonly` is limited to current async operations whose repetition cannot mutate host state:

- `system.packages.inspect`
- `system.services.inspect`
- `database.inspect`
- `app.node.status`

`system.services.inspect` and `app.node.status` reuse their exact private persisted payload; package/database inspection use an empty payload.

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-readonly <server-id> <job-id> --confirm
```

If the host probe, private context or durable completion cannot be confirmed, the original running job stays unresolved.

### Domain stage and activation

`domain.stage` is recoverable only when the exact deterministic staged Nginx config already exists. YunPanel re-renders the original queued domain spec and compares the expected content/checksum without writing or reloading Nginx:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-domain-stage <server-id> <job-id> --confirm
```

`domain.activate` additionally needs a root-protected success receipt written only after `nginx -t` and reload succeeded, plus an active config whose checksum still matches the queued stage:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-domain-activate <server-id> <job-id> --confirm
```

Activation receipts live below `/var/lib/yunpanel/recovery/domain-activations/<server-id>/<job-id>.json`. Recovery never reloads Nginx again.

### Static deploy and rollback

New agentless static deployments persist a bounded private receipt after successful deployment. Receipt directories are `0700`, receipt files are `0600`, and arbitrary payload/result/secret fields are not accepted.

Deploy recovery requires the receipt, `current -> releases/<job-id>` and a real target release directory:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-static-deploy <server-id> <job-id> --confirm
```

Static rollback does not guess from application state alone. Recovery requires the exact retained target/previous release directories and `current` to point at the queued rollback target:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-static-rollback <server-id> <job-id> --confirm
```

A stale receipt or release/symlink drift leaves the job unresolved.

### Node deploy, restart and rollback

Node mutations use private job-bound receipts because current service state alone cannot reconstruct historical deployment/restart metadata. Environment values and repository credentials are not written to receipts.

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-deploy <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-restart <server-id> <job-id> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-node-rollback <server-id> <job-id> --confirm
```

Recovery requires exact application/job/release intent, the corresponding private receipt and a fresh read-only Node status proving the expected systemd service is loaded/active and the expected release/port/health path is healthy. Node deploy receipts also retain the sanitized commit SHA/previous-release metadata needed by application reconciliation. Receipt roots are below `/var/lib/yunpanel/recovery/node-deployments`, `/var/lib/yunpanel/recovery/node-restarts` and `/var/lib/yunpanel/recovery/node-rollbacks`.

### Database create and delete

Database create can be recovered from the exact queued database name plus a fresh read-only local socket inventory proving the target schema exists:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-database-create <server-id> <job-id> --confirm
```

Database delete uses a private success receipt plus a fresh inventory proving the schema is still absent under the same engine:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-database-delete <server-id> <job-id> --confirm
```

Deletion receipts live below `/var/lib/yunpanel/recovery/database-deletions/<server-id>/<job-id>.json`. Raw SQL, socket/client paths, command output and credentials are not accepted.

### Managed-service recovery

Service `start` and `stop` are recovered from the exact private queued intent plus fresh package/unit inspection:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-service-control <server-id> <job-id> --confirm
```

Install and restart need a private receipt because final active state does not prove the historical mutation. The receipt contains a digest of the safe package/unit state recorded after success; recovery recomputes that digest from a fresh inspection:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-service-mutation <server-id> <job-id> --confirm
```

Receipts live below `/var/lib/yunpanel/recovery/service-mutations/<server-id>/<job-id>.json`. State drift invalidates the receipt.

### YunPanel package upgrade recovery

A package upgrade or no-op upgrade writes a private version-transition receipt. Recovery compares that receipt with a fresh read-only YunPanel package inspection and does not run `apt-get` or schedule service restarts again:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-system-upgrade <server-id> <job-id> --confirm
```

Receipts live below `/var/lib/yunpanel/recovery/system-upgrades/<server-id>/<job-id>.json`. Installed/candidate/version-transition drift leaves the job unresolved.

### Certificate issue and renewal recovery

Certificate operation receipts live below `/var/lib/yunpanel/recovery/certificates/<server-id>/<job-id>.json` and contain only bounded certificate/job identity and safe validation/fingerprint/validity metadata. They do not contain ACME email, PEM content, private-key paths or certbot output.

One command handles both persisted `ssl.issue` and `ssl.renew` intents:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-certificate <server-id> <job-id> --confirm
```

For staging issue and renewal dry-run, the exact success receipt is the historical proof; recovery does not call certbot again. Production issue/renew additionally inspect the current managed certificate and require matching X.509 fingerprint and validity metadata before reconciliation. Production issue may attach the recovered certificate to its managed HTTPS domain only after those checks succeed.

## Path A — migrate an existing enrolled server

### A1. Drain work

While the existing panel/agent is still available, let every `running` job reach a terminal state and cancel unwanted `queued` jobs through the normal UI/API. Do not terminate a host mutation just to make migration proceed.

Identify the exact existing server UUID, then inspect it:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs status <server-uuid>
```

`status` is read-only. It verifies the registry hostname against `os.hostname()` and reports API/agent state, active jobs and durable recovery count without changing ownership.

### A2. Stop both command consumers

```bash
sudo systemctl stop yunpanel-api.service yun-agent.service
```

Run the preflight again:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs status <server-uuid>
```

Continue only when `apiActive=false`, `agentActive=false`, `activeJobs=0`, `recoveryJobs=0`, the hostname is correct and the printed state paths are the intended packaged files.

### A3. Bind the existing identity to local runtime

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs bind <server-uuid> --confirm
```

The command re-runs the same service/job/recovery/hostname preflight immediately before mutation. Repeating a successful bind for the exact already-local host is idempotent.

Put the exact printed value in `/etc/yunpanel/control-plane/api.env`:

```text
YUNPANEL_LOCAL_SERVER_ID=<server-uuid>
```

Do not replace the existing server UUID with a new record during migration.

### A4. Disable the legacy consumer and start local API

```bash
sudo systemctl disable yun-agent.service
sudo systemctl start yunpanel-api.service
```

Do not start `yun-agent.service` while the server registry record is `executionMode=local`. Legacy heartbeat/command/environment/result routes are expected to reject that server with `server_managed_locally`.

## Path B — bootstrap a fresh agentless local server

Use this path only when there is no existing enrolled server identity that must be preserved.

### B1. Stop consumers and ensure no active durable work

```bash
sudo systemctl stop yunpanel-api.service yun-agent.service
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
```

Do not continue while durable recovery is unresolved. The fresh-create command also fails closed if API/agent is active, any queued/running job exists or the durable recovery sidecar contains unresolved work.

### B2. Create the local-only server record

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs create --confirm
```

The command uses `os.hostname()` and creates one server record directly in `executionMode=local`. It does not issue an enrollment token or agent token. The stored record has no usable legacy agent credential and cannot be released back to agent mode.

Copy the exact value printed by the command into `/etc/yunpanel/control-plane/api.env`:

```text
YUNPANEL_LOCAL_SERVER_ID=<printed-server-uuid>
```

A fresh local-only record is not a rollback bridge to the legacy agent. If a legacy-agent rollback is a requirement, use Path A with a previously enrolled identity instead.

### B3. Keep legacy agent disabled and start API

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

Then verify through the authenticated panel, in this order:

1. server connectivity and local host inventory,
2. allowlisted systemd service, Docker and Nginx snapshots,
3. read-only package/service/database/Node-status inspection,
4. one low-risk managed mutation on the test host,
5. Node/static runtime operations,
6. SSL, DB and package operations required by `todo.md`,
7. at least one controlled recovery interruption for each evidence family before production acceptance.

If durable recovery appears at any point, stop creating new work and use `job-recovery status` before deciding the next action.

The root API may adopt an existing private legacy auth directory/SQLite files below `/var/lib/yunpanel/control-plane/auth`. Unsafe modes, symlinks, foreign owners or control-plane-external auth paths must remain fail-closed.

## Rollback for Path A only

Do not run rollback while local work is active or durable recovery is unresolved.

1. Drain/cancel queued work and resolve only recovery states whose operation-specific proof succeeds. A missing proof remains unresolved rather than being forced.
2. Stop both services:

```bash
sudo systemctl stop yunpanel-api.service yun-agent.service
```

3. Remove `YUNPANEL_LOCAL_SERVER_ID` from `/etc/yunpanel/control-plane/api.env`.
4. Release the preserved enrolled identity:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs release <server-uuid> --confirm
```

5. Re-enable/start the retained agent only after release succeeds:

```bash
sudo systemctl enable yun-agent.service
sudo systemctl start yunpanel-api.service yun-agent.service
```

6. Verify agent heartbeat, exact server identity, queue behavior, auth, hosted sites, certificates and releases.

`release --confirm` deliberately fails for a fresh Path B local-only record because no legacy agent credential exists.

If any migration/recovery command reports an active service, active queue, recovery journal, hostname mismatch, invalid/outside state path or unreadable/mismatched host evidence, do not bypass the guard. Resolve the discrepancy from independent console access and the verified backup.

Complete `T-LOCAL-EXECUTOR`, `T-SERVICES`, `T-DATABASE`, `T-LIVE` and `T-MIGRATION` in `todo.md` on an isolated supported host before calling either path production-ready.
