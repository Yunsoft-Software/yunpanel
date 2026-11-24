# Mail Management

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

YunPanel integrates Postfix, Dovecot (Pigeonhole Sieve), Rspamd, and Roundcube on the local Linux host. Manage all mail domains from **Posta** (`/mail`) or manage mail for a specific site from its **E-posta** (`/websites/<id>/mail`) tab.

## Mail domains and management modes

When clicking **Mail alan adı ekle** (Add mail domain), choose one of two modes:

- **Bu sunucuda (Local):** Host mailboxes, aliases, forwarding, DKIM signing, and Webmail directly on this server.
- **Harici mail sağlayıcısı (External):** Disable local mail delivery for domains whose mail is hosted on an external provider to prevent local routing conflicts.

![YunPanel Mail domains management screen (Turkish UI)](assets/en/14-mail-domains.png)

## Mailboxes, quotas, forwarding, and aliases

Opening a local mail domain (**Yönet**) provides:

- **Mailbox provisioning and password changes:** Encrypted authentication records are scoped via the `yunpanel-mailauth` group for Postfix/Dovecot access only.
- **Quotas and forwarding:** Set per-mailbox storage quotas and configure forwarding either with a local copy preserved or forward-only.
- **Aliases:** Attach multiple alias addresses to existing mailboxes.
- **Client connection settings:** Ready-to-use IMAP/IMAPS and SMTP/Submission (STARTTLS) host and port details appear directly in the mailbox view.

## Auto-responder (vacation) and spam delivery policies

Server Owners can configure per-mailbox delivery policies:

- **Auto-responder (Dovecot Pigeonhole Sieve):** UTF-8 vacation replies with subject and body that chain cleanly with existing forwarding rules and enforce standard loop prevention.
- **Spam allow / deny rules (Rspamd Multimap):** Managed sender/domain allow and deny lists applied with configuration preview, configtest validation, and automatic rollback on failure.

## DKIM, SPF/DMARC, Smarthost, and Roundcube Webmail

- **DKIM & DNS diagnostics:** Generates per-domain RSA DKIM keys with rotation support and inspects required MX, SPF, DKIM, and DMARC records.
- **SRS & Smarthost:** Maintains encrypted SRS secrets for forwarded mail and supports external SMTP relay (Smarthost) plus delivery tracking.
- **Roundcube Webmail:** Serves per-domain Webmail under the isolated `yunpanel-roundcube` system user.

## Related guides

- Mail DNS records and Postfix/Dovecot TLS SNI certificates: [Domains, DNS, and SSL](doc:domains-and-ssl)
- Backing up mailbox data: [Backup and Recovery](doc:backups-and-recovery)
