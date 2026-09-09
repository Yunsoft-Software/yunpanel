# Local executor: uncertain outcomes and Node status migration

## Current integration boundary

This increment continues the existing host-runtime extraction; it does **not** retire the agent or change the API service identity. `apps/api/src/index.js` still does not start the local executor. Existing browser authentication, Owner/Read Only permissions, MFA, user administration, secret rotation and UI remain unchanged.

The in-process operation map now includes Node status alongside the previously migrated package, Nginx and ACME operations. Node deploy/restart/rollback and environment materialization have not been connected locally. Do not pass an empty environment bundle to a restart/deploy as a migration shortcut. Production startup, explicit local-server binding, exclusive queue ownership, supported-operation selection, durable recovery and package migration remain in `plan.md` B.

## Executor correction

The former executor caught both host-execution errors and completion-write errors in the same block. A successful host operation followed by a failed `complete(succeeded)` could therefore trigger a contradictory `complete(failed)`. Those phases are now separate.

Only an actual host-operation exception creates a failed operation result. Unconfirmed claims, inconsistent claim identity, failed/inconsistent completion acknowledgements and reconciliation failures halt the executor instance. No later job is claimed by that instance, and `start()` or `runOnce()` cannot silently clear the halt. The `failure()` method returns a defensive copy of safe phase/job metadata:

| Code | Meaning |
|---|---|
| `local_claim_unconfirmed` | Claim persistence/acknowledgement is uncertain; no host call was started by this executor. |
| `local_claim_invalid` | Server, job, envelope, operation or payload identity was inconsistent; execution was not started. |
| `local_completion_unconfirmed` | Host execution ended, but the saved terminal result could not be confirmed. Do not repeat the operation blindly. |
| `local_reconciliation_failed` | A terminal acknowledgement was received, but updating the related resource failed. |

Concurrent `runOnce()` calls still share one in-flight operation. `stop()` drains execution, completion and reconciliation; starting or manually claiming work while draining is rejected. Polling generations prevent an older callback from scheduling work after stop/restart. A scheduled fault stops polling and reports the safe phase error.

**This halt is in memory, not a durable recovery journal or an exactly-once guarantee.** Creating a new executor or restarting a process is not a recovery procedure. The existing JSON job registry still needs durable state/acknowledgement consistency and recovery work: it mutates in-memory state before persistence, and its idempotent terminal-return behavior cannot prove that a previous write reached disk. A completion write may have succeeded even when its acknowledgement was lost. Inspect the stored queue, application/certificate/domain state and actual host state before recovery. Do not automatically replay an uncertain deploy, upgrade, activation or issuance.

## Safe local error diagnostics

`local-execution-error.js` maps explicitly known host/OS error codes to authored public messages. Raw exception messages, command output, paths, stack traces, arbitrary properties and unknown error codes are not copied into a local failed-job record. Unknown values get `local_operation_failed`; malformed/throwing error objects are handled without reading their message. This affects the local executor only, not a completed redaction audit of all legacy agent and API paths. New host operations must add reviewed safe diagnostics rather than trusting arbitrary exception text.

## Shared Node status inspector

The previous `apps/agent/src/node-status-inspector.js` implementation was moved byte-for-byte into `packages/host-runtime/src/node-status-inspector.js` using its original Git blob `7ecf717ce44c32abc93dc8ae1be8d85c714d40f9`. The former agent path re-exports the same factory, singleton, error class and parser for compatibility; no second algorithm was introduced.

It retains existing UUID/runtime validation, the managed `current -> releases/<UUID>` check, drift rejection, deterministic service naming, bounded systemctl property inspection and loopback-only HTTP health check. The local operation map forwards the queued Node status payload to this inspector. It does not grant arbitrary shell execution or start a new listener.

An additional existing package-manager initialization defect was reproduced: its default restart list included `yun-agent.service`, but its own service-name validation rejected that exact name. The singleton threw during module import. The validator now accepts that exact legacy unit while continuing to reject unrelated units. Legacy defaults remain API/web/agent; the local-operation factory's explicit API/web override still excludes the agent. This is compatibility until the separately planned package migration, not a decision to retain an agent in the target architecture.

## Validation actually performed — 2026-09-09

The final command passed **43 tests, 0 failed, 0 skipped** on **Node 22.16.0**:

```bash
node --test \
  apps/api/test/local-executor-failures.test.js \
  apps/api/test/local-execution-error.test.js \
  apps/agent/test/node-status-inspector.test.js \
  packages/host-runtime/test/node-status-host.test.js \
  packages/host-runtime/test/system-package-defaults.test.js
```

The set contains 21 executor fault/lifecycle tests, six local-error redaction tests, four retained Node status tests, seven new host-status checks and five package-default tests. The executor uses controlled registry/host callbacks. The Node checks include actual temporary filesystem symlinks and one real loopback HTTP health server; systemctl is a controlled command adapter. Package tests simulate APT/systemd command execution; no package or host service was changed.

Original shared validation, systemd template and inspector sources were verified against repository blob hashes. Tests ran in a reconstructed source subset with local package exports pointing to the necessary modules. This did not load all production package barrel files or establish full dependency resolution. No validation algorithm, password KDF fallback or runtime requirement was replaced in the product.

The `local-host-operations.test.js` dispatch suite was extended and the existing real-registry `local-job-executor.test.js` expectation was updated for safe diagnostics. **Those two suites were not run here**; they need the complete host-runtime/protocol/registry dependency graph. The new dispatch source and test passed syntax checks. Normal workspace test commands still include both suites.

GitHub/Node runtime downloads were unavailable through the container's DNS/network, so a supported Node 24 install and full repository build were not performed. Native auth/SQLite/Argon2 regression, full `npm run check`, production package-barrel imports, actual systemd/Ubuntu behavior, browser rendering and live HTTPS acceptance remain open in `todo.md` T-LOCAL-EXECUTOR/T-RUNTIME/T-MIGRATION. No GitHub Actions, new branch, force push, live deployment or production data migration was performed.
