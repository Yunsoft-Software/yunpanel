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
- **Bağımlı:** —
- **Dosyalar:** `e2e/live-audit/13-native-source-mutation.spec.js`, `e2e/live-audit/15-native-source-removal-mutation.spec.js`, `e2e/live-audit/16-native-hosting-dns-restore.spec.js`, `e2e/live-audit/18-native-application-environment.spec.js`, `e2e/live-audit/19-native-hosting-settings.spec.js`, `e2e/live-audit/20-native-tenant-sites.spec.js`, `e2e/live-audit/22-native-hosting-file-settings.spec.js`
- **Kaynak:** SENIOR · 2026-11-09
- **İş:** Bu 59 test 10 Ekim'deki geçici kabul ortamına bağlı (`YUNPANEL_AUDIT_ACCEPTANCE_SHA`, `.local/acceptance-candidate/host-control.py`, `extraStatic`) ve hemen düşüyor; yani hiçbir şey sınamıyor. Bu ortamı geri kurma. Her test için karar ver: davranışı `e2e/ozellik` veya kalan `live-audit` zaten sınıyorsa testi sil ve raporda karşılığını `dosya:test adı` ile yaz; sınamıyorsa normal koşuda (panel API'si ve arayüz, kendi kaynağını kurup silerek) çalışacak şekilde yeniden yaz. Karşılık gösteremediğin testi silme. Sunucuya root ile müdahale eden adımları panel akışına çevir; çevrilemiyorsa testi silme, raporda gerekçesiyle listele. Dosyada test kalmazsa dosyayı sil.
- **Kabul:** 59 testin her biri raporda (silindi + karşılığı / yeniden yazıldı / listelendi + gerekçe); kalan testler `.28`'de iki koşuda da geçiyor ya da bulgu numarası var; `.28`'de `ypaudit-` kaynağı kalmadı; `npm run lint` geçiyor.
