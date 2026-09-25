# Development — gerçek ortam ek TODO

Bu dosya kök `todo.md` ve T-PL kabul listesini tamamlar; eski açık kabulleri kaldırmaz. Aktif dal `development`. `.44` Plesk hostu her amaçla yasak; yalnız `.local/test-server.env` içindeki izinli hedef teyit edilerek kullanılabilir.

## T-DEV-WEBSITE-REMOVE — cleanup adapter ve UI

- [x] `effb126f` / `5f14abda`: `fileCleanupHandler` canonical app/data/build/publish direct-child kökleriyle production composition'a bağlandı; symlink/foreign/shared state fail-closed, exact Website/Application receipt ve backup/log retention korunuyor.
- [x] `effb126f` / `c5d43ba8`: `unixIdentityCleanupHandler` yalnız provisioning journal'daki operation-owned `unix_identity` evidence ile compensation yapıyor; legacy/unowned/shared kimlik fail-closed kalıyor ve sonuç yeniden doğrulanıyor.
- [x] `d80c3357`: Application metadata lifecycle eksikliği `application_cleanup_unavailable` hard blocker olarak eklendi; yarım file cleanup ile kırık Application kaydı oluşmasına izin verme.
- [x] `befbe56f`: Owner-only GET removal preview UI; impact/blocker/journal görünür, destructive POST yok.
- [x] Application/env lifecycle: app-scoped variables/internal deployment credential/webhook secret purge + exact server/Application revision delete; Website metadata önce, Application metadata sonra olacak crash-safe sıra.
- [x] Host cleanup: provisioning receipt-owned Unix identity compensation; canonical app/data/build/publish direct-child file cleanup; backup/log scope retention evidence. Symlink/foreign/shared Application fail-closed.
- [x] Runtime cleanup: Passenger/Static exact `sourceOperationId + revision`; direct-systemd `53afe904` → `2455cc38` ile live Application evidence + deployment receipt + deterministic unit/env/current-release preflight, verified stop/disable/remove/daemon-reload ve varsa owned binding null-read. Receipt'siz legacy direct-systemd fail-closed.
- [x] Owner-only destructive UI + global recovery: domain adıyla typed confirmation, her çağrıda tek journal adımı, metadata kaybolduktan sonra global continue, unknown POST replay yok.
- [x] Cron cleanup bridge: `dedb4848` → `2ead7dc2`; exact cron identity step checkpoint'e yazılır, ortak durable `cron.remove` işi deterministic idempotency ile bulunur/oluşturulur; queued/running başarı sayılmaz, succeeded job + metadata yokluğu doğrulanır. `ea53f6d3` kaynak regresyonlarını ekler.
- [ ] Node24/npm11 gerçek checkout: tüm website-removal/application/environment/resource-impact + yeni cleanup/preflight/owner-recovery/frontend model/wiring regresyonları ve tam npm ci/check/build.
- [ ] Gerçek izinli host: Passenger/Static/direct-systemd site removal; multi-domain, cron/SFTP/DB credential/binding, Unix receipt, four canonical roots, systemd unit/env yokluğu, Website→Application metadata sırası, restart/blocked/failed continuation. Receipt'siz legacy direct-systemd blocker davranışı ayrıca doğrulansın. `.44` kullanılmaz.

## T-DEV-SUSPEND-UI — Website suspension ekranı sonrası

Kaynak: `482fb0e6`, `861ed2f9`; rapor `docs/ux/website-suspension-flow.md`. Mevcut journal/compensation motoru UI'ye bağlandı; yeni host motoru yazılmadı.

- [ ] Node24/npm11 tam checkout: Website/Domain suspension HTTP/runtime/registry + yeni panel/model/wiring testleri; tam npm ci/check/build.
- [ ] Owner/Site A/Site B tenant sınırı, session/grant revoke, stale preview/updatedAt, typed confirmation ve doğrudan API.
- [ ] Multi-domain partial suspend/resume, explicit retry, Nginx host/control-plane drift, API/process restart ve kayıp mutation cevabı. Kör replay olmamalı.
- [ ] Browser responsive/zoom/klavye/reload/back-forward/site değişimi ve Files/cron/PHP/backup/analytics/SSL regresyonu.
- [ ] Yalnız izinli test hostu; `.44` kullanılmaz.
## T-DEV-ANALYTICS — site GoAccess ekranı sonrası

Kaynak: `a99ccaf1`, `0848080f`, `cedec1a0`, `b3db42d2`; rapor `docs/ux/site-analytics-flow.md`. Yeni testler kaynakta var, bu oturumda tam checkout/test çalıştırılmadı.

- [ ] Node24/npm11 gerçek checkout: analytics safety/source/model/wiring + GoAccess manager/gateway/site-resource-boundary regresyonları; tam npm ci/check/build.
- [ ] Owner/Site A/Site B auth/CSRF: yalnız atanmış Website statik raporu/status. JSON/HTML/gateway yanıtlarında başka site verisi ve host PID/socket/path bilgisi olmamalı.
- [ ] Realtime lifecycle site_manager 403; Owner start/restart/stop. Ağ cevabı kaybolursa POST replay yok; status GET sonrası gerçek durum.
- [ ] GoAccess missing, rotated/empty log, report generation failure, stale daemon socket ve log izolasyonu. Raw host error kullanıcı cevabına çıkmamalı.
- [ ] Chromium/Firefox responsive/zoom/klavye/reload/site değişimi; mevcut Files/cron/PHP/backup/SSL yolları.
- [ ] Yalnız izinli test hostu; `.44` kullanılmaz. `docs/history/goaccess-live-acceptance-2026-09-20.md` geçmiş kanıttır.
## T-DEV-PHP-ACTIONS — reviewed action sözleşmesi sonrası

Kaynak: `405d3cee`, `6a14d501`, `47053dfc`, `6a02d83f`; ayrıntı `docs/ux/php-tools-flow.md`. Bu aşamada yalnız sabit action preview/onay sözleşmesi ve raw run endpoint daraltması vardır; site mutation UI/job execution açılmadı.

- [ ] Node >=24.11.1/npm >=11 gerçek checkout'ta `node --test apps/api/test/website-php-tool-action.test.js apps/api/test/website-php-tool-preview.test.js apps/api/test/website-php-tool-http-source.test.js` ve mevcut tüm website-php-tools/http/host-runtime regresyonlarını çalıştır; ardından tam `npm ci` / check / build. Bu tur GitHub DNS çözülmediği için test koşulmadı.
- [ ] Owner ve site_manager gerçek auth/CSRF: site_manager raw `wp-cli/run` ve `composer/run` için 403; action preview yalnız kendi Website kimliğiyle çalışmalı. Yabancı Website/Application/Unix kimliği ve revision değişimi 409/403 olmalı.
- [ ] Yeni protocol/action/queue/local-executor/result/receipt/recovery testlerini Node24/npm11 gerçek checkout'ta çalıştır: `packages/protocol/test/php-tool-action.test.js`, `apps/api/test/website-php-tool-action*.test.js`, `local-website-php-tool-operation.test.js`, `website-php-tool-job-result.test.js`, `website-php-tool-operation-receipt.test.js`, `job-running-php-tool-recovery*.test.js`, `job-recovery-php-tool-cli.test.js`. Tam eski job/local-runtime/recovery regresyonları da birlikte koşsun.
- [ ] PHP-ACTION-02c sonrası bağlantı kopması, worker/API restartı, aynı action çift tıklaması, iki sekme ve terminalden eşzamanlı çalışma. Receipt varsa recovery host komutunu ikinci kez çağırmamalı; receipt yoksa running job unresolved kalmalı. Unknown sonuçta yeni komut otomatik başlamamalı.
- [ ] Canlı auth/CSRF kabulü: site_manager action preview/queue yalnız kendi Website'inde; session revoke, rol/grant değişimi veya Website transferi enqueue ile worker başlangıcı arasındaysa action çalışmamalı. Kaynakta `getSessionById` ve worker reauthorization bağlı; gerçek auth HTTP ile doğrula. Owner raw endpoint ayrı debug/admin yüzeyi olarak kalmalı.
- [ ] İki bağımsız API processini aynı job store üzerinde aynı Application action'ına yarıştır. Application hazırlık lock'u eşzamanlı pencereyi kapatsa da ikinci processin stale in-memory JobRegistry state'ini yeniden yüklediği kanıtlanmadı. Production tek API writer ile çalışıyorsa bunu paket/service kabulünde doğrula; çok writer desteklenecekse ortak durable job-store process lock/reload kaynak işi ekle.
- [ ] İzinli test hostunda yalnız sabit katalog eylemlerinin doğru dedicated site Unix kullanıcısı ve doğru release/proje dizininde çalıştığını doğrula. `.44` Plesk hostuna dokunma.

## T-DEV-BACKUP-UI — site backup browser sonrası

Kaynak: `06bc9fc3`, `300f813a`; rapor `docs/ux/site-backup-manager.md`. Bu aşamada siteye özel yedek envanteri görünür; senkron backup/restore mutation UI'ye bağlanmadı.

- [ ] Node24/npm11 gerçek checkout'ta yeni browser/model/wiring testleri ve mevcut website-backup/restore/restic/site-resource-boundary regresyonları; tam npm ci/check/build.
- [ ] Owner/Site A/Site B: global backup repository/remotes/snapshot rotaları site_manager için kapalı, Website-scoped browser yalnız kendi site etiketini döndürmeli. Repository target/path/raw error/host/user bilgisi sızmamalı.
- [ ] 100+ snapshot, locked/error/uninitialized repository, stale site binding, session revoke ve site değişimi.
- [ ] Chromium/Firefox responsive/zoom/klavye/reload/back-forward; Files/cron/PHP/SSL regresyonları.
- [ ] Durable mutation sonrası gerçek backup → restart/kayıp cevap → receipt/recovery → restore → health failure → rollback kabulü. `.44` kullanılmaz.
## T-DEV-FILES — 256d991f ve 72a16712 kaynak sonrası

Kaynak kanıtı: `docs/history/development-files-entry-2026-09-23.md` ve `docs/history/site-files-visible-access-2026-09-23.md`. Global giriş ve site sekmesinin görünürlüğü kaynakta uygulandı. Node22 model/kaynak testleri gerçek dosya işlemi veya React render kabulü değildir.

- [ ] Node >=24.11.1/npm >=11 ile gerçek checkout'ta npm ci ve tam lint/test/build. `files-entry-model.test.js` ve `site-files-access.test.js` dahil olsun. Bu ortamın Node22 model testleri hedef sürümün veya JSX/React'in yerine geçmez.
- [ ] Chromium/Firefox üretim bundle'ında Owner ve iki site_manager: global Dosyalar menüsü ve mevcut domain File Manager. Tek site otomatik geçişi, çok site seçimi, `?site=<WebsiteID>` ve eski Domain-ID rota farklılığı.
- [ ] 403/401/500, yavaş/stale veri, eksik ilişki, yanlış/duplicate/site silinmiş ID, izin iptali. Yanlış hedef başka siteye düşmemeli; backend diğer siteye erişimi bağımsız reddetmeli. 72a16712 sonrasında site Files sekmesi bu durumlarda kaybolmamalı; gerçek neden/retry görünmeli ve doğrulanmayan FilesPanel mount edilmemeli.
- [ ] Gerçek site kullanıcısıyla liste/klasör/upload/create/edit/rename/delete/download, symlink/path izolasyonu. Bu tur mevcut file engine değişmedi ama girişten uçtan uca erişim kanıtlanmalı.
- [ ] Reload/back/forward, globalden siteye geçiş, dosya yolu/taslak, mobil/klavye, uzun liste. Özellikle manuel/arka plan refresh, stale→ready, site/oturum değişimi ve yetki iptalinde kaydedilmemiş editör içeriğinin sessiz kaybı veya başka siteye taşınması olmamalı. Gerekli draft koruma kaynak işi UX-PL-01f/08'de açıktır; görünür sekme tek başına kabul değildir.
- [ ] Yalnız izinli hostta API/web build kimliği ve asset tazeliği; bu kaynak commit'i dağıtılmış sayılmaz. UX-PL-01/DOS-01 üst kutuları gerçek kabul geçmeden kapanmaz.

## T-DEV-OWNER-PROFILES — RS-03a / RS-04a kaynak sonrası

Owner API `/api/users/hosting/accounts` mevcut kullanıcı router'ına bağlı; kaynak UI `/settings/users` içindedir. Commitler `058433a4`, `ecd39609`, `c7eed21e`; kanıt `docs/history/hosting-owner-ui-2026-09-23.md`. Bu tur 82 seçili istemci/model/kaynak testi geçti; JSX yalnız sözdizimi olarak kontrol edildi. Önceki API turunun 83 testi yeniden çalıştırılmış sayılmaz. Backend tenant/site erişimi bu UI ile açılmaz.

- [ ] Node >=24.11.1/npm >=11 tam checkout'ta `npm ci` ve `npm run check`; yeni `user-admin-patch.test.js`, `hosting-account-client.test.js`, `hosting-accounts-wiring.test.js` ve mevcut `user-admin-client.test.js` dahil. Gerçek React/Vite build ve modül çözümleme: kaynak ayrıştırma bunların yerine geçmez.
- [ ] Chromium/Firefox Owner akışı: Ayarlar → Kullanıcılar; normal kullanıcı CRUD korunmalı. Bayiler/Müşteriler listesinde 26+ kayıt, tür değiştirme, son sayfa boşalınca geri dönüş, refresh ve güncel kayıtla profil açma. Mevcut site_manager + boş Website listesi üzerinde bayi/doğrudan müşteri/bayi müşterisi bağlama; bayi seçicinin ikinci sayfasını da kullan.
- [ ] Boş/0/null ve büyük adet limitleri; limit azaltıldığında mevcut kayıtların korunması. Kullanımın kayıtlı/ayrılmış site adedi olduğunu doğrula; çalışan site veya disk sayacı gibi gösterilmesin. Askıdaki bayi picker'dan seçilememeli; okuma sonrasında bayi durumu değişirse backend reddetmeli.
- [ ] Genel kullanıcı formunda profilli hesabın ismini değiştir: PATCH yalnız değişen alanları taşımalı. Kasıtlı rol/active/site grant değişimi backend tarafından hâlâ engellenmeli. Yeni profil bağlandıktan sonra kullanıcı revizyonu yeniden okunmalı; eski userRevision ile ikinci işlem sessizce uygulanmamalı.
- [ ] Gerçek API 401/403, 404 eksik endpoint ile `hosting_account_not_found` ayrımı, 409 stale/limit, 500 ve bağlantı kesintisi. Kaybolan POST/PATCH/DELETE cevabı otomatik tekrar edilmemeli; kapat/yeni liste/güncel profil akışı ile sonuç uzlaştırılmalı. Yanlış hedef/parent veya beklenmeyen yanıt başarıya dönüşmemeli.
- [ ] Profil kaldırmada kullanıcı adı onayı; yalnız boş profil kalkmalı, login ve siteler kalmalı. Müşteri/site/rezervasyon bağı varsa 409 açıklaması görünmeli. Kaldırma sonrası profil listesinden düşmesi, login listesinin korunması ve başka hesabın etkilenmemesi doğrulanmalı.
- [ ] Modal focus/Escape, kaydedilmemiş taslak onayı, çift tıklama, devam eden istek sırasında kapatma, önceki oturumdan geç yanıt, reload/back/forward ve logout. 320/390/834/1440 px, %200 zoom, klavye ve ekran okuyucu; tablo/picker taşması ve gerçek loading/error/retry kabulü. Yeni sayfa/tema/Files değişikliği yapılmadı ama mevcut akış regresyonu sınanmalı.

## T-DEV-RESELLER — RS-02a/b/c/d kaynak sonrası

Kaynak kapsamı ve kalan kod: `docs/ux/plesk-full-scope.md` RS-02e–05. Önceki auth-depo kanıtı `docs/history/reseller-auth-storage-2026-09-23.md`; site kontenjanı/servis kanıtı `docs/history/reseller-site-allocation-2026-09-23.md` (`5b2afce3`, `99473414`, `654dbf64`). Aynı auth DB'sinde profil/limit deposuna kalıcı site kontenjanı ve mevcut site-create motoru için iç servis factory eklendi. **Reseller/customer self-service veya çalışan site job runtime bağlantısı açılmadı; hostta migration/deploy yapılmadı.** Owner profil API/UI kaynağı ayrı T-DEV-OWNER-PROFILES altında izlenir. İlk sürüm için paket/abonelik motoru kurulmaz.

RS-02d turunda `hosting-site-*.test.js` dosyaları: **65 geçti / 0 başarısız / 0 atlandı**, Node22.16.0/npm10.9.2. SQLite, dosya tabanlı yeniden açılış ve Worker yarışları gerçek; auth/MFA/session/Website/create adaptörleri kontrollü fixture. İki site yarış testi ayrıca 5 koşuda geçti, ayrı yeni test olarak toplama eklenmez. Önceki turun 97/1-atlandı ve RS-01'in 107 sonuçları o tur yeniden çalıştırılmadı. Factory syntax/kaynak bağlantısı testi gerçek site engine veya native auth kabulü değildir. Bu Owner UI turunda backend testleri yeniden çalıştırılmadı.

- [ ] Node >=24.11.1/npm >=11 gerçek checkout'ta `npm ci` ve `npm run check`. `node --test apps/api/test/hosting-site-*.test.js apps/api/test/hosting-account-*.test.js apps/api/test/user-admin-store.test.js` ile önceki `reseller-scope.test.js` / `reseller-limits.test.js` ve mevcut site-create/provisioning/regresyon testlerini birlikte çalıştır. Bu ortamda GitHub DNS erişimi olmadığından tam checkout/bağımlılıklar alınamadı; seçili connector dosyalarıyla çalışıldı.
- [ ] Özellikle `hosting-account-native-auth.test.js` hedef Node'da **atlamadan** geçsin: gerçek Argon2 setup/login, profil bağlamada eski oturum iptali, Owner oturumunun korunması ve yeni girişin site_manager + boş site kapsamı olarak kalması. Test önceki tur Node22'de native Argon2 yokluğundan atlandı; shim kullanıp native auth geçti denmesin. Gerçek MFA/challenge, uzun bağlantılar ve mevcut auth/login/user-admin testleriyle birlikte doğrula.
- [ ] İzinli test hedefinin doğrulanmış auth yedeğinde eski profil şemasına site kontenjanı yan şemasının eklenmesi, tekrar açılış ve geri dönüş; users/ID/parola/MFA/session/Website üyelikleri korunmalı. Yerel boş rollback ve eski profil tablosunu koruyan kurulum testleri geçti; veri içeren migration/rollback ayrıca tasarlanıp sınanmalı. Profil eski site_manager üyeliklerinden otomatik üretilmesin; ikinci login deposu kurulmasın.
- [ ] RS-02e runtime bağlantısı sonrasında gerçek `createHostingSiteCreateRuntime` ile mevcut site preview/create/provisioning motorunu çalıştır: müşteri bağlı onay, `siteAdmin` çakışması, yarım application/Website/domain/mail oluşturma, restart, aynı işlem tekrarı, stale plan, registry yazma hatası ve logout. API'den gelen snapshot/usage/role kanıt sayılmasın. `attached` yalnız sahiplik kaydı; `provisioningReady: false` gerçek host kabulü olmadan true yapılmasın.
- [ ] Site kotası ve lifecycle yarışları: bütün bayi müşterileri, askıdaki site ve bekleyen rezervasyon sayılır; son kontenjana iki farklı işlemden yalnız biri girmeli, aynı iş ikinci kontenjan tüketmemeli. Yerel SQLite yarışları geçti fakat API/host entegrasyonu, parent suspend, limit azaltma, farklı CLI/API süreçleri ve mevcut `/api/sites` / `/api/websites` yolları ortak kilit/yetkiyle sınanmalı. Servis içi Map süreçler arası kilit değildir.
- [ ] Güvenli cleanup/release: timeout/başarısız cevap otomatik rezervasyon silmemeli. Mevcut removal/compensation gerçek kaynakları temizlemeden ve eski yürütücünün yeniden yazması engellenmeden kontenjan serbest bırakılmamalı. Kısmi kaynak, cleanup hatası ve restart testi; doğru müşteri/site/iş kimliği, audit ve idempotency. Bu kaynak bağlantısı RS-02e'de açık; doğrudan SQL silme kabul değildir.
- [ ] Registry okuması ile auth sahiplik kaydı arasındaki bütün yazıcılar kaynak kilidiyle koordine edilmeli. Kayıt sonrası site server/runtime/Unix kimliği veya sahipliği değişince API/job/AI/tool/gateway/WS güncel durumu yeniden doğrulamalı. `registered_ownership` / `registered_and_reserved_ownership` bütün host sitelerinin veya canlı disk tüketiminin ölçümü diye sunulmasın.
- [ ] RS-03/04 tüm rollerin API/UI bağlantısı sonrasında: server-side filtreleme, mass-assignment/rol/parent/transfer engeli, revizyon, audit ve bağlı kaynakta silme engeli. Genel `/api/users` üzerinden profilli hesapta rol/active/site grant/silme bypass denemeleri kontrollü hata vermeli; normal parola/isim ve profilsiz kullanıcılar çalışmalı. Reseller kendi limitini veya Owner hesabını değiştirememeli.
- [ ] Owner, iki bayi, her bayide iki müşteri ve doğrudan Owner müşterisiyle API/list/job/log/AI/Files/DB/backup/tool/gateway/WebSocket tenant izolasyonu. Rol, müşteri veya bayi askıya alma ardından mevcut oturum ve açık bağlantılar yeniden yetkilendirilsin/iptal edilsin. Kayıt transaction'ında audit veya MFA iptal hatası yarım kayıt bırakmamalı.
- [ ] Gerçek tarayıcı: Owner Bayiler/Müşteriler; bayi Müşterilerim/Sitelerim; müşteri kendi site araçları. Files iki girişi, hata/retry, reload/back, yanlış ID ve oturum değişimi. Paket/abonelik açtırılmasın; henüz bağlanmamış eylem çalışıyor gösterilmesin.
- [ ] Entegrasyon/test bitmeden reseller login'i açma ve production'a dağıtma. Sonucu güncel commit/build kimliğiyle kaydet; kaynak testini canlı kabul sayma. Şema/legacy geçiş korumalarını bütün erişim yolları bağlanmadan kaldırma.

## T-DEV-REMOVAL-SAFETY — RS-02e.1/2 kaynak sonrası

`1e59771e` / `d3e16942`: hedef/onay bağlama, aynı registry içi örtüşme engeli ve cleanup doğrulama kontrolleri. Kanıt: `docs/history/website-removal-safety-2026-09-23.md`. Seçili kaynakta 70 test geçti; host adaptörleri kontrollü test verisidir. RS-02e ve BUG-20260923-02 üst kabulleri açık kalır.

- [ ] Node24/npm11 tam check ve mevcut removal/provisioning/site-create regresyonları. Yeni `website-removal-target.test.js` / `website-removal-cleanup.test.js` ve güncel runtime testlerini hedef sürümde çalıştır. Gerçek Express + auth/Origin/CSRF/MFA üzerinden Owner/Site A/Site B ile farklı URL Website/confirmation/operationId kombinasyonlarını reddet; işlem sırasında yetki/oturum kaybını sınayarak hiçbir başka-site sonucu döndürülmediğini doğrula.
- [ ] İzinli hostta gerçek file/Unix/direct-systemd cleanup ve durable cron kaldırma job sonuçlarını bağımsız doğrula. Production `index.js` bu adapter/job köprülerini artık bağlıyor; eksik receipt, unsafe path, foreign unit/env veya missing dependency varken önizlemede blocker + null confirmation görünmeli ve Domain silme dahil kısmi işe başlanmamalı. Node24/npm11 full suite + restart/write-failure kabulü root plan BUG-02/WR-04'te açık.
- [ ] Dosya/Unix temizliğinde gerçek hedef, korunan yedekler ve erişim kapanmasını doğrula; SFTP/DB/runtime kaydının silinmesi host temizliği sayılmasın. Receipt alanlarını istemci veya saf metadata çıktısından üretme. Kısmi temizlik, yanlış hedefli receipt, başarısız key revoke ve izin/disk/servis hatası silmeyi tamamlandı göstermemeli; düzeltilmiş aynı iş açık onayla devam etmeli.
- [ ] Website registry disk yazma hatası ve cache tutarlılığı; metadata silme sonrası süreç kapat/aç ve soğuk disk yeniden okuması. `getWebsite() === null` tek başına kalıcı disk temizliğini kanıtlamaz. Eski removed kayıtlarını kota release kanıtı sayma; uygulama/domain/mail/Unix kalıntıları ayrıca kontrol edilsin.
- [ ] Bağımsız API/CLI/create/provisioning/removal yazıcıları ortak kalıcı kilit altında yarışsın. Same-registry WeakMap yalnız aynı süreçte örtüşen removal çağrılarını reddeder; diğer yazıcıların kilidi değildir. Başarısız silmenin yerine yeni operation açılamamalı; restart sonrasında doğru önceki iş uzlaştırılmalı. Eski yürütücünün yeniden yazması engellenmeden ve gerçek cleanup doğrulanmadan kontenjan bırakılmamalı; release hâlâ açık kaynak işidir.

## T-DEV-PARITY — korunmuş uzun vadeli kapsam

- [ ] Envanterdeki satırlara mevcut YunPanel dosya/API/servis kanıtı ve rol bazlı canlı kabul bağla; checkbox sayısından tamamlanma yüzdesi üretme. Sade reseller için RS-00–05 geçerli; tam paket/abonelik/overselling/markalama sonraki fazdır ve MVP engeli değildir.
- [ ] Marketplace envanterini vendor/version/OS/lisans ve alt özellik düzeyinde tamamla (EKL-07); ilk reseller uygulamasına araştırma önkoşulu yapma.
- [ ] Sade Owner→isteğe bağlı Reseller→Customer→Website modelinin migration/rollback kabulü yukarıdaki T-DEV-RESELLER'de; tam provider/subscription/plan hattını ayrı sonraki faz olarak tut.
- [ ] Açık kaynak taban seçimi ayrıca kabul edilirse, temiz izolasyonlu hedefte lisans/bağımlılık ve ortak iş senaryosu karşılaştırması yap. Aynı hostta iki panelin aynı konfigürasyonu yönetmesine izin verme; mevcut canlı siteyi deney ortamı yapma.