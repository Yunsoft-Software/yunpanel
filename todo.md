# YunPanel — Codex / Gerçek Ortam TODO

Bu dosyada yalnız güvenilir biçimde çalıştırılamayan gerçek ortam doğrulamaları tutulur. Ürün/kod işleri `plan.md`, bağlayıcı kurallar `agents.md` içindedir. Doğrudan `main` üzerinde küçük commitler kullan; GitHub Actions kullanma. Secret, parola, cookie, MFA secretı veya kişisel veriyi repo/log/screenshot içine yazma.

Önceki dar kaynak-alt-kümesi sonuçlarının sınırları ilgili runbooklarda korunur. 2026-09-09'da güncel birleşik ağaç Node 24.19 üzerinde yerelde ve Node 24.20 üzerinde Ubuntu paket build hostunda filtresiz çalıştırıldı: repository policy, **473 test** ve Vite production build geçti. Bu sonuç native auth/SQLite/Argon2, master-key rotation, request-auth, local executor, host-runtime ve UI model testlerini kapsar; kullanıcı credentialı gerektiren gerçek Owner/MFA/Read Only, responsive/keyboard ve rollback kabulünün yerine geçmez.

## T-RUNTIME — P0: Desteklenen runtime ve tam repo kabulü

- [x] Node 24.11.1+ ve npm 11+ ile temiz dependency install yap; workspace manifestlerini ve native dependencies'i doğrula.
- [x] Filtre olmadan `npm run check`, bütün workspace testleri ve production build çalıştır. Test/build hatasını runtime gereksinimini düşürerek veya test atlayarak çözme.
- [x] Güncel `panel-http-guard.test.js`, `authenticated-core-boundary.test.js` ve request-auth fixture'a taşınan core/deploy/rollback/ACME/Node/package flow testlerini birlikte çalıştır. Raw `createApp()` + eski/admin Bearer management erişimi 401 kalmalı; authenticated listener gerçek core'a yalnız server-derived `request.auth` ile geçmeli; legacy agent claim/result/environment rotaları kendi agent credential'larını korumalı.
- [x] API/web/package entry pointlerinin aynı committen geldiğini doğrula.
- [ ] Bilerek mixed web/API build üretildiğinde privileged UI'ın fail-closed kaldığını ayrıca doğrula.
- [x] `.github/workflows` ekleme/değiştirme; doğrulamaları yerel/test hostunda çalıştır.

## T-LOCAL-EXECUTOR — P1: Yerel iş yürütücüsü ve host-runtime kabulü

- [x] `docs/local-executor-safety.md` içindeki beş test dosyasını desteklenen Node 24.11.1+ / tam workspace'te tekrar çalıştır. Ayrıca `apps/api/test/local-host-operations.test.js`, gerçek registry kullanan `local-job-executor.test.js`, host-runtime/agent package-manager testleri ve mevcut Node status testlerini birlikte çalıştır.
- [x] Paketlenmiş gerçek `@yunpanel/host-runtime` importunu ve agent compatibility re-export'unu test et. `yun-agent.service` varsayılan adı, eski API/web/agent restart planı ve yerel API/web override'ı güncel testlerle geçti; gerçek APT upgrade ve servis restartı test hostunda doğrulandı.
- [ ] Gerçek job registry ve disk üzerinde claim/result yazımı, rename, disk-full/read-only ve kaybolan acknowledgement hatalarını kontrollü üret. Başarılı host işi completion hatasında failed'e çevrilmemeli; belirsiz claim/complete/reconcile instance'ı durdurmalı ve yeni claim/otomatik retry olmamalı. In-memory terminal verisini durable disk kaydı kabul etme; plan B'deki kalıcı registry/recovery işi tamamlanmadan process restartını çözüm sayma.
- [ ] Stop sırasında çalışan işin execution/complete/reconcile aşamalarının beklendiğini, paralel runOnce'un aynı işi tekrar yürütmediğini ve eski scheduler callback'lerinin stop/restart sonrası iş başlatmadığını doğrula. Fault metadata'sında yalnız safe code/phase/jobId olmalı; raw exception/command/env/key/path kayıtlarına sızmamalı. Legacy hata yollarını ayrıca denetle; local sanitizer bütün sistem için redaction kanıtı değildir.
- [ ] İzole Ubuntu Node uygulamasında gerçek current symlink, deterministik systemd unit, runtime port/path ve health sonucunu karşılaştır. Wrong/missing release veya farklı uygulama kimliği host işleminden önce reddedilmeli. Buradaki gerçek temp-file/loopback HTTP testi gerçek systemctl, süreç izolasyonu veya live host kabulü değildir.
- [ ] Entry-point bağlantısı geliştirildiğinde önce explicit local-server binding, desteklenen operation seçimi, tek worker/kuyruk sahipliği, job drain ve kalıcı recovery'yi doğrula. Eski agent ve local worker aynı kuyruğu tüketmemeli; taşınmamış restart/deploy işleri boş env ile yürütülmemeli. `index.js` henüz local executor başlatmıyor; bu yardımcı modüllerin varlığını agentsiz production geçişi sayma.

## T-ACCESS — P0: Read Only gerçek kabulü

- [x] Yeni `panel-access`, `panel-http-guard`, owner-MFA capability, Read Only HTTP ve owner-access testlerini tam Node 24 workspace içinde mevcut auth/core testleriyle birlikte çalıştır.
- [ ] Gerçek browserda Read Only hesabıyla Dashboard, Web Siteleri, site detail ve Sunucular ekranlarının açıldığını doğrula. Jobs, Users, Settings, Applications management, Domains management, create ekranları ve diğer mutation yüzeyleri görünmemeli/mount edilmemeli.
- [ ] Network panelinde Read Only oturumunun yalnız izin verilen `GET/HEAD /api/{servers,applications,domains,certificates}` list/detail isteklerini yaptığını doğrula. `/jobs`, `/users`, application env/status, nested system inspection veya herhangi bir mutation otomatik/polling olarak üretilmemeli.
- [ ] Raw API'de Read Only ile jobs/users/env/status/system inspection ve bütün mutation isteklerinin core management handlerına ulaşmadan `403` kaldığını doğrula. URL yazarak veya client payload değiştirerek izin genişletilememeli.
- [ ] Owner + MFA management görünümünün eski işlevlerini regresyondan geçir. Read Only capability metadata'sına `*` veya bozuk mode enjekte edildiğinde UI ve API fail-closed kalmalı.
- [ ] Role change / disable / delete / logout sonrası açık Read Only ekranlarında eski kaynak cache'i kalmamalı; yeni session gelmeden stale privileged veri render edilmemeli.

## T-KEY — P0: Secret master-key rotation kabulü

- [x] Node 24 full workspace'te `apps/api/test/secret-master-key-rotation.test.js` çalıştır. Active MFA, pending MFA, application secret, public env value, wrong-current-key preflight, same-key reject, backup tamper, target-path binding, absent pre-rotation env-store ve rollback senaryolarının tümü geçti.
- [ ] Test hostunda packaged service ile `docs/secret-master-key-rotation.md` runbook'unu birebir prova et: bağımsız console/SSH erişimi -> yedek -> `yunpanel-api.service` stop -> rotation -> `api.env` root key update -> service start -> health/functional validation.
- [ ] Rotation sonrası Owner password + TOTP login, recovery akışı ve secret application environment materialization çalışmalı. API/frontend secret value'yu maskeli tutmalı; loglarda `mfa_key_unavailable` / `secret_decryption_failed` benzeri hata olmamalı.
- [ ] Rotation backup directory'nin 0700, snapshot/key dosyalarının 0600 ve public web root dışında olduğunu doğrula. Manifest raw key/plaintext secret içermemeli; generated key hiçbir argv/log/audit çıktısına düşmemeli.
- [ ] Rollback tatbikatı yap: API stop -> aynı live store pathleriyle rollback -> önceki `YUNPANEL_SECRET_MASTER_KEY` geri yükle -> API start -> MFA + application secret validation. Old-data/new-key veya new-data/old-key ile servis açma.
- [ ] Process kill/power-loss benzeri kesinti noktasını kontrollü test hostunda simüle et; backup/manifest ile deterministik recovery yapabildiğini doğrula. Bu prova tamamlanmadan production root key rotate etme.
- [x] Debian/package çıktısında `scripts/rotate-secret-master-key.mjs`, root `npm run secret-key`, `.env.example` ayarları ve runbook'un bulunduğunu doğrula.

## T-USER — P0: Kullanıcı yönetimi native ve browser kabulü

- [x] Native Argon2/SQLite ile user-admin store/HTTP/client testlerini mevcut auth/MFA/gateway/core testleriyle birlikte çalıştır.
- [ ] Gerçek `index.js -> authenticated API -> core/domain` zincirinde `/api/panel/users` CRUD'u doğrula. Anonymous, Read Only ve MFA enrollment'ı eksik Owner reddedilmeli; CSRF/Origin/body-limit korunmalı.
- [ ] Ayrı SQLite bağlantıları/process'leriyle son-Owner disable/demotion/delete, username/revision yarışları ve login sırasında account/session değişimini test et. Transaction/audit failure yarım lifecycle bırakmamalı.
- [ ] Auth DB upgrade/migration, repeated startup, unknown schema rejection, consistent backup/restore ve old-package rollback davranışını test et.
- [ ] Browserda `/settings/users`: create/edit/role/active/password reset/delete, typed confirm, son Owner hatası, pagination, dirty-form, double-submit, delayed/malformed/network response ve back/forward/reload davranışlarını dört hedef viewportta test et.
- [ ] User disable/delete/role/password/MFA değişikliğinin ilgili sessions, pending enrollment ve login challenges üzerinde beklenen revoke etkisini gerçek MFA ile doğrula. Hash/token/MFA secret list/audit/URL/localStorage/telemetry'ye düşmemeli.

## T-AUTH — P0: MFA, session ve gerçek HTTPS zinciri

- [ ] React production buildde first Owner setup, login/wrong password, MFA enrollment/verify/recovery, Account dialog, password change, session list/logout/logout-all, idle timeout ve absolute timeout akışlarını gerçek browserda test et.
- [x] 2026-09-10'da production build üzerinde ilk Owner oluşturma, parola girişi, zorunlu TOTP enrollment, recovery-code saklama onayı ve management kapısının açılması gerçek browserda doğrulandı. Wrong-password/recovery/password/session/timeout varyantları yukarıdaki maddede açık kaldı.
- [ ] İki browser tabında delayed request, stale 200/401, login cookie rotation, page restore (`pageshow`), lost MFA response ve keep-alive yarışlarını test et; eski response yeni login/session'ı bozmamalı.
- [x] Exact `YUNPANEL_PUBLIC_ORIGIN=https://cryptoraichu.website` (trailing slash yok), TLS reverse proxy, loopback API listener ve Origin/Sec-Fetch/CSRF enforcement'ı doğrula.
- [ ] Auth DB/path ownership: service-owned private directory 0700, DB/WAL/SHM 0600; CLI ve service aynı absolute DB'yi kullanmalı. Genel chmod/chown yapma.
- [x] Current IP/proxy protection'ı auth kabulü tamamlanmadan kaldırma; onaylı ve sahte istemci yollarını canlı gateway'de doğrula.
- [ ] Trusted-proxy/client-IP/rate-limit spoof kabulünü tamamlamadan public yüzeyi genişletme.

## T-UI — P1: Routed workspace gerçek browser kabulü

- [x] Built React uygulamasını gerçek browserda aç; `AuthGate` ilk Owner kurulum ekranını render etti ve login öncesi yalnız assetler ile `/api/auth/session` istendi, management collection requesti oluşmadı.
- [x] 2026-09-10'da authenticated browser ile Dashboard, Web Siteleri, Sunucular, Veritabanları, Docker, Mail, Yedekler, İşler, Denetim, Ayarlar/Kullanıcılar, Uygulamalar, site detay ve bütün site sekmesi linkleri tıklanarak doğru rotaya geçti. APT package inspect, SSL renew dry-run ve Node status işleri UI'dan kuyruğa alınıp `succeeded` oldu; job dialog açılıp kapandı ve `finishedAt` düzeltmesinden sonra tamamlanma zamanı canlıda göründü. Uygulanmamış modüller boş/bozuk görünüm yerine açık durum mesajı gösterdi.
- [ ] `/dashboard`, `/websites`, `/websites/new`, `/websites/:id/:tab`, `/applications`, `/applications/new`, `/domains`, `/servers`, `/jobs`, `/settings`, `/settings/users` için direct URL, reload, back/forward, invalid route ve reverse-proxy SPA fallback testlerini yap.
- [ ] Domain/alias search, URL filters/sort, group pagination, parent/child context, collapse/density/per-page preferences, multi-tab storage event ve bozuk/engelli localStorage davranışını test et.
- [ ] New site, application, env, domain/SSL ve job flows için delayed/401/403/404/409/network/malformed response üret. Dirty form ve uncertain mutation sonucunda kullanıcı verisi sessizce kaybolmamalı/kör retry olmamalı.
- [ ] Job drawer/dialog: queued/running/terminal, delayed list/detail, close/reopen, wrong ID, stale response, network cut ve permission loss. Dialog kapanınca server job devam edebilmeli; raw secret payload/result render edilmemeli.
- [ ] 1440×900, 1920×1080, 1280×800 ve 390×844 viewportlarda Dashboard/Websites/site detail/forms/jobs/users/MFA ekranlarını kontrol et. Sidebar, mobile focus trap/Escape/inert/backdrop, Cmd/Ctrl+K, skip link, modal focus restore, contrast, long hostnames/tables ve overflow'u düzelt.
- [x] Package build'in bütün workspace/router/assets dosyalarını içerdiğini ve update sonrası `/dashboard` deep-link/login kapısının çalıştığını doğrula.
- [ ] Paket rollback sonrası deep-link/login davranışını ayrıca doğrula.

## T-LIVE — P0/P1: Canlı panel, package ve rollback kapısı

- [x] `cryptoraichu.website` üzerinde deploy edilen `0.3.0-4` paketini, source API/agent `0.3.0` sürümlerini, Nginx/web/API/agent unitlerini, journal durumunu ve mevcut erişim korumasını gerçek hosttan doğrula.
- [x] Owner hesabını oluştur, zorunlu MFA'yı etkinleştir ve authenticated management menülerini canlıda smoke test et. Credential, TOTP secretı ve recovery kodları yalnız Git dışı yerel `0600` dosyada tutuldu.
- [ ] Owner/MFA sonrası browser console/network kaydını, back/forward/reload ve dört hedef viewport varyantını canlıda tamamla.
- [x] Production değişikliğinden önce `/etc/yunpanel`, `/var/lib/yunpanel`, auth alanı, master key config, package/unit, Nginx/vhost, cert ve release state için checksum doğrulamalı geri dönüş arşivi al.
- [ ] Geri dönüş arşivinin restore'unu ayrı test hostunda kanıtla.
- [x] Aday `.deb` install/upgrade çalıştır; required Node/native dependencies, auth CLI, rotation CLI/runbook, systemd ownership/sandbox ve service restart davranışını doğrula.
- [ ] `0.3.0-4` paket rollback + eşleşen state/config geri dönüşünü izole test hostunda prova et.
- [x] Hosted Node/static sitelerin panel restart/upgrade sırasında çalışmaya devam ettiğini 50 ardışık `200/200` örneğiyle doğrula.

2026-09-09/10 canlı kabul notu: `cryptoraichu.website` Ubuntu 24.04.5 test hostunda APT ile `0.2.0-1 -> 0.3.0-1 -> 0.3.0-2 -> 0.3.0-3 -> 0.3.0-4` yükseltildi. Son paket ve aday eşit, `dpkg -V` temiz, failed unit/pending update/reboot gereksinimi sıfır, API/web/agent journal warning kaydı yok ve ajan heartbeat sürümü `0.3.0`. Auth schema 2, DB/dizin izinleri `0600/0700`, eski bootstrap bearer kaldırılmış, anonim management `401`, yanlış istemci ve cross-origin mutation `403`. İlk Owner + TOTP MFA enrollment tamamlandı; recovery kodları Git dışı yerel credential dosyasında saklandı. Authenticated menü smoke testi, APT package inspect, SSL renew dry-run ve Node status işleri geçti. Job completion zamanı düzeltmesi `0.3.0-4` paketine panelin kendi upgrade akışıyla kuruldu; reload sonrası Owner oturumu/MFA korundu ve UI gerçek tamamlanma zamanını gösterdi. İlk geri dönüş arşivine ek olarak Owner/MFA verisini tutarlı SQLite backup ile içeren `/root/yunpanel-backups/yunpanel-pre-0.3.0-4-20260909T211941Z.tar.gz` checksum ve tar okunabilirliğiyle doğrulandı; ayrı host restore provası yapılmadı.

## T-MIGRATION — P1+: Agentless / Website / Plesk gerçek ortam kabulü

Bu bölüm yalnız ilgili kod `plan.md` içinden tamamlandıkça çalıştırılır.

- [ ] Ubuntu test hostunda agent kapalıyken local root backend ile inventory, Nginx test/reload, Node deploy/restart/rollback, SSL, package management ve root terminali doğrula; site workload'larının dedicated Unix user altında kaldığını kontrol et.
- [ ] Agentless migration için backup -> job drain -> state migration -> new backend health -> old agent disable -> rollback sırasını gerçek package üzerinde test et. IDs, auth DB, master key, vhost, cert, release ve users korunmalı.
- [ ] Kalıcı Website migration'ında apex + iki independent subdomain + alias, explicit parent, app binding, cert ve rollback'i gerçek DNS/test domainiyle doğrula. Domain-ID compatibility ekranını migration başarısı sayma.
- [ ] Plesk importer/migration geliştirildikten sonra external-managed inventory, Passenger/static/Node/DB/Docker/domain/cron/mail ve per-resource rollback'i izole Plesk fixture/test hostunda doğrula.

## Yayın kuralı

Bir maddenin kodunun repoda bulunması kabulün geçtiği anlamına gelmez. Node 24/full workspace, gerçek browser, HTTPS proxy, package/test-host ve gerektiğinde DNS/Ubuntu/Plesk doğrulaması yapılmadan ilgili özelliği production-ready sayma. Çalıştırılmayan testi geçmiş gibi yazma; GitHub Actions kullanma.
