# Secret master-key rotation

YunPanel uses one 32-byte root key (`YUNPANEL_SECRET_MASTER_KEY`) for two encrypted stores:

- application environment variables marked as secret;
- active and pending MFA TOTP secrets in the authentication SQLite database.

Changing the environment variable by itself makes existing secrets unreadable. Use the offline rotation command so both stores are rewrapped together and a rollback snapshot is created first.

## Safety requirements

Use Node.js 24.11.1 or newer and the same packaged YunPanel code that will be started after the rotation.

Before starting:

1. Confirm independent SSH/provider-console access to the host.
2. Record the exact production `YUNPANEL_AUTH_DB` and `YUNPANEL_APPLICATION_ENVIRONMENT_STORE` paths.
3. Ensure the current `YUNPANEL_SECRET_MASTER_KEY` is recoverable from a separate protected secret store. The rotation backup intentionally does **not** contain the raw old or new key.
4. Stop `yunpanel-api.service` and keep it stopped until the data rotation and API environment update are complete. `--confirm-offline` is an operator acknowledgement; it is not a substitute for stopping the service.
5. Choose a new, non-existing backup directory under a private service-owned location. Rotation refuses to reuse an existing backup directory.
6. Keep the current web/IP restrictions in place. Key rotation is not a deployment or security-boundary change.

The command never accepts a raw key as a command-line argument and never prints a key. It can read the current key from the process environment, a private key file, or a private systemd-style environment file. Private key/environment files must be regular files with no group/other permissions.

## Production rotation

The packaged service normally keeps writable control-plane state beneath `/var/lib/yunpanel/control-plane` and its API environment in `/etc/yunpanel/control-plane/api.env`. Use the paths actually configured on the host rather than copying these examples blindly.

Stop the API first:

```bash
sudo systemctl stop yunpanel-api.service
sudo systemctl is-active yunpanel-api.service
```

The second command must not report `active`.

Run the rotation as the service user. This example reads the existing root key directly from the private API environment file and creates a new mode-0600 key file without printing its contents:

```bash
sudo -u yunpanel env \
  YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  YUNPANEL_APPLICATION_ENVIRONMENT_STORE=/var/lib/yunpanel/control-plane/application-environment-registry.json \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/rotate-secret-master-key.mjs rotate \
  --confirm-offline \
  --current-env-file /etc/yunpanel/control-plane/api.env \
  --backup-dir /var/lib/yunpanel/control-plane/key-rotation-20260909T120000Z \
  --new-key-file /etc/yunpanel/control-plane/secret-master-key.next
```

The backup directory is created mode `0700`. It contains:

- a SQLite backup of the pre-rotation authentication database;
- the pre-rotation application environment store when that file existed;
- `manifest.json` with source paths, backup hashes, record counts and rotation state.

It contains no plaintext MFA/application secret and no raw master key. Treat it as sensitive control-plane backup material anyway.

Rotation preflights every encrypted application and MFA secret with the current key before replacing live data. It then rechecks the stores while holding an exclusive SQLite transaction. Normal runtime failures roll SQLite back and restore the environment store where necessary. A process/host crash can still interrupt a cross-file operation, which is why the service must be offline and the backup/manifest must be retained until validation is complete.

After the command succeeds, update the single `YUNPANEL_SECRET_MASTER_KEY` assignment in `/etc/yunpanel/control-plane/api.env` to the value held in the newly created private key file. Do this with a protected local editor or secret-management workflow; do not place the key in shell history, process arguments, Git, tickets, logs or chat. Preserve the previous key separately until the rollback window is closed.

Then start and validate:

```bash
sudo systemctl start yunpanel-api.service
sudo systemctl status yunpanel-api.service --no-pager
```

Acceptance is not just “the service started”. Verify at minimum:

- Owner password + TOTP login succeeds;
- an application containing a secret environment variable can materialize/use that secret successfully;
- the application environment API still masks secret values;
- ordinary management reads and one controlled mutation behave normally;
- no `mfa_key_unavailable`, `secret_decryption_failed` or related startup/runtime errors appear in service logs.

Only after those checks should the temporary `secret-master-key.next` file be removed according to the host's secret-management procedure. Retain the old key and rotation backup for the agreed rollback window, then destroy them securely according to policy.

## Rollback

Rollback intentionally restores the complete pre-rotation auth snapshot and application environment snapshot. Any auth/environment changes made after a successful rotation can therefore be lost. Stop the API before rollback.

Use the **same live store paths** used during rotation:

```bash
sudo systemctl stop yunpanel-api.service

sudo -u yunpanel env \
  YUNPANEL_AUTH_DB=/var/lib/yunpanel/control-plane/auth/auth.sqlite \
  YUNPANEL_APPLICATION_ENVIRONMENT_STORE=/var/lib/yunpanel/control-plane/application-environment-registry.json \
  /usr/local/bin/node /usr/lib/yunpanel/scripts/rotate-secret-master-key.mjs rollback \
  --confirm-offline \
  --backup-dir /var/lib/yunpanel/control-plane/key-rotation-20260909T120000Z
```

Rollback is bound to the source paths recorded in the manifest and refuses a different target. It also verifies backup SHA-256 hashes before restoring. If the application environment store did not exist before rotation, rollback removes a copy created after rotation so old-key state cannot be mixed with new-key data. SQLite WAL/SHM sidecars are removed before the auth snapshot is restored.

After the data rollback, restore the **previous** `YUNPANEL_SECRET_MASTER_KEY` in the private API environment, then start the API and repeat the MFA/application-secret validation above.

Do not start the service with old data + new key or new data + old key.

## Repository development

From the repository root the same CLI is exposed as:

```bash
npm run secret-key -- rotate --confirm-offline --backup-dir <new-private-dir> --new-key-file <private-file> --current-key-file <private-current-key-file>
npm run secret-key -- rollback --confirm-offline --backup-dir <rotation-backup-dir>
```

The rotation module has focused tests for active MFA, pending MFA, application secrets, wrong-current-key preflight, backup tampering, target-path binding, absent pre-rotation environment stores and rollback. Those tests still need to be run in the required Node 24/full-workspace acceptance environment before production use.
