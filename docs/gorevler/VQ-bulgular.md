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
