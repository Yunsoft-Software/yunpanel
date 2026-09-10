# Agent -> local runtime migration

This runbook transfers one enrolled host from the retained `yun-agent` command consumer to the in-process privileged `yunpanel-api` local runtime. It is intentionally manual and fail-closed until the package/test-host acceptance in `todo.md` is complete. Do not perform the first migration on the only production copy of a host.

## Preconditions

- Use the packaged Node runtime at `/usr/local/bin/node` and run the packaged migration CLI as root.
- Take and verify a rollback backup of `/etc/yunpanel`, `/var/lib/yunpanel`, auth SQLite state, master-key configuration, Nginx/vhost state, certificates and application releases.
- Confirm independent SSH/provider-console access.
- Identify the exact enrolled server UUID from YunPanel. The CLI never accepts a hostname as a substitute for the UUID and always compares the registry hostname with `os.hostname()`.
- Production control-plane stores must use absolute paths under `/var/lib/yunpanel/control-plane`. In `/etc/yunpanel/control-plane/api.env` use the production equivalents below rather than repository-development `.data` paths:

```text
YUNPANEL_SERVER_STORE=/var/lib/yunpanel/control-plane/server-registry.json
YUNPANEL_DOMAIN_STORE=/var/lib/yunpanel/control-plane/domain-registry.json
YUNPANEL_JOB_STORE=/var/lib/yunpanel/control-plane/job-registry.json
YUNPANEL_CERTIFICATE_STORE=/var/lib/yunpanel/control-plane/certificate-registry.json
YUNPANEL_APPLICATION_STORE=/var/lib/yunpanel/control-plane/application-registry.json
YUNPANEL_APPLICATION_ENVIRONMENT_STORE=/var/lib/yunpanel/control-plane/application-environment-registry.json
YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite
```

Do not change `YUNPANEL_SECRET_MASTER_KEY` during this migration. If the installed host still stores state elsewhere, migrate and verify that state separately while writers are stopped before using this runbook. The local-runtime CLI deliberately rejects packaged server/job paths outside the control-plane state root instead of copying unknown state automatically.

## 1. Drain work before stopping consumers

While the panel is still available, let every `running` job reach a terminal state. Cancel unwanted `queued` jobs through the existing job UI/API. Do not terminate a host mutation merely to make the migration proceed. The migration guard rejects any remaining `queued` or `running` job for the selected server.

You can inspect the planned host before the stop window:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs status <server-uuid>
```

`status` is read-only. An active API/agent is reported as a blocker but does not mutate registry ownership.

## 2. Stop both command consumers

```bash
sudo systemctl stop yunpanel-api.service yun-agent.service
```

Do not start either service until the ownership command below has completed. The CLI reads only the fixed `yunpanel-api.service` and `yun-agent.service` unit states. If systemd state cannot be read unambiguously, migration fails closed.

Run the preflight again:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs status <server-uuid>
```

Continue only when `apiActive=false`, `agentActive=false`, `activeJobs=0`, the hostname is the expected host and the printed server/job store paths are the intended `/var/lib/yunpanel/control-plane/...` files.

## 3. Bind registry ownership to the local runtime

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs bind <server-uuid> --confirm
```

The command re-runs the same service/job/hostname preflight immediately before mutation. Repeating a successful bind for the already-local exact host is idempotent. The command never writes the API environment or prints secret state.

Add the exact value printed by the command to `/etc/yunpanel/control-plane/api.env`:

```text
YUNPANEL_LOCAL_SERVER_ID=<server-uuid>
```

Keep the same server UUID; do not generate a new registry record for the local runtime.

## 4. Disable the legacy consumer and start the local API

```bash
sudo systemctl disable yun-agent.service
sudo systemctl start yunpanel-api.service
```

Do not start `yun-agent.service` while the registry record is in `executionMode=local`. Current package upgrades preserve an already-disabled agent instead of re-enabling it.

The root API startup can adopt an existing private legacy auth directory/SQLite files under `/var/lib/yunpanel/control-plane/auth` before opening the strict auth store. Unsafe modes, symlinks, foreign file owners or control-plane-external auth paths are not auto-fixed.

Verify at minimum:

```bash
systemctl is-active yunpanel-api.service
systemctl is-active yun-agent.service || true
```

Then use the authenticated panel to verify server connectivity and a read-only operation before any mutation. On the test host, complete the `T-LOCAL-EXECUTOR`, `T-SERVICES`, `T-DATABASE`, `T-LIVE` and `T-MIGRATION` checks from `todo.md` before declaring the migration production-ready.

## Rollback to the legacy agent

Do not run rollback while a local job is active.

1. Let/cancel queued work until there are no `queued` or `running` jobs for the host.
2. Stop both services:

```bash
sudo systemctl stop yunpanel-api.service yun-agent.service
```

3. Remove `YUNPANEL_LOCAL_SERVER_ID` from `/etc/yunpanel/control-plane/api.env`.
4. Release registry ownership:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs release <server-uuid> --confirm
```

5. Re-enable/start the legacy agent and start the API only after the release succeeds:

```bash
sudo systemctl enable yun-agent.service
sudo systemctl start yunpanel-api.service yun-agent.service
```

6. Verify agent heartbeat, server identity, queued-job behavior, auth, sites, certificates and hosted workloads.

If release/bind reports an active service, active queue, hostname mismatch, invalid state path or unreadable systemd state, do not bypass the check. Resolve the discrepancy from the independent console and the verified backup first.
