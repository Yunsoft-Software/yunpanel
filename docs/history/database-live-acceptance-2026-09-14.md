# Database live acceptance — 2026-09-14

YunPanel database module acceptance was completed on the isolated `test` host running Ubuntu 24.04 amd64. The target was verified against `.local/test-server.env` before any connection and was not the excluded `.44` Plesk host.

## Deployed build

- Package: `yunpanel 0.3.0-2026091404`
- Application revision: `e67e433`
- Package SHA-256: `9c6f4b000890cf9d5b61985db1d346b4fe93e63006c74b6da7f9db78ddf57073`
- Database engine: MariaDB `10.11.14-MariaDB-0ubuntu0.24.04.1`
- `yunpanel-api` and `yunpanel-web` were active; the retained legacy agent was disabled and inactive.

## Acceptance evidence

- The headed Owner browser completed server scan and database create/inspect/drop/inspect through the packaged HTTPS API. The final acceptance schema was removed.
- Installing the conflicting MySQL managed service was rejected without changing MariaDB; MySQL remained absent.
- System and injection-prone database names were rejected. Ownership binding accepted only the exact same-server Website/Application/site-user tuple, survived service restart and package upgrade, blocked schema deletion while bound, and rejected stale, cross-server, proxy and unsupported bindings.
- Credential desired state caused no host mutation until explicit apply. Deterministic local accounts received only the requested schema-scoped allowlist grants. Connection, rotation, previous-password rejection, apply rollback, delete rollback, collision and global/cross-schema/table/routine drift checks passed.
- Credential finalization required the matching terminal delete job. Unbind remained blocked while a credential existed. Lost-ack recovery required the current protected context, private receipt, marker, account and exact live grant evidence and did not replay the mutation.
- Database backup required the exact confirmation, used the durable job identity as its backup identity, produced canonical socket-only dumps and enforced private directory/file modes. Identity conflict, checksum tamper, permission drift, empty dump and missing schema cases failed closed.
- Restore required matching succeeded backup-job evidence, private manifest identity and SHA-256. Its queued public payload contained only the database name, backup identity and expected SHA-256. Pre-restore backup, verified restore, verified rollback, explicit rollback-failed handling and non-replaying lost-ack recovery passed.
- A 16,970,277-byte canonical dump containing 16,384 rows was backed up and restored. Live progress stayed bounded and monotonic: `source:10`, `pre_backup:30`, `apply:40`, `verify:80`, `receipt:90`, `done:100`.
- Public job and audit responses, recovery output and private receipts were scanned for credentials, socket paths, raw SQL, connection material and child-process raw output. No prohibited material was found.
- The full Node 24 workspace check and production web build completed successfully both locally and on the exact Ubuntu build tree used for the deployed package.

## Fixes found by live acceptance

- `b07284e` selects MariaDB's supported routine-grant catalog instead of querying a MySQL-only information-schema table.
- `e67e433` validates database credential recovery against protected context rather than relying on payload fields intentionally omitted from the public job record.

Credentials, session material, MFA secrets, SQL contents, socket paths and private artifact paths are intentionally excluded from this report.
