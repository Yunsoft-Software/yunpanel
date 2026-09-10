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

A `running` recovery job is handled differently. YunPanel currently permits automatic re-execution only for the two payload-free read-only inspections whose repetition cannot mutate host state:

- `system.packages.inspect`
- `database.inspect`

After both consumers are stopped, inspect the exact recovery identity first and then run:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs recover-readonly <server-id> <job-id> --confirm
```

The command re-runs the allowlisted read-only inspection and records that fresh inspection result on the original durable job. If the host probe or durable completion cannot be confirmed, the recovery record remains unresolved. `system.services.inspect`, Node status, deploy/restart/rollback, package upgrade, service mutations, database create/delete, domain and certificate operations are deliberately **not** accepted by this command.

Mutating `running` recovery still requires operation-specific external host evidence. Do not mark a mutation succeeded/failed by guess, do not clear its journal manually and do not use process restart as an automatic retry mechanism. That remaining recovery work stays gated by `plan.md` and `todo.md`.

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

Do not continue while durable recovery is unresolved. The fresh-create command also fails closed if API/agent is active, any queued/running job exists or the durable recovery sidecar still contains unresolved work.

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

1. server connectivity/local snapshot,
2. host inventory, allowlisted systemd services, Docker and Nginx snapshot parity,
3. read-only package/service/database inspection,
4. one low-risk managed mutation on the test host,
5. Node/static runtime operations,
6. SSL, DB and remaining host operations required by `todo.md`.

If durable recovery appears at any point, stop creating new work and use `job-recovery status` before deciding the next action.

The root API may adopt an existing private legacy auth directory/SQLite files below `/var/lib/yunpanel/control-plane/auth`. Unsafe modes, symlinks, foreign owners or control-plane-external auth paths must remain fail-closed.

## Rollback for Path A only

Do not run rollback while local work is active or durable recovery is unresolved.

1. Drain/cancel queued work and resolve any terminal reconciliation journal.
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

If any migration/recovery command reports an active service, active queue, hostname mismatch, unknown-running mutation, invalid/outside state path or unreadable systemd state, do not bypass the guard. Resolve the discrepancy from independent console access and the verified backup.

Complete `T-LOCAL-EXECUTOR`, `T-SERVICES`, `T-DATABASE`, `T-LIVE` and `T-MIGRATION` in `todo.md` on an isolated supported host before calling either path production-ready.
