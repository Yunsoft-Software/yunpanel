# Local executor safety contract

This document describes the current safety boundary of YunPanel's privileged in-process local executor. It is a current architecture contract, not a historical implementation diary.

## Ownership and startup

Production enters through `apps/api/src/index.js`. When `YUNPANEL_LOCAL_SERVER_ID` is empty, the API can run but local host execution remains disabled. When it is set, `startConfiguredLocalRuntime()` validates the configured server identity against the current OS hostname, then starts the local executor only for a server already bound to `executionMode=local`.

The packaged API may run as root because it performs structured host administration. This does **not** make hosted workloads root-owned:

- static Git/npm/build work runs as a deterministic `yunapp-*` account,
- Node Git/npm/build and the generated systemd service run as the deterministic application `yunapp-*` account,
- Node services use `NoNewPrivileges`, an empty capability set and restricted writable paths,
- future site cron/file-manager/terminal work must preserve the dedicated site-user boundary,
- only an explicitly Owner-protected Server terminal may become a root PTY after the WebSocket/session/MFA/audit gates are implemented.

There is no generic root shell operation inside the job protocol.

## Exclusive local execution

The local runtime acquires an exclusive host lock before claiming work. A server record must match the exact configured ID and normalized OS hostname before and after lock acquisition. The executor consumes the same durable job registry used by the control plane; it does not create a parallel queue.

Local ownership blocks the retained legacy heartbeat/command/environment/result channel with `server_managed_locally`. The legacy agent service remains installed only as a rollback bridge until the real migration/rollback acceptance in `todo.md` is complete.

## Supported host operations

The current local operation map covers the asynchronous queue operations used by the control plane, including:

- package inspection and YunPanel package upgrade,
- managed-service inspection/install/start/stop/restart,
- MySQL/MariaDB inspection/create/delete,
- Nginx domain stage/activate,
- ACME certificate issue/renew,
- static deploy/rollback,
- Node deploy/rollback/restart/status and release-bound enable/disable/start/stop process control.

Node environment secrets are materialized from the encrypted application environment registry at execution time. Plaintext application secrets are not copied into generic durable job payloads or public job responses.

A source-level queue/recovery parity invariant must fail when a new asynchronous operation is added without an explicit recovery classification.

## Snapshot contract

The local runtime refreshes the local server record with host state on a fixed cadence. The configured snapshot provider supplies:

- host inventory,
- allowlisted systemd service state,
- Docker inspection,
- Nginx inspection.

Snapshot data is persisted back onto the exact local server record. Snapshot/binding failures are fatal to the executor instance: polling stops, the executor drains, and the exclusive lock is released rather than continuing with uncertain host identity/state.

`local-runtime validate <server-id>` is the post-migration read-only health gate. It requires:

- exact server ID and OS hostname,
- `executionMode=local` and valid binding metadata,
- `yunpanel-api.service=active`,
- `yun-agent.service=inactive`,
- zero queued/running jobs for the server,
- clear durable recovery state,
- an online/fresh local snapshot with inventory hostname/mode matching the host,
- local runtime version matching the packaged API version,
- a successful bounded loopback `GET /api/health` probe.

This source implementation is not a substitute for the real Ubuntu/package acceptance listed in `todo.md`.

## Executor uncertain-outcome behavior

Host execution, terminal completion persistence and resource reconciliation are separate phases. A successful host operation followed by a failed `complete(succeeded)` write is **not** converted into a contradictory failed host operation.

The executor halts on uncertainty such as:

| Code | Meaning |
| --- | --- |
| `local_claim_unconfirmed` | Durable claim persistence/acknowledgement is uncertain; execution is not started by that executor. |
| `local_claim_invalid` | Claimed job/server/envelope identity is inconsistent; execution is not started. |
| `local_completion_unconfirmed` | Host execution ended but the terminal durable result could not be confirmed. Do not replay blindly. |
| `local_reconciliation_failed` | A terminal job exists but related resource reconciliation did not complete. |

Concurrent `runOnce()` calls share one in-flight execution. `stop()` drains execution/completion/reconciliation and scheduler generations prevent an old callback from claiming work after stop/restart.

Fatal reporting is bounded to reviewed `code`, `phase` and optional UUID job ID. Raw exception messages, command output, environment, secrets and arbitrary paths are not part of the executor fault surface.

## Durable recovery

The durable job registry writes a private versioned recovery sidecar for uncertain work. Restarting the API does not clear that state and does not authorize automatic replay.

Recovery has two distinct classes:

1. terminal reconciliation: `job-recovery reconcile` re-applies the already-persisted terminal result to resource state and never re-runs the host operation;
2. running recovery: only reviewed operation-specific handlers may resolve a persisted `running` job.

Read-only running recovery may re-run only explicitly allowlisted inspection work from exact persisted intent. Mutating recovery requires operation-specific external host evidence and/or a private job-bound success receipt. Current recovery coverage includes the active queue operations documented in `docs/local-runtime-migration.md`.

There is no generic `force-success`, `force-failed`, blind mutation retry or manual journal-clear escape hatch. Missing or drifted evidence means the job remains unresolved.

Private recovery context contains execution intent needed by recovery without adding payloads to public `/api/jobs` responses. Receipt stores accept only operation-specific bounded metadata; they do not accept arbitrary result/env/secret objects.

## Execution evidence

For host mutations whose final state alone cannot prove that the exact operation ran, the local executor may write a private success receipt after the host operation succeeds and before durable completion is attempted. Receipt write failure does not turn a successful host mutation into a failed mutation; normal completion is still attempted. If both evidence and completion are unavailable, recovery remains unresolved.

Examples include domain activation, Node deploy/restart/rollback, managed-service install/restart, database deletion, YunPanel upgrade and certificate operations. Recovery cross-checks the receipt against exact persisted job/resource identity and fresh host state instead of trusting a receipt alone. Idempotent Node enable/disable/start/stop recovery does not need a historical receipt: it requires the exact private release/runtime/action intent and a fresh final state that proves that intent is currently satisfied, without replaying `systemctl`.

## Safe diagnostics

`local-execution-error.js` maps reviewed host/OS error codes to authored public messages. Unknown or hostile error objects collapse to a generic `local_operation_failed` diagnostic. Raw child-process output, exception messages, stack traces, secrets and arbitrary unknown codes must not be copied into failed jobs.

The temporarily retained legacy agent transport has its own authored safe-error compatibility catalog and source guards. First enrollment is retired; retained transport exists only for already-enrolled rollback identities.

## Migration and rollback boundary

Ownership mutation (`create`, `bind`, `release`) is root-only in the packaged CLI and requires an exact verified snapshot under `/var/backups/yunpanel`.

Before ownership mutation, the current migration procedure requires:

1. drain jobs and resolve durable recovery,
2. stop API + legacy agent consumers,
3. create and re-verify the fixed-allowlist migration snapshot,
4. run non-destructive restore `preview`,
5. run private restore `stage`,
6. perform the guarded ownership mutation,
7. configure the exact local server ID,
8. keep/disable the agent as required and start the API,
9. run `local-runtime validate`,
10. only then continue with functional validation on the isolated test host.

Restore preview validates archive paths/types/links and compares managed `yunapp-*` Unix identities. Staging extracts only below `/var/backups/yunpanel/.restore-staging` with owner/permission restoration disabled, validates the staged tree and produces metadata evidence. `/etc/passwd` and `/etc/group` are identity references, not blind restore targets.

There is intentionally **no live archive apply/restore command yet**. Per-target replacement, owner/mode/ACL/xattr policy, Unix identity drift handling, pre-apply backup and deterministic rollback require real Ubuntu/package acceptance before live apply may be enabled.

## Validation status

Historical commits and previous package candidates have their own test evidence, but those results do not prove the current tree. The current source has changed substantially since the last full supported-Node/package acceptance.

Do not claim the present `main` passed the complete Node 24 workspace, Debian package, browser or real Ubuntu migration/recovery suite unless those commands were actually run for the current commit. The outstanding acceptance gates live in `todo.md`. GitHub Actions are not used for this project.
