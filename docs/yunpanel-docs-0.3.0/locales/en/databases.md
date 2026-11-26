# Database Management

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

YunPanel provisions isolated MariaDB databases and per-schema database users for each website and subdomain. Use **Veritabanları** (`/databases`) for the server-wide inventory or a site's **Veritabanları** (`/websites/<id>/databases`) tab for site-scoped databases.

## Creating and binding a database

1. Click **Veritabanı oluştur** (Create database) and select the target website or subdomain.
2. Enter the database name, database username, and a strong password.
3. YunPanel creates the schema and dedicated user with access limited to that database, and stores credentials encrypted with `YUNPANEL_SECRET_MASTER_KEY`.
4. Customer database count quotas (`maxDatabases`) are enforced automatically during provisioning.

![YunPanel Databases workspace screen (Turkish UI)](assets/en/13-databases.png)

## Day-to-day database operations

- **Password rotation and credential repair:** Rotate database user passwords from the panel or repair missing credential bindings cleanly.
- **Copying and SQL export/import:** Create site database dumps or perform safe same-host database copies for staging workflows.
- **Guarded deletion:** Dropping a database requires explicit confirmation and removes only the selected schema without touching sibling databases.

## Authenticated phpMyAdmin gateway

YunPanel never exposes phpMyAdmin unauthenticated to the public internet. Launching phpMyAdmin from the panel:

- Issues a short-lived, session-bound single sign-on (**sign-on**) handoff tied to the active panel session and authorized website scope.
- Runs phpMyAdmin under the isolated `yunpanel-phpmyadmin` system user; revoking the panel session or user grants terminates gateway access immediately.
- Restricts Site Managers and Customers strictly to databases bound to their assigned websites.

## Related guides

- Binding a database to WordPress: [WordPress Management](doc:wordpress)
- Including databases in Restic site backups: [Backup and Recovery](doc:backups-and-recovery)
