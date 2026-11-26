# Domains, DNS, and SSL

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

YunPanel manages domain lifecycle, authoritative and external DNS zones, Let's Encrypt SSL/TLS certificates, and Nginx web server settings directly in site context.

## Domains, subdomains, redirects, and Nginx settings

- **Primary domains, subdomains, and aliases:** Attach subdomains under a parent domain, add domain aliases, and control `www` redirect behavior.
- **Forwarding / redirect domains:** Configure `301` or `302` HTTP redirect domains (with optional path preservation) without provisioning local hosting content.
- **Web Sunucusu & Nginx (`/websites/<id>/hosting`):** Configure CORS headers, security headers, immutable static caching presets, sub-path reverse proxy rules (such as `/api`), and framework presets for Next.js, Astro, Vite, Nuxt, Remix, Node.js, and Python.
- **Gelişmiş alan adı araçları (`/domains`):** Server-wide domain and certificate inventory accessible from **Araçlar ve Ayarlar** (Tools & Settings).

## DNS management

The site **DNS** tab (`/websites/<id>/dns`) and **Ayarlar → DNS ve SSL** (`/settings?section=dns`) support two DNS operating modes:

1. **Local Authoritative DNS (PowerDNS):** Once the server DNS identity (IPv4/IPv6, `ns1`/`ns2`, SOA, and optional secondary DNS AXFR/NOTIFY targets) is configured, YunPanel creates and manages local authoritative zones with A, AAAA, CNAME, MX, TXT, CAA, SRV records, and DNSSEC controls.
2. **External DNS (Cloudflare API or manual provider):** When a domain's DNS is hosted externally, the panel clearly indicates that no local PowerDNS zone exists and supports Cloudflare DNS API integration for DNS-01 challenges and record management.

![YunPanel site DNS management screen (Turkish UI)](assets/en/09-site-dns.png)

## SSL/TLS certificates and automated renewal

Open **SSL/TLS Sertifikaları** (`/websites/<id>/ssl`) on any site to issue and renew Let's Encrypt certificates:

- **Coverage options:** Protect the root domain, `www`, `webmail`, and `mail` subdomains, assign the certificate to Postfix/Dovecot TLS SNI, or issue wildcard (`*.domain`) certificates via Cloudflare DNS-01.
- **ACME validation pre-check:** Use **ACME doğrulamasını test et** (Test ACME verification) before issuing a live certificate.
- **Automatic renewal scheduler:** Checks certificates every 6 hours by default (`YUNPANEL_CERTIFICATE_RENEWAL_INTERVAL_MS`) and renews certificates within 30 days of expiration (`YUNPANEL_CERTIFICATE_RENEW_BEFORE_MS`).
- **Central alerts:** The bell icon in the top bar opens **Bildirim ve Görev Merkezi** (Notification and Task Center). Its **Bildirimler** (Notifications) tab lists missing or expiring SSL certificates.

![YunPanel site SSL/TLS certificate management screen (Turkish UI)](assets/en/08-site-ssl.png)

## Related guides

- Adding domains and subdomains: [Basic Site and Role Operations](doc:sites-and-roles)
- Mail DKIM/SPF/DMARC diagnostics: [Mail Management](doc:mail)
