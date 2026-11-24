# File Management

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

All YunPanel file operations run strictly inside the website's own document root under its dedicated Linux user (`yunapp-<hash>`). Both the global **Dosyalar** (`/files`) menu entry and each site's **Dosya Yöneticisi** (`/websites/<id>/files`) tab share this isolated file engine.

## Shared parent-domain file root for subdomains

Subdomains do not create disconnected top-level document roots. Instead, subdomain files live inside the parent domain workspace (`subdomains/<subdomain>`), allowing administrators to browse and edit subdomain files directly from the parent domain's File Manager while keeping site-level isolation intact.

## Built-in File Manager and code editor

From **Dosya Yöneticisi**, you can:

- Create directories and files, rename, copy, move, compress (ZIP), extract archives, upload, and download files.
- Adjust file permissions safely: insecure world-writable (`777`) permissions are blocked.
- **Built-in code editor:** Clicking any text or code file—or opening a direct deep link such as `?file=index.html` or `?path=public&file=notes.txt`—opens the line-numbered editor (`Ctrl/Cmd + S` to save, with concurrent-modification protection).
- **Unsaved-changes protection and clean dismissal:** Attempting to close a dirty editor opens the shared **Kaydedilmemiş değişiklikler var** (Unsaved changes) dialog (**Düzenlemeye dön** / **Değişiklikleri bırak**). Closing the editor removes the `?file=` query parameter cleanly so reloads or background polls never reopen a closed file.

![YunPanel Site File Manager with built-in code editor open (Turkish UI)](assets/en/11-files-editor.png)

## Integrated elFinder, SFTP keys, and Site Terminal

- **elFinder ile Aç** (Open in elFinder): Launches the bundled elFinder file manager via a short-lived, session-bound handoff under the dedicated site Unix user.
- **Erişim Hesapları (`/websites/<id>/access`):** Add, rotate, or revoke SSH/SFTP public keys for the website user. A single Owner has full SFTP key management on the Free tier as well.
- **Site Terminal (`ttyd`):** The **Terminal** tab launches a browser terminal scoped strictly to the site's dedicated Unix user (the Owner root server terminal is separate on the **Sunucu** page).

## Related guides

- Domain and subdomain structure: [Basic Site and Role Operations](doc:sites-and-roles)
- Backing up and restoring site files: [Backup and Recovery](doc:backups-and-recovery)
