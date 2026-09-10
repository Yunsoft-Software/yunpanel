# YunPanel verified migration backup

This runbook defines the backup gate used before changing local/legacy execution ownership. It does not perform restore and it does not make an agentless migration production-ready by itself. Real restore and migration acceptance remain in `todo.md`.

## What is captured

The packaged backup command uses a fixed source allowlist. It does not accept arbitrary source paths from the operator.

Required sources:

- `/etc/yunpanel`
- `/var/lib/yunpanel`
- `/etc/passwd`
- `/etc/group`

Optional sources, when present:

- `/etc/nginx`
- `/etc/letsencrypt`
- `/etc/systemd/system/yunpanel-api.service`
- `/etc/systemd/system/yunpanel-web.service`
- `/etc/systemd/system/yun-agent.service`

`/etc/passwd` and `/etc/group` preserve Unix identity metadata needed to validate dedicated `yunapp-*` ownership. `/etc/shadow` is deliberately not included. Package-owned files under `/usr/lib` are restored by package rollback, not copied as mutable host state.

Top-level source entries must be real files/directories rather than symbolic links. Required missing paths fail closed.

## Create and verify a snapshot

Use independent console/SSH access and run the packaged command as root:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm
```

The command writes below the fixed root:

```text
/var/backups/yunpanel/migration-<timestamp>/
  state.tar
  manifest.json
```

The backup root and snapshot directory are `0700`; the archive and manifest are `0600`. The manifest contains only version/timestamp, archive name, SHA-256 and source path/type/presence metadata. It does not copy source file contents into the manifest.

`create` immediately verifies the new archive before reporting success. The safe operator output contains only snapshot paths, SHA-256 and present/missing source counts.

## Re-verify an existing snapshot

Before any ownership mutation, re-run verification on the exact snapshot directory printed by `create`:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs verify /var/backups/yunpanel/migration-<timestamp>
```

Packaged verification refuses the backup root itself and paths outside `/var/backups/yunpanel`. Verification checks:

1. snapshot/archive/manifest are real files/directories rather than symlinks,
2. group/other permissions are absent,
3. manifest schema exactly matches the fixed source set,
4. required sources were present when the snapshot was created,
5. archive SHA-256 matches the manifest,
6. archive member names stay under one of the recorded allowlisted source roots and contain no absolute or `..` escape.

Any mismatch means the backup is not a valid migration gate. Do not bypass the check.

## Use the verified snapshot as the ownership-mutation gate

`local-runtime.mjs status <server-uuid>` remains read-only and does not need a backup argument. Every ownership mutation must receive the exact verified snapshot directory:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs create --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs bind <server-uuid> --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-runtime.mjs release <server-uuid> --backup-dir /var/backups/yunpanel/migration-<timestamp> --confirm
```

The ownership CLI re-verifies `manifest.json`, archive SHA-256, permissions and archive member paths immediately before invoking the migration command. A missing, altered, outside-root or malformed snapshot prevents the ownership mutation from starting. Successful mutation output reports the exact verified snapshot directory used as the gate.

The backup path itself is not copied into server/job state, and the verification step does not expose file contents or secrets.

## Restore boundary

There is intentionally no automatic extract/restore command yet. A valid archive proves that the pre-migration snapshot was created and has not changed; it does not prove restore acceptance.

Before a restore implementation is enabled, it must additionally validate archive link targets and ownership/mode behavior in a staged extraction environment. Never introduce a blind `tar -x` against `/` as rollback automation.

Until the restore path has real Ubuntu/package acceptance, rollback continues to use the verified snapshot plus the explicit procedure in `docs/local-runtime-migration.md` and package rollback tooling.

## Acceptance

On an isolated Ubuntu 24.04 package host, verify at minimum:

- creation and re-verification with the real `/usr/bin/tar`, ACL and xattr flags,
- exact `0700`/`0600` permissions,
- SHA-256 tamper rejection,
- missing required source rejection,
- top-level symlink source rejection,
- archive-member escape rejection,
- `create`, `bind` and `release` refusing to run without an exact valid `--backup-dir` snapshot,
- no secret/file-content material in `manifest.json` or normal command output,
- restoration rehearsal from the snapshot before any production migration is approved.
