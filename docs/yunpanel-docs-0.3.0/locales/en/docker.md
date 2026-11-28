# Docker and Compose Management

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

YunPanel manages standalone containers, Docker Compose stacks, persistent volumes, and Nginx reverse proxy bindings from **Uygulama Marketi** (Application Catalog) and **Araçlar ve Ayarlar → Docker ve Stack Yönetimi** (`/docker`).

## Compose stacks and editable YAML

Click **Compose projesi ekle** (Add Compose project) to deploy a stack in three ways:

1. **Inline YAML editor:** Paste and validate a `compose.yml` definition directly.
2. **Select from a website or subdomain directory:** Bind an existing Compose file inside a hosted site workspace.
3. **Upload `.yml` file:** Upload a local Compose configuration and edit it directly in the panel.

Existing projects expose their editable Compose YAML, encrypted environment variables (protected by `YUNPANEL_SECRET_MASTER_KEY`), and private registry credentials. The same project screen shows **Konteyner günlükleri** (Container logs), the container console, **Proje işlemleri** (Project actions: build, pull images, start, stop, restart, remove project), and **Dağıtım ve çalıştırma geçmişi** (Deployment and run history).

## Container and server port mapping and reverse proxy binding

Each Docker workload maps a **Konteyner portu** (Container port) to a loopback **Sunucu portu** (Server port, `127.0.0.1:<port>`):

- Use **Subdomain'e Docker Bağla** (Bind Docker to Subdomain) or a site's **Web Sunucusu & Nginx** panel to proxy a root domain, subdomain, or sub-path (such as `/api`) to a Docker stack.
- The **Depolama** (Storage) section lists each service's persistent volumes and directory mounts. In **Kalıcı volume yönetimi** (Persistent volume management) you can delete one volume that belongs only to this project and is not attached to any container. Deletion needs explicit confirmation and shows a permanent data loss warning.
- The **Projeyi kaldır** (Remove project) preview lists the project's named volumes. The default is **Volume'ları koru** (Keep volumes), which leaves them on the server. With **Volume'ları da sil** (Also delete volumes), only volumes that belong to this project and no other project are deleted in the same confirmed operation. The choice is part of the confirmation text; changing it refreshes the preview.

## Application Catalog (Ready-to-Deploy Apps)

The **Uygulama Marketi** section on `/docker` includes 14 pre-configured templates plus live **Docker Hub** image search:

- **JAMstack, BaaS & Headless CMS:** PocketBase, Directus, Strapi, Ghost, Meilisearch, WordPress + MariaDB Stack.
- **Automation & AI:** n8n Workflow Automation, Open WebUI.
- **Monitoring & Analytics:** Umami Web Analytics, Uptime Kuma, Grafana.
- **Databases, Cache & Storage:** PostgreSQL 16, Redis 7, MinIO S3 Storage.

Templates automatically generate required secrets, define persistent volumes, and pre-wire container ↔ server loopback port mappings.

![YunPanel Docker and Compose Management screen with the Application Catalog (Turkish UI)](assets/en/12-docker-compose.png)

## Related guides

- Domain and sub-path Nginx proxy rules: [Domains, DNS, and SSL](doc:domains-and-ssl)
- Managing site workspace files: [File Management](doc:files)
