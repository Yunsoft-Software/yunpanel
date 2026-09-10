# YunPanel verified migration backup

This runbook defines the backup gate used before changing local/legacy execution ownership. It also provides non-live restore preview and private staged extraction primitives. It does not replace live host state and it does not make an agentless migration production-ready by itself. Real restore/apply and migration acceptance remain in `todo.md`.

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

## Preview restore intent without changing the host

After verification, inspect the current restore intent before any rollback/rehearsal work:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs preview /var/backups/yunpanel/migration-<timestamp>
```

`preview` is deliberately non-destructive. It re-verifies the exact snapshot, validates the archive's normalized member/type/link graph, compares allowlisted top-level targets against the current host, and compares only managed `yunapp-*` Unix identities from snapshot `/etc/passwd` + `/etc/group` against the current host.

Archive inspection rejects duplicate members, special filesystem objects, control-character/non-canonical names, manifest root/type drift, and symlink/hardlink targets that escape their verified source root. The operator output reports only counts and `archiveLinksSafe=true`; it does not print the internal member manifest or raw link metadata.

Unix identity comparison is limited to managed `yunapp-<12 hex>` users. It compares UID, GID, home, shell, dedicated primary group and supplementary group membership. GECOS/password fields and unrelated system users are not emitted. Drift output is bounded to the managed username, status and changed field names.

Restore-intent classes are conservative:

- mutable YunPanel/Nginx/Let's Encrypt/systemd state present in the snapshot can be classified as a future `restore_replace` target,
- `/etc/passwd` and `/etc/group` are always `identity_reference` inputs and are **not** automatic restore targets,
- optional paths absent from the snapshot are `preserve_current`; preview does not propose deleting current host state merely because the old snapshot lacked it.

If a current top-level target is a symlink or another unsafe/unexpected type, preview fails closed. Preview does not extract `state.tar`, copy files, delete files, change ownership/modes, edit Unix users/groups or restart services.

## Stage a verified restore without touching live host state

A successful preview can be followed by private staged extraction:

```bash
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs stage /var/backups/yunpanel/migration-<timestamp> --confirm
```

`stage` runs the full restore preview first. It then extracts the verified archive only below the fixed private staging root:

```text
/var/backups/yunpanel/.restore-staging/<snapshot-name>-<random>/
```

The staging root and generated stage directory are forced to `0700`. GNU tar is invoked with `--no-same-owner` and `--no-same-permissions`, so staged extraction is content/link validation rather than a live ownership/mode restore. The archive is never extracted against `/`.

After extraction YunPanel walks the staged tree without following symlinks and requires the exact normalized archive member set. Symlink targets must still resolve to the same verified in-root destination. Hardlinks must resolve to the verified archived target and, where filesystem inode metadata is available, remain real hardlinks rather than copied files. Unexpected/missing/special members or link drift remove the partial stage and fail closed.

Successful output contains only `validated=true`, `destructive=false`, `liveMutation=false`, the snapshot/staging paths, checksum and member count. It does not print file contents, Unix account records, secrets or internal archive member names.

Staging is **not** live restore approval. It creates a root-private rehearsal tree only. There is intentionally no `restore`/`apply` command yet.

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

There is intentionally no live automatic restore/apply command yet. `preview` describes validated intent; `stage` proves that the verified archive can be extracted into a private non-live tree with member/link validation. Neither replaces current `/etc`, `/var/lib`, Nginx, certificate, systemd or Unix identity state.

Before live restore/apply can be enabled it must define per-target replacement rules, preserve the package/control-plane recovery path, validate ownership/modes/ACL/xattrs, handle `yunapp-*` identity drift explicitly rather than overwriting `/etc/passwd` or `/etc/group`, create a pre-apply backup, and provide deterministic rollback if any target or health check fails. Never introduce a blind `tar -x` against `/` as rollback automation.

Until that path has real Ubuntu/package acceptance, rollback continues to use the verified snapshot plus the explicit procedure in `docs/local-runtime-migration.md` and package rollback tooling.

## Acceptance

On an isolated Ubuntu 24.04 package host, verify at minimum:

- creation and re-verification with the real `/usr/bin/tar`, ACL and xattr flags,
- exact `0700`/`0600` backup permissions,
- SHA-256 tamper rejection,
- missing required source rejection,
- top-level symlink source rejection,
- archive member/type/link escape and duplicate/special-member rejection,
- `preview` reports `destructive=false`, treats `/etc/passwd` plus `/etc/group` as identity references only, and reports real `yunapp-*` identity drift without exposing account-file contents,
- `stage <snapshot> --confirm` writes only under `/var/backups/yunpanel/.restore-staging`, uses private permissions/no live owner-mode restore, validates the exact extracted tree and cleans failed partial stages,
- `create`, `bind` and `release` refuse to run without an exact valid `--backup-dir` snapshot,
- no secret/file-content material in `manifest.json` or normal command output,
- staged restoration rehearsal plus the future live apply/rollback path before any production migration is approved.
