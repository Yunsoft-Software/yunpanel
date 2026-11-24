# Docker and Compose Management

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

YunPanel manages standalone containers, Docker Compose stacks, persistent volumes, and Nginx reverse proxy bindings from **Uygulama Marketi** (Application Catalog) and **Araçlar ve Ayarlar → Docker ve Stack Yönetimi** (`/docker`).

## Compose stacks and editable YAML

Click **Compose / Stack Ekle** (Add Compose / Stack) to deploy a stack in three ways:

1. **Inline YAML editor:** Paste and validate a `compose.yml` definition directly.
2. **Select from a website or subdomain directory:** Bind an existing Compose file inside a hosted site workspace.
3. **Upload `.yml` file:** Upload a local Compose configuration and edit it directly in the panel.

Existing projects expose their editable Compose YAML, encrypted environment variables (protected by `YUNPANEL_SECRET_MASTER_KEY`), private registry credentials, container logs, container console, and lifecycle history (start, stop, redeploy).

## Inner ↔ Outer port mapping and reverse proxy binding

Each Docker workload maps a container **Inner Port** to a loopback host **Outer Port** (`127.0.0.1:<port>`):

- Use **Subdomain'e Docker Bağla** (Bind Docker to Subdomain) or a site's **Web Sunucusu & Nginx** panel to proxy a root domain, subdomain, or sub-path (such as `/api`) to a Docker stack.
- Removing a persistent volume (**Depolama / Volumes**) requires explicit single-volume confirmation with a permanent data loss warning.

## Application Catalog (Ready-to-Deploy Apps)

The **Uygulama Marketi** section on `/docker` includes 14 pre-configured templates plus live **Docker Hub** image search:

- **JAMstack, BaaS & Headless CMS:** PocketBase, Directus, Strapi, Ghost, Meilisearch, WordPress + MariaDB Stack.
- **Automation & AI:** n8n Workflow Automation, Open WebUI.
- **Monitoring & Analytics:** Umami Web Analytics, Uptime Kuma, Grafana.
- **Databases, Cache & Storage:** PostgreSQL 16, Redis 7, MinIO S3 Storage.

Templates automatically generate required secrets, define persistent volumes, and pre-wire Inner ↔ Outer loopback port mappings.

![YunPanel Docker, Compose Stack, and Application Catalog screen (Turkish UI)](assets/en/12-docker-compose.png)

## Related guides

- Domain and sub-path Nginx proxy rules: [Domains, DNS, and SSL](doc:domains-and-ssl)
- Managing site workspace files: [File Management](doc:files)
