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
- **Dosyalar:** `packages/host-runtime/src/dns-parent-ds-inspector.js`, `packages/host-runtime/test/dns-parent-ds-inspector.test.js`
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
- **Kilit:** domain-removal
- **Kaynak:** SENIOR · 2026-10-28 (T825 canlı doğrulaması)
- **İş:** Alan adı silme planı `authoritativeDns.zoneSnapshotDigest`'i başlangıçta sabitliyor; aynı zincirin `mail_domain` adımı MX/SPF/DKIM/DMARC kayıtlarını silince bölge özeti değişiyor ve `007:authoritative_dns` `domain_removal_dns_preview_drift` ile kalıcı `failed` oluyor (.28: `teml09-acodex-mvs6ww4k-target.webrich.news`, posta alan adı ve site bağlantısı silinmiş, bölge ve site kalmış). Özet, zincirin kendi önceki adımlarından sonra yeniden sabitlenmeli; zincir dışı değişiklik yine durdurmalı. Sonra .28'de 6 askıdaki + 2 draft `teml09-*` sitesini temizle, T819'u koş.
- **Kabul:** Önce kırılan birim testi; `npm test`; .28'de posta alan adlı site panelden tamamen siliniyor (404).

### T850 · Bekleyen posta alan adı silmesi, başka bir posta alan adı değişince bir daha ilerleyemiyor
- **Bağımlı:** —
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/mail-domain-removal-runtime.js`, `apps/api/src/mail-domain-removal-operation-registry.js`, `apps/api/test/mail-domain-removal-runtime.test.js`
- **Kaynak:** SENIOR · 2026-10-30 (T824/T825 canlı temizliği)
- **İş:** Silme onayında `cleanupPlan.disableConfiguration.previewDigest` ve `configurationSha256` sunucudaki **bütün** posta yapılandırmasından sabitleniyor. Arada başka bir alan adının postası eklenir/silinirse bekleyen silme `mail_domain_removal_config_preview_stale` ile kalıcı `failed` oluyor (.28: `teml09-acodex-mvs4o7vu-guard.webrich.news`, `teml09-acodex-mvs47pnd-guard.157-180-11-28.sslip.io`). Hedef alan adının kendi durumu (`sourceStatus/Revision/UpdatedAt`) değişmediyse önizleme yeniden alınmalı; hedefin durumu değiştiyse yine durmalı. Sonra bu iki siteyi panelden temizle.
- **Kabul:** Önce kırılan birim testi; `npm test`; .28'de iki site panelden siliniyor (404).

### T851 · Posta DNS gereksinimleri doğru kayıtları da "Hatalı / Eksik" gösteriyor
- **Bağımlı:** —
- **Sahip:** SENIOR
- **Dosyalar:** `apps/web/src/workspace/mail-dns-requirements.js`, `apps/web/src/workspace/MailDkimDiagnosticsPanel.jsx`, `apps/web/src/workspace/MailboxesPanel.jsx`, `apps/web/test/mail-dns-requirements.test.js`
- **Kaynak:** SENIOR · 2026-10-30 (T819 canlı koşusu)
- **İş:** Arayüz `dnsRequirements.<kayıt>.status` alanını `valid`/`matched`/`unconfigured` diye okuyor; API ise tanılama aracının `state` alanını (`present`, `ready`, `not_configured`, `missing` …) döndürüyor. Bu yüzden MX/SPF/DKIM/DMARC/PTR doğru olsa da hep hata görünüyor. Gerçek `state` değerlerinden göster; DMARC politikasını mevcut kayıttan al.
- **Kabul:** Birim testi; `npm test`; .28'de eml-09 tanılama senaryosu "Geçerli" görüyor.

### T852 · API açıldıktan sonra eklenen alan adlarının DNSSEC ekranı 404 veriyor
- **Bağımlı:** —
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/dns-zone-dnssec-http.js`, `apps/api/src/dns-zone-secondary-status-http.js`, `apps/api/src/powerdns-http.js`, `apps/api/test/dns-zone-dnssec-http.test.js`
- **Kaynak:** SENIOR · 2026-10-30 (T820 canlı koşusu)
- **İş:** `defaultService` kendi `createDomainRegistry` örneğini açılışta bir kez belleğe okuyor; panelin sonradan eklediği alan adlarını görmüyor ve `/api/domains/:id/dns/dnssec` `domain_not_found` dönüyor (UI "DNSSEC durumu okunuyor…"da kalıyor). Panelin ortak kayıt defteri kullanılsın.
- **Kabul:** Kırılan birim testi önce; `npm test`; .28'de dns-04 DNSSEC aç/kapat senaryosu çalışıyor.

### T857 · KRİTİK: 16–23 karakterlik veritabanı parolası API'nin bir sonraki açılışını kilitliyor
- **Bağımlı:** —
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/database-credential-registry.js`, `apps/api/test/database-credential-registry.test.js`
- **Kaynak:** SENIOR · 2026-10-30 (.28'de API 16:23–16:55 arası açılmadı)
- **İş:** Parola kuralı 16–128 karakter; AES-GCM şifreli metni aynı bayt uzunluğunda. Açılış denetimi base64 uzunluğunu ≥32 istediği için 16–23 karakterlik parola çalışan API'de kabul edilip kaydediliyor, ama yeniden başlatmada `Database credential envelope is invalid` ile API açılmıyor. Denetim çözülmüş bayt uzunluğuna (16–128) baksın.
- **Kabul:** Kırılan birim testi önce; `npm test`; .28'de API açılıyor ve kayıtların hepsi okunuyor.

### T858 · Doğrulama: test — Verify-TLS, renewal-outcome, and reload-outcome endpoints expose presentation chec
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-02 10:04
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - Verify-TLS, renewal-outcome, and reload-outcome endpoints expose presentation checks and handle partial reloads gracefully (live TLS and registry state)
    
     without allocating a localhost port (0.218875ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.11325ms)
    ✔ normalizes complete Node deployment specs (0.291334ms)
    ✔ normalizes fixed Node process actions against a managed release (0.645417ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (0.948584ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.209666ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.613292ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (7.442875ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.380292ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (0.492708ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.161125ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.185959ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.080625ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.070208ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (1.107167ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.083458ms)
    ✔ normalizes python rollback, restart, and status specs (0.144125ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (0.770875ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.309583ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.217709ms)
    ✔ tenant constants and role classification predicates (1.006333ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.234417ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (1.080542ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.44825ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.310542ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.298792ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.174166ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.180542ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.294375ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.170042ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.174834ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.22325ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.391333ms)
    ✔ tenant context creation and account normalization security edge cases (0.148084ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 128.330292

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T859 · eml-02, eml-06 ve bak-04 kendi test sitesiyle yeniden yazılacak
- **Bağımlı:** T181, T185, T191
- **Dosyalar:** `e2e/ozellik/eml-02.spec.js`, `e2e/ozellik/eml-06.spec.js`, `e2e/ozellik/bak-04.spec.js`
- **Kaynak:** SENIOR · 2026-11-02
- **İş:** Bu üç test paylaşılan kaynakları değiştiriyordu (`eml-02` yerel posta alan adının kutu/takma adları, `eml-06` gerçek posta alan adını kapatıp açma ve geride kalan harici alan adı, `bak-04` var olan siteye yedek planı). Kayıt dosyası/veritabanı düzenleyen temizlik kodları kaldırıldı ve testler `test.skip` ile kapatıldı. Her biri kendi test sitesini kurup kaynaklarını panelin normal akışıyla silecek şekilde yeniden yazılsın; `test.skip` kaldırılsın. Kaydı doğrudan yazmak yasak: `scripts/validate-repository.mjs` bunu reddeder. `eml-06` için panelde harici posta alan adını tek başına kaldıran yol yok; site silme kaldırıyor.
- **Kabul:** Üç test `.28`'de iki kez art arda geçiyor, sonrasında bu öneklerde kaynak kalmıyor, `npm run lint` geçiyor.

### T860 · Sunucu uyarıları: e-posta, panel içi ve panelden bağımsız nöbetçi
- **Bağımlı:** —
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/operational-notification-service.js`, `apps/api/src/operational-notification-sweep.js`, `apps/api/src/operational-notification-http.js`, `apps/api/src/notification-sentinel.js`, `apps/web/src/workspace/NotificationSettingsPanel.jsx`, `apps/web/src/workspace/NotificationCenterDrawer.jsx`, `packaging/systemd/yunpanel-sentinel.service`, `packaging/systemd/yunpanel-sentinel.timer`
- **Kaynak:** İNSAN · 2026-11-03
- **İş:** Hazır bildirim motoru hiçbir yere bağlı değildi. Otomatik kontrol, kalıcı kayıt, sahibin adresi, e-posta göndericisi, ayar ekranı, panel içi akış, yedek ve servis olayları bağlandı; panel kapanınca da uyaran bağımsız nöbetçi eklendi.
- **Kabul:** `npm test`; `.28`'de deneme e-postası gelir, API durdurulunca iki kontrol sonra kesinti, düzelince düzeldi e-postası gelir.

### T861 · Site silme: file_cleanup_preflight_failed ve unix_cleanup_evidence_unavailable
- **Bağımlı:** T853
- **Dosyalar:** `apps/api/src/website-removal-runtime.js`, `apps/api/test/website-removal-cleanup-preflight.test.js`, `docs/manuel-test/temizlik-T853.md`
- **Kaynak:** QA · 2026-11-04 12:19
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    .28'de 10 tweb sitesinde Unix kullanıcısı/provisioning kanıtı eksikliği nedeniyle silme önizlemesi file_cleanup_preflight_failed ve unix_cleanup_evidence_unavailable ile duruyor.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T862 · Doğrulama: e2e-28 — locked sunucu-28-genel by VERIFY
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-04 14:53
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    configured repository and a real preview (439ms)
      ✘   234 [chromium] › e2e/live-audit/05-ai-live.spec.js:3:1 › @ai-live Existing env key reaches real OpenRouter while the active provider is preserved (493ms)
      ✘   235 [chromium] › e2e/live-audit/05-ai-live.spec.js:20:1 › @ai-live AI streams a real nonce response and retains it after close/reopen/reload (520ms)
      ✘   236 [chromium] › e2e/live-audit/06-host-lifecycle.spec.js:11:1 › @mutation SSL issue on the disposable hostname produces a trusted, matching live certificate (438ms)
      ✘   237 [chromium] › e2e/live-audit/06-host-lifecycle.spec.js:24:1 › @mutation SSL manual renewal changes the actual fingerprint and expiry instead of returning false success (468ms)
      ✘   238 [chromium] › e2e/live-audit/06-host-lifecycle.spec.js:29:1 › @mutation A dedicated Restic repository initializes on the actual host (473ms)
      ✘   239 [chromium] › e2e/live-audit/06-host-lifecycle.spec.js:36:1 › @mutation Backup creates an actual Restic snapshot receipt before content verification (487ms)
      ✘   240 [chromium] › e2e/live-audit/06-host-lifecycle.spec.js:45:1 › @mutation A real selective Restic restore restores the saved file contents (412ms)
      ✘   241 [chromium] › e2e/live-audit/06-host-lifecycle.spec.js:55:1 › @mutation Suspension stops only the owned Website and resume restores its HTTP service (491ms)
      ✘   242 [chromium] › e2e/live-audit/07-subsystem-mutation.spec.js:21:1 › @mutation Mail domain is created through its real form for the owned Website (133ms)
      ✘   243 [chromium] › e2e/live-audit/07-subsystem-mutation.spec.js:26:1 › @mutation Two actual mailboxes are created and rendered in the owned mail workspace (408ms)
      ✘   244 [chromium] › e2e/live-audit/07-subsystem-mutation.spec.js:31:1 › @mutation Mail quota, forwarding and alias CRUD retain actual revisions (487ms)
      ✘   245 [chromium] › e2e/live-audit/07-subsystem-mutation.spec.js:41:1 › @mutation Mail apply supports real IMAP login after a password rotation (404ms)
      ✘   246 [chromium] › e2e/live-audit/07-subsystem-mutation.spec.js:46:1 › @mutation Mail delivery sends only to the disposable sibling mailbox (508ms)
      ✘   247 [chromium] › e2e/live-audit/07-subsystem-mutation.spec.js:51:1 › @mutation DNS zone provisioning and TXT create update delete run on the owned hostname (405ms)
      ✘   248 [chromium] › e2e/live-audit/07-subsystem-mutation.spec.js:58:1 › @mutation Docker Compose creates a dedicated project with no published ports (116ms)
      ✘   249 [chromium] › e2e/live-audit/07-subsystem-mutation.spec.js:62:1 › @mutation Docker pulls starts stops its own actual Compose service (453ms)
      ✘   250 [chromium] › e2e/live-audit/07-subsystem-mutation.spec.js:67:1 › @mutation Docker project offers normal teardown and removal in its real workspace (122ms)
    
    
    TIMEOUT: `bash orkestra/lock.sh acquire sunucu-28-genel VERIFY && { npx playwright test; rc=$?; bash orkestra/lock.sh release sunucu-28-genel VERIFY; exit $rc; }` 45 dakikada bitmedi; süreç grubu durduruldu.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T863 · Docker testleri projeleri panelin arkasından siliyor
- **Bağımlı:** T169, T168, T167, T166, T165, T164
- **Dosyalar:** `e2e/ozellik/dkr-01.spec.js`, `e2e/ozellik/dkr-02.spec.js`, `e2e/ozellik/dkr-03.spec.js`, `e2e/ozellik/dkr-04.spec.js`, `e2e/ozellik/dkr-05.spec.js`, `e2e/ozellik/dkr-06.spec.js`, `scripts/validate-repository.mjs`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** Bu testlerin temizlik adımı Docker konteyner, volume ve Compose projelerini `.28`'de doğrudan (`docker rm`, `docker volume rm`, `docker compose down`) siliyor; panel kaydı kalıyor ve panelin kaldırma akışı sonra bunu tutarsızlık sayıyor. Testin oluşturduğu her projeyi panelin kendi kaldırma akışıyla sil (arayüzden ya da panel API'si); doğrudan Docker silmesini kaldır. Bittiğinde `scripts/validate-repository.mjs` içindeki `liveTestWriteRules` listesine `runSsh` ile `docker (rm|volume rm|compose … down)` kuralını ekle. Site testlerindeki aynı sorun 06-11'de giderildi.
- **Kabul:** Altı test `.28`'de iki kez art arda geçiyor; sonrasında panelde ve `docker ps -a`/`docker volume ls` çıktısında testten kalan proje yok; `npm run lint` yeni kuralla geçiyor.

### T864 · Site oluşturma yarıda kalıyor: kurulum adımları ilerlemiyor
- **Bağımlı:** —
- **Sahip:** SENIOR
- **Dosyalar:** `apps/web/src/workspace/SiteCreateResult.jsx`, `apps/web/src/workspace/provisioning-client.js`, `apps/web/src/workspace/provisioning-recovery.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** 06-11 tam e2e koşusunda `.28`'de açılan 42 site kurulumundan yaklaşık yarısı bir sunucu adımında (`unix_identity`, `elfinder`, `static_runtime`, `website_database`, `tls_activation`) `pending` kalıp hiç ilerlemedi; `passenger_health` 4 sitede `blocked`. Kurulum adımlarını tarayıcıdaki sonuç ekranı ilerletiyor; oluşturma isteğinin cevabı belirsiz gelince ekran "Sunucudaki sonuç henüz doğrulanamadı" deyip duruyor, sayfa kapanınca da kurulum orada kalıyor. Sonuç: sistem kullanıcısı oluşmuyor (RUN-01), site 502 veriyor (WEB-01, WEB-08), WEB-05/RUN-05 site kaydını bulamıyor. Önce tekrar üret: oluşturma cevabı neden belirsiz geliyor, yarım kalan kurulum kullanıcıya nasıl görünüyor ve nereden sürdürülebiliyor.
- **Not (SENIOR, 06-11 13:15):** `.28` erişim kaydında bugünkü 42 `POST /api/panel/sites` isteğinin 41'i 201, biri 409 döndü; yani sunucu cevap veriyor. Kurulum adımlarını yalnız tarayıcı ilerletiyor (`site-create-submission.js` → `autoAdvanceWebsiteProvisioning`); test ya da kullanıcı sayfadan ayrılınca adımlar `pending` kalıyor. WEB-05'teki "sonuç doğrulanamadı" 201 cevabının istemcide reddedildiğini (`createdRecord` beklenen kayıtla eşleşmiyor) düşündürüyor; doğrulanacak. Karar gerekiyor: kurulum sunucuda kendi kendine mi tamamlansın, yoksa tarayıcı güdümlü kalıp yarım kurulum panelde belirgin biçimde sürdürülebilir mi olsun.
- **Kabul:** Bir site oluşturulup sonuç sayfası kapatılsa bile kurulum ya tamamlanıyor ya da panelde sürdürülebilir/geri alınabilir görünüyor; WEB-01, WEB-05, WEB-08, RUN-01, RUN-05 `.28`'de geçiyor.

### T865 · Eski kök e2e testleri güncel ekranla uyuşmuyor
- **Bağımlı:** —
- **Dosyalar:** `e2e/01-auth-users.spec.js`, `e2e/02-website-creation.spec.js`, `e2e/03-website-workspace-tabs.spec.js`, `e2e/04-native-file-manager.spec.js`, `e2e/05-native-terminal.spec.js`, `e2e/06-authoritative-dns.spec.js`, `e2e/06-logs-and-audit.spec.js`, `e2e/07-ssl-certificates.spec.js`, `e2e/08-mail-webmail.spec.js`, `e2e/08-server-settings-jobs.spec.js`, `e2e/09-ai-assistant.spec.js`, `e2e/09-databases.spec.js`, `e2e/10-docker-compose.spec.js`, `e2e/11-app-tools.spec.js`, `e2e/12-domain-operations.spec.js`, `e2e/13-system-services.spec.js`, `e2e/14-logs-audit-jobs.spec.js`, `e2e/15-ai-assistant.spec.js`, `e2e/16-ui-preferences.spec.js`, `e2e/panel.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** 06-11 koşusunda bu 80 testin 52'si düştü; çoğu artık olmayan seçicileri arıyor (ör. `table.ws-table`). Her dosya için: `e2e/ozellik` aynı davranışı zaten test ediyorsa dosyayı sil ve rapora hangi `ozellik` testinin kapsadığını yaz; etmiyorsa güncel ekrana göre düzelt. Mock kullanılmaz; panelin arkasından sunucuda silme yapılmaz.
- **Kabul:** Kalan kök testleri `.28`'de geçiyor; silinen her dosyanın karşılığı raporda yazılı; `npm run lint` geçiyor.

### T866 · RUN-05: Node.js site sihirbazı oluşturma isteği göndermiyor
- **Bağımlı:** T128
- **Dosyalar:** `e2e/ozellik/run-05.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** RUN-05 mutlu yolunda "Siteyi oluştur"a basıldıktan sonra `.28` erişim kaydında hiç `POST /api/panel/sites` yok; site oluşmuyor ve test siteyi listede bulamıyor. Önce tekrar üret: sihirbaz mı isteği göndermiyor (ürün hatası) yoksa test yanlış düğmeye/adıma mı basıyor. Ürün hatasıysa düzeltmeyi senior'a bulgu olarak yaz; test hatasıysa testi düzelt. Site listesinde arama kutusunu kullan, ilk sayfaya güvenme.
- **Kabul:** RUN-05 `.28`'de iki kez art arda geçiyor ve oluşturduğu siteyi panelden siliyor.

### T867 · WEB-01 H4 testi artık beklenmedik şekilde geçiyor
- **Bağımlı:** T846
- **Dosyalar:** `e2e/ozellik/web-01.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** "bilinen hata: Docker / Compose Proxy … boş proje kimliği 400 (H4)" testi `test.fail` ile işaretli, ama 06-11'de site boş proje kimliğiyle oluştu ve kurulumu tamamlandı; test bu yüzden kırmızı. Panelde boş proje kimliğiyle oluşan Docker sitesinin ne yaptığını incele (hangi projeye bağlandı, çalışıyor mu). Doğru davranışsa `test.fail`'i kaldırıp beklenen sonucu doğrula ve oluşturduğu siteyi temizle; yanlışsa senior'a bulgu yaz.
- **Kabul:** WEB-01 `.28`'de geçiyor; bu testin oluşturduğu site test sonunda panelden siliniyor.

### T868 · Kurulum sürerken alan adı ayarı değişince site silinemez kalıyor
- **Bağımlı:** T122, T804
- **Sahip:** SENIOR
- **Dosyalar:** `apps/api/src/domain-http.js`, `apps/api/src/management-app.js`, `apps/api/src/website-provisioning-worker.js`, `apps/api/test/domain-update-provisioning-guard.test.js`, `apps/web/src/workspace/domain-alias-model.js`, `e2e/ozellik/web-05.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** `.28`'de `tweb05-a3-mw4v7w9k.webrich.news`: WEB-05 kurulum sürerken tercih edilen alan adını değiştirdi; kurulumun `domain_activation` adımı `website_domain_activation_state_drift` ile düştü. Alan adı kaydı `active` (revizyon 2/2/2) ama nginx üzerindeki ayar kayıtla uyuşmuyor (`domain_nginx_active_state_drift`). Silme `routing_suspend` adımında `domain_removal_suspension_preview_stale` ile duruyor ve panelden çıkış yolu yok. Karar ver: kurulum bitmeden alan adı ayar değişikliği reddedilsin mi, yoksa sapmış nginx ayarı panelden yeniden uygulanabilsin mi; ve bu durumdaki site nasıl güvenle silinir.
- **Kabul:** Yeniden üretilen durumda site panelden silinebiliyor ya da kurulum sürerken ayar değişikliği net bir mesajla reddediliyor; `.28`'deki site temizlenmiş.

### T869 · 06-11 tam koşuda düşen yedek ve veritabanı testleri: BAK-05, BAK-06, DB-04, DB-05
- **Bağımlı:** T131, T130, T136, T192
- **Dosyalar:** `e2e/ozellik/bak-05.spec.js`, `e2e/ozellik/bak-06.spec.js`, `e2e/ozellik/db-04.spec.js`, `e2e/ozellik/db-05.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** Bu testler 06-11 tam e2e koşusunda düştü. O koşudan sonra site kurulumu sunucuda tamamlanır hale geldi (T864) ve silme hataları giderildi; bir kısmı artık geçebilir. Her testi `.28`'de tek tek koş (yalnız bu dosyalar; tam koşu yapma) ve her biri için raporda sonucu yaz: (a) artık geçiyor; (b) test hatası: düzelt (eski seçici, kurulum bitmeden kontrol, `fetch` ile `Host` başlığı gibi; örnek: WEB-08'deki `vhostGet`); (c) ürün hatası: testi değiştirme, `orchestrator.py finding` ile senior'a yaz. Mock yok; panelin arkasından sunucuda silme yok; oluşturduğun her kaynağı panelden temizle.
- **Kabul:** Her test için (a)/(b)/(c) sonucu raporda; (a) ve (b) olanlar `.28`'de iki kez art arda geçiyor; testlerden sonra `.28`'de bu görevin öneğiyle kalan site yok.

### T870 · 06-11 tam koşuda düşen dosya ve çalışma ortamı testleri: DOS-05, DOS-09, DOS-10, RUN-04, RUN-06, RUN-07, RUN-08
- **Bağımlı:** T157, T156, T129, T155, T153, T152, T148
- **Dosyalar:** `e2e/ozellik/dos-05.spec.js`, `e2e/ozellik/dos-09.spec.js`, `e2e/ozellik/dos-10.spec.js`, `e2e/ozellik/run-04.spec.js`, `e2e/ozellik/run-06.spec.js`, `e2e/ozellik/run-07.spec.js`, `e2e/ozellik/run-08.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** Bu testler 06-11 tam e2e koşusunda düştü. O koşudan sonra site kurulumu sunucuda tamamlanır hale geldi (T864) ve silme hataları giderildi; bir kısmı artık geçebilir. Her testi `.28`'de tek tek koş (yalnız bu dosyalar; tam koşu yapma) ve her biri için raporda sonucu yaz: (a) artık geçiyor; (b) test hatası: düzelt (eski seçici, kurulum bitmeden kontrol, `fetch` ile `Host` başlığı gibi; örnek: WEB-08'deki `vhostGet`); (c) ürün hatası: testi değiştirme, `orchestrator.py finding` ile senior'a yaz. Mock yok; panelin arkasından sunucuda silme yok; oluşturduğun her kaynağı panelden temizle.
- **Kabul:** Her test için (a)/(b)/(c) sonucu raporda; (a) ve (b) olanlar `.28`'de iki kez art arda geçiyor; testlerden sonra `.28`'de bu görevin öneğiyle kalan site yok.

### T871 · 06-11 tam koşuda düşen rol, güvenlik, sistem ve tls testleri: API-04, ROL-01, SYS-05, TLS-03
- **Bağımlı:** T822, T821, T835, T216
- **Dosyalar:** `e2e/ozellik/api-04.spec.js`, `e2e/ozellik/rol-01.spec.js`, `e2e/ozellik/sys-05.spec.js`, `e2e/ozellik/tls-03.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** Bu testler 06-11 tam e2e koşusunda düştü. O koşudan sonra site kurulumu sunucuda tamamlanır hale geldi (T864) ve silme hataları giderildi; bir kısmı artık geçebilir. Her testi `.28`'de tek tek koş (yalnız bu dosyalar; tam koşu yapma) ve her biri için raporda sonucu yaz: (a) artık geçiyor; (b) test hatası: düzelt (eski seçici, kurulum bitmeden kontrol, `fetch` ile `Host` başlığı gibi; örnek: WEB-08'deki `vhostGet`); (c) ürün hatası: testi değiştirme, `orchestrator.py finding` ile senior'a yaz. Mock yok; panelin arkasından sunucuda silme yok; oluşturduğun her kaynağı panelden temizle.
- **Kabul:** Her test için (a)/(b)/(c) sonucu raporda; (a) ve (b) olanlar `.28`'de iki kez art arda geçiyor; testlerden sonra `.28`'de bu görevin öneğiyle kalan site yok.

### T872 · 06-11 tam koşuda düşen site ve arayüz testleri: WEB-04, WEB-06, WEB-07, UX-01, UX-04
- **Bağımlı:** T847, T123, T143, T223, T844
- **Dosyalar:** `e2e/ozellik/web-04.spec.js`, `e2e/ozellik/web-06.spec.js`, `e2e/ozellik/web-07.spec.js`, `e2e/ozellik/ux-01.spec.js`, `e2e/ozellik/ux-04.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** Bu testler 06-11 tam e2e koşusunda düştü. O koşudan sonra site kurulumu sunucuda tamamlanır hale geldi (T864) ve silme hataları giderildi; bir kısmı artık geçebilir. Her testi `.28`'de tek tek koş (yalnız bu dosyalar; tam koşu yapma) ve her biri için raporda sonucu yaz: (a) artık geçiyor; (b) test hatası: düzelt (eski seçici, kurulum bitmeden kontrol, `fetch` ile `Host` başlığı gibi; örnek: WEB-08'deki `vhostGet`); (c) ürün hatası: testi değiştirme, `orchestrator.py finding` ile senior'a yaz. Mock yok; panelin arkasından sunucuda silme yok; oluşturduğun her kaynağı panelden temizle.
- **Kabul:** Her test için (a)/(b)/(c) sonucu raporda; (a) ve (b) olanlar `.28`'de iki kez art arda geçiyor; testlerden sonra `.28`'de bu görevin öneğiyle kalan site yok.

### T873 · API-04 phpMyAdmin SSO signon 403 Access denied: /usr/lib/yunpanel/phpmyadmin/signon.php dosya grubu root kalmış
- **Bağımlı:** T216, T871
- **Dosyalar:** `e2e/ozellik/api-04.spec.js`, `packages/config-templates/src/phpmyadmin-signon.js`, `packages/host-runtime/src/phpmyadmin-config-activator.js`
- **Kaynak:** QA · 2026-11-06 15:49
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    API-04 test 1 ve test 2'de POST /tools/phpmyadmin/__yunpanel/signon isteği 403 Forbidden (Access denied.) dönüyor. İnceleme: Nginx fastcgi_param SCRIPT_FILENAME /usr/lib/yunpanel/phpmyadmin/signon.php olarak unix:/run/php/yunpanel-phpmyadmin.sock'a yönlendiriyor. PHP-FPM pool kullanıcısı yunpanel-phpmyadmin (gid 115). Ancak sunucudaki /usr/lib/yunpanel/phpmyadmin/signon.php dosyasının izinleri -rw-r----- 1 root root olarak kalmış (grubu yunpanel-phpmyadmin değil root). PHP-FPM pool kullanıcısı dosyayı okuyamadığı için Nginx/PHP-FPM Access denied. (403) dönüyor. packages/host-runtime/src/phpmyadmin-config-activator.js içinde bridgePath için gid: runtimeIdentity.gid ile atomicReplace yapılıyor; ancak sunucu ortamındaki dosya güncellenmemiş veya host kurulumunda chgrp yunpanel-phpmyadmin uygulanmamış.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T874 · DB-04 & DB-05: phpMyAdmin signon.php dosya grubu root kalmış, FastCGI 403 Permission denied dönüyor
- **Bağımlı:** T130, T131, T869
- **Dosyalar:** `packages/host-runtime/src/phpmyadmin-config-manager.js`, `e2e/ozellik/db-04.spec.js`, `e2e/ozellik/db-05.spec.js`
- **Kaynak:** QA · 2026-11-06 15:58
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Nginx fastcgi_param SCRIPT_FILENAME /usr/lib/yunpanel/phpmyadmin/signon.php olarak unix:/run/php/yunpanel-phpmyadmin.sock'a yönlendiriyor. PHP-FPM havuzu yunpanel-phpmyadmin kullanıcısıyla çalışıyor. Sunucudaki /usr/lib/yunpanel/phpmyadmin/signon.php dosyasının sahipliği -rw-r----- 1 root root kalmış (grubu yunpanel-phpmyadmin değil root). Nginx error.log'da 'Unable to open primary script: /usr/lib/yunpanel/phpmyadmin/signon.php (Permission denied)' hatasıyla 403 Forbidden dönüyor ve DB-04 (SSO açılış) ile DB-05 (SQL dışa aktar) testleri bu nedenle phpMyAdmin oturumu açamıyor.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T875 · WEB-05 "SSL olmadan" testi artık sertifikalı siteyle karşılaşıyor
- **Bağımlı:** T122, T868
- **Dosyalar:** `e2e/ozellik/web-05.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** Site kurulumu artık sunucuda tamamlandığı için (T864) aynı `describe` içindeki site sertifikasını da alıyor; "hatalı girdi ve sınır durumu: SSL olmadan HTTPS uyarısı" testi sertifikasız site varsaydığından uyarıyı bulamıyor. Bu senaryo için sertifikasız bir durum kur (ör. HTTPS kapalı oluşturulan ayrı bir test sitesi) ve uyarıyı orada doğrula; form sınır değer kontrolü aynı kalsın. Mock yok; testin oluşturduğu siteyi panelden temizle.
- **Kabul:** WEB-05 `.28`'de iki kez art arda 2/2 geçiyor; test sonunda `tweb05` öneğiyle site kalmıyor.

### T876 · Askıdan geri açılan alan adının nginx ayarı kayıttan sapıyor
- **Bağımlı:** T872, T875, T827
- **Sahip:** SENIOR
- **Dosyalar:** `e2e/helpers.js`, `e2e/ozellik/web-05.spec.js`, `e2e/ozellik/web-06.spec.js`
- **Kaynak:** SENIOR · 2026-11-06
- **İş:** 06-11'de WEB-06'nın (askıya al / geri aç / sil) bıraktığı 6 sitenin ve WEB-05'in bir sitesinin alan adı `active` görünürken askıya alma önizlemesi `domain_nginx_active_state_drift` veriyordu; silme `routing_suspend` adımında `domain_removal_suspension_preview_stale` ile durdu. Panelin `stage` + `activate` adımları ayarı düzeltti ve siteler silinebildi. Tekrar üret: hangi adım (geri açma, tercih edilen alan adı değişikliği) nginx ayarını kayıttaki özetle uyumsuz bırakıyor. Düzelt; WEB-06 testinin sonunda sitenin panelden silinebildiğini doğrulat.
- **Kabul:** Askıya al → geri aç → sil akışı `.28`'de onarım adımı olmadan tamamlanıyor; birim testi var.

### T877 · live-audit salt okunur testlerini kendi ayarıyla koş ve ayıkla
- **Bağımlı:** —
- **Dosyalar:** `e2e/live-audit/01-route-inventory 02-critical-flows 03-responsive-and-auth 08-forms-and-navigation 12-source-ui 14-native-source-ui 17-native-source-screen-coverage 21-native-mobile-site-navigation.spec.js`
- **Kaynak:** SENIOR · 2026-11-07
- **İş:** `e2e/live-audit` testleri yalnız kendi ayarıyla koşar (`playwright.live-audit.config.js`, hazırlık `e2e/live-audit/setup.js`); 06-11'den beri varsayılan koşuda yoklar ve uzun süredir düzgün koşulmadılar. Yalnız bu salt okunur dosyaları koş, `@mutation`/`@ai-live` içeren dosyaları koşma. Komut: `YUNPANEL_AUDIT_RUN_DIR=.local/browser-audit/t877-<zaman> YUNPANEL_AUDIT_LANE=read npx playwright test --config=playwright.live-audit.config.js <dosyalar>`. Her seferinde yeni bir run klasörü kullan; `.local/browser-audit/current` eski bir koşuya ait, kullanma. Her düşen test için raporda sonucu yaz: (a) artık geçiyor; (b) test hatası, düzelt (eski seçici, ekran metni değişmiş); (c) ürün hatası, testi değiştirme, `orchestrator.py finding` ile senior'a yaz. Run klasöründeki dosyaları rapora kopyalama (giriş bilgisi içerebilir), yalnız sonuç sayılarını yaz.
- **Kabul:** Her düşen test için (a)/(b)/(c) raporda; (a) ve (b) olanlar iki koşuda da geçiyor; test sunucusunda hiçbir şey değişmedi (salt okunur).

### T878 · Site oluşturup hemen alan adı ayarı değiştiren testler kurulumu beklesin: API-03, RUN-01, RUN-03, RUN-04, TLS-03, TLS-05, WEB-03, WEB-04
- **Bağımlı:** —
- **Dosyalar:** `e2e/ozellik/api-03 run-01 run-03 run-04 tls-03 tls-05 web-03 web-04.spec.js`
- **Kaynak:** SENIOR · 2026-11-07
- **İş:** Panel, sitenin kurulumu sürerken alan adı ve barındırma ayarı değişikliğini artık reddediyor (`domain_update_provisioning_in_progress`, T868). Bu testler site oluşturduktan hemen sonra barındırma ayarını kaydediyor ya da alan adını güncelliyor. Her birinde ilk değişiklikten önce `e2e/helpers.js` içindeki `waitForWebsiteSetup(page, domainId)` çağır; örnek: `web-06.spec.js`. Kendi bekleme kodu yazma. Yalnız bu dosyaları `.28`'de koş, tam koşu yapma.
- **Kabul:** Sekiz test `.28`'de iki kez art arda geçiyor (beklenen `test.fail`'ler hariç); testlerden sonra bu görevin öneğiyle site kalmıyor.

### T879 · Live-audit native source testleri (14, 17, 21) salt okunur lane'de YUNPANEL_AUDIT_ACCEPTANCE_SHA ve mutation fixture'ı gerektiriyor
- **Bağımlı:** —
- **Dosyalar:** `e2e/live-audit/14-native-source-ui.spec.js`, `e2e/live-audit/17-native-source-screen-coverage.spec.js`, `e2e/live-audit/21-native-mobile-site-navigation.spec.js`
- **Kaynak:** QA · 2026-11-07 10:24
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    14-native-source-ui.spec.js, 17-native-source-screen-coverage.spec.js ve 21-native-mobile-site-navigation.spec.js testleri başında YUNPANEL_AUDIT_ACCEPTANCE_SHA (64 karakter hex sha) ve m.fixture.provisioningReady / createdDomainIds doğrulaması yapmaktadır. Bu koşullar yalnız özel acceptance adımı ve mutation fixture'ları ile sağlandığı için salt okunur lane'de (YUNPANEL_AUDIT_LANE=read) bu testler doğrudan koşulamaz durumdadır.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T880 · live-audit değişiklik yapan testlerini kendi ayarıyla koş ve ayıkla
- **Bağımlı:** —
- **Dosyalar:** `e2e/live-audit/04-mutation-lifecycle 06-host-lifecycle 07-subsystem-mutation 09-role-mutation 10-removal-mutation 11-component-cleanup-mutation 13-native-source-mutation 15-native-source-removal-mutation 16-native-hosting-dns-restore 18-native-application-environment 19-native-hosting-settings 20-native-tenant-sites 22-native-hosting-file-settings.spec.js`
- **Kaynak:** SENIOR · 2026-11-07
- **İş:** T877'de salt okunur hat geçti. Şimdi `@mutation` dosyaları: her biri `.28`'de kendi test kaynağını kurar, değiştirir ve siler. `05-ai-live` kapsam dışı. Komut: `YUNPANEL_AUDIT_RUN_DIR=.local/browser-audit/t880-<zaman> YUNPANEL_AUDIT_LANE=mutation npx playwright test --config=playwright.live-audit.config.js <dosya>`; her dosyayı ayrı ve yeni bir run klasörüyle koş. Gerçek sertifika isteyen adımlar Let's Encrypt sınırına takılırsa bunu (c) olarak değil "dış sınır" olarak yaz ve geç. Her düşen test için: (a) artık geçiyor; (b) test hatası, düzelt; (c) ürün hatası, testi değiştirme, `orchestrator.py finding` ile senior'a yaz. Panelin arkasından sunucuda silme yapma; her dosyadan sonra o dosyanın kurduğu siteleri, alan adlarını, veritabanlarını ve projeleri panelden kontrol et ve kalan varsa panelden sil. Run klasöründeki dosyaları rapora kopyalama.
- **Kabul:** Her dosya için sonuç raporda; (a) ve (b) olanlar iki koşuda da geçiyor; testlerden sonra `.28`'de `ypaudit-` öneğiyle kaynak kalmıyor.

### T881 · Provision edilen DNS zone sonrası domain/website silme dns_zone_delete_ownership_evidence_required ile kilitleniyor
- **Bağımlı:** T852, T868
- **Dosyalar:** `apps/api/src/dns-zone-ownership-registry.js`, `apps/api/src/dns-zone-retirement.js`, `apps/api/src/powerdns-http.js`, `apps/api/src/index.js`, `apps/api/src/management-app.js`, `apps/api/test/dns-zone-ownership-registry.test.js`
- **Kaynak:** QA · 2026-11-09 09:45
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    POST /api/domains/:id/dns/provision-zone ile zone açılan sitelerde, web sitesi silinmek istendiğinde (website removal operation -> domain_removal adımı) domain removal preview dnsRetirementImpact.preview den zone.ownershipOrigin?.evidenceDigest null döndüğü için domain-removal-plan.js satır 815te dns_zone_delete_ownership_evidence_required hardBlockers ekleniyor ve domain_removal_not_ready hatasıyla silme adımı blocked kalıyor. Bu durumdaki siteler panelden silinemez duruma düşüyor.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T882 · live-audit 04, 10 ve 11: kalan düşmeleri ve sessiz atlamaları çöz
- **Bağımlı:** —
- **Dosyalar:** `e2e/live-audit/04-mutation-lifecycle.spec.js`, `e2e/live-audit/10-removal-mutation.spec.js`, `e2e/live-audit/11-component-cleanup-mutation.spec.js`
- **Kaynak:** SENIOR · 2026-11-09
- **İş:** T880'den kalanlar. (1) `11`: posta verisi silme işi (`mail_data_delete`) sunucuda `local_operation_failed` veriyor; nedenini sunucu kaydından bul. (2) `10`: site silme `domain_removal_not_ready` ile düştü; T881 sonrası tekrar koş, hâlâ düşüyorsa gerçek engeli `domains/:id/removal` önizlemesinden oku. (3) `04`: WordPress parola ve kaldırma testleri düğme görünmezse `test.skip` ile geçiyor; düğme kaybolsa da test sorun göstermez. Test kendi WordPress'ini kursun ya da düğme yoksa düşsün. Her dosya için `YUNPANEL_AUDIT_RUN_DIR=.local/browser-audit/<görev>-<zaman> YUNPANEL_AUDIT_LANE=mutation npx playwright test --config=playwright.live-audit.config.js <dosya>`, her seferinde yeni run klasörü. Ürün hatası bulursan testi gevşetme; `orchestrator.py finding` ile senior'a yaz. Kurduğun kaynakları panelden temizle.
- **Kabul:** Üç dosyanın her testi için sonuç raporda (geçti / test düzeltildi / bulgu numarası); `04`'te koşulsuz `test.skip` kalmadı; geçenler iki koşuda da geçiyor; `.28`'de `ypaudit-` kaynağı kalmadı.

### T883 · Eski kabul ortamına bağlı live-audit testlerini güncelle ya da kaldır
- **Bağımlı:** T886, T887, T888
- **Dosyalar:** `e2e/live-audit/13-native-source-mutation.spec.js`, `e2e/live-audit/15-native-source-removal-mutation.spec.js`, `e2e/live-audit/16-native-hosting-dns-restore.spec.js`, `e2e/live-audit/18-native-application-environment.spec.js`, `e2e/live-audit/19-native-hosting-settings.spec.js`, `e2e/live-audit/20-native-tenant-sites.spec.js`, `e2e/live-audit/22-native-hosting-file-settings.spec.js`
- **Kilit:** hosting-settings-audit, source-audit-13, terminal-removal-audit
- **Kaynak:** SENIOR · 2026-11-09
- **İş:** Bu 59 test 10 Ekim'deki geçici kabul ortamına bağlı (`YUNPANEL_AUDIT_ACCEPTANCE_SHA`, `.local/acceptance-candidate/host-control.py`, `extraStatic`) ve hemen düşüyor; yani hiçbir şey sınamıyor. Bu ortamı geri kurma. Her test için karar ver: davranışı `e2e/ozellik` veya kalan `live-audit` zaten sınıyorsa testi sil ve raporda karşılığını `dosya:test adı` ile yaz; sınamıyorsa normal koşuda (panel API'si ve arayüz, kendi kaynağını kurup silerek) çalışacak şekilde yeniden yaz. Karşılık gösteremediğin testi silme. Sunucuya root ile müdahale eden adımları panel akışına çevir; çevrilemiyorsa testi silme, raporda gerekçesiyle listele. Dosyada test kalmazsa dosyayı sil.
- **Kabul:** 59 testin her biri raporda (silindi + karşılığı / yeniden yazıldı / listelendi + gerekçe); kalan testler `.28`'de iki koşuda da geçiyor ya da bulgu numarası var; `.28`'de `ypaudit-` kaynağı kalmadı; `npm run lint` geçiyor.

### T884 · WP-CLI core download skips content and locale error on official ZIP URL during WordPress install
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/wordpress-toolkit-service.js`
- **Kaynak:** QA · 2026-11-09 11:14
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    apps/api/src/wordpress-toolkit-service.js:262 wp-cli download komutuna https://wordpress.org/latest.zip argümanı geçildiğinde wp-cli Error: Skip content and locale options are not available for URL downloads hatası vermekte ve WordPress kurulumu wordpress_rollback_failed ile başarısız olmaktadır. run() fonksiyonunun eklediği --skip-plugins/skip-themes/skip-packages ve formun getirdiği --locale seçenekleri URL download ile kullanılamaz; wp-cli core download URL argümanı olmadan download, --force, --locale olarak çalıştırılmalıdır.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T885 · T883 gerçek canlı testleri için sahipli kaynak yardımcıları eksik
- **Bağımlı:** —
- **Dosyalar:** `e2e/live-audit/owned-fixture.js`
- **Kaynak:** QA · 2026-11-12 16:31
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Normal .28 panel API kullanımı, tekil run ledger, idempotent provision ve normal cleanup, güvenli salt okunur fiziksel kanıt sağlayan ortak test yardımcısı ekle. Eski acceptance SHA/extraStatic/root mutation yok. Gerçek smoke fixture kur-sil ile doğrula. Test girdileri dışında ürün kodu ve deploy kapsam dışı.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T886 · T883 site DB posta WordPress ve silme senaryoları eksik
- **Bağımlı:** T885, T900
- **Dosyalar:** `e2e/live-audit/13-native-source-mutation.spec.js`, `e2e/live-audit/15-native-source-removal-mutation.spec.js`
- **Kaynak:** QA · 2026-11-12 16:31
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Silinen 13 ve 15 dosyalarındaki 17 mantıksal senaryoyu güncel normal UI/API ve yalnız sahipli kaynaklarla tamamla; eski acceptance ortamını geri kurma. Her assertion için gerçek kanıt, iki fresh run veya gerçek bulgu kaydı; restart gibi desteklenmeyen adımı açık gerekçesiyle koru, skip/pass sayma. Testleri gevşetme; ürün değişikliği/deploy yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T887 · T883 hosting DNS ve gerçek Node ortam geri yükleme senaryoları eksik
- **Bağımlı:** T885
- **Dosyalar:** `e2e/live-audit/16-native-hosting-dns-restore.spec.js`, `e2e/live-audit/18-native-application-environment.spec.js`, `e2e/live-audit/19-native-hosting-settings.spec.js`, `e2e/live-audit/22-native-hosting-file-settings.spec.js`
- **Kaynak:** QA · 2026-11-12 16:31
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Silinen 16 18 19 22 dosyalarındaki 18 mantıksal senaryoyu native .28 UI/API ve sahipli kaynaklarla tamamla. Eski env/SHA/extraStatic/root mutation yok. HTTP header/body/index/error, responsive/negative, DNS hosting backup rollback ve actual Node secret restore assertions. İki fresh run veya bulgu numarası; fiziksel kanıt ve tam cleanup, ürün kodu/deploy yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T888 · T883 gerçek tenant site job terminal ve iptal zinciri kapsamı eksik
- **Bağımlı:** T885
- **Dosyalar:** `e2e/live-audit/20-native-tenant-sites.spec.js`
- **Kaynak:** QA · 2026-11-12 16:31
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Silinen 20 dosyasındaki üç mantıksal senaryoyu normal native .28 UI/API ile yeniden yaz. İki reseller müşteri ve doğrudan müşteri için 3 ayrı gerçek site/UID/release/HTTP; API job tool WS izolasyonu ve parent revoke; normal UI removal ve fiziksel/account cleanup. Eski acceptance/SHA/localdist/root mutation yok. İki fresh run veya gerçek bulgu, ürün/deploy yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T889 · Yeni PHP sitesi ilk kurulumunda PHP-FPM uygulama doğrulaması aralıklı başarısız
- **Bağımlı:** —
- **Dosyalar:** `packages/host-runtime/src/php-fpm-site-manager.js`, `packages/host-runtime/test/php-fpm-site-manager.test.js`, `apps/api/src/website-php-runtime-provisioning-handler.js`, `apps/api/test/website-php-runtime-provisioning-handler.test.js`, `apps/api/test/php-fpm-runtime-golden-path.test.js`, `e2e/live-audit/24-native-php-readiness-mutation.spec.js`, `e2e/live-audit/php-readiness-probe.js`
- **Kaynak:** QA · 2026-11-12 16:53
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T885 gerçek native .28 ilk PHP smoke: normal create/provisioning php_runtime adımı php_fpm_apply_unverified verdi; Unix kimliği, elFinder ve php_bootstrap geçti. Kaynak koduna veya host kayıtlarına müdahale yapılmadı. Aynı koşunun sitesi normal removal ile temizlendi, Website/Domain/Application404 ve kalıntı yokluğu doğrulandı. Yeni farklı PHP fixture ile tekrar tüm kurulum/HTTP/temizlik geçti; kök neden henüz kanıtlanmadı, reload/socket zamanlama varsayımı teşhis sayılmaz. Özel kanıt .local/t885-smoke/run-1794490934/owned-fixtures/t885-smoke.json ve php-repeat-*; T885 raporu. Gerçek kurulumu tekrarlayıp hatanın gerekçesini kaydet; yanlış başarısızlık/başarılılık üretmeden hazır olmayı fiziksel doğrula. Yeni deploy bu test kapsamına dahil değil.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T890 · Sahipli test yardımcısı otomatik provisioning işçisiyle devam çakışmasını yanlış hata sayıyor
- **Bağımlı:** T885
- **Dosyalar:** `e2e/live-audit/owned-fixture.js`
- **Kaynak:** QA · 2026-11-12 16:55
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T886 native ilk debug: normal UI ve normal API static create sonrası server automatic worker devam ederken owned-fixture POST /sites/provisioning/:id/continue HTTP409 site_mutation_locked alıp testi bitiriyor. Ürün hatası değildir; finalready ve requiredstep assertions korunarak yalnız belgeli409 busy/stale durumunda aynı operation okunup beklenmeli; kör mutation retry yok. UygulamaHTTP400/403 ve gerçekfailedstep yine hata. Gerçek fresh PHP/static UI/API kur-sil ile tekrar üret, düzelt, cleanup yokluğunu doğrula. Diğer dosyalara ve ürün/deploy/restarta dokunma.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T891 · PHP barındırma ayarları kaydediliyor ancak hazırlama invalid_operation_payload ile reddediliyor
- **Bağımlı:** T887
- **Dosyalar:** `packages/protocol/src/index-node-passenger.js`, `packages/protocol/test/domain-php-stage.test.js`, `apps/api/test/domain-job-flow-v2.test.js`, `e2e/live-audit/19-native-hosting-settings.spec.js`
- **Kilit:** hosting-settings-audit
- **Kaynak:** QA · 2026-11-12 17:04
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T887 native .28 /19 Chrome debug: owned PHP normal UI Kaydet ve uygula -> update-preview200, PATCH200, domain stage400 invalid_operation_payload. Yeni header,2MiBbodylimit,cache120 uygulanamadı; orijinal ayara normal API dönüşten sonraki stage de400. Aynı native pakette Node ve static hosting senaryoları geçti. .local/t883-20261112/t887-debug-19-chrome özel route/API kanıtı; altı test kaynağı normal removal ile temizlendi. Kaynak şüphesi validatePhpDomainStage PHP-only nginxSettings alanlarını inheritedPassenger doğrulamasına aktarırken staticAssetCacheSeconds alanını ayırmıyor; henüz kök neden diye kabul edilmez, dar gerçek API tekrarının mesajıyla doğrula. Testi gevşetme; PHP canonical envelope ve gerçek HTTP etkisi için regresyonu düzelt. Bu test çalışmasında deploy/servis restart yok.

- **Doğrulanmış ek kanıt (12 Kasım):** Sabit T890 yardımcıyla taze API tekrarında original `{clientMaxBodySizeMb:null,headers:[]}` üzerine yalnız `staticAssetCacheSeconds:120` eklendi: preview200/PATCH200/stage400, `invalid_operation_payload`, `domain.stage nginxSettings are invalid`, details null; aktif Nginx checksum değişmedi. Özel kayıt `.local/t883-20261112/t887-php-stage-repro-stable-1/php-stage-proof.json`. Sonraki fiziksel silme kalıntısı ayrı T892.
- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T892 · Başarısız PHP ayar hazırlamasından sonra site silme aktif Nginx dosyasını bırakıyor
- **Bağımlı:** T803, T826, T881
- **Dosyalar:** `apps/api/src/domain-registry-base.js`, `apps/api/src/domain-removal-plan.js`, `apps/api/src/domain-removal-runtime.js`, `apps/api/src/domain-removal-production-runtime.js`, `apps/api/test/domain-registry.test.js`, `apps/api/test/domain-removal-plan.test.js`, `apps/api/test/domain-removal-runtime.test.js`, `apps/api/test/domain-removal-production-runtime.test.js`, `e2e/live-audit/23-native-applied-domain-removal-mutation.spec.js`, `apps/api/src/domain-registry.js`, `apps/api/src/website-domain-activation-provisioning-handler.js`, `apps/api/src/website-provisioning-handlers.js`, `apps/api/src/website-provisioning-handlers-isolation.js`, `apps/api/src/website-provisioning-runtime.js`, `apps/api/src/website-provisioning-retirement-provider.js`, `apps/api/src/index.js`, `packages/host-runtime/src/nginx-manager.js`, `apps/api/test/website-domain-activation-provisioning-handler.test.js`, `apps/api/test/website-provisioning-retirement-provider.test.js`, `apps/api/test/website-provisioning-runtime.test.js`, `apps/api/test/website-provisioning-handlers.test.js`, `packages/host-runtime/test/nginx-manager.test.js`, `e2e/live-audit/25-native-provisioning-retirement-mutation.spec.js`
- **Kilit:** domain-removal
- **Kaynak:** QA · 2026-11-12 17:14
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T887 iki bağımsız owned native .28 lifecycle: PHP hosting update PATCH200 sonrası stage400 invalid_operation_payload (T891); normal Website removal sonra Website/Domain/Application404, Unix user/group, canonical4roots, FPM/socket ve mount yok; fakat /etc/nginx/sites-enabled/yunpanel-<exact-owned-hostname>.conf regular uid0gid0 mode0600 kalıyor. 3sn sonra salt okunur tekrar aynı. İlkdebug19 altı ledgerdan yalnız buPHP kalıntılı, diğerbeş fizikseltemiz; stableminimalAPIrepro ikinciaynıkalıntı. Özel kanıt .local/t883-20261112/t887-debug-19-chrome/physical-cleanup-summary.json ve t887-php-stage-repro-stable-1/physical-cleanup-details.json ile physical-cleanup-repeat.json. Registry/hostconfigelledeğiştirilmedi. Desiredrevision>applied sonrası draft removal eski applied Nginx hedefini kaçırıyor olabilir; kaynak çıkarımı, kanıtlanmış neden değil. Aktif config kalırken removed ilan etme; normal lifecycle ile doğrulanmış owned configi kaldır, yabancı configi koru ve gerçek HTTP/physical regresyon yaz. Bu test diliminde deploy yok; kalıntılar kanıt/scopeledger ile korunuyor.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T893 · Depo oluşturma initialize true sonrası 201 uninitialized dönebiliyor
- **Bağımlı:** T887
- **Dosyalar:** `apps/api/src/restic-repository-registry.js`, `apps/api/src/backup-repository-http.js`, `apps/api/test/restic-repository-registry.test.js`, `apps/api/test/backup-repository-http.test.js`, `e2e/live-audit/16-native-hosting-dns-restore.spec.js`
- **Kilit:** hosting-settings-audit
- **Kaynak:** QA · 2026-11-12 17:21
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T887 native16 ilk Chrome koşusu: POST /api/panel/backups/repositories initialize:true ->201 fakat repository.status=uninitialized; synchronous initialize varsayılanı backup-repository-http:72init/get/201 ready sözleşmesine uymuyor. Hazır-depo assertionı doğru nedenle kırıldı; DNS/hosting restore bu ilkkoşuda henüzçalışmadı. Ayrı init regression korunarak normal initialize:false + /init + gerçek /check + GET ready hazırlığıyla restore diğerkanallar ayrıca sınanıyor. Kaynak çıkarımı: listRepositories.reloadFromDisk stateyi değiştirirken initResticRepository await manager.init öncesi record referansı tutuyor; statusready detachedrecord üzerinde kalabilir. Kök neden gerçek eşzamanlı okuma/initialization tekrarında kanıtlanmalı; şimdilik çıkarım. Ürün/deploydeğişikliği yok, test gevşetilmez. Özel16 koşusu T887 raporunda kesin adreslenecek.

    Native ön dilim mevcut initialize:true testini genişletir: tek normal POST sırasında sınırlı iki gerçek GET/list poller; en az bir başarılı liste POST bitmeden dönmeli. Gerçek init penceresinde kendi uninitialized satırı görülemezse nedensellik açık kalır. Sonra 201 ready, kalıcı GET ready, gerçek Restic /check ve boş snapshots doğrulanır. Belirsiz POST yeniden gönderilmez; yalnız kanıtlı own repository normal metadata DELETE +404, fiziksel cleanup-required kaydıyla bırakılır. Fiziksel repo silme ayrı exact allowlist ve root incelemesi gerektirir. Sahte binary/manager/HTTP veya zaman aşımı gevşetme yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T894 · Site kurulum arayüzü worker kilit çakışması sonrası gerçek hazır durumu göstermiyor
- **Bağımlı:** T864, T886
- **Dosyalar:** `apps/web/src/workspace/provisioning-client.js`, `apps/web/src/workspace/provisioning-advance.js`, `apps/web/test/provisioning-advance.test.js`, `apps/web/test/provisioning-client.test.js`, `e2e/live-audit/28-native-provisioning-ui-race-mutation.spec.js`
- **Kaynak:** QA · 2026-11-12 17:21
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T888 gerçek Chrome normal hosted UI: 5hesap ve 3ayrı customer static site. Üçüncü directcustomer site durableoperation GET ready:true ve10zorunluadım succeeded; fakat nativeUI kırmızı Site kaydı oluşturuldu ancak kurulumun son durumu doğrulanamadı mesajında sftp/nginx/static/domainpending göstererek kaldı. Trafik aynı /sites/provisioning/<id>/continue için409, pageErrors boş. LocalUIoverlay/mock yok. İlkikisimarkerHTTP/UID geçti; bu UIassert gevşetilmedi, sonraki2serialcase ilkkoşudaçalışmadı. Özel ekran/traffic .local/t883-20261112/t888-chrome-20261112-01. Sunucu hazırken istemci hata gösteriyor; yalnız belgeli preexecution409 sonrası aynıdurableişi okuyup görünümü doğru sonuca taşı. Transport belirsizliğinde yeni create veya kör retry yok, failed/blocked gerçekdurum saklanmaz. Bu test diliminde deploy yok.

    T886 selected13-q1 bağımsız yeni Owner static form varyantı: aynı POST continue409 sonrası arayüz180s boyunca altı succeeded/dört pending gösterdi; gerçek UIhazır assertionı kırıldı ve13 bağımlı senaryo çalışmadı. İşlem e6e8f8d4-d80e-4536-9915-0d3f608442a7, Website4f9b931f-1335-5659-ae4a-5f025803a835. Bu koşuda409 gövde kodu saklanmadığından bilinmiyor; site_mutation_locked nedeni varsayılmıyor. Yalnız normal cleanup SONRASI aynı operation GET200/ready:true/10succeeded okundu; backend'in hata ANINDA hazır olduğu bu varyantla kanıtlanmış sayılmaz. İki owned site normal kaldırıldı, katalog+Unix/group/canonicalroots/mount/FPM/socket/Nginx yokluğu gerçek pinnedprobe ile doğrulandı; kendi oturumu kapatıldı. Özel t886-selected13-q1 tarayıcı/traffic, safe-ui-provisioning-readback.json, at-rest-proof.json ve run-cleanup-physical-proof.json; kaynak13 7ae4e91c/helperc26e8c13 koşu boyunca değişmedi. Yeni test gözlemcisi bundan sonra yalnız own operationID/status/error.code saklar; ham yanıt/mesaj/token yok. Bu aynıT894 ailesine ek kanıttır, ayrı yeni ürün bulgusu değildir.

    Native28 kaynak dilimi önce yalnız yeni test dosyasını yazar: en fazla üç fresh sahipli normal UI statik kurulum denemesi; her denemede tek create, aynı gerçek durable operation üzerinde ikinci gerçek istemciden en fazla iki normal continue (her biri bir kez ve authoritative durum/kimlik kontrolüyle). Gerekirse yalnız own UI continue isteğinde sınırlı pass-through route.continue gönderim bariyeri kullanılır; HTTP yanıtı, istek içeriği veya backend durumu uydurulmaz/değiştirilmez. Gerçek UI409 ve mevcut belgeli preexecution code gözlenmeli; o anda aynı operation GET, ardından backend ready/allrequired succeeded ve aynı sitenin gerçek DOM hazır hali birlikte kanıtlanır. Yalnız ikinci istemcinin409'u veya sıradan happy UI bu kapıyı kapatmaz. Belirsiz POST tekrarı, ilave create, lock dosyası/registry/servis müdahalesi yok; bilinen kimlikle yalnız okuma/normal yaşam döngüsü. Her deneme normal cleanup ve fiziksel yoklukla biter; kaynak motorlarına ancak gerçek yeni hata tekrar üretildikten sonra dokunulur.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T895 · T883 doğrulanmış davranış matrisi ve sonraki öncelikler güncel belgede yok
- **Bağımlı:** —
- **Dosyalar:** `docs/test-scenarios-matrix.md`, `docs/t883-coverage-and-priorities-2026-11-12.md`
- **Kaynak:** QA · 2026-11-12 17:25
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Kullanıcının 12 Kasım talebi: T883 test kapsamı açığını gerçek .28 sonuçlarıyla değerlendir, ardından site kopyalama ve kalan özellikler için öncelikli plan çıkar. 38 eski mantıksal senaryo/59 proje koşusunun assertion auditini, yeni gerçek test adı/dosyası ve çalıştırıldı-geçti/hata-bulgu/çalışmadı/izinli kanala çevrilemeyen kapı ayrımıyla yaz. Başlangıç matrisi 22kısmi16eksik0tam; eski yanlış kabul tekrarlanmaz. Her gerçek yeni koşunun source/hash/paket sınırı, physicalcleanup ve kalan ownresidue açık olsun. Site kopyalamayı uygulama; mevcutWPclone motorunu ve genelcopy eksiğini kaynakla ayırıp öncelik+bağımlılık+kabul ölçütleri öner. Kök plan.md ve senior rol dosyaları değiştirilmez; bu doküman öneri ve test raporudur. Testler bitene kadar belgeyi açık/ara olarak tut; tüm ilgili kaynak kapısı sonunda sonuçları kesinleştir.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T896 · Canlı test yardımcısı belirsiz oluşturma sonrası null journal yanıtını yanlış ayrıştırıyor
- **Bağımlı:** T885, T890
- **Dosyalar:** `e2e/live-audit/owned-fixture.js`
- **Kaynak:** QA · 2026-11-12 17:33
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T887 22 q1b gerçek create transport belirsizliğinden sonra GET provisioning/latest HTTP200 {data:null}, Website404; f.call body.data null değerini nullish fallback ile {data:null} wrapper yapıp recoverCreation operation.websiteId undefined assertion atıyor. Bu ürün değil test yardımcısı kusuru. Dar düzeltme: data field mevcutsa null koru; latest null ise aynı identity bounded read ve açık belirsiz/notcreated hata, create tekrar yok. Previewden doğrulanmış expected UnixUser/documentRoot bilgisini erken ledgera kaydederek başarısız/hiçoluşmamış fixture cleanup fiziksel yokluk kanıtını da mümkün kıl; kimlik tahmini/yenidenatama yok. SafeApi tarafından zaten maskelenmiş transport için yalnız allowlist ECONNRESET/socket hang up/timeout/context-disposed gibi güvenli hint koru; headers/cookie/URLquery/rawcause yok. Tekrarlı mutationlarda stale keep-alive şüphesini ayırmak için normal API client Connection:close transportu kullanılabilir, gerçek status/assertionlar değişmez. Native gerçek API/UI smokes +null read contract proof +lint; ürün/deploy/rootwrite yok. Diğer ajan kaynakları değişmez.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T897 · Statik site silme tamamlandıktan sonra çalışan PHP WordPress kardeş site 502 verdi
- **Bağımlı:** T861, T891
- **Dosyalar:** `packages/host-runtime/src/elfinder-fpm-site-manager.js`, `packages/host-runtime/test/elfinder-fpm-site-manager.test.js`, `e2e/live-audit/27-native-fpm-retirement-mutation.spec.js`, `apps/api/src/website-elfinder-provisioning-handler.js`, `apps/api/test/website-elfinder-provisioning-handler.test.js`
- **Kaynak:** QA · 2026-11-12 17:37
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T886 13 fullq1 native .28: yeni PHP sitenin Türkçe WP kurulumu, gerçek publicHTTP200 ve fresh adminlogin önce geçti. Ayrı owned static site normal removal tamamlandı, Website/Domain/Application404; hemen sonraki PHP sibling rootHTTP ilk yanıt502 (200 bekleniyor), WPstatus installedtrue. Strict assertion korunuyor; kaynak/runtime neden henüzkanıtlanmadı. T889 ilkPHPFPMapply bulgusu ayrı; aynı neden diye varsayma. Koşu5pass1fail8upstreamnedeniyleçalışmadı; her iki owned yaşam döngüsü normaltemizlendi. Özel .local/t883-20261112/ altında T886 lifecycle-q1 kanıtı. Siblinggate sonrasına taşınarak diğerkanallar ayrıca çalıştırılıyor, bu hata başarıya çevrilmiyor. Yeni before/after pinnedvhostHTTP/Nginxhash/safeFPMreadback ve boundedtakip, ilk502yi gizlemeden nedeni ayıracak. Kaynak düzeltmesi varsa dedicateduser ve çalışan kardeşlerin sürekliliği korunmalı. Bu test diliminde deploy/servisrestart yok.


    13 Kasım 2026 İNSAN onayı: T889 tarihsel nedensellik kapısı AÇIK kalır; bu görev T861/T891 kaynak önkoşullarıyla bağımsız gerçek elFinder FPM retirement kusurunu düzeltir. Onaylanan .local/antigravity-review-20261113/t889-gate-decision-proposal.md kapsamıdır. İlk502'nin nedeni aynıymış gibi yazılmaz. Somut kaynak açıklığı: static removal elFinder compensate/retire ve identity cleanup yollarında ortak PHP-FPM'i tekrarlı reload edebiliyor; kendi pool/socket yokluğunu kontrol ederken önceden sağlıklı kardeş listener'ların geri hazır olmasını doğrulamadan terminal başarı dönebiliyor. Mevcut manager/receipt/configtest/hash/drift/retained-pool korumaları korunarak reload tekrarı kaldırılmalı ve önceden sağlıklı aynı-servis listener'ları gerçek bounded readiness ile korunmalı. Yeni FPM motoru, sahte binary/socket/HTTP veya servis bozma yok.
    Zorunlu mevcut API bağlantısı: inspectRetirement wrapper aynı operationId değerini mevcut FPM manager’a aktarır; checkpoint durum/sağlık kontrolü API inspect kısa yolunda düşürülemez. Bu dar aktarım ve gerçek dosya/manager ile doğrulaması aynı retirement düzeltmesidir; yeni motor veya tarama fallback’i yoktur.
    Önce yeni native27 senaryo matrisi ve gerçek eski davranış kanıtı; sonra dar kaynak dilimi. Aynı normal static removal, en az iki fresh gerçek PHP sibling, her ilk dynamic nonce/nonrootUID/fpm-fcgi/no-store200, mümkünse gerçek journal/typed reload sayısı ve idempotent retirement; bozuk/foreign/retained receipt, drift ve hata/rollback sınırları; aynı PHP sürümü ve exact pool/socket kimliği. Her own kaynak normal API ile temizlenir; canonical Unix/group/FPM/socket/Nginx/mount yokluğu ve orijinal site kimlikleri/ilk canonical TLS200 korunur. Native test yalnız root tarafından izinli .28'de, kaynak fulltest+bağımsız inceleme ve eşleşen paket onayından sonra kabul edilir. Eski failed native kayıtlar korunur. T898 bundan sonra kalır. T889 veya genel P0 bu görevle kapanmaz.

    13 Kasım ek gerçek karşı örnek: 13.04/source391 native20 açık B terminaliyle Unix adımında failed oldu; browser context kapanıp Direct normal silindikten sonra B’nin original receipt compensated/checkpoint retired/own pool+socket absent durumunda kurulu manager salt okunur inspect `sibling_pending` verdi. Başarılı eski retirement kaydı, sonradan normal silinen sibling’i sonsuza kadar beklememeli. Yalnız doğrulanmış terminal pair için mutasyonsuz tekrar denetimi, aynı FPM binary/effective config tam resolved Unix listen seti ve actual kernel/socket yokluğu ile artık tanımlı olmayan eski listener’ı ayırır; hâlâ configured missing listener, parse belirsizliği veya own config/socket yeniden görünmesi kapalı kalır. Prepared/reload_started immutable baseline ve ilk readiness koşulu değişmez; checkpoint/receipt baseline yeniden yazılmaz. Mevcut beş dosya kapsamı ve yeni native27 geç kontrolü + aynı B journal’ın normal API devamı, tam test ve yeni eşleşen paket gereklidir. Ham FPM dump/env loga veya UI/API çıktısına çıkmaz. T898 ilk terminal hatası ve eski 502 nedenselliği ayrı korunur.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T898 · Açık geçerli site terminali normal silmede kapanmadan Unix kullanıcı temizliği başarısız oluyor
- **Bağımlı:** T861, T897, T892, T888
- **Dosyalar:** `apps/api/src/live-session-registry.js`, `apps/api/src/terminal-capability-registry.js`, `apps/api/src/terminal-process-manager.js`, `apps/api/src/ttyd-session-manager.js`, `apps/api/src/terminal-websocket.js`, `apps/api/src/website-removal-runtime.js`, `apps/api/src/index.js`, `apps/api/test/live-session-registry.test.js`, `apps/api/test/terminal-capability-registry.test.js`, `apps/api/test/website-removal-runtime.test.js`, `apps/api/test/website-removal-runtime-binding.test.js`, `apps/api/test/website-removal-cleanup-preflight.test.js`, `apps/api/test/terminal-websocket-policy.test.js`, `apps/api/test/ttyd-session-manager.test.js`, `apps/api/test/terminal-production-wiring.test.js`, `e2e/live-audit/20-native-tenant-sites.spec.js`
- **Kilit:** terminal-removal-audit
- **Kaynak:** QA · 2026-11-12 18:16
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T888 Chrome04 tam165API/CSRF/job/5PTY/revoke güvenlik senaryosu geçti. RA/CA iptal4001, B/directPTYler geçerliaçık kaldı. Sonraki normal UI silmede A başarılı; açık Bterminali varken B journal unix_identity_cleanup / website_identity_compensation_user_failed ile failed. Domain/root/Nginx/FPM/socket/mount kaldırılmış, UnixUID986 user/group ve Website/App metadata kaldı. afterAll actorbrowsercontexts kapatıldı; aynı failed journal authoritativeread sonrası bir /run202 ile removed/5adım succeeded oldu ve normalcb/rbprofile/logincleanup tamamlandı. Root/process/registrywrite veya Unixforce delete yok. Originalfailurekorunur; gerçek activePTYrevocationremovaldanönceolsun ve aynıjournal ilerlesin. Özel t888-chrome-20261112-04/t888-final-recovery-cleanup-proof.json ve orijinal journal/traffic kanıtları. Firefoxsecurity henüzçalışmadı. Bu dilimde ürün/deploydeğişikliği yok.


    13 Kasım İNSAN onaylı t889-gate-decision-proposal kapsamı: T897 bağımlılığı ve T889 OPEN korunur. T892/T888 yalnız mevcut index/native20 yazarlarının kabul edilmiş kaynak önkoşullarıdır; hiçbir açık kabul atlanmaz. Kesin inceleme .local/antigravity-review-20261113/t898-readonly-scope/proposal.md. Mevcut shared registry/NodePTY/ttyd/capability/WS/removal nesnelerinde Website-ID fence + ilk async işlem öncesi pending-open lease + doğrulanmış awaitable drain uygulanır. Başka motor, auth/Unix adapter veya gateway yeniden yazılmaz.
    Fence ilk kalıcı removal journal'da ve startup/init'te unfinished journal için kurulur; aynı journal retry sırasında sürer. Fence sonrası capability issue/consume/WS/ttyd open/authorize reddedilir; fence öncesi pending lease geç child yaratırsa o da kendi lifecycle ile kapanıp gerçek exit/drain beklenir. En az file_cleanup ve kesinlikle unix_identity_cleanup öncesi kendi Website terminal drain doğrulanır. WS close veya map boşluğu tek başına yetmez: gerçek child exit, bilinen sahipli process/group yokluğu ve ttyd socket cleanup gerekir; EPERM, PID-reuse veya belirsizlikte kapalı kalır. Root ve başka Website/tenant oturumları korunur; UID-genel arama/kill, forceuserdel, servis bozma, yeni terminal motoru veya belirsiz mutation retry yok. Terminal dışı detached süreçlerin evrensel temizliği iddia edilmez.
    Mevcut fake spawn/EventEmitter/fs/HTTP testleri yeni native kabul için genişletilmez. Saf registry/state ve gerçek file-backed journal kanıtları davranış sınırı içindir; gerçek OS/child/group/socket/RBAC/CSRF/WebSocket/drain/ilk sibling challenge kabulü native20'de normal Owner/Reseller/Customer tarayıcı/API yaşam döngüsünde yapılır. Native timeout veya gerçekleşmeyen pending-race OPEN kalır; ilk hata sonraki yeşille silinmez. Kaynak fulltest + bağımsız review + eşleşen yeni paket + iki fresh gerçek run + tüm metadata/canonicalUnix/FPM/socket/Nginx/mount/DB cleanup olmadan bitmiş sayılmaz. Host/native test rootta seri yürür, source maker bu kapsamda host/network işlemez.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T899 · Paralel normal işlerde kuyruk recovery required 503 ile geçici kapanıyor
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/durable-job-registry.js`, `apps/api/src/local-runtime.js`, `apps/api/test/durable-job-live-reconciliation-concurrency.test.js`, `e2e/live-audit/26-native-job-concurrency-mutation.spec.js`
- **Kaynak:** QA · 2026-11-12 18:16
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T886 lifecycle-q3 üçpozitifakıştan sonra PHPconfig enqueue503 durable_job_reconciliation_required; yeni işoluşmadı ve POSTtekrarlanmadı. Önceki WordPressqueue503kodu yakalanamadığıiçin aynı neden sayılmaz. Diğer ikiworker in-flight normalişleri bitirdi, yeni batchlerdurduruldu. Normal APIqueued0/running0 ve ownjobs terminal; kök saltokunur disk projection job-registry.json.recovery.json version1 jobs[]; APIuptime10Kasım21:07 active NRestarts0. Dolayısıyla bu gözlemde panelrestart veya kalıcıdosyadüzenleme yapılmadı, bekleyenrecoverystate bulunmadı. Kaynak çıkarımı: automaticcomplete/reconciliationack penceresi globalenqueueguardı geçici etkileyebilir; henüzkök nedenkanıtlanmadı. Native UI/API bu durumda gerçekkalıcırequestkimliğiyle doğruyenileme/güvenlibudget göstermeli; genelretry/blindPOSTolmaz. Eşzamanlıgerçekikiişile tekrarüret, sağlamack/jobdurumunu ölç; güvenlikgatekapatılmaz. Şimdi kalanmutatingpozitifkapsam sıralıkoşulacak, builk503başarıyasayılmaz.

    Native26 ön dilimi: iki normal sahipli statik siteyi sırayla kur, gerçek HTTP nonce ve aktif Nginx hash doğrula; en fazla üç dalgada normal draft ayar/preview ve iki ayrı domain için eşzamanlı stage/activate job POST'ları. Her POST tek gönderim, 202 ve farklı gerçek job ID zorunlu; tüm own jobs terminal succeeded, gerçek config/HTTP header etkisi, API yeniden başlatmadan ilerleme ve ters sırada normal metadata/fiziksel cleanup doğrulanır. Gözlenen örtüşme ve statuslar kaydedilir; yerel deterministik reconciliation kabulüyle native zamanlama kanıtı karıştırılmaz. Yeni test yardımcı/shared motor yazmaz ve ürün kaynağı bu test diliminde değişmez.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.


### T900 · Gerçek birleşik site geri yüklemesi geri alma sırasında da başarısız oluyor
- **Bağımlı:** T895
- **Dosyalar:** `apps/api/src/application-environment-registry.js`, `apps/api/src/website-restore-service.js`, `apps/api/src/website-mail-backup-adapter.js`, `apps/api/src/website-backup-operation-registry.js`, `apps/api/src/website-backup-operation-service.js`, `apps/api/test/website-restore-service.test.js`, `apps/api/test/website-environment-backup-adapter.test.js`, `e2e/live-audit/13-native-source-mutation.spec.js`, `docs/t883-coverage-and-priorities-2026-11-12.md`, `docs/test-scenarios-matrix.md`
- **Kaynak:** QA · 2026-11-12 19:23
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T886 lifecycle-q4 gerçek .28 üzerinde yeni sahipli PHP/WordPress sitesi, DB ve iki posta hesabıyla ilk7 normal senaryoyu geçti. Restic backup operation dc6a992b-ec7d-464d-8af2-dd2c64beebda / job f81dbabe-6994-41e8-b1f0-a7020993bdfa succeeded. Snapshot sonrasında yalnız benzersiz test mesajının UID STORE/UID EXPUNGE ile silinmesi ve SEARCH=0, dosya+SQL değerinin değişmesi, yeni posta parolasıyla gerçek IMAP auth ve eski/yeni korunan webhook anahtarının gerçek HMAC davranışı kanıtlandı. Normal restore include paths/databases/mail/environment preview200/queue202 kabul edildi; operation 81efdde9-e91c-450a-a123-1828abff9dad failed/error restore_rollback_failed, job c75e5cee-b4ed-40cb-85cf-6e809322fc9a failed/error local_operation_failed oldu. website-restore-service.js:265–277 hem restore hem rollback adapter zincirindeki hatayı bu kodla kapatıyor; hangi adapterin asıl hata olduğu henüz kanıtlanmadı. Beklenen tüm seçili içerik, özgün RFC822 hash/bytes, önceki IMAP parola ve korunan HMAC anahtarı geri gelmeli; hata halinde önceki canlı içerik güvenli rollback ile geri dönmeli. Assertion gevşetilmedi; restore POST tekrar edilmedi, ürün/deploy/root registry değişikliği yok. Özel lifecycle-q4/safe-operation-readback.json ve mutation-results.json güvenli kanıtı tutar. Kısmi pre-restore kanıtları geri yükleme PASS sayılmaz; sonraki7 serial senaryo bu koşuda çalışmadı.

- **Kabul:** Hata tekrar üretilmiyor; gerçek seçili içerik ve rollback matrisi iki yeni sahipli koşuda doğrulanıyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T901 · Paket tanılaması doğrulanmamış sabit build kaydını senkronize gösteriyor
- **Bağımlı:** T800
- **Dosyalar:** `apps/api/src/core-app.js`, `scripts/build-deb.sh`, `scripts/emit-build-info.mjs`, `apps/web/vite.config.js`, `apps/web/src/workspace/deployment-diagnostics-client.js`, `apps/web/src/workspace/SystemSettingsPanels.jsx`, `apps/api/test/deployment-version-diagnostics.test.js`, `apps/web/test/deployment-diagnostics-client.test.js`, `apps/web/test/ember-staging-deployment-acceptance.test.js`, `apps/api/test/staging-e2e-verification.test.js`
- **Kaynak:** QA · 2026-11-12 20:28
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Bağımsız T887 incelemesinde gerçek .28 GET /api/system/diagnostics/version HTTP200, data.commit/sourceInfo.sourceCommit b3f505cf14c341d58d472ea3b8916a31, buildId build-20261001-0300 ve buildTime 2026-10-01 verdi. Pinned salt okunur dpkg-query kurulu0.3.0-2026111001; API PID846281 ve üç kritik native JS SHA256 a2fdc8c1 ile aynı. Bu üç dosya karşılaştırması bütün ağacın eşitliği iddiası değildir. Yerel core-app.js140-149 sabit fallbackler aynı değerleri üretir; metadata yokken sourceCommit deployed fallbacke eşitlenip sourceMatchesDeployed:true ve RUNTIME SYNCHRONIZED olur. Saf resolver env:{} ile tekrar üretildi. build-deb.sh build commit/time manifesti üretmiyor; SystemSettingsPanels bu veriyi senkronize gösterebiliyor. Host metadata env alanları okunmadığından eksik veya stale explicit env ayrımı kanıtlanmadı; runtime eski denmiyor. Beklenen gerçek paketten immutable build kimliği; metadata yoksa unknown/unverified ve kaynak/runtime eşitliği kanıtlanmamış olsun. Güvenli kanıt .local/t883-20261112/t887-review-agent1-20261112-01/native-diagnostic-readonly.json ve native-code-identity-proof.json. Bu test diliminde ürün/deploy değişikliği yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T902 · Doğrulama: test — conversation ownership, legacy preservation, paging and storage failures through t
- **Bağımlı:** —
- **Dosyalar:** `apps/api/test/ai-conversation-storage.test.js`, `apps/api/test/tenant-site-recreate-lifecycle.test.js`
- **Kaynak:** QA · 2026-11-12 21:51
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - conversation ownership, legacy preservation, paging and storage failures through the real service
    - re-creating a deleted tenant with the same slug generates a new generation/journal and avoids old provisioning/removal collisions
    
    rofiles without allocating a localhost port (0.817625ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (1.189125ms)
    ✔ normalizes complete Node deployment specs (79.124958ms)
    ✔ normalizes fixed Node process actions against a managed release (1.918875ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (81.656417ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (130.519167ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (1.661958ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (172.652458ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (2.79825ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (2.448ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.610041ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (8.211708ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.739333ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.374875ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (5.017167ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.43125ms)
    ✔ normalizes python rollback, restart, and status specs (0.670917ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (2.420584ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.989166ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.671333ms)
    ✔ tenant constants and role classification predicates (3.6235ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.879792ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (2.765959ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (1.1795ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (1.382ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.577458ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.850083ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.604375ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (1.02225ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.95525ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (1.401666ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.905833ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (1.073584ms)
    ✔ tenant context creation and account normalization security edge cases (0.471ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 2691.057125

- **12 Kasım RCA ve dar kapsam:** İki dosya ilk dar koşuda3/4, ikinci aynı kaynak koşusunda4/4 geçti. Tenant generation3 DELETE için test yalnız202 bekliyordu; gerçek router `state=removed` ise200, sürüyorsa202 döndürür. Gerçek200/senkron tamamlanma dalı ilk koşuda gözlendi. Testte geçerli HTTP durumu ile semantik state bağlanacak; generation/journal/kimlik/yokluk assertionları korunacak. AI storage dar koşularda iki kez geçti; tam dalgadaki neden henüz kanıtlanmadı. Bu dosyada yalnız alt process başarısızlığı için güvenli status/signal/error-code tanısı güçlendirilebilir; süre artırma, beklenti gevşetme, force-exit veya ürün kaynağı değişikliği yok. Sonraki tam doğrulamanın tam çıktısı özel600dosyada tutulacak. Kaynak rootcause kanıtı `.local/t883-20261112/t902-repro/safe-repro-summary.json`; staging stream timer olasılığı bu iki hatanın nedeni diye gösterilmez.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T903 · Doğrulama: test — independent SQLite writers serialize the last site slot (same operation: true)
- **Bağımlı:** —
- **Dosyalar:** `apps/api/test/hosting-site-allocation-concurrency.test.js`, `apps/api/test/runner.js`
- **Kaynak:** QA · 2026-11-12 22:26
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - independent SQLite writers serialize the last site slot (same operation: true)
    
    ut allocating a localhost port (21.639875ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.524833ms)
    ✔ normalizes complete Node deployment specs (2.597917ms)
    ✔ normalizes fixed Node process actions against a managed release (28.559417ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (10.756667ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (137.695792ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (40.642083ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (135.389167ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (1.493709ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (6.231125ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.67175ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.645125ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.301958ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (103.7905ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (3.31ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.628667ms)
    ✔ normalizes python rollback, restart, and status specs (0.916708ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (131.82225ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (58.110708ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (2.057083ms)
    ✔ tenant constants and role classification predicates (12.913542ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (1.807459ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (14.85875ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (53.33575ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (1.471292ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (5.564125ms)
    ✔ createTenantContext builds accurate tenant context for all roles (73.126417ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (1.764834ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (2.280375ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (2.418583ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.885083ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.848083ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.810375ms)
    ✔ tenant context creation and account normalization security edge cases (0.6205ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 5002.255

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T904 · Doğrulama: test — concurrent normal HTTP job enqueues during an active in-flight reconciliation succ
- **Bağımlı:** T899
- **Dosyalar:** `apps/api/test/durable-job-live-reconciliation-concurrency.test.js`
- **Kaynak:** QA · 2026-11-13 01:38
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - concurrent normal HTTP job enqueues during an active in-flight reconciliation succeed without transient 503
    - stalled live reconciliation past the bounded window fails closed with durable_job_reconciliation_required
    
    ofiles without allocating a localhost port (0.504709ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.626542ms)
    ✔ normalizes complete Node deployment specs (6.063042ms)
    ✔ normalizes fixed Node process actions against a managed release (2.425ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (2.638916ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.982333ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (2.029667ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (39.474083ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.469917ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (0.691084ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.60125ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.980417ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.543292ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.474833ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (2.504458ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.616667ms)
    ✔ normalizes python rollback, restart, and status specs (1.426167ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (2.661292ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.733125ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.441ms)
    ✔ tenant constants and role classification predicates (1.753333ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.322792ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (3.125916ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.711625ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.5395ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.455666ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.368542ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.236917ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.489166ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.411125ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.558667ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.388625ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.555708ms)
    ✔ tenant context creation and account normalization security edge cases (0.28325ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 473.897708

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T905 · WordPress taze giriste POST yaniti gozlenmiyor
- **Bağımlı:** T886
- **Dosyalar:** `e2e/live-audit/13-native-source-mutation.spec.js`
- **Kilit:** source-audit-13
- **Kaynak:** QA · 2026-11-13 05:51
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Native .28 package0.3.0-2026111301/source621 t897-wp-chrome-q2: realDBform+TurkishWPinstall passed; fresh emptybrowserContext GETwp-login200/form1/testcookiepresent, then waitForResponse exactPOST timedout45s. Staticremoval serialtailSKIPPED, notPASS. Previousq1all4PASS doesnotcloseit. Ownfixture normalcleanedallmetadata/physical. Beforeproductchange instrument browserLogin actualrequest/response/requestfailed-safeerrorcodes/formsubmission/validity/action/scheme andposttimeoutURL/DOMbooleans; NEVERpassword/usernamevalues/cookies/headers/postdata/HTML/trace. Preserveactualbrowser/no mocks,noblindloginPOSTretry,no timeout/selector/assertrelaxation. Boundnativefreshrepeatwithobservations; classifyactualfailureastransport/form/productfromevidence beforefixing. Privateq2mutation-results.json/ledger under .local/p0-native-20261113. Helper/sourceinstrumentationonly first; nativefailurecause remainsOPEN.

    Bu ön dilim yalnız mevcut gerçek tarayıcı yardımcısına güvenli gözlem ekler; T883 genel ürün kabulünü beklemek yerine T886 test kaynağı üzerine sıralanır ve T883 ile source-audit-13 kilidini paylaşır. Ürün/deploy değişikliği bu test dosyası sözleşmesinin dışında kalır. T889/T897/T898 bağımlılıkları korunur.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T906 · Site olusturma sonucunda dogrulanmis islem kimligi gosterilmiyor
- **Bağımlı:** —
- **Dosyalar:** `apps/web/src/workspace/site-create-submission.js`
- **Kaynak:** QA · 2026-11-13 08:59
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Gerçek .28/0.3.0-2026111302/source1b6 native28 q1, source353b74b1: tek create201, gerçek backend/DOM tüm required adımlar ready; ancak teknik ayrıntılarda İşlem kimliği alanı —. createReceipt.operationId/provisioningId geçerli5d8dd6c3-1af3-4bca-a51a-8b23802e7a05 iken SiteCreateResult state.operationId/domain.operationId bulamıyor. Source site-create-submission doğrulanmış expected.operationId bilgisini state içine hiç yayınlamıyor. Gerçek test toContainText(operationId) kırıldı; bu assertion/süre kaldırılmayacak veya gevşetilmeyecek. Own site normal cleanup, üç metadata404 ve tüm physicalabsence geçti; diğer siteler korundu. Özel t894-native28-chrome13-02-q1 kırmızı kanıtı korunur; UI409 bu koşuda gözlenmedi.
    Yalnız mevcut submission state sınırında doğrulanmış işlem kimliğini koru. Kimliği preview doğrulamasından önce sunucuda doğrulanmış gibi yayınlama; domain/Website/provisioning kimliklerini birbirine karıştırma. Preview başarısızlığı, belirsiz create, recorded/provisioning/ready/attention ve session geçişi davranışları; single-create/no-replay ve mevcut hata güvenliği korunsun. Yeni motor, sentetik HTTP/fixture servisi, test beklenti gevşetme veya başka UI düzenlemesi yok. Mevcut kırmızı native28 gerçek regresyonudur; callback/harness veya metin-regex kontrolleri native kanıt diye sunulmaz.
    Güncel onaylı P0 package/test/fix döngüsünde root bağımsız kaynak incelemesi+ilgili test+tam kaynak kapısından sonra eşleşen yeni paketi yalnız .28'e kuracak. Aynı native28 DOM işlem/Website/domain/hostname eşleşmesi iki fresh koşuda doğrulanmalı; gerçek allowed409 nedenselliği T894'ün ayrı kabulüdür ve gözlenmezse açık kalır. Eski UNKNOWN/GC/başka P0 kapıları bu dar düzeltmeyle kapanmaz.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T907 · Site oluşturma oturum sıfırlama testi yeni kimlik alanını kapsamıyor
- **Bağımlı:** T901
- **Dosyalar:** `apps/api/test/staging-e2e-verification.test.js`
- **Kaynak:** QA · 2026-11-13 09:06
- **İş:** Full-source-gate06 sourceb2aa74bd: 8694 test/8692pass/1fail/1skip; tek hata Source contract T-DEV-CREATE-RESULT testinde satır9234 deepEqual EMPTY_SITE_SUBMISSION. T906 yeni doğrulanmış operationId state alanını boş durumda null ile sıfırlar; mevcut expected nesne alanı hiç kapsamıyor. Gerçek diff yalnız actual operationId:null ekidir. Beklenen boş state'e operationId:null ekle; strict deepEqual, session-change/no-publish/password-clear/unmount/abort assertionlarını ve diğer senaryoları koru. Yeni mock/harness/HTTP veya ürün değişikliği yok. Bu eski source/state sözleşmesi uyumluluk kontrolüdür, native kanıt değildir; gerçek native28 DOM regresyonu ve T906 kabulü ayrıdır. Önce mevcut kırmızıyı scoped testte doğrula, sonra aynı scoped test+lint ve root yeni tam kapı geçmeli. Başarısız06 kanıtı korunur, paket kurulmaz.
- **Kabul:** Aynı tam deepEqual yeni açık null alanını doğruluyor, ilgili scoped contract ve başarılı yeni aggregate gate; T906 native kabulü ayrıca açık.

### T908 · Doğrulama: test — GET /api/websites/:websiteId/cache returns policy
- **Bağımlı:** —
- **Dosyalar:** `apps/api/test/website-cache-http.test.js`
- **Kaynak:** QA · 2026-11-13 16:59
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - GET /api/websites/:websiteId/cache returns policy
    
     profiles without allocating a localhost port (0.939416ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.490625ms)
    ✔ normalizes complete Node deployment specs (15.900584ms)
    ✔ normalizes fixed Node process actions against a managed release (1.698459ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (3.354917ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.619042ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.893167ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (16.99525ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.784916ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (1.343708ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.418167ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.5055ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.24ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.36175ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (2.054417ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (2.796791ms)
    ✔ normalizes python rollback, restart, and status specs (1.393583ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (2.065ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.812792ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.577ms)
    ✔ tenant constants and role classification predicates (1.836041ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.602667ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (1.297833ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.347667ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.260791ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.260541ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.356666ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.412709ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.607292ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.339083ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.378167ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.511041ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.958417ms)
    ✔ tenant context creation and account normalization security edge cases (0.333542ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 413.820042

    İlk başlangıç doğrulaması kaynak7bb3 üzerinde kırıldı; önce bu exact testin gerçek error/stack ve server/request kapanışını izole koşuda kanıtla. Eski source test servis/auth stub kullanıyor ve native ürün kanıtı değildir; yeni mock, canned response veya assertion/timeout gevşetme ekleme. Dar actual HTTP/server lifecycle sorunu varsa gerçek neden ve regression ile gider; yeni pozitif ürün kanıtı gerekiyorsa gerçek file-backed registry/service/AuthStore ve HTTP kullan, kapsamı başka dosyaya kendi başına genişletme. Global failed kaydı korunur; sadece yeşil rerun eski nedeni çözülmüş sayılmaz.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T909 · Doğrulama: test — stalled live reconciliation past the bounded window fails closed with durable_job_
- **Bağımlı:** T899, T904
- **Dosyalar:** `apps/api/test/durable-job-live-reconciliation-concurrency.test.js`
- **Kaynak:** QA · 2026-11-13 18:25
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - stalled live reconciliation past the bounded window fails closed with durable_job_reconciliation_required
    
    ithout allocating a localhost port (0.808791ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (2.045583ms)
    ✔ normalizes complete Node deployment specs (6.62575ms)
    ✔ normalizes fixed Node process actions against a managed release (7.169708ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (2.784125ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.877833ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (1.076417ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (226.195166ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (2.195375ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (10.90525ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (1.716958ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (4.828791ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.462666ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.326458ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (2.21475ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.555083ms)
    ✔ normalizes python rollback, restart, and status specs (1.239292ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (3.091875ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (1.420125ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (1.350375ms)
    ✔ tenant constants and role classification predicates (6.041459ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.818417ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.651625ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.654083ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.965541ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.709709ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.639958ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (1.32275ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (2.146416ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.609208ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (4.53225ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.554125ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (1.179083ms)
    ✔ tenant context creation and account normalization security edge cases (1.652917ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 1207.668375

    Dar tanı ve test sözleşmesi: full-source-gate-08 Node24/defaultumask0022/frozen c44677f7 gerçek logunda test:423, helper:124 `Timed out waiting for 1 live reconciliation waiters (observed 0)`. 80ms gerçek canlı uzlaşma penceresi HTTP bekleyici kaydolmadan dolmuş olabilir; bu ürün kusuru diye varsayılmaz. Önce gerçek file-backed registry/gerçek HTTP ile tekrar üret; deadline, 503 error code ve exact durable recovery kimliği korunarak hatalı test zamanlama varsayımını düzelt. Window/timeout artırma, retry/skip veya sahte clock/servis/HTTP cevabı yok. Gerekli kaynak hatası kanıtlanırsa mevcut bu test sözleşmesinde ürün dosyası yazılmadan root'a bildir. T899'un native kabulü veya T908'in eski bilinmeyen hatası bu kayıtta değiştirilmez.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T910 · Doğrulama: test — cleanup result whitelists safe fields; arbitrary adapter secrets are not published
- **Bağımlı:** —
- **Dosyalar:** `apps/api/test/website-removal-cleanup.test.js`, `apps/api/test/website-removal-http.test.js`, `apps/api/test/website-removal-target.test.js`
- **Kilit:** terminal-removal-audit
- **Kaynak:** QA · 2026-11-13 23:49
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - cleanup result whitelists safe fields; arbitrary adapter secrets are not published
    - website-removal-http reconciles interrupted running step upon restart as blocked (fail-closed) and does not blindly replay
    - overlapping continuation cannot replay an in-flight cleanup step
    
    ofiles without allocating a localhost port (0.691292ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.731667ms)
    ✔ normalizes complete Node deployment specs (11.72975ms)
    ✔ normalizes fixed Node process actions against a managed release (0.76ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (27.822917ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (1.978792ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (2.410792ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (19.638167ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (11.853125ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (1.503291ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (68.404417ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (1.344ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (3.205542ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.412791ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (8.867959ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (1.990375ms)
    ✔ normalizes python rollback, restart, and status specs (0.545625ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (2.929208ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (2.799416ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (1.308125ms)
    ✔ tenant constants and role classification predicates (3.897125ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (1.335375ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (2.301916ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.44425ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.436542ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.99625ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.787791ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (1.1125ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (1.797542ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (2.255708ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (1.96275ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (6.127208ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (1.594458ms)
    ✔ tenant context creation and account normalization security edge cases (2.691167ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 1183.2125

    13 Kasım P0 döngüsü dar test kapsamı: full-source-gate-11 source90a03b11 gerçek raw stack5530–5587 korunur. Yeni terminalDrain güvenli typed sonucu whitelist içinde exact doğrulanır, adapter key/secret sızıntısı beklentisi kaldırılmaz. Restart ve overlap pozitifleri geçerli gerçek file-backed journal + aynı shared lifecycle reservation/commit ile kurulmalı; legacy eksik kanıt hâlâ blocked/fenced ve cleanup yoktur. Callback kapısına hiç ulaşmayan eski legacy fixture timeout artışı/retry/skip veya yeni sahte servis/HTTP/process/fs ile geçirtilemez. Anlamlı gerçek disk/HTTP veya saf durum sınırı kullan; kaynak üretim dosyası değiştirme gereği kanıtlanırsa önce root bildir. Yalnız bu üç test dosyası; T898 ürün/kernel düzeltmesi ayrı kalır. İlgili üç dosya tam batch + bağımsız inceleme ve sonraki full-source-gate-12 gereklidir.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T911 · ttyd WebSocket gateway sikistirma yanit basligini dusuruyor
- **Bağımlı:** —
- **Dosyalar:** `apps/web/server.js`
- **Kaynak:** QA · 2026-11-14 18:51
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Gercek 1307/source0864011a native20 q1 2PASS1FAIL: ilk bagli ttyd browser testinde GET200 ve xterm var, terminal verisi yok. Iki ayri normal sahipli statik/ttyd probe gercek101, client binary40B ve sifirserverframe sonrasi hemen kapandi. Ikinci probe1922074d extensionOfferedtrue, responseExtensionPresentfalse ve75ms reserved-bit protocol error kaydetti; OwnerAPI/browser200. Kaynak apps/web/server.js browserProxyHeaders uzanti teklifini iletirken proxyTtydWebSocket101 yanit allowlisti sec-websocket-extensions alanini dusuruyor.
    Dar onayli P0 bugfix: YALNIZ apps/web/server.js mevcut upgrade yanit allowlistine sec-websocket-extensions ekle; varolan string/CRLF kontrolu aynen kalir. Auth, Origin, cookie, tenant, reauthorization, routing, pipe, timeout, ttyd args veya motor degismez. Yeni fake HTTP/ttyd/WS servis testi ekleme. Otomatik gercek regression mevcut native20 strict15s terminalframe/pending/drain/cleanup kontrati ve mevcut bounded passive probe. EskiFAIL/UNKNOWN/KEEP kanitlari korunur; HTTP-after101 alternatifi veya tumtarihsel nedenler cozuldu iddia edilmez.
    Maker syntax/lint/ilgili mevcut web testleri + bagimsiz kaynak review; ardindan frozen tam sourcegate13 ve matching yeni paket08 .28 yetkili P0 dongusunde. Actualpositive probe public101 extensionpresent + gercek terminalverisi + strict204close/normalphysicalcleanup ve iki fresh FULL native20 gate gereklidir. Native kanit rootta seri, makerhost/network islemez. Kaynak/local test native kabul degildir. T889OPEN korunur. Test-backup GC07 pindeki runtime0864/writer4305/ownedhelper degismez; bu tekwebkaynak dilimi GC ile bagimsiz yuruyebilir, deploy/export ancak GC ve tamgate bittikten sonra.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T912 · Doğrulama: test — POST /api/importer/plesk/preview returns 200 and preview for owner
- **Bağımlı:** —
- **Dosyalar:** `apps/api/test/plesk-importer-http.test.js`
- **Kaynak:** QA · 2026-11-15 01:27
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - POST /api/importer/plesk/preview returns 200 and preview for owner
    - Plesk Importer HTTP API
    
    rofiles without allocating a localhost port (0.522083ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.196958ms)
    ✔ normalizes complete Node deployment specs (0.730958ms)
    ✔ normalizes fixed Node process actions against a managed release (1.751833ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (3.452458ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (1.164584ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (1.186417ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (40.349ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.705375ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (1.50675ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.325333ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.611292ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.167625ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.299917ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (3.163959ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.269208ms)
    ✔ normalizes python rollback, restart, and status specs (1.820375ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (28.276333ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (18.200083ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (1.47975ms)
    ✔ tenant constants and role classification predicates (2.090042ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (1.999375ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.834709ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.621167ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.385709ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.296166ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.4585ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.518125ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.615083ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.413875ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.606042ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.797ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (2.474ms)
    ✔ tenant context creation and account normalization security edge cases (1.591583ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 806.036458


    15 Kasım dar kaynak sözleşmesi: izole temiz96794af0 tam kapısı01 gerçek stack/test67de OwnerPOST401!==200 gösterdi; parent suite de failed sayıldığı için toplamfail2dir, ayrıikiürünhatası değildir. Ham log/gate sonucu korunur. Önce gerçek Node24/umask0022HTTP request'in exactintendedlistener/context/adresailesi ve listen/close yaşam döngüsünü ölçerek tekrar üret. Mevcut auth fixture/200-owner/401-unauth/403-role/400-validation ve .44-only-string-offline sınırlarını gevşetme; yeni mock/auth/canned HTTP veya gerçek .44 erişimi yok. Kaynak yalnız bu test dosyasıdır; ürün guard/route değişikliği kanıtlanırsa önce root'a bildir. Güvenli dinleme/kapanış kusuru varsa gerçekHTTP regresyonuyla dar onar; eskiilkcause kanıtı yokken varsayımı kesinleştirme. Root yeni frozenfullgate ve bağımsızreview sonrasında nativeye geçer. Lisans WIP primarykaynakta korunur, çalışma yalnızverification-checkout-01 içinde yürür.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T913 · Node Passenger site silme sonrasi generated ortam dosyasi kaliyor
- **Bağımlı:** T861, T881, T892, T898, T910
- **Dosyalar:** `packages/host-runtime/src/website-passenger-environment-manager.js`, `packages/host-runtime/src/application-environment-backup-manager.js`, `apps/api/src/website-removal-cleanup-adapters.js`, `apps/api/src/website-removal-runtime.js`, `apps/api/src/index.js`, `packages/host-runtime/test/website-passenger-environment-manager.test.js`, `packages/host-runtime/test/application-environment-backup-manager.test.js`, `apps/api/test/website-removal-cleanup-adapters.test.js`, `apps/api/test/website-removal-runtime.test.js`, `apps/api/test/website-removal-cleanup-wiring.test.js`, `e2e/live-audit/29-native-passenger-environment-retirement-mutation.spec.js`, `playwright.live-audit.config.js`, `apps/api/src/domain-registry-base.js`, `apps/api/test/domain-registry.test.js`, `apps/api/test/website-removal-http.test.js`, `apps/api/test/website-removal-cleanup-preflight-source.test.js`
- **Kaynak:** QA · 2026-11-16 00:30
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Gate06 ilk tam kaynak sonucu 3 regresyon T914 olarak kaydedildi; exact mevcut HTTP fixture ve source-preflight beklentileri yeni zorunlu retirement/namespace sozlesmesine uygun gercek FS/registry kaniti ile duzeltilir, uretim guardlari gevsetilmez. Bes P1 criticalreview c84d3210 kaynagi ile negatif regresyonlara eklenir; eski5b/Gate06FAILED korunur.
    16 Kasim gerekli dar kapsam eki: domain-registry-base bindWebsite normal migration yazari namespace rezervasyonunu atliyor; yalniz mevcut withRoutingNamespace ile serialize et, reentrant caller kontrolu ve gercek file-backed yaris regresyonu ekle. App->Website->namespace gate actualabsence/checkpoint/unlink boyunca ortak yazarlari dislar; yeni kilit/motor yok.
    16 Kasim kullanici acik talimati: Node.js silme sonrasi kalan ortam dosyasini once duzelt; T889 acik kalacak. T883 genel kabulunu veya tarihsel basarisiz kanitlari kapatma.
    Gercek .28 product08/9c8 Native19Chrome05 run 9PASS/1FAIL (ayri afterAll45s kusuru). Normal dort removal journal removed ve12metadata404; Node App257aad37-bbfe-58f2-9846-bb007a5eb6ff generated /etc/yunpanel/passenger-env/<AppID>.conf kaldi. Salt okunur inspection5226671e ve exactfile proofc939abbd: root0:0/0600/regular/canonical/nlink1/81byte/SHA2959773fa4c9e7dcb6f413a76b201bf03feee0ae997180b27b6c4642e253df0e/emptyrev0; manuel silme yok. Tam artifact paths .local/p0-20261115/checkpoint.md son16Nov kaydi.
    Kaynakta runtime_cleanup yalniz binding kaydini, file_cleanup dort uygulama kokunu, application_cleanup JSONenv kaydini siliyor; generated include fiziksel temizligi yok. Provisioning compensate normalretirement yerine kullanilamaz, sonradan uygulanmis ortam revizyonunu geri yukleyebilir.
    Mimari private oneri .local/p0-20261116/passenger-include-retirement-proposal-ag3-01/PROPOSAL.md e5bdf6e0. Mevcut manager/cleanup/journal yolunda exactApp/Website/server/managedauthority/currentappliedrevision/hash + secureFD ile scope; unlink ONCESI mevcut checkpointStep, ayni journal idempotence ve gercekabsence. Yalniz desteklenen NodePassenger; ordinaryPython/direct/PHP/static korunur. Eski completed journals zorla acilmaz; gecmis ownorphan recovery ayri exact inceleme kapsamidir. Degerler/journallara plaintextsir yazilmaz; yeni motor, rawregistrywrite, glob/prune/manualrm yok.
    Kaynak kabul: once dogru sebeple kirilan otomatik realFS/policy testi, sonra ilgili mevcut birim/API kontrolleri ve bagimsiz kaynak incelemesi; mock/stub/fakestat/yapayHTTP ekleme. Senaryo matrisi: empty0, laterapplied, saved-not-applied, aynijournalretry/absence, interruptedlegacy, foreign/symlink/FIFO/hardlink/drift, protectedsibling. Beklenti/innerdeadlinegevsetme yok.
    Nihai kabul: tam lint/test/build + bagimsizinceleme, matching yeni actualpaket/.28kurulumu (Root ve mevcutP0izni), normal API/browser Nodeempty ve guncellenmis/saved-but-unapplied envcreate->delete iki fresh kosuda exactinclude.existsfalse +3metadata404 +physicalabsence +protectedfirstPHP200. Current08 veya source-onlyPASS yeni productfixed sayilmaz. UserT889 acik; T883 Native18/19/22 testcleanup dilimi AGENT_2 tarafinda ayridir. Test/gelistirme28rutinyedek yok;44erisim yok. Push/main/force/reset yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T914 · Doğrulama: test — production removal wires cleanup preflight inspectors as well as mutators
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-16 01:21
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - production removal wires cleanup preflight inspectors as well as mutators
    - website-removal-http executes complete removal lifecycle verifying cleanup of files, unix identity, domain, database, SFTP, cron, runtime-binding and Application metadata
    - website-removal-http remains fail-closed on partial failure and subsequent destructive steps do not execute
    
    e profiles without allocating a localhost port (0.346458ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.204417ms)
    ✔ normalizes complete Node deployment specs (0.518583ms)
    ✔ normalizes fixed Node process actions against a managed release (3.291084ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (1.477375ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.28375ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.513584ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (9.31225ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.317084ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (1.28925ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.451625ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.508792ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.233959ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.2095ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (2.4315ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.150292ms)
    ✔ normalizes python rollback, restart, and status specs (0.261875ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (1.057542ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.395084ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.277917ms)
    ✔ tenant constants and role classification predicates (1.380041ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.2915ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.307709ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.295834ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.13475ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.122958ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.165708ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.195ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.332917ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.192125ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.225458ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.271042ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.306333ms)
    ✔ tenant context creation and account normalization security edge cases (0.159625ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 223.661625

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T915 · Doğrulama: test — hosting customer and reseller sessions derive live site scope from attached owners
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-16 14:01
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - hosting customer and reseller sessions derive live site scope from attached ownership without legacy grants
    
    iles without allocating a localhost port (0.326291ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.59525ms)
    ✔ normalizes complete Node deployment specs (1.477416ms)
    ✔ normalizes fixed Node process actions against a managed release (2.633583ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (5.497041ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.672625ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (1.012458ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (49.683958ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.859583ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (0.839834ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.539708ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (1.454542ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.126875ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.188208ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (3.073292ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.351416ms)
    ✔ normalizes python rollback, restart, and status specs (0.277209ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (2.759417ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.640042ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.926791ms)
    ✔ tenant constants and role classification predicates (2.250542ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.373458ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.244167ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.161417ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.127875ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.22025ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.169ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.253708ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.488458ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.330708ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.232125ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.323042ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.535917ms)
    ✔ tenant context creation and account normalization security edge cases (0.512291ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 443.752

- **Kabul:** Izole Gate09 kesintisi icin Root bounded-disposition incelemesi; bu entegrasyon taskacceptance veya Primary combinedPASS degildir. Gate09 FAILED hamkanit korunur; unchanged auth-store25/25 ve Gate10 8745PASS/0cancel makineuykusu sonrasinda gercekten gecmistir. Auth asla flaky degildir/T908-T889 nedeni cozuldu iddiasi yoktur.

- **Entegrasyon kanit siniri:** Yukaridaki72PASS otomatik QA tail'i ilkfailurestack veya birlesik kabul degildir. Actual auth-store164 timeout30157524ms/120000 ve Sleep05:36:48→Wake13:59:29 zaman cizelgesi SourceGate09'a aittir. Powerproof699664a310147cb692f4cee516c6a59fd7e85285b31c20b93c795ec4498067f6; bagimsizdisposition c6d19cfc21839fe9cb6e60373551dae77c85b839121fa2bb196dda7597b70417; Gate10 33b2641461b47b5fd2d1b573b3f49fcc6e68c5baf70d98eab298bb5c99e72a15. Source/Primary artifact ayrimi ve eskihamFAILED korunur; Primary tasks/verified degistirilmez.

### T916 · Doğrulama: test — real mounted conversation handlers preserve the auth boundary and reject actor/que
- **Bağımlı:** T902
- **Dosyalar:** `apps/api/test/ai-conversation-storage.test.js`, `apps/web/test/menu-redundancy-log-placement.test.js`, `apps/web/test/license-settings-panel.test.js`
- **Kaynak:** QA · 2026-11-16 17:19
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - real mounted conversation handlers preserve the auth boundary and reject actor/query spoofing
    - SettingsPage: categories omit deprecated records tab, keeping only editable settings
    
    les without allocating a localhost port (0.311792ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.155541ms)
    ✔ normalizes complete Node deployment specs (0.845125ms)
    ✔ normalizes fixed Node process actions against a managed release (4.003291ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (1.947917ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.634959ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.541125ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (19.412917ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.32525ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (0.669083ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.463417ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.282083ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.107958ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.093209ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (1.43075ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.088833ms)
    ✔ normalizes python rollback, restart, and status specs (0.170125ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (1.462542ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.631334ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.342334ms)
    ✔ tenant constants and role classification predicates (1.896542ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.451667ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.304667ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.183ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.161292ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.1605ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.197209ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.242709ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.506209ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.255875ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.268875ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.385167ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.835167ms)
    ✔ tenant context creation and account normalization security edge cases (0.543167ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 389.877333

    Root kapsam kaydı: aynı iki başarısız testin gerçek davranış karşılığını doğrulamak için yalnız yukarıdaki üç mevcut test dosyası kullanılır. Gerçek Chromium Settings gezinmesi mevcut license-settings-panel testinde sınanır; yeni sahte auth/HTTP/LLM servisi kurulmaz. AI eski module-mock/doğrudan handler varsayımı yerine gerçek file-backed registry, native SQLite auth, gerçek loopback HTTP ve gerçek Ed25519 doğrulama kullanan depolama/yetki senaryolarıyla değiştirilir. Yerel imzalı kripto vektörü vendor/live lisans veya ödeme kabulü sayılmaz; model inference yokken gerçek provider-not-configured hatası beklenir, sahte başarılı yanıt yok. Lisans gate, CSRF, RBAC, tenant sınırı, Source9e/Primary ve eski başarısız kanıtlar korunur. Yeni kaynak planı → gerçek RED → dar test değişimi → ilgili batch/bağımsız inceleme/tam combined gate sırası geçerlidir.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T917 · Website backup operation reads replace unchanged durable store
- **Bağımlı:** T900
- **Dosyalar:** `apps/api/src/website-backup-operation-registry.js`, `apps/api/test/website-backup-operation-registry-readonly-real-fs.test.js`
- **Kaynak:** QA · 2026-11-16 17:29
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    T883 gerçek kabulünün başarılı test yedekleri temizliğinde engel bulundu. Source9e gerçek registry/service+gerçek FS negatifinde 9 testten 8 salt okuma inode korunumunda doğru sebeple FAIL, 1 gerçek create kontrolü PASS: list/get/worker/service/missing/empty-reconcile byte/SHA aynı olduğu halde atomik yeniden yazıyor. Özel RED32f503714b0ccc3459a8e248c03e5ac00fe7a59f257eb9028eb04f86f3ab2af1, tanıfreeze023114b54746dc0ae8dff8e03fb67bbe01ca176bb85916d5dceb88617ac62a7f.
    Yalnız bu özel combined checkout içinde aynı process lock+fresh disk load korunarak zaten yüklenen raw payload ve yeni canonical payload byte-identical ise gereksiz save/rename atlanır. Eksik store oluşturma, gerçek create/update/cancel/recovery ve migration/canonicalization kalıcı yazımı korunur. Gerçek FS+actual registry/service/default lock; mock/stub/fakeHTTP/DB yok. Önce RED, sonra fix+GREEN; salt regex yeterli değil.
    Source9e ve Primary28ec bu dilimde değiştirilmez. Eski07/08/401/compare HOLD ve nativeC1FAILED korunur; 14:05 kesin writer UNKNOWN. GC inode/FD/hash/once-only guardları gevşetilmez; 10repo26snapshot/18durable receipts KEEP. T889 açık. Kaynak uygunluğu ve ilgili/full combined gate gereklidir; matching yeni paket/.28 gerçek GET inode korunum+GC sonucu Root tarafından ayrı doğrulanmadan runtime kabulü yok. Push/main/force/reset yok.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T918 · Doğrulama: test — site admin provisioning creates site_manager role and never leaks password in resp
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-17 04:23
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - site admin provisioning creates site_manager role and never leaks password in response
    - AI-triggered durable service.restart interrupted by process kill at host mutation boundary reconciles inspect-first without duplicate side-effects
    - real HTTP conversation storage preserves migration, paging, limits and failed bytes without a model
    - real HTTP conversations enforce native auth, license and ownership before provider access
    - auth and user lifecycle dual-write into the bounded common audit model
    - failed anonymous login records only generic failure metadata
    - local CLI issues setup tokens and recovers an account without passwords in argv/output
    - real store setup/login/session/logout flow works over HTTP
    - non-owner user cannot set recovery email
    
    sword command-line arguments (55367.7625ms)
    ✔ live terminal authenticator accepts site management sessions and returns current Website grants (87.202416ms)
    ✔ all management paths reject anonymous and bootstrap-bearer requests before the handler (4587.02775ms)
    ✔ authenticated owner reaches handlers through request.auth without injected credentials (1052.667208ms)
    ✔ mutation requires both exact origin and the session CSRF token (1576.979625ms)
    ✔ login sets a host-only secure HttpOnly cookie without exposing it in JSON (521.055416ms)
    ✔ login refuses cross-origin, missing-origin and wrong-content-type requests (609.243208ms)
    ✔ login rate limiting receives only authenticated single-hop client IP metadata (977.784167ms)
    ✔ auth body parser rejects malformed, non-object and oversized JSON (1002.983083ms)
    ✔ session listing and logout use the same backend-verified session (1274.757458ms)
    ✔ session-bound Website and ttyd gateways fail closed without an authorizer (1416.486791ms)
    ✔ session-bound phpMyAdmin delegates exact panel session context to its authorizer (330.528917ms)
    ✔ site manager phpMyAdmin gateway receives the current Website grants (444.084417ms)
    ✔ site manager elFinder gateway receives current Website grants and target state (370.693917ms)
    ✔ session-bound ttyd gateway delegates exact Owner session context to its authorizer (264.460709ms)
    ✔ read-only role cannot enter protected tool gateways (324.431709ms)
    ✔ read-only role reaches only its explicitly declared inventory surface (359.333916ms)
    ✔ retired legacy agent routes require owner session and reject bearer transport tokens (1064.991459ms)
    ✔ production development endpoints stay closed and public health contains no inventory (415.705208ms)
    ✔ duplicate session cookies are rejected (159.097166ms)
    ✔ insecure or noncanonical production origins cannot start the API (27.318167ms)
    ✖ real store setup/login/session/logout flow works over HTTP (124709.980291ms)
    ✔ createAuthMailer with custom transport sends mail with proper envelope and headers (9.864458ms)
    ✔ createAuthMailer reports isAvailable false when SMTP port is unreachable (54.333ms)
    ✔ createAuthMailer communicates with SMTP server mock (1088.260291ms)
    ✔ email validation strictly rejects invalid formats and normalizes valid addresses (303.756333ms)
    ✔ owner can configure recovery email during setup and manage it afterwards (19434.826459ms)
    ✖ non-owner user cannot set recovery email (120626.811209ms)
    ✔ password reset request generates 15-minute token hashed with SHA-256 and sends email (15387.02425ms)
    ✔ new reset request supersedes previous reset token (single-use replacement) (24188.336875ms)
    ✔ anti-enumeration: non-existent account returns { sent: true } without sending email when SMTP is up (66341.714417ms)
    ✔ fail-closed: when SMTP is unavailable, requestPasswordReset throws 503 smtp_unavailable for all accounts (35519.830708ms)
    ✔ expired reset token is rejected (34452.16225ms)
    
    
    TIMEOUT: `npm test` 45 dakikada bitmedi; süreç grubu durduruldu.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T919 · Doğrulama: test — a site owner adds, changes and removes a user; only a hash is stored and only name
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-18 15:50
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - a site owner adds, changes and removes a user; only a hash is stored and only names are listed
    - the Owner can manage any Domain
    - a user is stored as a SHA-512 crypt hash that openssl reproduces; the password is never written
    - changing a password replaces only that user; removing keeps the others
    - a path or a whole domain can be cleaned up; unknown files list as empty
    - the number of users per directory is capped
    - nginx can traverse the auth root and the domain directory (found on .28: a root-only root made every login 500)
    
    rofiles without allocating a localhost port (0.302583ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.158958ms)
    ✔ normalizes complete Node deployment specs (0.371417ms)
    ✔ normalizes fixed Node process actions against a managed release (1.740541ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (3.69625ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.311958ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.48175ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (10.123ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.308042ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (1.689666ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.229125ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (1.071875ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.136541ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.240583ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (4.881458ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.094583ms)
    ✔ normalizes python rollback, restart, and status specs (0.406459ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (1.478208ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.683959ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.303083ms)
    ✔ tenant constants and role classification predicates (0.9085ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.309375ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.304084ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.198334ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.140375ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.152042ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.203292ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.233458ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.39ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.226292ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.271667ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (1.177541ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.975959ms)
    ✔ tenant context creation and account normalization security edge cases (0.248792ms)
    ℹ tests 72
    ℹ suites 0
    ℹ pass 72
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 254.317667

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T920 · İş yürütücüsü durduğunda durum ve durma nedeni eksik görünüyor
- **Bağımlı:** T881, T892, T898, T899, T913
- **Dosyalar:** `apps/api/src/local-claim-failure-diagnostic.js`, `apps/api/src/local-job-executor.js`, `apps/api/src/local-runtime.js`, `apps/api/src/index.js`, `apps/api/test/local-claim-failure-diagnostic.test.js`, `apps/api/test/local-claim-failure-diagnostic-durable.test.js`, `apps/api/test/fixtures/local-claim-failure-diagnostic-lock-owner.mjs`, `apps/api/test/local-runtime.test.js`
- **Kaynak:** QA · 2026-11-19 00:10
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    16 ve 17 Kasım .28 kayıtlarında yürütücü local_claim_unconfirmed ile durmuş ve mevcut kayıt, sıranın okunmasıyla iş sahiplenmenin hangisinin hata verdiğini ayırt etmiyor. Kimliksiz iş hatasında yalnız güvenli sınıf/kod ve işlem aşamasını servis günlüğüne yaz. Gerçek yerel yürütücü durduğunda durum sorgusu running=false göstermeli. İşi tekrar yürütme ve hata sonrası durma davranışı korunur. Geçici gerçek iş deposu ve gerçek işlem kilidiyle regresyonu doğrula. Tarihsel neden ayrıca açık kalır.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T921 · WordPress klonlamada yeni PHP hedefi varsayılan index.php nedeniyle reddediliyor
- **Bağımlı:** T208, T804, T868, T881, T884
- **Dosyalar:** `apps/api/src/wordpress-clone-service.js`, `apps/api/src/wordpress-toolkit-service.js`, `apps/api/src/management-app.js`, `apps/api/src/site-file-worker.js`, `apps/api/test/site-file-worker.test.js`, `apps/web/src/workspace/SiteWordPressPanel.jsx`, `e2e/ozellik/wp-04.spec.js`
- **Kaynak:** QA · 2026-11-19 04:02
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    .28 0.3.0-2026111901 normal provision edilen geçici PHP hedefi, yalnızca üretim bootstrap index.php dosyası içerdiğinde bile wordpress_clone_target_not_empty 409 döndürüyor. Başlangıç dosyasını sadece bu geçici siteden kaldırınca normal hedef veritabanı kapsamı kontrolüne ilerledi. Hedefi normal panelden kaldırdık. Yalnız canlı bootstrap makbuzu ve içeriği eşleşen tek resmi index.php dosyasına izin ver. Site ve DB sınırlarını koru, var olan diğer dosyaya dokunma, önizleme ve yazma anında tekrar doğrula. İçe aktarma ve yeniden deneme sözleşmesi korunur. Gerçek boş hedef eski önizlemesi uyumlu kalır. Klon formunda başlangıç dosyasını elle kaldırma talimatını güncelle.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T948 · Doğrulama: test — SiteDetailPage surfaces "Web Sunucusu & Nginx" (hosting) and "Alan Adları & Yönlen
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-21 19:50
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - SiteDetailPage surfaces "Web Sunucusu & Nginx" (hosting) and "Alan Adları & Yönlendirme" (domains) in overview tool cards
    - Mail and Database tables have full ARIA semantics and scroll containment
    
    profiles without allocating a localhost port (0.268417ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.190625ms)
    ✔ normalizes complete Node deployment specs (0.380833ms)
    ✔ normalizes fixed Node process actions against a managed release (1.200375ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (1.70275ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.35075ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.978792ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (8.417125ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.336541ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (0.623584ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.346208ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.280209ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.113ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.088833ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (1.615166ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.085625ms)
    ✔ normalizes python rollback, restart, and status specs (0.215375ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (1.319459ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.441459ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.40775ms)
    ✔ tenant constants and role classification predicates (1.048167ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.317ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.295708ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.514041ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.468542ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.401417ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.2375ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.256042ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.381834ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.226791ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.330167ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.283834ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.515209ms)
    ✔ tenant context creation and account normalization security edge cases (0.213333ms)
    ℹ tests 79
    ℹ suites 0
    ℹ pass 79
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 234.302875

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T949 · Trafik ve kota sonrası rota, site kurtarma ve şema regresyonları
- **Bağımlı:** —
- **Dosyalar:** `packages/protocol/src/index.js`, `apps/api/src/hosting-site-create-service.js`, `apps/api/src/hosting-account-schema.js`
- **Kaynak:** QA · 2026-11-22 00:35
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - Owner resolves proxy rule by domainId via real auth/CSRF, updates domain with proxyRoutes + disjoint protectedPaths, stages via real protocol, and renders exact Nginx config
    - Compose reverse-reference protection blocks breaking edits and removal while referenced by active domain, staged/applied live Nginx, or pending stage/activate jobs, allows non-breaking edits, and unblocks after clean activation
    - pending queued DOMAIN_STAGE job blocks breaking Compose edit and removal even if domain draft was cleared
    - shared per-project lock prevents concurrent races between Compose update and Domain proxyRoutes update/stage
    - missing or incomplete siteMutationLock fails closed with 503 across all 6 proxyRoutes and Compose lock callers while empty proxyRoutes pass through
    - legacy Compose projects sharing a published host port allow unchanged routine edits, block new/changed port conflicts, block non-exclusive proxyRoutes (409), and allow binding once exclusive
    - a site owner forwards an old name to their own site and stages it; another tenant's site is refused
    - hosting site create service preserves verified website and allocation when provisioning registration fails
    - Staging E2E: Data migration and rollback procedures for customer and website entities ensure consistent state without orphan records
    - stop answers 503, archive forwards to billing, and active serves the application again
    
    iles without allocating a localhost port (0.294333ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.152917ms)
    ✔ normalizes complete Node deployment specs (0.373292ms)
    ✔ normalizes fixed Node process actions against a managed release (1.134334ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (1.267458ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.485459ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.546709ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (8.043291ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.299166ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (0.705292ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.214416ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.247375ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.130417ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.09025ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (1.145875ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.093625ms)
    ✔ normalizes python rollback, restart, and status specs (0.188ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (0.983708ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.469083ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.41075ms)
    ✔ tenant constants and role classification predicates (0.861292ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.82775ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.225417ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.156625ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.117916ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.121834ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.213584ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.232167ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.386292ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.215958ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.222792ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.29775ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.523083ms)
    ✔ tenant context creation and account normalization security edge cases (0.203375ms)
    ℹ tests 79
    ℹ suites 0
    ℹ pass 79
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 248.919083

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T950 · Doğrulama: test — Klavye navigasyonu, modal odak yakalama (focus trap), Escape iptali ve odak geri y
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-25 02:19
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - Klavye navigasyonu, modal odak yakalama (focus trap), Escape iptali ve odak geri yükleme
    
    e profiles without allocating a localhost port (0.3635ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.164083ms)
    ✔ normalizes complete Node deployment specs (0.495083ms)
    ✔ normalizes fixed Node process actions against a managed release (3.017917ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (1.392125ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.309416ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.393791ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (13.079125ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.380625ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (1.51725ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.512625ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.506542ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.180833ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.112ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (1.653792ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.117792ms)
    ✔ normalizes python rollback, restart, and status specs (0.1905ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (1.213459ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.942042ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.408292ms)
    ✔ tenant constants and role classification predicates (1.040208ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.380292ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.59725ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.317ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.149084ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.132208ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.167166ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.222417ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.36375ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.216333ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.229875ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.315041ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.703209ms)
    ✔ tenant context creation and account normalization security edge cases (0.39475ms)
    ℹ tests 79
    ℹ suites 0
    ℹ pass 79
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 255.909125

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T963 · Doğrulama: test — Gerçek mobil ekranlarda (320px/390px) görünüm, hesaplama, sarmalama ve taşma engel
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-26 05:26
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - Gerçek mobil ekranlarda (320px/390px) görünüm, hesaplama, sarmalama ve taşma engellemesi
    - Koyu temada (data-ws-theme=dark) ve Ember tasarım sisteminde kurtarma ekranı ve modalı token kurallarına tam uyar
    - provisioning recovery wires mobile layout, keyboard focus trapping, dark theme tokens, and abort isolation
    - SiteCreateResult and shared-site result containers wire keyboard focus, screen reader live regions, and theme focus styles
    - Source contract T-DEV-CREATE-RESULT: React StrictMode, logout/login, yetki değişimi, unmount/abort, parola temizleme ve sonuç erişilebilirliği
    
    files without allocating a localhost port (0.611208ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.362792ms)
    ✔ normalizes complete Node deployment specs (0.396291ms)
    ✔ normalizes fixed Node process actions against a managed release (0.6975ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (1.294292ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.294834ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.398167ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (8.296667ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.269083ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (1.540667ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.415958ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.492625ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (1.004958ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.346709ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (1.272833ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.083417ms)
    ✔ normalizes python rollback, restart, and status specs (0.173625ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (0.896959ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (0.37075ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.294875ms)
    ✔ tenant constants and role classification predicates (2.039041ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.30625ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.22725ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.160042ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.120333ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.133917ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.186709ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.204958ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.444458ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.313959ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.240458ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.2795ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.318667ms)
    ✔ tenant context creation and account normalization security edge cases (0.194791ms)
    ℹ tests 87
    ℹ suites 0
    ℹ pass 87
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 238.05475

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T967 · Doğrulama: test — Criterion 17: Güncel MS-01–04 ile tek-kutu silmede alan adı açık kalsın; yalnız se
- **Bağımlı:** —
- **Dosyalar:** —
- **Kaynak:** QA · 2026-11-28 01:22
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Başarısız testler:
    - Criterion 17: Güncel MS-01–04 ile tek-kutu silmede alan adı açık kalsın; yalnız seçilen hesabın gerçek SMTP/IMAP/Postfix/Dovecot/Roundcube erişimi denetlensin. Domain-scope toplu silmenin kendi domain disabled şartı korunur. Disabled kayıt tek başına canlı kapanma kanıtı değildir; ayrıntılı kabul yukarıdaki T-DEV-MR-SINGLE içindedir
    - 5. Non-Distro Version Refused Without Verified Repository
    - PHP-FPM Runtime Golden Path - Distro Baseline, Multi-Version & Verified Repo Validation
    - SCN-DCK-03.3: invalid projectName ("../evil", "UPPERCASE", "-bad") returns HTTP 400 across prepare, generate-compose, and create
    
     without allocating a localhost port (0.719166ms)
    ✔ rejects shell fragments, unsafe entry files, ports and health URLs (0.411208ms)
    ✔ normalizes complete Node deployment specs (0.569584ms)
    ✔ normalizes fixed Node process actions against a managed release (0.471667ms)
    ✔ Passenger release snapshots carry exact site, runtime and routing revisions without a port (1.123167ms)
    ✔ Passenger release snapshots reject systemd ports, arbitrary commands and public secrets (0.276833ms)
    ✔ Passenger snapshots reject missing or ambiguous authorities and unsupported revisions (0.417958ms)
    ✔ proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs (14.117333ms)
    ✔ proxy hosts reject schemes, paths, credentials and config control characters (0.353459ms)
    ✔ normalizePythonRuntimeConfig applies canonical defaults (0.585959ms)
    ✔ normalizePythonRuntimeConfig accepts valid custom options (0.191166ms)
    ✔ normalizePythonRuntimeConfig rejects unsupported versions or app servers (0.245042ms)
    ✔ normalizePythonRuntimeConfig rejects invalid entry points or workers (0.101917ms)
    ✔ normalizePythonRuntimeConfig enforces port requirements when requested (0.974292ms)
    ✔ normalizePythonApplicationSpec normalizes complete spec (1.011417ms)
    ✔ normalizePythonApplicationSpec rejects invalid fields (0.078584ms)
    ✔ normalizes python rollback, restart, and status specs (0.187333ms)
    ✔ a redirect target keeps the URL and defaults to a permanent redirect that keeps the path (1.166042ms)
    ✔ redirect URLs that could break out of the nginx directive or mislead are refused (1.00825ms)
    ✔ redirect Domains accept only settings that apply to a redirect response (0.351916ms)
    ✔ tenant constants and role classification predicates (3.417333ms)
    ✔ assertTenantIdentifier and isValidTenantIdentifier (0.3275ms)
    ✔ normalizeResellerAccount validates reseller models and enforces no nesting (0.657583ms)
    ✔ normalizeCustomerAccount validates customer under reseller and direct Owner customer (0.478084ms)
    ✔ normalizeHostingAccount delegates and verifies expectedKind (0.359791ms)
    ✔ normalizeWebsiteOwnership validates website-to-customer ownership projection (0.749792ms)
    ✔ createTenantContext builds accurate tenant context for all roles (0.253083ms)
    ✔ resolveEntityTenantScope maps all entity types to their tenant scope (0.53325ms)
    ✔ assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM (0.422417ms)
    ✔ filterByTenantBoundary filters resources according to actor tenant boundary (0.226459ms)
    ✔ resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors (0.229666ms)
    ✔ assertTenantAccess negative scenarios: cross-tenant data leakage prevention (0.523208ms)
    ✔ filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections (0.321875ms)
    ✔ tenant context creation and account normalization security edge cases (0.198833ms)
    ℹ tests 87
    ℹ suites 0
    ℹ pass 87
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 313.371542

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.
