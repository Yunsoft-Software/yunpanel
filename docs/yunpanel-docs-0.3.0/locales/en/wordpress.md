# WordPress Management

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

Every PHP-FPM website and subdomain exposes the **WordPress** tab (`/websites/<id>/wordpress`). All WordPress operations run through the bundled, pinned **WP-CLI** binary (`/usr/lib/yunpanel/vendor/wp-cli/wp`) under the website's dedicated Linux user.

![YunPanel site detail overview and tool cards (Turkish UI)](assets/en/06-site-overview.png)

> **Runtime note:** WordPress installation, WP-CLI updates, and live HTTP rollback execute on Linux hosts with PHP-FPM and MariaDB (verified end-to-end in Chromium and on Linux under package `0.3.0-2026112301` / `f13b2b78`).

## Installing WordPress

1. Open a PHP-FPM website or subdomain and go to the **WordPress** tab.
2. Provide the site title, admin username, strong password, admin email, and WordPress locale (such as `tr_TR` or `en_US`).
3. Select a MariaDB database bound to the site (or create one first in [Database Management](doc:databases)).
4. The operation runs via the durable job queue: YunPanel creates a pre-install hosting backup, writes `wp-config.php` with `0640` permissions owned by the site user, and verifies WP-CLI checksums and database connectivity.

## Core, plugin, and theme operations

- Inspect installed WordPress core version, plugins, and themes, and execute updates with durable operation receipts.
- Manage PHP-FPM version, memory limits, and runtime settings in the adjacent **PHP Ayarları** (`/websites/<id>/php`) tab.

## Staging clone and selective staging-to-production transfer

YunPanel includes a guarded selective transfer workflow designed to push staging code changes to production without overwriting live orders, customers, or configuration:

1. **Scoped file selection:** Transfers only explicitly selected relative paths (`themes`, `plugins`, `mu-plugins`, or validated `wp-content/` paths).
2. **Protected production state:** `wp-config.php`, `.htaccess`, `.user.ini`, and `wp-content/uploads/**` are preserved by default, along with WooCommerce order/subscription tables, `users`/`usermeta`, and `comments`.
3. **Preview digest & explicit confirmation:** The UI displays a file creation/overwrite summary (`planSha256`) and requires confirmation (**Dosya aktarımını onayla**) before writing; if source or target digests drift after preview, the transfer aborts safely.
4. **Automatic HTTP 503 rollback:** If the target site fails health checks (such as returning HTTP 503) after file transfer, YunPanel automatically restores the previous healthy file state from its durable recovery journal (`/var/lib/yunpanel/recovery/wordpress-selective`) while preserving concurrent production writes.

## Removing WordPress

The **WordPress'i kaldır** (Remove WordPress) action requires explicit confirmation, captures a pre-removal Restic backup, removes WordPress core files, `wp-config.php`, and WordPress database tables, and leaves the underlying website, SSL certificate, and non-WordPress files intact.

## Related guides

- Binding a MariaDB database: [Database Management](doc:databases)
- Inspecting site files: [File Management](doc:files)
- Pre-operation backups and restore: [Backup and Recovery](doc:backups-and-recovery)
