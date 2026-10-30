# QA ve doğrulama bulguları (T800–T999)

> `orkestra/orchestrator.py finding` ve QA ajanları yazar. Elle düzenlenebilir; kimlikler sabit kalır.

### T800 · KRİTİK TLS-01: core-app.js sertifika yenileme ve sonuç uçlarında kiracı (tenant) izolasyonu eksik
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/core-app.js`, `apps/api/src/certificate-http.js`, `apps/api/test/ssl-renewal-wiring.test.js`
- **Kaynak:** QA · 2026-10-26 20:23
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Tekrar üretme: 1) Owner hesabıyla bir alan adına (ör. ttls01-a2.webrich.news) SSL sertifikası (certId: 89da9d5b-c2f3-4414-bf5b-5e895749137c) al. 2) Hiçbir web sitesi olmayan farklı bir Customer hesabıyla (ttls01-a2-cust) giriş yap. 3) POST /api/panel/certificates/89da9d5b-c2f3-4414-bf5b-5e895749137c/renew ({dryRun: true}) ve GET /api/panel/certificates/89da9d5b-c2f3-4414-bf5b-5e895749137c/renewal-outcome?jobId=<jobId> isteklerini gönder. Beklenen: Başka kiracıya ait sertifika için 403/404 dönmeli (certificate-http.js satır 187-231 canAccessCertificate kontrolü gibi). Gerçek: apps/api/src/core-app.js satır 1138-1205 içindeki /api/certificates/:id/renew, /renewal-outcome ve /reload-outcome rotaları certificate-http.js rotalarını gölgelemekte ve yalnızca domains.write/domains.read rol iznine bakıp canAccessDomain(req, domain) kontrolü yapmamaktadır. Customer hesabı 202 Accepted ile Owner sertifikasında yenileme işi (jobId: 487a3e84-f87d-4fcf-808b-707d565032bd) başlatabilmiş ve 200 OK ile yabancı sertifika detaylarını okuyabilmiştir.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T801 · KRİTİK TLS-01: SSL sertifikası bulunan web siteleri certificates_present engeli yüzünden silinemiyor
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/website-removal-plan.js`, `apps/api/test/website-removal.test.js`
- **Kaynak:** QA · 2026-10-26 20:23
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Tekrar üretme: 1) Bir web sitesi oluştur (ttls01-a2.webrich.news) ve /websites/:id/ssl sekmesinden ücretsiz Let's Encrypt sertifikası al. 2) /websites/:id/settings sekmesine gidip 'Siteyi sil' bölümünü incele veya POST /api/panel/websites/:websiteId/removal-preview çağrısı yap. Beklenen: Ekrandaki etki tablosunda 'SSL/TLS sertifikası: Bağlı sertifikalar emekliye ayrılır (retire)' yazdığı ve domain-removal-plan.js içinde certificates_present orchestratable olduğu gibi, site silme önizlemesi readyToStart: true dönmeli ve site silinebilmeli. Gerçek: apps/api/src/website-removal-plan.js satır 268-282 içindeki ORCHESTRATABLE_WEBSITE_IMPACT_BLOCKERS listesinde 'certificates_present' bulunmadığı için hardBlockers: ['certificates_present'] ve readyToStart: false dönmekte, 'Silme işlemi için gerekli güvenlik kontrolü tamamlanmadı: certificates_present' uyarısıyla silme butonu gizlenmektedir.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T802 · --title
- **Bağımlı:** —
- **Dosyalar:** `--group`, `Grup 13 · Yedek ve kurtarma`, `--files`, `apps/web/src/workspace/SiteBackupPanel.jsx apps/web/src/workspace/site-backup-client.js apps/api/src/backup-repository-http.js apps/api/src/website-hosting-backup-adapter.js`, `--notes`, `1) Sunucuda varsayılan Restic deposu bulunmadığında SiteBackupPanel 'Yedek deposu yok' gösterip Yedek Al ve Plan butonlarını kilitlemekte; ancak POST /api/panel/backups/repositories uç noktasını çağıran hiçbir UI ekranı/modalı bulunmadığından Owner tarayıcıdan yedek deposu başlatamamaktadır. Ayrıca DELETE /api/panel/backups/repositories/:id fiziksel /var/lib/yunpanel/backups/restic/repos/<id> dizinini temizlememektedir. 2) SiteBackupPanel.jsx:170 yalnız status==='succeeded' olduğunda load({refresh:true}) çağırdığından, sağlık kontrolü hatasıyla otomatik geri alınan (rolled_back) geri yüklemelerden sonra özet kartındaki 'Son geri yükleme sonucu' ve yeni oluşan 'pre_restore' snapshot tablosu yenilenmemektedir. 3) Taslak (draft) sitede nginx config henüz yokken backup preview başarılı dönüp işlem prepare adımında ENOENT ile düşmektedir. 4) SiteBackupPanel.jsx içinde AGENTS.md Madde 6'ya aykırı '(Rollback)', '(rclone)', '(health_check_failed)' parantez içi ifadeleri bulunmaktadır.`
- **Kaynak:** QA · 2026-10-26 20:33
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    BAK-08: Panelde Restic yedek deposu oluşturma ekranı yok ve geri alma sonrası UI durumu yenilenmiyor

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T803 · KRİTİK WEB-01: Bayi site tahsisi (AllocateSiteDialog) kilitli ve sihirbazla açılan sitelerin silinmesi domain_removal_not_ready ile bloke oluyor
- **Bağımlı:** —
- **Dosyalar:** `apps/web/src/workspace/ResellerCustomersPage.jsx`, `apps/web/src/workspace/workspace-resources.js`, `apps/web/src/workspace/new-website-form.js`, `apps/api/src/domain-removal-plan.js`, `apps/api/src/dns-zone-retirement.js`
- **Kaynak:** QA · 2026-10-27 02:20
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    1) /customers rotasında servers koleksiyonu kapalı olduğu için AllocateSiteDialog içinde serverId=null kalıyor ve bayi müşterisine site tahsis edemiyor; ayrıca handlePreview payload şeması site-create-base.js ile uyumsuz. 2) Sihirbazla açılan siteler (varsayılan authoritative DNS veya otomatik DB ile) silinmek istendiğinde 001:domain_removal adımında dns_zone_parent_ds_unverifiable ve database_binding_dependencies_present hardBlocker'ları nedeniyle domain_removal_not_ready hatasıyla bloke oluyor. 3) Subdomain dosya kökü UI'da /var/www/vhosts/<domain>/subdomains/<sub> gösterilirken fiziksel sunucuda ayrı /var/www/yunpanel/apps/<id>/current altında açılıyor.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T804 · KRİTİK ROL-03: Bayi (Reseller) müşterisine site tahsis etme uç noktaları (/api/panel/sites/hosted*) customerLookup bağlama hatası nedeniyle 403 dönüyor ve 0 siteli bayide sunucu listesi boş geliyor
- **Bağımlı:** T803
- **Dosyalar:** `apps/api/src/management-app.js`, `apps/api/src/tenant-boundary.js`, `apps/api/src/site-resource-boundary.js`, `apps/web/src/workspace/workspace-resources.js`, `apps/web/src/workspace/ResellerCustomersPage.jsx`
- **Kaynak:** QA · 2026-10-27 02:30
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Tekrar üretme: 1) Bayi (reseller) hesabıyla giriş yapıp kendine bağlı bir müşteri oluştur. 2) Bayi oturumuyla POST /api/panel/sites/hosted/create-preview veya POST /api/panel/sites/hosted uçlarına kendi müşterisinin customerId değeri ve geçerli site-create şemasıyla istek gönder; ayrıca 0 siteli bayide GET /api/panel/servers çağır ve /customers sayfasında 'Site tahsis et' modalını aç. Beklenen: Bayi kendi müşterisine site tahsis edebilmeli ve AllocateSiteDialog içinde yerel sunucu seçilebilmeli. Gerçek: (a) apps/api/src/management-app.js satır 444'te userAdminStore allOptions'tan destructure edildiği için satır 499'da options.userAdminStore undefined kalmakta ve customerLookup null olarak createTenantBoundaryMiddleware'e geçmektedir; bu yüzden tenant-boundary.js:357 tüm bayi site tahsisi isteklerini 403 tenant_boundary_forbidden ('Site allocation requires customer verification.') ile reddetmektedir. (b) site-resource-boundary.js:214 GET /api/servers yanıtını bayinin mevcut sitelerinin serverId kümesiyle filtrelediği için 0 siteli bayiye [] dönmekte, ayrıca workspace-resources.js içinde /customers rotasında servers:false olduğundan AllocateSiteDialog 'Yerel sunucu bilgisi yükleniyor…' durumunda kilitli kalmaktadır (T803 ile ilişkili).

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T805 · Doğrulama: test — and APP_PYTHON_STATUS is read-only (1.461625ms)
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-10-27 11:37
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    n-capable and protocol-owned header settings (0.789291ms)
    ✔ normalizes structured Node runtime profiles without arbitrary commands (4.614292ms)
    ✔ normalized Node runtime profiles can be normalized again without losing startup state (0.695792ms)
    ✔ normalizes Passenger Node runtime profiles without allocating a localhost port (1.351834ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (2.235959ms)
    ✔ normalizes complete Node deployment specs (1.412334ms)
    ✔ normalizes fixed Node process actions against a managed release (0.530875ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (9.862ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (1.163958ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (3.166375ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (30.58225ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (1.346667ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (2.504708ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.625834ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.954083ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.769583ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.468333ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (3.616583ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.342667ms)
    ✔ normalizes python rollback, restart, and status specs (0.456125ms)
    ✔ tenant constants and role classification predicates (4.810792ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.989125ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.756458ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.615667ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (2.227708ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (2.579375ms)
    ✔ createTenantContext builds accurate tenant context for all roles (1.504958ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (1.224125ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (3.257334ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.602917ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.889292ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.094959ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (2.381875ms)
    ✔ tenant context creation and account normalization security edge cases (1.4815ms)
    ℹ tests 59
    ℹ suites 0
    ℹ pass 59
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 758.403583

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T806 · Doğrulama: test — > node --test
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-10-27 13:26
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    jection-capable and protocol-owned header settings (0.749875ms)
    ✔ normalizes structured Node runtime profiles without arbitrary commands (9.568625ms)
    ✔ normalized Node runtime profiles can be normalized again without losing startup state (0.505417ms)
    ✔ normalizes Passenger Node runtime profiles without allocating a localhost port (0.95325ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.563541ms)
    ✔ normalizes complete Node deployment specs (1.720833ms)
    ✔ normalizes fixed Node process actions against a managed release (1.04325ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (6.124333ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.893917ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (5.200208ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (25.006583ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (1.406625ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (2.257458ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.944458ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (2.90525ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.59025ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.252917ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (1.589333ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.197042ms)
    ✔ normalizes python rollback, restart, and status specs (0.583791ms)
    ✔ tenant constants and role classification predicates (3.141334ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (1.245ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (1.423333ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (2.85475ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.726542ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.448834ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.579084ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.63575ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (1.97925ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.688458ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (1.39875ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.069041ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (2.679166ms)
    ✔ tenant context creation and account normalization security edge cases (0.993708ms)
    ℹ tests 67
    ℹ suites 0
    ℹ pass 67
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 783.80775

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T807 · Doğrulama: test — nvalid domains (0.67625ms)
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-10-27 14:41
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    meConfig rejects invalid entry points or workers (0.399ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.31875ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (5.232542ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (1.065208ms)
    ✔ normalizes python rollback, restart, and status specs (2.843125ms)
    ✔ tenant constants and role classification predicates (12.254458ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (2.7785ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (3.164958ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (15.917167ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.533542ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.39075ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.467333ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (3.147584ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (3.916542ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (3.70875ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.922125ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.214208ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (9.009209ms)
    ✔ tenant context creation and account normalization security edge cases (1.393666ms)
    ℹ tests 67
    ℹ suites 0
    ℹ pass 66
    ℹ fail 1
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 1721.117083
    
    ✖ failing tests:
    
    test at test/nginx-redirect-rules.test.js:30:1
    ✖ redirect rules reject nginx injection, unsafe schemes, reserved paths, loops and ambiguous prefixes (363.423292ms)
      AssertionError [ERR_ASSERTION]: path validation must stay linear on hostile input
          at TestContext.<anonymous> (file:///Volumes/DevSSD/Developer/Projects/Projeler/yunpanel/packages/shared/test/nginx-redirect-rules.test.js:48:10)
          at Test.runInAsyncScope (node:async_hooks:227:14)
          at Test.run (node:internal/test_runner/test:1402:25)
          at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
          at Test.postRun (node:internal/test_runner/test:1542:19)
          at Test.run (node:internal/test_runner/test:1467:12)
          at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
        generatedMessage: false,
        code: 'ERR_ASSERTION',
        actual: false,
        expected: true,
        operator: '==',
        diff: 'simple'
      }
    npm error Lifecycle script `test` failed with error:
    npm error code 1
    npm error path /Volumes/DevSSD/Developer/Projects/Projeler/yunpanel/packages/shared
    npm error workspace @yunpanel/shared@0.3.0
    npm error location /Volumes/DevSSD/Developer/Projects/Projeler/yunpanel/packages/shared
    npm error command failed
    npm error command sh -c node --test

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T808 · Doğrulama: test — es a strict bounded dotenv import without executing interpolation (0.911917ms)
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-10-27 14:50
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    es without allocating a localhost port (0.897042ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.347667ms)
    ✔ normalizes complete Node deployment specs (3.5155ms)
    ✔ normalizes fixed Node process actions against a managed release (2.12525ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (4.053792ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (1.140375ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (1.343917ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (216.42475ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (8.510791ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (21.740083ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (12.456ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (5.601084ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (3.671792ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.30925ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (9.592ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (4.388208ms)
    ✔ normalizes python rollback, restart, and status specs (1.926375ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (3.197625ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (1.181167ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (11.00675ms)
    ✔ tenant constants and role classification predicates (105.496333ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (12.221792ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (6.607542ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (1.509916ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.676542ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.405333ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.565458ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (1.166417ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (1.197458ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.557625ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.616458ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.920334ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (5.773291ms)
    ✔ tenant context creation and account normalization security edge cases (0.877625ms)
    ℹ tests 70
    ℹ suites 0
    ℹ pass 70
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 996.37325

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T809 · Doğrulama: test — website-removal-http remains fail-closed on partial failure and subsequent destruc
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-10-27 15:28
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - website-removal-http remains fail-closed on partial failure and subsequent destructive steps do not execute
    
    files without allocating a localhost port (1.366541ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.773542ms)
    ✔ normalizes complete Node deployment specs (2.192541ms)
    ✔ normalizes fixed Node process actions against a managed release (0.605417ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (4.082583ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (1.224875ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (9.216ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (20.098125ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (1.073791ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (2.198167ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (1.762042ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (1.009375ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.7085ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.444666ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (3.052709ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.6155ms)
    ✔ normalizes python rollback, restart, and status specs (3.714584ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (2.888667ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (1.564041ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (2.514666ms)
    ✔ tenant constants and role classification predicates (3.376417ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (1.106167ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (1.782375ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.607167ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.438542ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.376459ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.429167ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.589125ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (1.013708ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.586167ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.652833ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.0265ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (1.368041ms)
    ✔ tenant context creation and account normalization security edge cases (0.477125ms)
    ℹ tests 70
    ℹ suites 0
    ℹ pass 70
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 507.704125

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T810 · Doğrulama: test — RBAC: Authentication and Authorization on /api/firewall/ports
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-10-27 16:45
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - RBAC: Authentication and Authorization on /api/firewall/ports
    - PROD-05 Firewall HTTP API Suite
    
    ime profiles without allocating a localhost port (0.7445ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (3.756375ms)
    ✔ normalizes complete Node deployment specs (2.125667ms)
    ✔ normalizes fixed Node process actions against a managed release (5.146333ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (6.661ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (1.46375ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (2.759333ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (28.789417ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (3.826917ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (2.887959ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.87425ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (4.758958ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.708166ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.34925ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (2.214208ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (5.3675ms)
    ✔ normalizes python rollback, restart, and status specs (1.202833ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (4.062209ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (4.330583ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (1.668084ms)
    ✔ tenant constants and role classification predicates (2.619292ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (4.123375ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (1.661583ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (1.273041ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.596ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.577208ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.508583ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.770125ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (1.193ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (1.130334ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (1.150917ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.177417ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (1.341333ms)
    ✔ tenant context creation and account normalization security edge cases (0.604834ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 741.331125

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T811 · KRİTİK: DEV-06 test temizliği başka sitelerin cron dosyalarını siliyor
- **Bağımlı:** T163
- **Dosyalar:** `e2e/ozellik/dev-06.spec.js`
- **Kaynak:** QA · 2026-10-28 10:59
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    28-10-2026 kaynak kanıtı: e2e/ozellik/dev-06.spec.js afterAll, /etc/cron.d/yunpanel-* genel deseniyle tüm yönetilen cron dosyalarını siliyor. .28 otomasyon kabulünde beş eski SYS-06/DEV-06 test cron kaydı dosyasız bulundu; ad, komut ve zamanlama test kaynaklarıyla birebir doğrulanıp İNSAN onayıyla normal API üzerinden kaldırıldı. Genel yıkıcı komutu .28 üzerinde yeniden çalıştırma. Temizliği yalnız bu koşunun oluşturduğu görev kimlikleri ve normal panel API akışıyla sınırla; iki ayrı test kaynağından yalnız kendisininkini kaldırınca diğerinin dosyası ve registry kaydı korunduğunu gerçek API/host ile kanıtla. Diğer testler ve kullanıcı kaynakları korunmalı; mock/stub yok. Sonuç ve sınırı docs/otomasyon-api.md Kalan işler notuyla eşleştir.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T812 · Otomasyon: silinen tenant aynı slug ile eski provisioning ve kaldırma kayıtlarını kullanıyor
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/tenant-site-service.js`, `apps/api/src/tenant-site-store.js`, `e2e/otomasyon/tenant-e2e.mjs`
- **Kaynak:** QA · 2026-10-28 10:59
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    28-10-2026 gerçek .28 kabulünde ypt-e2e tenant silindi, aynı slug yeniden PUT edildi. Sabit hostname tabanlı provisioning operationId eski ready kaydını kullandı; yeni domain certificateId null iken API active döndü, HTTPS hostname doğrulaması başarısız oldu. Sonraki DELETE eski domain kaldırma kaydını tamamlanmış saydı ve website_removal_domains_still_attached ile durdu. Başarısız tekrarın bütün kaynakları normal APIlerle temizlendi. Ayrıntı docs/otomasyon-api.md Kalan işler 1. Canlı aynı tenant tekrar PUT idempotency davranışını koru; tamamen silinmiş tenant yeniden kurulumunda yeni nesil/journal kimliklerini güvenli ayır. Eski kaydı elle silerek veya kimlik/tenant korumasını atlayarak geçirme. e2e/otomasyon/tenant-e2e.mjs benzersiz tenant ile 19/19 geçti; bu kabul aynı slug yeniden kurulumunu kapsamıyor. Oluştur, sertifika, sil, aynı slug yeniden oluştur, gerçek sertifika/200, tekrar sil/404 senaryosunu gerçek .28 API/DB/tarayıcı ile kanıtla. .28 mevcut tek dosya hotfixi kaynakta 9ab0622b; yeni deployment için ayrıca kullanıcı hedef/scope izni gerekir.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T813 · Doğrulama: site log testlerinin sabit tarihi son 24 saat aralığının dışında kalıyor
- **Bağımlı:** —
- **Dosyalar:** `apps/api/test/website-site-logs.test.js`
- **Kaynak:** QA · 2026-10-28 10:59
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    28-10-2026 son npm test --workspace @yunpanel/api sonucu 5314/5316: website-site-logs.test.js satır 62 ve 76 testleri entries [] döndüğü için başarısız. Testin line() fonksiyonu sabit 27/Oct/2026 10:00 +0300 satırları üretiyor; gerçek normalizeLogQuery varsayılan son 24 saati uygular. Tarih değişiminden bağımsız, açık since/until aralığıyla mevcut gerçek HTTP ve gerçek dosya okuyucu testlerini düzelt; beklentiyi gevşetme veya ürünün 24 saat filtresini kaldırma. Tarih sınırı senaryosunu da koru. Anahtar testindeki base64url underscore ayrıştırma hatası 9ab0622b içinde düzeltildi; o hatayı tekrar açma. Mock/stub ekleme. İlgili testler ve verify --quick yeşil kanıtlanmalı.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T814 · Doğrulama: test — a customer reads only the access log of their own site, never the server-wide ngin
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-10-28 11:07
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - a customer reads only the access log of their own site, never the server-wide nginx log
    - the served hostname decides the file: a preferred www name reads www.<domain>.access.log
    
    without allocating a localhost port (0.850625ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (2.297833ms)
    ✔ normalizes complete Node deployment specs (1.306584ms)
    ✔ normalizes fixed Node process actions against a managed release (0.894792ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (4.955125ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (3.271334ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (8.227708ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (23.173292ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (4.17475ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (3.963959ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (1.828375ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (1.492417ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.279666ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.738542ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (3.216583ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (2.215333ms)
    ✔ normalizes python rollback, restart, and status specs (0.951667ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (7.272916ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (1.033792ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (1.861834ms)
    ✔ tenant constants and role classification predicates (3.085042ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (2.013834ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (1.892416ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (3.540542ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.421625ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.303209ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.509208ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (1.209625ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (1.519125ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.541708ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.485625ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.170291ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (2.666541ms)
    ✔ tenant context creation and account normalization security edge cases (0.7975ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 891.264958

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T815 · Doğrulama: test — re-creating a deleted tenant with the same slug generates a new generation/journal
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-10-28 11:17
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - re-creating a deleted tenant with the same slug generates a new generation/journal and avoids old provisioning/removal collisions
    
     without allocating a localhost port (1.655917ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.893875ms)
    ✔ normalizes complete Node deployment specs (14.671ms)
    ✔ normalizes fixed Node process actions against a managed release (0.507583ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (5.427958ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (3.135708ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (16.233709ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (37.6285ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (3.961791ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (2.201459ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (1.054125ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.845459ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.32775ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.253292ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (1.711291ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (6.143667ms)
    ✔ normalizes python rollback, restart, and status specs (0.77475ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (9.207792ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (1.751666ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (1.457292ms)
    ✔ tenant constants and role classification predicates (5.391042ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (1.205209ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (117.941417ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (3.740458ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (5.735292ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (6.100208ms)
    ✔ createTenantContext builds accurate tenant context for all roles (1.125792ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (8.929125ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (7.632333ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (3.192292ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (8.144917ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.297ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (6.918541ms)
    ✔ tenant context creation and account normalization security edge cases (12.044375ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 3039.013625

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T816 · Doğrulama: test — application lock rejects a second live process lock and releases after completion
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-10-28 11:35
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - application lock rejects a second live process lock and releases after completion
    
    ime profiles without allocating a localhost port (0.565583ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.262042ms)
    ✔ normalizes complete Node deployment specs (0.734333ms)
    ✔ normalizes fixed Node process actions against a managed release (1.5055ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (8.051834ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.758958ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.774666ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (15.6905ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (1.1825ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (26.489709ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.5215ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.465792ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (4.8925ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (2.069666ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (2.721583ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.377042ms)
    ✔ normalizes python rollback, restart, and status specs (1.104333ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (5.01675ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (1.415458ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (1.683875ms)
    ✔ tenant constants and role classification predicates (1.660917ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.672ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (2.141625ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (3.499417ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (1.441625ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.92425ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.531459ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.825708ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (1.9115ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.615334ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.975583ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.398041ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (5.169875ms)
    ✔ tenant context creation and account normalization security edge cases (0.711917ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 452.136416

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T817 · Doğrulama raporu: API-01 hata sayımı ve tenant yeniden kurma kabul sınırı
- **Bağımlı:** T299
- **Dosyalar:** `docs/manuel-test/OZET.md`, `docs/otomasyon-api.md`, `docs/manuel-test/CODEX-KABUL-DENETIMI.md`
- **Kaynak:** QA · 2026-10-28 14:02
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    CODEX bağımsız denetimi: docs/manuel-test/API-01.md ürün hatası yok diyor fakat OZET.md normal=1 ve toplam238 sayıyor. API-01 satırı0, toplam237 olmalı; tematik yüzdeler için sayım kanıtı yok. apps/api/test/tenant-site-recreate-lifecycle.test.js execFn, identityManager, domainRemovalRuntime ve cleanup stub kullanıyor; https:false ile çalışıyor. docs/otomasyon-api.md tam doğrulandı ifadesini yerel kısmi entegrasyon kanıtıyla sınırla; T812/T815 kabulü canlı .28 HTTPS yeniden kurmayı kanıtlamaz. Kabul: 124 rapor/124 benzersiz tablo satırı, kategori toplamları tutarlı, API-01 hata0, açık kabul sınırı yazılı, npm run lint. Uygulama veya kabul edilmiş görev geçmişi değiştirilmez.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T818 · Otomasyon: aynı slug için gerçek .28 HTTPS yeniden kurma kabulü
- **Bağımlı:** T817
- **Dosyalar:** `docs/otomasyon-api.md`, `docs/yapilanlar.md`, `docs/manuel-test/OTOMASYON-YENIDEN-KURMA.md`
- **Kaynak:** QA · 2026-10-28 14:40
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    İNSAN dört API dosyasının .28 aktarımını ve servis restartını açıkça onayladı. .local/automation-recreate-deployment/manifest.json içindeki sabit kaynak ve kurulu hashleri karşılaştır; yalnız dört dosyayı aktar. Aynı yeni slug ile iki gerçek tenant-e2e.mjs koşusu: geçerli HTTPS, gerçek içerik,503/302/200, gerçek silme/404; ayrıca nesil, Website/Domain/provisioning kimliklerinin değiştiğini kanıtla. Yalnız bu testin parent/key/tenant/upstream kaynaklarını temizle. .44, push, paket kurulumu ve rutin yedek yok. Kaynak test fixture sonucu canlı kabul yerine kullanılamaz. Dokümanlara kısa gerçek kanıt ve sınırları yaz.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T819 · KRİTİK EML-09: test temizliği bütün DKIM materyalini siliyor
- **Bağımlı:** T188
- **Dosyalar:** `e2e/ozellik/eml-09.spec.js`, `docs/manuel-test/EML-09.md`
- **Kaynak:** QA · 2026-10-28 15:02
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    e2e/ozellik/eml-09.spec.js afterAll bütün mail-dkim dizinini globla siliyor ve API restart ediyor; test mevcut ilk mail domaininde DKIM oluşturuyor. Güvenli biçimde yalnız kendine ait yeni test domaininde DKIM oluştur; başka domaine ait materyalin korunduğunu gerçek host metadata/hash ile doğrula, özel anahtarı çıktı/artefacte alma. Kendi test kaynağını normal panel/UI/API kaldırma zinciriyle temizle, genel restart ve glob silme kaldır. Sabit mevcut domaine mutasyon yapma. Mevcut mutlu/hatalı girdileri sıkı tut; beklenen hata yalnız doğrulanan ürün eksikliğine test.fail. Kilitli gerçek .28 Playwright koşusu, lint ve kısa rapor. Uygulama deploy/push yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T820 · KRİTİK DNS-04: test DNSSEC geçmişini sıfırlıyor ve mevcut domaini değiştiriyor
- **Bağımlı:** T173
- **Dosyalar:** `e2e/ozellik/dns-04.spec.js`, `docs/manuel-test/DNS-04.md`
- **Kaynak:** QA · 2026-10-28 15:02
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    dns-04.spec.js tüm dnssec-operations.json dosyasını boşaltıp sabit mevcut hedef DNSSEC durumunu değiştiriyor/API restart ediyor. Bunu kaldır; yalnız kendine ait yeni izole test zone/domaininde gerçek UI senaryosu yaz/koş, önceki diğer domain/işlem kayıtlarının korunduğunu gerçek kanıtla doğrula. Registry dosyasını elle düzenleme, wildcard cleanup/restart yok; cleanup normal API/UI yalnız owned kaynaklar. Beklenen product gaps test.fail doğru preconditiondan sonra. Kilitli .28 gerçek koşu+lint+rapor, deploy/push yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T821 · KRİTİK SYS-05: test tüm ttyd süreçlerini ve socketlerini kaldırıyor
- **Bağımlı:** T138
- **Dosyalar:** `e2e/ozellik/sys-05.spec.js`, `docs/manuel-test/SYS-05.md`
- **Kaynak:** QA · 2026-10-28 15:02
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    sys-05.spec.js tüm ttyd süreçlerini öldürüp /run/yunpanel/ttyd/*.sock siliyor. Yalnız kendi UI/API oturum kimliğini kapat, diğer gerçek terminal oturumunun korunmasını kanıtla. Mevcut site/terminal oturumuna mutasyon yapma; kendi test sitesi/hesabı gerektiği kadar oluştur normal cleanup. Registry veya genel servis restart/glob cleanup yok. Kilitli .28 gerçek Playwright+lint+rapor; deploy/push yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T822 · KRİTİK TLS-03: test geniş önekle kayıtları düzenleyip servisi yeniden başlatıyor
- **Bağımlı:** T177
- **Dosyalar:** `e2e/ozellik/tls-03.spec.js`, `docs/manuel-test/TLS-03.md`
- **Kaynak:** QA · 2026-10-28 15:02
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    tls-03.spec.js ttls03 genel öneğiyle çoklu registry dosyalarını doğrudan filtreleyip API restart ediyor. Yalnız bu koşunun benzersiz kaynak IDlerinin normal panel silme zincirini kullan; doğrudan registry edit/global restart/genel önek tarama yok. İlgisiz site/domain/certificate materyalinin korunduğunu doğrula. Gerçek UI happy/invalid/role gerekli senaryoları koru; secret key/cert dosyaları public output/screenshots yok. Kilitli .28 gerçek test+lint+rapor; deploy/push yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T823 · KRİTİK DKIM: hazır olmayan tek posta alan adı bütün yeni sitelerin DKIM'ini durduruyor
- **Bağımlı:** —
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/mail-dkim-configuration.js`, `apps/api/src/website-mail-dkim-config-provisioning-handler.js`, `apps/api/test/mail-dkim-configuration.test.js`, `apps/api/test/website-mail-dkim-config-provisioning-handler.test.js`, `apps/api/src/website-provisioning-orchestrator.js`, `apps/api/test/website-provisioning-orchestrator.test.js`
- **Kaynak:** SENIOR · 2026-10-28
- **İş:** `previewIdentity` bütün etkin anahtarların DNS durumu `ready` değilse `readyToApply=false` veriyor; tek OpenDKIM yapılandırması olduğu için DNS'i görünmeyen bir alan adı (ör. `sslip.io` altındaki eski test sitesi) sunucudaki bütün yeni posta sitelerini `website_mail_dkim_dns_not_ready` ile kilitliyor. Ayrıca adım `blocked` olunca DNS hazır olsa da devam etmiyor: `/continue` hep blocked, `/retry` 409 (`canRetry=false`). .28'de tekrar üretildi (teml09 koşuları, işlem `dcaf984a-…`). Hedef: yalnız hedef anahtarın DNS'i engel olsun, diğerleri uyarı; blocked adım DNS hazır olunca normal ilerlesin. Sonra .28'de takılı `teml09-acodex-mvs47pnd-guard.157-180-11-28.sslip.io` ve `teml09-acodex-mvs4j36n-guard.webrich.news` sitelerini panelden temizle ve T819'u (`e2e/ozellik/eml-09.spec.js`, artık `webrich.news` altında) yeniden koş.
- **Kabul:** Önce kırılan birim testi; `npm test` ve lint geçiyor; İNSAN onaylı .28 kurulumundan sonra eml-09 5/5 geçiyor.

### T824 · KRİTİK DNS: DNSSEC açılmış alt alan adı, üst bölge aynı sunucudayken silinemiyor
- **Bağımlı:** T803
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/dns-zone-retirement.js`, `apps/api/src/dns-delegation-inspector.js`, `apps/api/test/dns-zone-retirement.test.js`
- **Kaynak:** Codex T820 · 2026-10-28
- **İş:** `tdns04-acodex-mvs2ku0w.webrich.news` (`.local/manuel-test/T820-owned.json`) üst DS durumu `unverifiable` döndüğü için `dns_zone_parent_ds_unverifiable` ile kalıcı engelleniyor; üst bölge `webrich.news` aynı PowerDNS'te. DS güvenlik koşulu atlanmayacak: üst bölge yerelse DS'i yerel kaynaktan kesin doğrula ve gerekiyorsa kaldırma planına DS geri çekmeyi ekle. Sonra bu siteyi panelden temizle ve T820'yi (`e2e/ozellik/dns-04.spec.js`) yeniden koş.
- **Kabul:** Kırılan birim testi önce; `npm test`; .28'de dns-04 geçiyor ve artık site kalmıyor.

### T825 · Site sihirbazında posta adımı takılınca site silinemiyor; posta alan adını silecek ekran yok
- **Bağımlı:** T801
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/website-removal-plan.js`, `apps/api/test/website-removal-plan.test.js`
- **Kaynak:** SENIOR · 2026-10-28
- **İş:** Posta adımı engellenen sitenin silinmesi `mail_domains_present` ile duruyor; `DELETE /api/mail-domains/:id` var ama web istemcisinde çağrısı yok. Plesk'teki gibi site silme bağlı posta alan adını da kaldırsın (posta kutusu varsa açık onayla) veya posta alan adı ekrandan silinebilsin.
- **Kabul:** Takılı posta adımlı site panelden silinebiliyor; birim + .28 kanıtı.

### T826 · Alan adı hiç yayınlanmamış (draft) site panelden silinemiyor
- **Bağımlı:** T803, T825
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/domain-removal-plan.js`, `apps/api/test/domain-removal-plan.test.js`
- **Kaynak:** SENIOR · 2026-10-28
- **İş:** Kurulumu yarıda kalan sitenin alan adı `draft` kalınca silme `domain_removal_domain_not_stable` ile duruyor; kullanıcı önce yayınlamak zorunda kalıyor. Yayınlanmamış alan adı için yönlendirme geri alma adımı gereksiz; silme doğrudan ilerlesin.
- **Kabul:** Kırılan birim testi önce; `npm test`; .28'de yarım kalmış site panelden silinebiliyor.

### T827 · Playwright hata dosyaları giriş parolasını düz metin yazıyor
- **Bağımlı:** —
- **Sahip:** SENIOR
- **Dosyalar:** `playwright.config.js`, `e2e/helpers.js`
- **Kaynak:** SENIOR · 2026-10-28
- **İş:** Giriş başarısız olunca `test-results/**/error-context.md` sayfanın erişilebilirlik görüntüsünü yazıyor; doldurulmuş parola alanı değeriyle görünüyor. Ajanlar bu dosyaları okuyup rapora taşıyabilir. Girişten sonra ya da hata anında parola alanı temizlensin veya hata bağlamı kapatılsın.
- **Kabul:** Bilerek bozulan girişte oluşan `error-context.md` parola içermiyor.

### T848 · Webmail etkinleştirmesi yeniden yükleme anındaki tek 502 yüzünden geri alınıyor
- **Bağımlı:** —
- **Sahip:** SENIOR
- **Dosyalar:** `packages/host-runtime/src/roundcube-config-activator.js`, `packages/host-runtime/test/roundcube-config-activator.test.js`
- **Kaynak:** SENIOR · 2026-10-28 (T823 canlı doğrulaması)
- **İş:** `assertHttpHealthy` PHP-FPM/Nginx yeniden yüklemesinden hemen sonra her webmail adresini tek kez yokluyordu; .28'de bu anda bir istek 502 aldı ve `roundcube_mapping` her denemede `website_roundcube_apply_failed` ile geri alındı. Kısa aralıklı sınırlı yeniden deneme; kalıcı hata yine geri alır.
- **Kabul:** Önce kırılan birim testi; `npm test`; .28'de takılı `roundcube_mapping` adımı yeniden denemeyle geçiyor.

### T849 · KRİTİK: posta alan adlı site silinirken DNS adımı kendi posta temizliği yüzünden düşüyor
- **Bağımlı:** T825
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/domain-removal-runtime.js`, `apps/api/test/domain-removal-runtime.test.js`
- **Kaynak:** SENIOR · 2026-10-28 (T825 canlı doğrulaması)
- **İş:** Alan adı silme planı `authoritativeDns.zoneSnapshotDigest`'i başlangıçta sabitliyor; aynı zincirin `mail_domain` adımı MX/SPF/DKIM/DMARC kayıtlarını silince bölge özeti değişiyor ve `007:authoritative_dns` `domain_removal_dns_preview_drift` ile kalıcı `failed` oluyor (.28: `teml09-acodex-mvs6ww4k-target.webrich.news`, posta alan adı ve site bağlantısı silinmiş, bölge ve site kalmış). Özet, zincirin kendi önceki adımlarından sonra yeniden sabitlenmeli; zincir dışı değişiklik yine durdurmalı. Sonra .28'de 6 askıdaki + 2 draft `teml09-*` sitesini temizle, T819'u koş.
- **Kabul:** Önce kırılan birim testi; `npm test`; .28'de posta alan adlı site panelden tamamen siliniyor (404).
