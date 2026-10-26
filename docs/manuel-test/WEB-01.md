# WEB-01 — Domain ekleme ve amaca göre site oluşturma sihirbazı

- **Grup:** 04 · Siteler ve domainler
- **Tarih:** 2026-10-27
- **Ajan:** AGENT_3
- **Panel sürümü:** `0.3.0` (`8f44b2a9`)
- **Sonuç:** KISMİ

## Özet
Gerçek `.28` (`https://server.cryptoraichu.website`) sunucusunda 3 adımlı site oluşturma sihirbazı (`/websites/new`) ve bayi müşteri site tahsis akışı (`/customers`) tarayıcı üzerinden uçtan uca test edildi. Bağımsız kök alan adı (`PHP-FPM` + `www` alias + otomatik MariaDB veritabanı + yerel PowerDNS zone), alt alan adı (`sub.tweb01-a3-php.webrich.news`), mevcut Website paylaşımı (`shared_website`) ve Owner tarafından müşteriye site açma (`/websites/new?customer=<id>`) akışları fiziksel sunucuda (Nginx vhost, PHP-FPM soketi, PowerDNS zone, MariaDB şeması ve `curl` HTTP `200`) doğrulandı. Buna karşın alt alan adı dosya kökünün UI'da `/var/www/vhosts/<domain>/subdomains/<sub>` gösterilmesine rağmen fiziksel sunucuda ayrı üst dizinde (`/var/www/yunpanel/apps/<appId>/current`) açıldığı, bayi hesabıyla `/customers` ekranındaki `Site tahsis et` (`AllocateSiteDialog`) penceresinin `servers` koleksiyonu kapalı olduğu için kalıcı olarak kilitli kaldığı, `Docker / Compose Proxy` hazır ayarının varsayılan `'easypanel-stack'` kimliğiyle `400 site_create_invalid_id` hatası verdiği, önizleme hatalarının (`409`/`400`) genel bir mesajla maskelendiği ve sihirbazla oluşturulan sitelerin panelden silinmesinin (`Siteyi sil…`) `001:domain_removal` adımında `domain_removal_not_ready` (`dns_zone_parent_ds_unverifiable` / `database_binding_dependencies_present`) nedeniyle bloke olduğu tespit edildi.

## Senaryolar

### S01 — Kök alan adı (Root Domain) + PHP-FPM hazır ayarı + www alias + otomatik MariaDB veritabanı oluşturma (Mutlu Yol)
- **Adımlar:**
  1. Owner (`yunsoft-owner`) ile giriş yapılıp `/websites` sayfasındaki `"Web sitesi ekle"` butonuna tıklandı (`/websites/new`).
  2. **Adım 1 (Alan Adı ve Hiyerarşi):** `Bağımsız alan adı (Root Domain)` seçildi, `Alan adı (Primary domain)` alanına `tweb01-a3-php.webrich.news` yazıldı, `www davranışı` olarak `"www aynı siteye alias olsun"` seçildi ve `"Devam et"` butonuna basıldı.
  3. **Adım 2 (Çalışma Türü ve Kaynak):** `PHP-FPM / WordPress / Laravel` hazır ayar kartına tıklandı (`siteKind=php_app`, `sourceMode=upload`, `phpVersion=8.3`, `documentRoot=public`), `"Bu site için otomatik veritabanı oluştur"` kutusu işaretlendi (`databaseEngine=mariadb`), `"Devam et"` butonuna basıldı.
  4. **Adım 3 (DNS, SSL ve Onay):** DNS yönetimi `"Bu sunucuda yönet"` (`authoritative`), HTTPS `"Şimdilik HTTP"`, Site giriş hesabı `"Oluşturma (Owner üzerinden yönet)"` bırakılıp `"Web sitesi oluştur"` butonuna basıldı.
- **Beklenen:** `POST /api/panel/sites/create-preview` (`200`) ve `POST /api/panel/sites` (`201`) çağrılarının ardından kurulum adımlarının tamamlanması; Nginx vhost, PHP-FPM havuzu, PowerDNS zone ve MariaDB veritabanının fiziksel sunucuda oluşması; `http://tweb01-a3-php.webrich.news` ve `http://www.tweb01-a3-php.webrich.news` adreslerinin HTTP `200` dönmesi.
- **Gözlenen:**
  - `POST /api/panel/sites/create-preview` → `200 OK`
  - `POST /api/panel/sites` → `201 Created` (`operationId: site-create-bfcaad46-a47d-4dc0-acbb-ba21c9bb01f7`, `websiteId: 7a445a53-62f3-520f-b79d-3cbd3015f9b3`, `domainId: 43a3b60c-85b5-5dd1-af4a-2883b03b4af9`, `applicationId: 343a65e3-5d8e-53a6-853c-030cf372b37f`).
  - 12 kurulum adımının tamamı `Tamamlandı` durumuna geçti; ancak adım listesinde `application_metadata`, `website_metadata`, `primary_domain_metadata`, `database`, `domain_activation` anahtarları çevrilmeden ham snake_case olarak göründü.
  - Fiziksel sunucu doğrulaması (`.28` SSH):
    - Nginx vhost `/etc/nginx/sites-enabled/yunpanel-tweb01-a3-php.webrich.news.conf` oluştu (`server_name tweb01-a3-php.webrich.news www.tweb01-a3-php.webrich.news;`, `root /var/lib/yunpanel/apps/343a65e3-5d8e-53a6-853c-030cf372b37f/current/public;`, `fastcgi_pass unix:/run/php/yunpanel-yunapp-95b119dd71d4.sock;`).
    - `curl -s -o /dev/null -w "%{http_code}" -H "Host: tweb01-a3-php.webrich.news" http://127.0.0.1/` → `200` (`<h1>Website ready</h1>`), `Host: www.tweb01-a3-php.webrich.news` → `200`.
    - PowerDNS üzerinde `tweb01-a3-php.webrich.news` zone kaydı (`A 157.180.11.28`, `NS`, `SOA`, `www CNAME`) oluştu.
    - MariaDB üzerinde `yp_14830486339821b4b8cbe29fda7e7808` veritabanı oluştu ve site `/websites/43a3b60c-85b5-5dd1-af4a-2883b03b4af9/databases` ekranında `active` olarak listelendi.
- **Kanıt:** `.local/manuel-test/WEB-01/01-websites-list-initial.png`, `.local/manuel-test/WEB-01/02-wizard-step1-initial.png`, `.local/manuel-test/WEB-01/03-s01-step1-filled.png`, `.local/manuel-test/WEB-01/04-s01-step2-php-db.png`, `.local/manuel-test/WEB-01/05-s01-step3-summary.png`, `.local/manuel-test/WEB-01/06-s01-created-result.png`, `.local/manuel-test/WEB-01/07-s01-site-overview.png`, `.local/manuel-test/WEB-01/08-s01-site-databases.png`.
- **Durum:** GEÇTİ (Kozmetik adım etiketi eksikliği H7 ile kayıtlı)

### S02 — Alt alan adı (Subdomain) oluşturma ve ortak domain içi dosya kökü kontrolü
- **Adımlar:**
  1. `/websites/new` ekranında **Adım 1**: `Alt alan adı (Subdomain)` kutusu seçildi, `Üst alan adı (Parent domain)` olarak `tweb01-a3-php.webrich.news` (`43a3b60c-85b5-5dd1-af4a-2883b03b4af9`) seçildi, `Alan adı` alanına `sub.tweb01-a3-php.webrich.news` yazıldı, `www davranışı` `"www ekleme"` seçildi ve `"Devam et"` butonuna basıldı.
  2. **Adım 2:** `Site türü` olarak `Statik site`, `Uygulama kaynağı` olarak `Panelden dosya yükleme` seçildi, `"Devam et"` butonuna basıldı.
  3. **Adım 3:** Özet kartında `Dosya dizini` kontrol edilip `"Web sitesi oluştur"` butonuna basıldı.
- **Beklenen:** `agents.md` (24 Ekim 2026 §2) kuralı gereği alt alan adının ana domainden kopuk ayrı bir üst dosya kökü olmaması; UI'da gösterildiği gibi ana domainin çalışma dizini altında ortak dosya kökünde açılması ve ana domainin Dosya Yöneticisi içinden erişilebilir olması.
- **Gözlenen:**
  - UI Adım 1'de `Ortak Domain İçi Dosya Kökü: /var/www/vhosts/tweb01-a3-php.webrich.news/subdomains/sub` rozeti ve Adım 3 özetinde `Dosya dizini: /var/www/vhosts/tweb01-a3-php.webrich.news/subdomains/sub` gösterildi.
  - `POST /api/panel/sites` → `201 Created` (`domainId: f5e350bd-8d07-5701-b945-a084fdc3be4d`, `websiteId: 1dac24b4-2820-506a-84d6-7266c99bd762`, `applicationId: 382d93fe-e155-5928-9c9c-6a45b4a7fda1`), HTTP `200` döndü.
  - **Ancak fiziksel sunucuda (`.28`):** `new-website-form.js` `siteCreateInputFromForm` fonksiyonu `sharedFileRoot` değerini arka uca hiç göndermediği ve `apps/api/src/site-create-base.js` her siteyi bağımsız uygulama dizininde açtığı için, alt alan adı `/var/www/yunpanel/apps/382d93fe-e155-5928-9c9c-6a45b4a7fda1/current` altında ve ayrı bir Unix kullanıcısıyla (`yunapp-2ecbe5e969db`) oluşturuldu. Sunucuda `/var/www/vhosts/tweb01-a3-php.webrich.news/subdomains/sub` dizini mevcut değil (`No such file or directory`). Ana domainin Dosya Yöneticisi (`/websites/43a3b60c-85b5-5dd1-af4a-2883b03b4af9/files`) içinden alt alan adı klasörüne erişilemiyor.
- **Kanıt:** `.local/manuel-test/WEB-01/09-s02-step1-subdomain.png`, `.local/manuel-test/WEB-01/10-s02-step2-static.png`, `.local/manuel-test/WEB-01/11-s02-step3-summary.png`, `.local/manuel-test/WEB-01/12-s02-subdomain-created.png`, `.local/manuel-test/WEB-01/13-websites-tree-hierarchy.png`, SSH `ls -ld /var/www/vhosts/tweb01-a3-php.webrich.news/subdomains/sub` → `No such file or directory`.
- **Durum:** KALDI (H3)

### S03 — JAMstack / Framework hazır ayarları (`docker_stack` dahil) ve Mevcut Website'i paylaş (`shared_website`)
- **Adımlar:**
  1. `/websites/new` Adım 1'de `tweb01-a3-shared.webrich.news` girilip Adım 2'ye geçildi.
  2. Adım 2'deki 9 hazır ayar kartı (`Next.js (SSR / Hybrid)`, `Astro (Static / Islands)`, `Vite / React / Vue SPA`, `Nuxt 3 (Nitro SSR)`, `Remix (Full-Stack)`, `Node.js / Express / Fastify API`, `Python (FastAPI / Django / Flask)`, `Docker / Compose Proxy`, `PHP-FPM / WordPress / Laravel`) sırayla tıklandı.
  3. `Docker / Compose Proxy` (`docker_stack`) seçili iken (`Docker Compose proje kimliği` alanı `required` olmadığı için boş bırakılarak) Adım 3'e geçilip `"Web sitesi oluştur"` butonuna basıldı.
  4. Ardından Adım 2'ye dönülüp `Uygulama kaynağı` olarak `"Mevcut Website'i paylaş"` (`shared_website`) ve hedef olarak `tweb01-a3-php.webrich.news — PHP (8.3)` seçildi, Adım 3'te `"Alan adını ekle"` butonuna basıldı ve açılan onay penceresinde `"Alan adını bağla"` onaylandı.
- **Beklenen:**
  - Tüm hazır ayar kartlarının formu doğru doldurması; `Docker / Compose Proxy` seçildiğinde ya geçerli bir Compose projesi seçtirmesi/oluşturması ya da alanda doğrulama yapması.
  - `Mevcut Website'i paylaş` akışının yeni alan adını mevcut Website'e bağlayıp yayına hazır hale getirmesi.
- **Gözlenen:**
  - 9 hazır ayar kartının tamamı `aria-pressed="true"` durumuna geçti ve form alanlarını güncelledi.
  - **Kırık akış (`docker_stack`):** `Docker Compose proje kimliği` alanı `sourceMode === 'docker_compose'` iken `required` olmadığı için Adım 2'den Adım 3'e boş geçilebildi; `new-website-form.js` satır 304 boş alanı `'easypanel-stack'` olarak doldurdu ve `POST /api/panel/sites/create-preview` `400 Bad Request` (`code: "site_create_invalid_id"`, `message: "projectId must be a UUID"`) döndü. UI ise gerçek hatayı gizleyip `"Önizleme doğrulanamadı. Formu ve güncel site bilgilerini kontrol edip tekrar deneyin."` mesajını gösterdi.
  - **`Mevcut Website'i paylaş` (`shared_website`):** Onay penceresi (`share-site:tweb01-a3-shared.webrich.news:7a445a53-62f3-520f-b79d-3cbd3015f9b3`) açıldı ve `POST /api/panel/domains` → `201 Created` (`id: c8da3e5a-addd-4366-9d1f-80f440b83729`) ile alan adı mevcut Website'e bağlandı. Ancak sihirbaz `stage`/`apply` çağrısı yapmadığı için alan adı `state: "draft"` (`Henüz yayınlanmadı`) durumunda kaldı ve bu nedenle `GET /api/panel/domains/c8da3e5a-addd-4366-9d1f-80f440b83729/removal` çağrısı `409 domain_removal_domain_not_stable` hatası verdi.
- **Kanıt:** `.local/manuel-test/WEB-01/14-s03-preset-docker-stack.png`, `.local/manuel-test/WEB-01/15-s03-docker-stack-invalid-id.png`, `.local/manuel-test/WEB-01/16-s03-shared-website-step2.png`, `.local/manuel-test/WEB-01/17-s03-shared-confirm-modal.png`, `.local/manuel-test/WEB-01/18-s03-shared-domain-created.png`.
- **Durum:** KISMİ (H4, H5, H6)

### S04 — Sınır değerler ve hatalı girdiler (Geçersiz alan adı, mükerrer alan adı `409`, HTTP + yerel e-posta `409`)
- **Adımlar:**
  1. **S04a (Geçersiz alan adı):** `/websites/new` Adım 1'de `Alan adı` alanına noktasız `gecersiz_alan_adi` yazılıp `"Devam et"` butonuna basıldı.
  2. **S04b (Mükerrer alan adı):** Adım 1'de sistemde zaten kayıtlı olan `webrich.news` yazılıp Adım 3'te `"Web sitesi oluştur"` butonuna basıldı.
  3. **S04c (HTTP + yerel e-posta çelişkisi):** Adım 1'de `tweb01-a3-mailerr.webrich.news` yazılıp Adım 3'te `HTTPS: Şimdilik HTTP` ve `E-posta: Bu sunucuda yerel e-posta` seçilerek `"Web sitesi oluştur"` butonuna basıldı.
- **Beklenen:**
  - Geçersiz alan adının Adım 1'den Adım 2'ye geçişi engellemesi.
  - Mükerrer alan adı (`409 site_create_domain_conflict`) ve HTTP + yerel e-posta (`409 site_create_local_mail_https_required`) hatalarında kullanıcıya hangi alanın neden reddedildiğini açıkça belirten Türkçe hata mesajı gösterilmesi.
- **Gözlenen:**
  - **S04a:** `gecersiz_alan_adi` Adım 1'de engellenmedi; Adım 2 ve Adım 3'e kadar ilerlenebildi, yalnızca Adım 3'te gönderildiğinde istemci tarafında `"Geçerli bir birincil alan adı girin."` hatası çıktı.
  - **S04b:** `POST /api/panel/sites/create-preview` arka uçta `409 Conflict` (`code: "site_create_domain_conflict"`, `message: "webrich.news is already registered"`) döndü; fakat `site-create-submission.js` satır 178 bu hatayı yutup kullanıcıya yalnızca genel `"Önizleme doğrulanamadı. Formu ve güncel site bilgilerini kontrol edip tekrar deneyin."` mesajını gösterdi.
  - **S04c:** `POST /api/panel/sites/create-preview` arka uçta `409 Conflict` (`code: "site_create_local_mail_https_required"`, `message: "Local mail requires managed HTTPS"`) döndü; fakat UI yine aynı genel `"Önizleme doğrulanamadı. Formu ve güncel site bilgilerini kontrol edip tekrar deneyin."` mesajını gösterdi.
- **Kanıt:** `.local/manuel-test/WEB-01/19-s04a-invalid-domain.png`, `.local/manuel-test/WEB-01/20-s04b-duplicate-domain-409.png`, `.local/manuel-test/WEB-01/21-s04c-http-local-mail-409.png`.
- **Durum:** KALDI (H5)

### S05 — Yetki sınırları (Owner müşteri adına site açma, Reseller site tahsisi ve Customer izolasyonu)
- **Adımlar:**
  1. **S05a (Owner → Müşteri adına site açma):** `/users` ekranında `tweb01-a3-cust` (Doğrudan Owner müşterisi) ve `tweb01-a3-res` (Bayi, limit: 10 müşteri / 25 site) oluşturuldu. Owner `/customers` ekranında `tweb01-a3-cust` satırındaki `"Site aç"` bağlantısına tıklayarak `/websites/new?customer=ef5564d8-39aa-474b-9e69-f749c469af39` sayfasına gitti ve `tweb01-a3-custsite.webrich.news` sitesini oluşturdu.
  2. **S05b (Reseller → Müşteri oluşturma ve `Site tahsis et`):** `tweb01-a3-res` bayi hesabıyla giriş yapıldı, `/customers` (`Müşterilerim`) sayfasında `"Yeni müşteri ekle"` ile `tweb01-a3-rcust` oluşturuldu (`201 Created`). Ardından `tweb01-a3-rcust` satırındaki `"Site tahsis et"` butonuna tıklandı.
  3. **S05c (Customer → Yetki ve izolasyon kontrolü):** `tweb01-a3-cust` müşteri hesabıyla giriş yapıldı; `/websites` listesi, `"Web sitesi ekle"` butonu varlığı ve doğrudan `/websites/new` adresine erişim kontrol edildi.
- **Beklenen:**
  - Owner'ın müşteri adına site açabilmesi (`POST /api/panel/sites/hosted`).
  - Bayinin `/customers` ekranından kendi müşterisine site tahsis edebilmesi.
  - Müşterinin yalnız kendi sitesini (`tweb01-a3-custsite.webrich.news`) görmesi, diğer siteleri (`tweb01-a3-php.webrich.news`) görmemesi ve yeni site oluşturamaması.
- **Gözlenen:**
  - **S05a (GEÇTİ):** `/websites/new?customer=ef5564d8-39aa-474b-9e69-f749c469af39` sayfasında `Müşteri: tweb01-a3-cust` bilgisi göründü; `POST /api/panel/sites/hosted/create-preview` (`200`) ve `POST /api/panel/sites/hosted` (`201`) ile `tweb01-a3-custsite.webrich.news` başarıyla oluşturuldu.
  - **S05b (KALDI — KRİTİK):** Bayi hesabıyla `/customers` sayfasında `"Site tahsis et"` (`AllocateSiteDialog`) açıldığında, modal içindeki `<fieldset>` kalıcı olarak devre dışı (`disabled`) kaldı ve üstte `"Yerel sunucu bilgisi yükleniyor…"` mesajı takılı kaldı (`Ana alan adı` input'u `disabled=true`, `"Planı Önizle"` butonu `disabled=true`). Kök neden: `apps/web/src/workspace/workspace-resources.js` içinde `/customers` rotası `'servers'` koleksiyonunu etkinleştirmediği için (`useCollection('/servers', { enabled: false })`) `servers.items` her zaman `[]` ve `serverId = null` kalıyor. Ayrıca `ResellerCustomersPage.jsx` satır 332–344'teki `handlePreview` fonksiyonu `{ displayName, aliases, dnsMode, mailMode, source: { kind } }` gönderiyor; oysa arka uç `site-create-base.js` `normalizeInput` yalnızca `{ name, dns, mail, ... }` alanlarını kabul ediyor.
  - **S05c (GEÇTİ):** `tweb01-a3-cust` giriş yaptığında `/websites` ekranında yalnızca `tweb01-a3-custsite.webrich.news` listelendi (`tweb01-a3-php.webrich.news` görünmedi), `"Web sitesi ekle"` butonu render edilmedi ve doğrudan `/websites/new` adresine gidildiğinde `/websites` sayfasına yönlendirildi.
- **Kanıt:** `.local/manuel-test/WEB-01/22-s05a-owner-customer-site-created.png`, `.local/manuel-test/WEB-01/23-s05b-reseller-allocate-site-disabled.png`, `.local/manuel-test/WEB-01/24-s05c-customer-websites-isolated.png`.
- **Durum:** KISMİ (H1)

### S06 — Oluşturulan test sitelerinin ve kullanıcıların panel akışıyla temizlenmesi
- **Adımlar:**
  1. Owner hesabıyla `/websites/f5e350bd-8d07-5701-b945-a084fdc3be4d/settings` (`sub.tweb01-a3-php.webrich.news`) ve `/websites/5aafb60e-8f4e-56a9-bfbf-f850512ca033/settings` (`tweb01-a3-custsite.webrich.news`) sayfalarına gidilip `"Siteyi sil…"` → onay alanı doldurulup `"Kalıcı silmeyi başlat"` butonuna basıldı.
  2. `/websites/43a3b60c-85b5-5dd1-af4a-2883b03b4af9/settings` (`tweb01-a3-php.webrich.news`) sayfasında `"Siteyi sil…"` denendi.
  3. `/users` sayfasında `tweb01-a3-rcust` ve `tweb01-a3-res` hesaplarının önce `"Bayi / müşteri"` → `"Profili kaldır"` ile profilleri kaldırıldı, ardından `"Sil"` ile kullanıcı hesapları silindi.
- **Beklenen:** Oluşturulan tüm test sitelerinin ve kullanıcıların panelin normal akışıyla silinebilmesi.
- **Gözlenen:**
  - `tweb01-a3-rcust` ve `tweb01-a3-res` kullanıcıları ve bayi/müşteri profilleri panelden tamamen silindi.
  - **Ancak oluşturulan sitelerin silinmesi (`WebsiteRemoval`) 1. adımda (`001:domain_removal`) bloke oldu:**
    - `sub.tweb01-a3-php.webrich.news` (`ws-rem-cf5ccfd3-a986-41ec-be34-6567de446c8e`) ve `tweb01-a3-custsite.webrich.news` (`ws-rem-df34ca76-0471-4095-92e6-38e3d6cb869a`) silme işlemleri `001:domain_removal` adımında `status: "blocked"`, `error.code: "domain_removal_not_ready"` (`"Bağlı alan adı henüz silmeye hazır değil."`) hatasıyla durdu.
    - `GET /api/panel/domains/:id/removal` incelendiğinde, sihirbazın varsayılan `"Bu sunucuda yönet"` (`authoritative`) DNS seçeneğiyle oluşturulan her site için `dns-zone-retirement.js` üst alan adı DS kaydını sorgulayıp `dns_zone_parent_ds_unverifiable` engelini, otomatik veritabanı ile oluşturulan `tweb01-a3-php.webrich.news` için ise `domain-removal-plan.js` ayrıca `database_binding_dependencies_present` engelini `hardBlockers` listesine eklediği ve `confirmation: null` döndürdüğü tespit edildi.
- **Kanıt:** `.local/manuel-test/WEB-01/25-s06-cleanup-websites.png`, `.local/manuel-test/WEB-01/26-s06-users-cleaned.png`, `GET /api/panel/domains/f5e350bd-8d07-5701-b945-a084fdc3be4d/removal` (`hardBlockers: ["dns_zone_parent_ds_unverifiable"]`).
- **Durum:** KALDI (H2)

## Hatalar

| # | Sınıf | Başlık | Dosya / Uç Nokta | Yeniden Üretim | Kanıt |
|---|---|---|---|---|---|
| H1 | KRİTİK | Bayi (Reseller) `/customers` ekranındaki `Site tahsis et` (`AllocateSiteDialog`) penceresi `servers` koleksiyonu kapalı olduğu için kalıcı olarak kilitli ve önizleme payload şeması uyumsuz | `apps/web/src/workspace/ResellerCustomersPage.jsx` (`:287`, `:332-344`, `:367`) · `apps/web/src/workspace/workspace-resources.js` (`:16-30`) · `POST /api/panel/sites/hosted/create-preview` | 1. Bayi hesabıyla giriş yapıp `/customers` sayfasına git. 2. Bir müşterinin satırındaki `"Site tahsis et"` butonuna tıkla. 3. `"Yerel sunucu bilgisi yükleniyor…"` mesajının hiç kaybolmadığını ve tüm form alanları ile `"Planı Önizle"` butonunun `disabled` kaldığını gör. | `.local/manuel-test/WEB-01/23-s05b-reseller-allocate-site-disabled.png` · Bulgular kaydı: `T803` |
| H2 | KRİTİK | Sihirbazla (varsayılan `"Bu sunucuda yönet"` DNS veya otomatik veritabanı ile) oluşturulan sitelerin silinmesi `001:domain_removal` adımında `domain_removal_not_ready` hatasıyla bloke oluyor | `apps/api/src/website-removal-runtime.js` (`:496-502`) · `apps/api/src/domain-removal-plan.js` (`:738-790`) · `apps/api/src/dns-zone-retirement.js` (`:285-286`) · `POST /api/panel/websites/:id/removal` | 1. `/websites/new` sihirbazında varsayılan ayarlarla bir site oluştur. 2. Site ayarlarından (`/websites/:id/settings`) `"Siteyi sil…"` → `"Kalıcı silmeyi başlat"` adımlarını uygula. 3. İşlemin `001:domain_removal` adımında `domain_removal_not_ready` (`hardBlockers: ["dns_zone_parent_ds_unverifiable", "database_binding_dependencies_present"]`) ile `blocked` kaldığını gör. | `.local/manuel-test/WEB-01/25-s06-cleanup-websites.png` · `GET /api/panel/domains/:id/removal` · Bulgular kaydı: `T803` |
| H3 | NORMAL | Alt alan adı (Subdomain) dosya kökü UI'da `/var/www/vhosts/<domain>/subdomains/<sub>` gösterilirken fiziksel sunucuda ayrı üst dizinde (`/var/www/yunpanel/apps/<appId>/current`) açılıyor | `apps/web/src/workspace/NewWebsitePage.jsx` (`:55`, `:138`, `:360`) · `apps/web/src/workspace/new-website-form.js` (`:103-112`, `:289-340`) · `apps/api/src/site-create-base.js` | 1. `/websites/new` Adım 1'de `Alt alan adı (Subdomain)` seçip `sub.tweb01-a3-php.webrich.news` oluştur. 2. UI'da `/var/www/vhosts/tweb01-a3-php.webrich.news/subdomains/sub` yazdığını, fakat sunucuda bu dizinin oluşmadığını ve sitenin ayrı `/var/www/yunpanel/apps/<appId>/current` dizinine kurulduğunu gör. | `.local/manuel-test/WEB-01/09-s02-step1-subdomain.png`, `.local/manuel-test/WEB-01/11-s02-step3-summary.png`, SSH `ls -ld /var/www/vhosts/...` |
| H4 | NORMAL | `Docker / Compose Proxy` (`docker_stack`) hazır ayarı seçildiğinde `Docker Compose proje kimliği` zorunlu tutulmuyor ve varsayılan `'easypanel-stack'` değeri `400 site_create_invalid_id` (`projectId must be a UUID`) hatası veriyor | `apps/web/src/workspace/NewWebsitePage.jsx` (`:281`) · `apps/web/src/workspace/new-website-form.js` (`:304`) · `POST /api/panel/sites/create-preview` | 1. `/websites/new` Adım 2'de `Docker / Compose Proxy` kartına tıkla. 2. `Docker Compose proje kimliği` alanını boş bırakıp Adım 3'e geç ve `"Web sitesi oluştur"` butonuna bas. 3. `POST /api/panel/sites/create-preview` çağrısının `400 site_create_invalid_id` ile reddedildiğini gör. | `.local/manuel-test/WEB-01/14-s03-preset-docker-stack.png`, `.local/manuel-test/WEB-01/15-s03-docker-stack-invalid-id.png` |
| H5 | NORMAL | Adım 1'de alan adı sözdizimi doğrulanmıyor; Adım 3'te ise `409 site_create_domain_conflict` ve `409 site_create_local_mail_https_required` önizleme hataları genel bir mesajla maskeleniyor | `apps/web/src/workspace/NewWebsitePage.jsx` (`:93-95`) · `apps/web/src/workspace/site-create-submission.js` (`:175-179`) | 1. Adım 1'de `gecersiz_alan_adi` yazıp `"Devam et"`e bas (Adım 2 ve 3'e engelsiz geçer). 2. Kayıtlı `webrich.news` veya `HTTP + yerel e-posta` ile Adım 3'te gönder; spesifik `409` hatası yerine `"Önizleme doğrulanamadı. Formu ve güncel site bilgilerini kontrol edip tekrar deneyin."` mesajını gör. | `.local/manuel-test/WEB-01/19-s04a-invalid-domain.png`, `.local/manuel-test/WEB-01/20-s04b-duplicate-domain-409.png`, `.local/manuel-test/WEB-01/21-s04c-http-local-mail-409.png` |
| H6 | NORMAL | `Mevcut Website'i paylaş` (`shared_website`) ile eklenen alan adı otomatik yayına (`stage`/`apply`) alınmadığı için `draft` (`Henüz yayınlanmadı`) durumunda kalıyor ve tekil domain silme arayüzü bulunmuyor | `apps/web/src/workspace/NewWebsitePage.jsx` (`:82-91`) · `POST /api/panel/domains` | 1. Adım 2'de `Uygulama kaynağı: Mevcut Website'i paylaş` seçip alan adını bağla. 2. Alan adının `state: "draft"` kaldığını ve `/websites/:id/domains` ekranında ayrıca `"Yayına uygula"` gerektirdiğini gör. | `.local/manuel-test/WEB-01/18-s03-shared-domain-created.png` |
| H7 | KOZMETİK | Kurulum sonuç ekranında (`SiteCreateResult.jsx`) `application_metadata`, `website_metadata`, `primary_domain_metadata`, `database`, `domain_activation` adım kimlikleri çevrilmeden ham snake_case olarak gösteriliyor | `apps/web/src/workspace/SiteCreateResult.jsx` (`:5-19`) | 1. Sihirbazla yeni bir site oluştur. 2. Kurulum tamamlandığında adım listesinde Türkçe etiketler yerine `application_metadata`, `website_metadata`, `primary_domain_metadata`, `database`, `domain_activation` ham anahtarlarının göründüğünü doğrula. | `.local/manuel-test/WEB-01/06-s01-created-result.png`, `.local/manuel-test/WEB-01/12-s02-subdomain-created.png` |

## Mevcut testler

| Test dosyası | Durum | Sınıf | Not |
|---|---|---|---|
| `e2e/02-website-creation.spec.js` | KIRMIZI (`1 geçti, 4 kaldı`) | YANLIŞ | Eski tek sayfalı form ve `table.ws-table tbody tr` seçicilerini bekliyor; güncel 3 adımlı sihirbaz (`Devam et` butonu) ve domain ağaç kartlarıyla uyumsuz. |
| `apps/web/test/reseller-customer-panel.test.js` | YEŞİL | YANLIŞ | `ResellerCustomersPage.jsx` içinde yalnızca regex (`assert.match`) ile `/api/sites/hosted/create-preview` metnini arıyor; gerçekte `AllocateSiteDialog` `serverId=null` yüzünden kalıcı olarak `disabled` ve payload şeması kırık. |
| `apps/web/test/jamstack-presets-and-git-dx.test.js` | YEŞİL | YÜZEYSEL | `JAMSTACK_FRAMEWORK_PRESETS` birim kontrolü ve kaynak dosya regex kontrolü yapıyor; `docker_stack` hazır ayarının `'easypanel-stack'` ile arka uç UUID doğrulamasında (`400 site_create_invalid_id`) patladığını yakalamıyor. |
| `apps/web/test/centralized-shadcn-ui-and-docker.test.js` | YEŞİL | YÜZEYSEL | Kaynak kod metin araması ve `resolveSubdomainSharedFileRoot` string kontrolü yapıyor; alt alan adının fiziksel sunucuda `/var/www/vhosts/...` yerine ayrı `/var/www/yunpanel/apps/...` dizininde açıldığını test etmiyor. |
| `apps/web/test/scenarios-websites-nginx-jamstack.test.js` | YEŞİL | YÜZEYSEL | `resolveSubdomainSharedFileRoot` ve `domainCreatePayload` yardımcı fonksiyonlarını test ediyor; arka uç `/api/sites` entegrasyonunu test etmiyor. |
| `apps/web/test/new-website-admin-layout.test.js` | YEŞİL | YÜZEYSEL | `renderToStaticMarkup(LoginCredentialsFields)` ve `NewWebsitePage.jsx` metin/CSS regex kontrolü. |
| `apps/web/test/admin-layout.test.js` | YEŞİL | YÜZEYSEL | CSS ve kaynak dosya metin kontrolü. |
| `apps/web/test/site-create-result-wiring.test.js` | YEŞİL | YÜZEYSEL | `fs.readFile` ile kaynak dosya metin araması; `SiteCreateResult.jsx` içindeki eksik `STEP_LABELS` (`application_metadata` vb.) anahtarlarını yakalamıyor. |
| `apps/web/test/new-website-form.test.js` | YEŞİL | GEÇERLİ | `siteCreateInputFromForm`, `availableExistingApplications`, `availableSharedWebsites`, `sharedDomainCreateInput` birim testleri. |
| `apps/web/test/site-create-submission.test.js` | YEŞİL | MOCK | Stub `request`/`advance` ile istemci durum makinesini (idempotency, oturum değişimi, StrictMode unmount) test ediyor. |
| `apps/web/test/site-admin-result.test.js` | YEŞİL | GEÇERLİ | `siteAdminResult` ve `siteAdminMessage` doğrulama testleri. |
| `apps/api/test/site-create.test.js` | YEŞİL | GEÇERLİ | Gerçek dosya tabanlı registry ile site oluşturma planlama ve doğrulama testleri. |
| `apps/api/test/site-create-php.test.js` | YEŞİL | GEÇERLİ | PHP sürüm seçimi, FPM havuzu ve docroot doğrulama testleri. |
| `apps/api/test/site-create-python.test.js` | YEŞİL | GEÇERLİ | Python (ASGI/WSGI) site oluşturma doğrulama testleri. |
| `apps/api/test/site-create-managed-compose.test.js` | YEŞİL | GEÇERLİ | Managed Compose bağlama ve port/servis doğrulama testleri. |
| `apps/api/test/site-create-independent-subdomain.test.js` | YEŞİL | GEÇERLİ | Alt alan adı hiyerarşisi ve bağımsız Website planlama testleri. |
| `apps/api/test/site-create-independent-guard.test.js` | YEŞİL | GEÇERLİ | Alt alan adı ve ebeveyn domain izolasyon koruma testleri. |
| `apps/api/test/site-create-isolation-guard.test.js` | YEŞİL | GEÇERLİ | Dedicated Unix kullanıcısı ve uygulama izolasyon testleri. |
| `apps/api/test/site-create-provisioning.test.js` | YEŞİL | GEÇERLİ | Kurulum adımları (provisioning steps) durum geçişi ve hata kurtarma testleri. |
| `apps/api/test/site-create-dns-provisioning.test.js` | YEŞİL | GEÇERLİ | PowerDNS zone kurulum adımı testleri. |
| `apps/api/test/site-create-mail-provisioning.test.js` | YEŞİL | GEÇERLİ | Yerel ve harici e-posta kurulum adımı testleri. |
| `apps/api/test/site-create-php-provisioning.test.js` | YEŞİL | GEÇERLİ | PHP-FPM havuz ve dizin hazırlama testleri. |
| `apps/api/test/site-create-provisioning-php.test.js` | YEŞİL | GEÇERLİ | PHP uygulama sürüm/current yayınlama testleri. |
| `apps/api/test/site-create-provisioning-www.test.js` | YEŞİL | GEÇERLİ | `www` alias ve yönlendirme kurulum testleri. |
| `apps/api/test/site-create-provisioning-node-release.test.js` | YEŞİL | GEÇERLİ | Node.js yayın dizini hazırlama testleri. |
| `apps/api/test/site-create-provisioning-isolation.test.js` | YEŞİL | GEÇERLİ | Kurulum sırasında Unix kullanıcı izolasyonu testleri. |
| `apps/api/test/site-create-http-dns-planner.test.js` | YEŞİL | GEÇERLİ | DNS planlayıcı ve HTTP önizleme uyumu testleri. |
| `apps/api/test/site-create-http.test.js` | YEŞİL | MOCK | Stub runtime ile `/api/sites` HTTP sözleşmesi, RBAC ve CSRF testleri. |
| `apps/api/test/hosting-site-create-http.test.js` | YEŞİL | MOCK | Stub servis ile `/api/sites/hosted` HTTP rota testleri. |
| `apps/api/test/hosting-site-create-service.test.js` | YEŞİL | GEÇERLİ | Bayi/müşteri kotası ve sahiplik atamasıyla site oluşturma servis testleri. |
| `apps/api/test/site-create-mount-contract.test.js` | YEŞİL | GEÇERLİ | Rota bağlama sözleşmesi testleri. |
| `apps/api/test/site-create-submission.test.js` | YEŞİL | MOCK | İstemci-sunucu gönderim akışı birim testleri. |
| `apps/api/test/site-admin-result.test.js` | YEŞİL | GEÇERLİ | Site yönetici hesabı sonuç doğrulama testleri. |
| `apps/api/test/site-create-result-wiring.test.js` | YEŞİL | YÜZEYSEL | Kaynak dosya regex kontrolü. |
| `apps/api/test/site-admin-result-wiring.test.js` | YEŞİL | YÜZEYSEL | Kaynak dosya regex kontrolü. |

## Panelde olmayan / bulunamayan

- **Sihirbaz içinden yeni Compose YAML yapıştırarak/yükleyerek sıfırdan Docker Stack ile site açma:** `/websites/new` Adım 2'de `Docker / Compose Proxy` seçildiğinde yalnızca mevcut bir `Docker Compose proje kimliği` (UUID) girilebiliyor; sihirbaz içinde Compose YAML editörü veya mevcut projeleri listeleyen bir açılır kutu (`<select>`) bulunmuyor.
- **Paylaşılan alan adını (`shared_website`) Website'i silmeden tek başına kaldırma arayüzü:** Arka uçta `/api/domains/:domainId/removal` uç noktaları (`apps/api/src/domain-removal-http.js`) mevcut olmasına rağmen, ön yüzde (`apps/web/src/workspace/`) `Mevcut Website'i paylaş` ile eklenen ikincil bir `Domain` kaydını paylaşılan `Website`'i silmeden tek başına kaldıran bir buton/ekran bulunmuyor.

## Oluşturulan ve temizlenen kaynaklar

| Kaynak | Oluşturuldu | Temizlendi | Not |
|---|---|---|---|
| `tweb01-a3-res` (Bayi kullanıcısı ve profili) | evet | evet | `/users` ekranından önce bayi profili kaldırıldı, ardından kullanıcı hesabı silindi. |
| `tweb01-a3-rcust` (Bayi müşterisi kullanıcısı ve profili) | evet | evet | `/users` ekranından önce müşteri profili kaldırıldı, ardından kullanıcı hesabı silindi. |
| `tweb01-a3-php.webrich.news` (`43a3b60c-85b5-5dd1-af4a-2883b03b4af9` · Website `7a445a53-62f3-520f-b79d-3cbd3015f9b3` · DB `yp_14830486339821b4b8cbe29fda7e7808`) | evet | temizlenemedi | Panelin normal silme akışı (`/websites/.../settings` → `Siteyi sil…`) `child_domains_present`, `database_binding_dependencies_present` ve `dns_zone_parent_ds_unverifiable` (`H2`) nedeniyle `001:domain_removal` adımında bloke oldu. |
| `sub.tweb01-a3-php.webrich.news` (`f5e350bd-8d07-5701-b945-a084fdc3be4d` · Website `1dac24b4-2820-506a-84d6-7266c99bd762`) | evet | temizlenemedi | Panelin normal silme akışında `ws-rem-cf5ccfd3-a986-41ec-be34-6567de446c8e` işlemi `001:domain_removal` adımında `domain_removal_not_ready` (`dns_zone_parent_ds_unverifiable` — `H2`) ile `blocked` durumunda kaldı. |
| `tweb01-a3-shared.webrich.news` (`c8da3e5a-addd-4366-9d1f-80f440b83729`) | evet | temizlenemedi | `Mevcut Website'i paylaş` ile `7a445a53-62f3-520f-b79d-3cbd3015f9b3` sitesine bağlandı; tekil domain silme arayüzü yok ve `state: "draft"` kaldığı için `domain_removal_domain_not_stable` (`H6`) veriyor. |
| `tweb01-a3-custsite.webrich.news` (`5aafb60e-8f4e-56a9-bfbf-f850512ca033` · Website `2876e881-ba26-5b36-ad34-6b211c22f6ee`) | evet | temizlenemedi | Panelin normal silme akışında `ws-rem-df34ca76-0471-4095-92e6-38e3d6cb869a` işlemi `001:domain_removal` adımında `domain_removal_not_ready` (`dns_zone_parent_ds_unverifiable` — `H2`) ile `blocked` durumunda kaldı. |
| `tweb01-a3-cust` (Doğrudan müşteri kullanıcısı ve profili) | evet | temizlenemedi | Üzerine kayıtlı `tweb01-a3-custsite.webrich.news` sitesi `H2` nedeniyle silinemediği için müşteri profili ve hesabı `/users` ekranından kaldırılamadı. |
