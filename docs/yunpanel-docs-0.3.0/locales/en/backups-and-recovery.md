# Backup and Recovery

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

YunPanel provides two complementary backup and recovery layers: **per-site Restic/rclone backup and restore** inside the panel UI, and **control-plane / disaster-recovery backups** via packaged host CLI tools.

## Per-site backup and restore (Restic & rclone)

Each website's **Yedekleme ve Geri Yükleme** (`/websites/<id>/backup`) tab manages encrypted Restic repositories:

- **Scope summary (`Kapsam özeti`):** Tracks file roots, bound MariaDB databases, mail data, DNS records, environment configuration, and Nginx/hosting configs in one inventory.
- **Local and remote destinations:** Supports local Restic repositories as well as named **rclone** remotes (such as WebDAV or S3-compatible remote storage) with encrypted credentials.
- **Schedules and retention (`Plan ve Zamanlama`):** Configure daily, weekly, or custom cron schedules alongside snapshot retention policies.
- **Guarded restore:** Previews snapshot contents before restoring, captures a safety backup of live state, and verifies configuration drift safely.

![YunPanel Site Backup and Restore screen (Turkish UI)](assets/tr/15-site-backup.png)

## Control-plane migration and bare-metal recovery backups

To back up server-wide YunPanel control-plane state and stage recovery on a clean Linux host, use the packaged `local-migration-backup.mjs` CLI:

```bash
# 1. Create a control-plane backup (strict allowlist; /etc/shadow excluded)
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm

# 2. Verify archive integrity and SHA-256 manifest
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs verify /var/backups/yunpanel/migration-<timestamp>

# 3. Preflight a downloaded external archive before staging
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs preflight /path/to/backup --expected-sha256 <sha256> --expected-server-id <uuid>

# 4. Stage into a private directory without modifying live services
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs stage /var/backups/yunpanel/migration-<timestamp> --confirm
```

The fixed allowlist includes `/etc/yunpanel`, `/var/lib/yunpanel`, `/etc/passwd`, `/etc/group`, and Nginx / Let's Encrypt / systemd units when present; `/etc/shadow` is never archived. Store `YUNPANEL_SECRET_MASTER_KEY` separately in a secure vault for off-host recovery.

## Durable job recovery and master-key rotation

- **Job recovery (`job-recovery.mjs`):** Inspect interrupted durable jobs with `sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status`. Scoped recovery commands require exact server/job identity and explicit confirmation.
- **Master-key rotation (`rotate-secret-master-key.mjs`):** Never rotate `YUNPANEL_SECRET_MASTER_KEY` by editing `.env` alone. Stop the API and run the offline rotation script, which preflights, re-wraps every encrypted store, writes a manifest, and keeps a rollback snapshot.

## Related guides

- Pre-upgrade backup checklist: [Installation and Upgrade](doc:installation-and-upgrade)
- WordPress selective transfer and automatic rollback: [WordPress Management](doc:wordpress)
