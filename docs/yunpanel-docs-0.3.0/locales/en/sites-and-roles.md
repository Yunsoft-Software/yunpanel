# Basic Site and Role Operations

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

Daily hosting management centers on the **Web Siteleri** (Websites, `/websites`) workspace. Root domains and their subdomains are organized hierarchically, and each website runs under its own isolated Linux user (`yunapp-<hash>`), document root, database bindings, and site tools.

## Websites view and domain hierarchy

The **Web Siteleri** page clearly displays root domain and subdomain counts (`X ana alan adı · Y alt alan adı`). Subdomains appear nested under their parent domain in the UI and live inside the parent domain workspace on disk (`<domain-root>/subdomains/<subdomain>`), while still supporting independent PHP, Node.js, Python, Static, database, and Docker proxy workloads.

![YunPanel Websites hierarchy screen (Turkish UI)](assets/en/04-websites-hierarchy.png)

## Creating a website or subdomain

Click **Web sitesi ekle** (Add website) or **Alt alan adı ekle** (Add subdomain) in the page header, or **Alt alan adı** (Subdomain) on a root domain card, to open `/websites/new`:

1. **Alan adı ve sahip** (Domain & owner): Choose a standalone root domain or a subdomain under an existing parent, configure `www` handling, and choose the site owner.
2. **Barındırma** (Hosting): Select PHP-FPM, Node.js, Python, Static site, Redirect, or Docker proxy.
3. **DNS, HTTPS, and Mail:** Configure local/external DNS, Let's Encrypt HTTPS, and mail support.
4. **Preview and confirm:** Mutations execute through the durable job queue only after preview digest verification and explicit confirmation.

![YunPanel new website wizard (Turkish UI)](assets/en/05-new-website.png)

## Site detail overview and tool cards

Clicking **Yönet** (Manage) opens `/websites/<id>` with symmetric tool cards organized in two groups:

- **Sık kullanılan araçlar** (Frequently used): Dosya Yöneticisi (File Manager), Veritabanları (Databases), Site Kaynakları (Site Resources), SSL/TLS Sertifikaları (SSL/TLS Certificates), E-posta (Mail), Yedekleme ve Geri Yükleme (Backup & Restore), WordPress.
- **Geliştirici ve sunucu araçları** (Developer & server tools): Web Sunucusu & Nginx, Alan Adları & Yönlendirme (Domains & Redirects), DNS, PHP Ayarları (PHP Settings), Git / Yayınlama (Git / Deploy), Günlükler (Logs), İstatistikler (Statistics), Zamanlanmış Görevler (Cron), Erişim Hesapları (SFTP/SSH Access), Terminal.

![YunPanel site detail overview and tool cards (Turkish UI)](assets/en/06-site-overview.png)

From the site view, you can also suspend a website or remove it with guarded cleanup tracking.

## Role model and access boundaries

YunPanel uses a streamlined, strictly isolated role hierarchy:

| Role | Scope | Edition requirement |
| :--- | :--- | :--- |
| **Sunucu Yöneticisi (Owner)** | Full server, service, DNS, firewall, license, and account control. | Included in Free (single Owner with unlimited sites, site terminal, and SFTP). |
| **Bayi (Reseller)** | Manages own customers and their assigned sites within configured customer/site count limits. | Requires YunPanel Premium. |
| **Müşteri (Customer)** | Manages assigned websites, files, databases, and resource quotas. | Requires YunPanel Premium. |
| **Site Yöneticisi (`site_manager`)** | Manages only explicitly assigned websites; blocked from other sites and the Owner root terminal. | Requires YunPanel Premium. |
| **Salt Okunur (`read_only`)** | Read-only visibility across permitted inventory views without mutation rights. | Additional panel login requires YunPanel Premium. |

Each website keeps its own dedicated Unix user for runtime, cron, files, SFTP, and site terminal; multiple sites under a Customer or Reseller are never merged onto one Unix user.

![YunPanel Users and Roles screen (Turkish UI)](assets/en/07-users-and-roles.png)

## Related guides

- Domain routing, DNS zones, and HTTPS certificates: [Domains, DNS, and SSL](doc:domains-and-ssl)
- Free vs. Premium role boundaries: [Licensing and Three-Month Premium](doc:licensing-and-premium)
