# Docker ve Compose Yönetimi

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `c1a84a51` (`c1a84a5159add2f2f87fd6e21725f7c657cf98ec`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel, sol menüdeki **Uygulama Marketi** ve **Araçlar ve Ayarlar → Docker ve Stack Yönetimi** (`/docker`) üzerinden konteyner, Docker Compose yığını (stack), kalıcı hacim (volume) ve Nginx ters vekil (reverse proxy) port bağlama işlemlerini yönetir.

## Compose projeleri ve YAML yönetimi

**Compose projesi ekle** penceresinden yeni bir proje oluşturmanın üç yolu vardır:

1. **Doğrudan YAML editörü:** `compose.yml` içeriğini editöre yapıştırıp doğrulayabilirsiniz.
2. **Site veya alt alan adı dizininden dosya seçme:** Barındırılan bir sitenin çalışma klasöründeki Compose dosyasını bağlayabilirsiniz.
3. **`.yml` dosyası yükleme:** Yerel bilgisayarınızdan Compose yapılandırmasını yükleyip düzenleyebilirsiniz.

Mevcut projelerin Compose YAML içeriği düzenlenebilir olarak görüntülenir; şifreli ortam değişkenleri (`YUNPANEL_SECRET_MASTER_KEY` ile korunur), özel kayıt defteri (registry) kimlik bilgileri, **Konteyner günlükleri**, konteyner konsolu, **Proje işlemleri** (Derle, İmajları indir, Başlat, Durdur, Yeniden başlat, Projeyi kaldır) ve **Dağıtım ve çalıştırma geçmişi** aynı proje ekranındadır.

## Konteyner ve sunucu portu eşlemesi, alan adına bağlama

Her Docker servisi için **Konteyner portu** ile yerel **Sunucu portu** (`127.0.0.1:<port>`) eşlenir:

- **Subdomain'e Docker Bağla** veya site içi **Web Sunucusu & Nginx** ayarlarından bir Docker yığınını ana alan adına, alt alan adına veya belirli bir alt URL yoluna (`/api` gibi) ters vekil olarak bağlayabilirsiniz.
- **Depolama** bölümü servislerin kalıcı disk (volume) ve dizin bağlantılarını gösterir. **Kalıcı volume yönetimi** bölümünden yalnız bu projeye ait ve hiçbir konteynere bağlı olmayan tek bir volume silinebilir. Silme açık onay ister ve veri kaybı uyarısı gösterir.
- **Projeyi kaldır** önizlemesi projenin adlı volume'larını listeler. Varsayılan seçim **Volume'ları koru**'dur; volume'lar sunucuda kalır. **Volume'ları da sil** seçilirse yalnız bu projeye ait, başka projenin kullanmadığı volume'lar aynı onaylı işlemde silinir. Seçim onay metnine girer; seçim değişince önizleme yenilenir.

## Uygulama Marketi (Hazır Uygulamalar)

**/docker** sayfasının alt bölümündeki **Uygulama Marketi** kategorilere ayrılmış 14 hazır şablon ve canlı **Docker Hub** imaj araması sunar:

- **JAMstack & BaaS / Headless CMS:** PocketBase, Directus, Strapi, Ghost, Meilisearch, WordPress + MariaDB Stack.
- **Otomasyon & AI:** n8n Workflow Automation, Open WebUI.
- **İzleme & Analitik:** Umami Web Analytics, Uptime Kuma, Grafana.
- **Veritabanı, Cache & Depolama:** PostgreSQL 16, Redis 7, MinIO S3 Storage.

Her hazır şablon otomatik gizli anahtar üretimi, kalıcı volume tanımı ve konteyner ↔ sunucu port eşlemesiyle tek tıkla kuruluma hazırdır.

![Docker ve Compose Yönetimi ile Uygulama Marketi ekranı](assets/tr/12-docker-compose.png)

## İlgili kılavuzlar

- Alan adı ve alt yol Nginx proxy kuralları için [Alan Adı, DNS ve SSL](doc:domains-and-ssl)
- Site içi dosya ve klasör yönetimi için [Dosya Yönetimi](doc:files)
