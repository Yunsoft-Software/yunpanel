# Installation and Upgrade

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

YunPanel runs on a single local Linux host using an authenticated Node.js management API, a privileged local host runtime, and a React management web interface. Hosted websites run under dedicated isolated Linux users (`yunapp-<hash>`), so Nginx, PHP-FPM, databases, and mail services remain online even if the panel services are stopped or restarted.

## Supported Linux distributions and prerequisites

The centralized OS platform adapter (`os-platform`) supports the following 64-bit (`amd64` and `arm64`) Linux distributions:

| Family | Distributions | Package manager | Default PHP-FPM |
| :--- | :--- | :--- | :--- |
| Ubuntu LTS | Ubuntu 20.04 (Focal), 22.04 (Jammy), 24.04 (Noble) | `apt` | 7.4 / 8.1 / 8.3 |
| Debian | Debian 11 (Bullseye), Debian 12 (Bookworm) | `apt` | 7.4 / 8.2 |
| Enterprise Linux | AlmaLinux 8/9, Rocky Linux 8/9, RHEL 8/9 | `dnf` | 7.4 / 8.1 |

- **Runtime prerequisites:** Node.js `>= 24.11.1` and npm `>= 11.0.0`.
- **Debian package dependencies:** `adduser`, `ca-certificates`, `certbot`, `curl`, `git`, `nginx`, `openssh-client`, `python3-certbot-dns-cloudflare`, `xz-utils`.
- **Network & TLS:** Production installs require `YUNPANEL_PUBLIC_ORIGIN` to be an exact `https://` origin without a trailing slash. Loopback `http://127.0.0.1` is restricted to local development.

## Installing the `.deb` package

When you install a verified `.deb` package, `postinst` automatically performs safe, non-destructive initialization:

1. Normalizes immutable package payload modes under `/usr/lib/yunpanel` and `/usr/share/yunpanel` (`0755`/`0644`).
2. Provisions isolated system accounts and state directories (`yunpanel`, `vmail`, `yunpanel-mailauth`, `yunpanel-roundcube`, `yunpanel-phpmyadmin`, `yunpanel-elfinder`).
3. Seeds the official Yunsoft Ed25519 license verification public key (`kid: 1cbcc4d3173d0c15`) into `/etc/yunpanel/control-plane/entitlement-public.pem` without overwriting any operator-supplied custom key.
4. Generates the internal API ↔ web gateway credential (`/etc/yunpanel/control-plane/proxy.env`) and appends any missing default store paths to `/etc/yunpanel/control-plane/api.env`.
5. Enables `yunpanel-api.service`, `yunpanel-web.service`, and `yunpanel-sentinel.timer`.

```bash
sudo dpkg -i yunpanel_0.3.0-2026112301_amd64.deb
sudo apt-get -f install
```

Verify active services and a clean recovery queue after installation:

```bash
systemctl is-active yunpanel-api.service yunpanel-web.service yunpanel-sentinel.timer
/usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
```

## Core environment variables

Production environment files live in `/etc/yunpanel/control-plane/api.env` (`0600`, `root:root`) and `/etc/yunpanel/web/web.env`:

- `YUNPANEL_PUBLIC_ORIGIN`: Exact HTTPS origin of the panel (for example `https://panel.ornek.example`).
- `YUNPANEL_LOCAL_SERVER_ID`: Local server UUID initialized and validated via `local-runtime.mjs`.
- `YUNPANEL_SECRET_MASTER_KEY`: 32-byte root key protecting application secrets, MFA secrets, DNS/mail credentials, and encrypted license keys. Keep this value unchanged across upgrades; rotate it only with the offline rotation tool.
- `YUNPANEL_OWNER_MFA_REQUIRED`: Defaults to `true` in production.
- `YUNPANEL_LICENSE_COMMERCE_URL`: Defaults to `https://yunsoft.com/api/commerce`.

## Upgrading YunPanel

Before upgrading, check that no durable jobs are pending and take a control-plane migration backup if needed (see [Backup and Recovery](doc:backups-and-recovery)):

```bash
/usr/local/bin/node /usr/lib/yunpanel/scripts/job-recovery.mjs status
/usr/local/bin/node /usr/lib/yunpanel/scripts/local-migration-backup.mjs create --confirm
```

To upgrade from the panel UI, open **Araçlar ve Ayarlar → YunPanel güncellemeleri** (Tools & Settings → YunPanel Updates, `/settings?section=updates`):

1. Click **Güncellemeleri denetle** (Check updates) to inspect the candidate APT package version.
2. When an update is available, click **YunPanel'i güncelle** (Update YunPanel) and confirm (`upgrade-yunpanel`).
3. After the upgrade finishes, `yunpanel-api` and `yunpanel-web` restart while preserving your `/etc/yunpanel/control-plane/` configuration and hosted sites.

![YunPanel Tools and Settings directory (Turkish UI)](assets/en/18-tools-settings.png)

## Next step

After installation, create your first `Owner` account by following [First-Time Setup](doc:first-time-setup).
