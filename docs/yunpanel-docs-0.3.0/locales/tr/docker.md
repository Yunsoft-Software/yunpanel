# Docker ve Compose Yönetimi

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel, sol menüdeki **Uygulama Marketi** ve **Araçlar ve Ayarlar → Docker ve Stack Yönetimi** (`/docker`) üzerinden konteyner, Docker Compose yığını (stack), kalıcı hacim (volume) ve Nginx ters vekil (reverse proxy) port bağlama işlemlerini yönetir.

## Compose projeleri ve YAML yönetimi

**Compose / Stack Ekle** penceresinden yeni bir proje oluşturmanın üç yolu vardır:

1. **Doğrudan YAML editörü:** `compose.yml` içeriğini editöre yapıştırıp doğrulayabilirsiniz.
2. **Site veya alt alan adı dizininden dosya seçme:** Barındırılan bir sitenin çalışma klasöründeki Compose dosyasını bağlayabilirsiniz.
3. **`.yml` dosyası yükleme:** Yerel bilgisayarınızdan Compose yapılandırmasını yükleyip düzenleyebilirsiniz.

Mevcut projelerin Compose YAML içeriği düzenlenebilir olarak görüntülenir; şifreli ortam değişkenleri (`YUNPANEL_SECRET_MASTER_KEY` ile korunur), özel kayıt defteri (registry) kimlik bilgileri, konteyner günlükleri, konsol ve yaşam döngüsü (start/stop/redeploy) geçmişi aynı proje ekranından takip edilir.

## İç ↔ Dış port eşlemesi ve alan adına bağlama

Her Docker servisi için konteyner iç portu (**Inner Port**) ile yerel sunucu dış portu (**Outer Port**, `127.0.0.1:<port>`) eşlenir:

- **Subdomain'e Docker Bağla** veya site içi **Web Sunucusu & Nginx** ayarlarından bir Docker yığınını ana alan adına, alt alan adına veya belirli bir alt URL yoluna (`/api` gibi) ters vekil olarak bağlayabilirsiniz.
- Kalıcı disk hacimlerinin (**Depolama / Volumes**) silinmesi tek hacim adına açık onay gerektirir ve veri kaybı uyarısı gösterir.

## Uygulama Marketi (Hazır Uygulamalar)

**/docker** sayfasının alt bölümündeki **Uygulama Marketi** kategorilere ayrılmış 14 hazır şablon ve canlı **Docker Hub** imaj araması sunar:

- **JAMstack & BaaS / Headless CMS:** PocketBase, Directus, Strapi, Ghost, Meilisearch, WordPress + MariaDB Stack.
- **Otomasyon & AI:** n8n Workflow Automation, Open WebUI.
- **İzleme & Analitik:** Umami Web Analytics, Uptime Kuma, Grafana.
- **Veritabanı, Cache & Depolama:** PostgreSQL 16, Redis 7, MinIO S3 Storage.

Her hazır şablon otomatik gizli anahtar üretimi, kalıcı volume tanımı ve Inner ↔ Outer port eşlemesiyle tek tıkla kuruluma hazırdır.

![Docker, Compose Stack ve Uygulama Marketi ekranı](assets/tr/12-docker-compose.png)

## İlgili kılavuzlar

- Alan adı ve alt yol Nginx proxy kuralları için [Alan Adı, DNS ve SSL](doc:domains-and-ssl)
- Site içi dosya ve klasör yönetimi için [Dosya Yönetimi](doc:files)
