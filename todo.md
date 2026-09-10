# YunPanel — Codex / Gerçek Ortam TODO

Bu dosyada yalnız güvenilir biçimde bu oturumda çalıştırılamayan gerçek ortam / desteklenen runtime / browser / package kabul işleri tutulur. Ürün ve kod işleri `plan.md`, bağlayıcı kurallar `agents.md` içindedir. Doğrudan `main` üzerinde küçük commitler kullan; GitHub Actions kullanma. Secret, parola, cookie, MFA secretı veya kişisel veriyi repo/log/screenshot içine yazma.

2026-09-09'daki birleşik ağaç Node 24.19 üzerinde yerelde ve Node 24.20 Ubuntu package build hostunda filtresiz doğrulanmıştı: repository policy, **473 test** ve Vite production build geçti. Bu tarihsel kabul daha sonra eklenen agentless local-runtime, managed-service ve database management commitlerini kapsamaz. Güncel source için aşağıdaki yeni Node 24/package/browser maddeleri ayrıca çalıştırılmadan “full check geçti” denmeyecek.

## T-RUNTIME — P0: Desteklenen runtime ve tam repo kabulü

- [x] Node 24.11.1+ ve npm 11+ ile temiz dependency install yap; workspace manifestlerini ve native dependencies'i doğrula.
- [x] 2026-09-09 birleşik ağacında filtresiz `npm run check`, bütün workspace testleri ve production build çalıştırıldı.
- [x] Güncel `panel-http-guard.test.js`, `authenticated-core-boundary.test.js` ve request-auth fixture'a taşınan core/deploy/rollback/ACME/Node/package flow testleri birlikte çalıştırıldı; raw `createApp()` + eski/admin Bearer management erişimi 401 kaldı.
- [x] API/web/package entry pointlerinin aynı committen geldiği önceki package adayında doğrulandı.
- [ ] `2e08f38e` ve sonrasındaki agentless runtime + managed-service + DB queue/API/UI değişiklikleriyle Node 24.11.1+ ortamında temiz install sonrası filtresiz `npm run check` ve production Vite build'i tekrar çalıştır. Yeni testleri atlama veya runtime gereksinimini düşürme.
- [ ] Bilerek mixed web/API build üretildiğinde privileged UI'ın fail-closed kaldığını ayrıca doğrula.
- [x] GitHub Actions eklenmedi/değiştirilmedi; doğrulamalar yerel/test hostunda yapıldı.

## T-LOCAL-EXECUTOR — P1: Yerel iş yürütücüsü ve host-runtime kabulü

- [x] Eski local-executor güvenlik testleri, local host operation testleri, package-manager ve Node status testleri önceki Node 24 full-workspace kabulünde çalıştırıldı.
- [x] Paketlenmiş `@yunpanel/host-runtime` importu ve agent compatibility re-export'u önceki adayda doğrulandı; gerçek APT upgrade ve servis restartı test hostunda çalıştı.
- [ ] Güncel source'ta explicit `YUNPANEL_LOCAL_SERVER_ID`, OS hostname eşleşmesi, derived lock path, root `yunpanel-api.service`, production `index.js` startup/shutdown ve execution-time application env materialization zincirini Node 24 full workspace'te doğrula. Env verilmemişse local runtime kapalı kalmalı.
- [ ] Local runtime'ın 30 saniyelik snapshot yenilemesini, 90 saniyelik offline eşiğini geçmeden server kaydını canlı tuttuğunu gerçek registry/disk üzerinde doğrula. Binding kaybı veya snapshot persist hatası executor'ı drain edip ownership lock'unu bırakmalı.
- [ ] Executor fatal fault sırasında yalnız safe `code/phase/jobId` raporlandığını; snapshot timer'ın durduğunu, executor'ın drain olduğunu ve exclusive lock'un bırakıldığını process-level testte doğrula. Raw exception/command/env/key/path hiçbir kayıt/loga sızmamalı.
- [ ] Gerçek job registry ve disk üzerinde claim/result yazımı, rename, disk-full/read-only ve kaybolan acknowledgement hatalarını kontrollü üret. Başarılı host işi completion hatasında failed'e çevrilmemeli; belirsiz claim/complete/reconcile instance'ı durdurmalı ve yeni claim/otomatik retry olmamalı. Plan B'deki durable recovery işi tamamlanmadan process restartını çözüm sayma.
- [ ] Stop sırasında çalışan işin execution/complete/reconcile aşamalarının beklendiğini, paralel `runOnce`'un aynı işi tekrar yürütmediğini ve eski scheduler callback'lerinin stop/restart sonrası iş başlatmadığını doğrula.
- [ ] İzole Ubuntu Node uygulamasında gerçek current symlink, deterministik systemd unit, runtime port/path ve health sonucunu karşılaştır. Wrong/missing release veya farklı application identity host işleminden önce reddedilmeli.
- [ ] Legacy agent + local worker dual-consumer testini gerçek durable queue üzerinde yap: local bind öncesi API ve agent durmuş + job drain şartı; bind sonrası aynı server kuyruğunu yalnız local executor tüketmeli. Node deploy/restart/rollback secret env değerleri job JSON'una düşmemeli.

## T-SERVICES — P1: Managed host servisleri gerçek kabulü

- [ ] Node 24 full workspace'te managed-service manager, protocol, job registry, authenticated HTTP ve web client/model testlerini birlikte çalıştır.
- [ ] Ubuntu 24.04 test hostunda Owner ile Nginx, MariaDB/MySQL, Docker, Cron, Postfix, Dovecot ve Rspamd için inspect çalıştır. Kurulu olmayan güvenli bir servis üzerinde install -> enable/start -> stop -> start/restart akışını gerçek `apt-get/systemctl` ile doğrula.
- [ ] MariaDB kurulu hostta MySQL kurulumunun ve MySQL kurulu hostta MariaDB kurulumunun fail-closed kaldığını doğrula; mevcut DB servisini kaldırma/bozma.
- [ ] `/servers` Owner UI'da “Servisleri tara”, install/start/stop/restart job progress, terminal sonuç sonrası refresh ve reload sonrası snapshot doğruluğunu browserda test et. Mutation sonrası eski inspect snapshot'ı tekrar render edilmemeli.
- [ ] Read Only browser oturumunda managed-service paneli mount edilmemeli ve networkte nested `/servers/:id/services` isteği oluşmamalı. Raw API isteği 403 kalmalı.

## T-DATABASE — P1/P2: MySQL/MariaDB yönetimi gerçek kabulü

- [ ] Güncel Node 24 full workspace'te `database-manager`, DB protocol, local/legacy dispatch, DB result-sanitizer, DB job-registry, authenticated HTTP ve web client/model testlerini diğer job/host-runtime testleriyle birlikte çalıştır.
- [ ] İzole Ubuntu 24.04 test hostunda root Unix socket auth ile MariaDB veya MySQL engine/version tespiti ve non-system schema inventory/size sorgusunu doğrula. TCP password fallback ekleme.
- [ ] Test amaçlı güvenli isimle DB create -> inspect -> drop -> inspect yap. `mysql`, `information_schema`, `performance_schema`, `sys` oluşturma/silme hedefi olamamalı; boş/özel karakterli/injection isimleri host komutundan önce reddedilmeli.
- [ ] Durable queued/completed DB job JSON'unda yalnız engine/version/name/size/created/deleted metadata bulunduğunu doğrula. Raw SQL, socket/client path, command output veya credential persist edilmemeli; malformed completion running işi terminal kabul ettirmemeli.
- [ ] `/databases` Owner UI'da server seçimi, liste/refresh/scan/create/typed-confirm delete, engine/version/size, stale/error/job-progress, reload/back-forward ve network kesintisi senaryolarını gerçek browserda test et. Read Only oturumunda route management'e yönlenmeli ve nested DB isteği üretilmemeli; raw API 403 kalmalı.

## T-ACCESS — P0: Read Only gerçek kabulü

- [x] `panel-access`, `panel-http-guard`, Owner-MFA capability, Read Only HTTP ve owner-access testleri önceki Node 24 workspace kabulünde geçti.
- [ ] Gerçek browserda Read Only hesabıyla Dashboard, Web Siteleri, site detail ve Sunucular ekranlarının açıldığını doğrula. Jobs, Users, Settings, Applications management, Domains management, create ekranları ve mutation yüzeyleri görünmemeli/mount edilmemeli.
- [ ] Network panelinde Read Only oturumunun yalnız izin verilen `GET/HEAD /api/{servers,applications,domains,certificates}` list/detail isteklerini yaptığını doğrula. `/jobs`, `/users`, application env/status, nested service/DB/system inspection veya mutation polling üretilmemeli.
- [ ] Raw API'de Read Only ile jobs/users/env/status/nested system/service/DB inspection ve bütün mutation isteklerinin core management handlerına ulaşmadan `403` kaldığını doğrula.
- [ ] Owner + MFA management görünümünün eski işlevlerini regresyondan geçir. Read Only capability metadata'sına `*` veya bozuk mode enjekte edildiğinde UI ve API fail-closed kalmalı.
- [ ] Role change / disable / delete / logout sonrası açık Read Only ekranlarında eski kaynak cache'i kalmamalı; yeni session gelmeden stale privileged veri render edilmemeli.

## T-KEY — P0: Secret master-key rotation kabulü

- [x] Önceki Node 24 full workspace'te `apps/api/test/secret-master-key-rotation.test.js` active MFA, pending MFA, application secret, public env, wrong-key, same-key, backup tamper, target-path, absent-store ve rollback senaryolarıyla geçti.
- [ ] Test hostunda packaged service ile `docs/secret-master-key-rotation.md` runbook'unu birebir prova et: bağımsız console/SSH -> yedek -> API stop -> rotation -> `api.env` key update -> service start -> health/functional validation.
- [ ] Rotation sonrası Owner password + TOTP login, recovery ve secret application environment materialization çalışmalı; frontend secret value'yu maskeli tutmalı.
- [ ] Rotation backup directory 0700, snapshot/key dosyaları 0600 ve public web root dışında olmalı. Manifest raw key/plaintext secret içermemeli.
- [ ] Rollback tatbikatı: API stop -> aynı live store pathleriyle rollback -> eski key -> API start -> MFA + application secret validation.
- [ ] Process kill/power-loss kesintisini test hostunda simüle et; backup/manifest ile deterministik recovery kanıtla.
- [x] Önceki Debian/package adayında rotation CLI, root `npm run secret-key`, `.env.example` ve runbook bulunduğu doğrulandı.

## T-USER — P0: Kullanıcı yönetimi native ve browser kabulü

- [x] Native Argon2/SQLite user-admin store/HTTP/client testleri önceki auth/MFA/gateway/core paketiyle birlikte geçti.
- [ ] Gerçek `index.js -> authenticated API -> core/domain` zincirinde `/api/panel/users` CRUD'u doğrula. Anonymous, Read Only ve MFA enrollment eksik Owner reddedilmeli; CSRF/Origin/body-limit korunmalı.
- [ ] Ayrı SQLite connection/process'leriyle son-Owner disable/demotion/delete, username/revision yarışları ve login sırasında account/session değişimini test et.
- [ ] Auth DB upgrade/migration, repeated startup, unknown schema reject, consistent backup/restore ve old-package rollback davranışını test et.
- [ ] Browserda `/settings/users`: create/edit/role/active/password reset/delete, typed confirm, son Owner hatası, pagination, dirty-form, double-submit, delayed/malformed/network response ve back/forward/reload davranışlarını dört viewportta test et.
- [ ] User disable/delete/role/password/MFA değişikliğinin sessions, pending enrollment ve login challenges revoke etkisini gerçek MFA ile doğrula.

## T-AUTH — P0: MFA, session ve gerçek HTTPS zinciri

- [ ] React production buildde first Owner setup, login/wrong password, MFA enrollment/verify/recovery, Account dialog, password change, session list/logout/logout-all, idle ve absolute timeout akışlarını gerçek browserda tamamla.
- [x] 2026-09-10 production build üzerinde ilk Owner oluşturma, parola, zorunlu TOTP enrollment, recovery-code saklama onayı ve management kapısının açılması browserda doğrulandı.
- [ ] İki browser tabında delayed request, stale 200/401, login cookie rotation, `pageshow`, lost MFA response ve keep-alive yarışlarını test et.
- [x] Exact `YUNPANEL_PUBLIC_ORIGIN=https://cryptoraichu.website`, TLS reverse proxy, loopback API listener ve Origin/Sec-Fetch/CSRF enforcement canlıda doğrulandı.
- [ ] Root API geçişinden sonra auth DB/path ownership'i tekrar doğrula: private directory 0700, DB/WAL/SHM 0600; service ve CLI aynı absolute DB'yi kullanmalı.
- [x] Current IP/proxy protection auth kabulü tamamlanmadan kaldırılmadı; onaylı ve sahte istemci yolları canlı gateway'de doğrulandı.
- [ ] Trusted-proxy/client-IP/rate-limit spoof kabulünü tamamlamadan public yüzeyi genişletme.

## T-UI — P1: Routed workspace gerçek browser kabulü

- [x] Built React uygulamasında `AuthGate` login öncesi yalnız assetler + `/api/auth/session` isteğiyle render oldu; management collection requesti oluşmadı.
- [x] 2026-09-10 authenticated browser smoke testinde Dashboard, Web Siteleri, Sunucular, Veritabanları, Docker, Mail, Yedekler, İşler, Denetim, Ayarlar/Kullanıcılar, Uygulamalar, site detail ve site sekmeleri doğru rotaya geçti. O tarihte uygulanmamış modüller açık placeholder gösterdi.
- [ ] Yeni managed-service ve gerçek DB UI ile `/servers` ve `/databases` için direct URL, reload, back/forward, job drawer, stale/error/permission loss ve responsive davranışı tekrar test et.
- [ ] `/dashboard`, `/websites`, `/websites/new`, `/websites/:id/:tab`, `/applications`, `/applications/new`, `/domains`, `/servers`, `/jobs`, `/settings`, `/settings/users` için direct URL, reload, back/forward, invalid route ve reverse-proxy SPA fallback testlerini tamamla.
- [ ] Domain/alias search, URL filters/sort, group pagination, parent/child context, collapse/density/per-page preferences, multi-tab storage event ve bozuk/engelli localStorage davranışını test et.
- [ ] New site, application, env, domain/SSL ve job flows için delayed/401/403/404/409/network/malformed response üret. Dirty form ve uncertain mutation sonucunda kullanıcı verisi kaybolmamalı/kör retry olmamalı.
- [ ] Job drawer/dialog: queued/running/terminal, delayed list/detail, close/reopen, wrong ID, stale response, network cut ve permission loss. Raw secret payload/result render edilmemeli.
- [ ] 1440×900, 1920×1080, 1280×800 ve 390×844 viewportlarda Dashboard/Websites/site detail/forms/jobs/users/MFA + Servers service paneli + Databases ekranını kontrol et.
- [x] Önceki package build'in bütün workspace/router/assets dosyalarını içerdiği ve update sonrası `/dashboard` deep-link/login kapısının çalıştığı doğrulandı.
- [ ] Paket rollback sonrası deep-link/login davranışını ayrıca doğrula.

## T-LIVE — P0/P1: Canlı panel, package ve rollback kapısı

- [x] `cryptoraichu.website` üzerinde deploy edilen `0.3.0-4` paket, Nginx/web/API/agent unitleri, journal ve mevcut erişim koruması gerçek hostta doğrulandı.
- [x] Owner hesabı + zorunlu MFA ve authenticated management menüleri canlıda smoke test edildi.
- [ ] `2e08f38e` ve sonrasındaki source'u yeni `.deb` adayına dönüştürmeden önce Node 24 full check'i bitir; ardından root `yunpanel-api.service`, local-runtime env/config, managed-service ve DB queue/API/UI dosyalarının pakete gerçekten girdiğini `dpkg-deb -c/-I` ile doğrula.
- [ ] Yeni agentless aday `.deb` için install/upgrade sırasında auth DB/master key/state ownership, API root service, web sandbox, agent migration durumu ve restart davranışını izole test hostunda doğrula; mevcut `0.3.0-4` canlı hosta kör deploy yapma.
- [ ] Owner/MFA sonrası browser console/network, back/forward/reload ve dört viewport varyantını canlıda tamamla.
- [x] Production değişikliğinden önce `/etc/yunpanel`, `/var/lib/yunpanel`, auth, master key config, package/unit, Nginx/vhost, cert ve release state için checksum doğrulamalı geri dönüş arşivi alındı.
- [ ] Geri dönüş arşivinin restore'unu ayrı test hostunda kanıtla.
- [ ] `0.3.0-4` ve yeni agentless aday arasında package/state rollback provası yap.
- [x] Hosted Node/static sitelerin önceki panel restart/upgrade sırasında çalışmaya devam ettiği 50 ardışık `200/200` örneğiyle doğrulandı.

2026-09-09/10 canlı kabul notu: `cryptoraichu.website` Ubuntu 24.04.5 test hostunda APT ile `0.2.0-1 -> 0.3.0-1 -> 0.3.0-2 -> 0.3.0-3 -> 0.3.0-4` yükseltildi. `dpkg -V` temiz, failed unit/pending update/reboot sıfır, API/web/agent journal warning yoktu. İlk Owner + TOTP MFA enrollment tamamlandı; credential materyali Git dışı `0600` dosyada tutuldu. APT package inspect, SSL renew dry-run ve Node status işleri geçti. Bu not **sonraki agentless/managed-service/DB source commitlerinin canlı kabulü değildir**.

## T-MIGRATION — P1+: Agentless / Website / Plesk gerçek ortam kabulü

Bu bölüm yalnız ilgili kod `plan.md` içinden tamamlandıkça çalıştırılır.

- [ ] Paketlenmiş local binding/migration CLI tamamlandıktan sonra backup -> API+agent stop -> job drain -> UUID/hostname bind -> `YUNPANEL_LOCAL_SERVER_ID` config -> local backend start -> health -> agent disable sırasını gerçek package üzerinde test et. IDs, auth DB, master key, vhost, cert, release ve users korunmalı.
- [ ] Ubuntu test hostunda agent kapalıyken local root backend ile inventory, Nginx test/reload, Node deploy/restart/rollback, SSL, package management, managed services ve DB inspect/create/drop doğrula; site workload'larının dedicated Unix user altında kaldığını kontrol et.
- [ ] Local runtime fault/lock recovery ve package rollback'i gerçek systemd/process üzerinde test et; agent tekrar açılacaksa local worker önce tamamen durmuş ve lock bırakmış olmalı.
- [ ] Kalıcı Website migration'ında apex + iki independent subdomain + alias, explicit parent, app binding, cert ve rollback'i gerçek DNS/test domainiyle doğrula.
- [ ] Plesk importer/migration geliştirildikten sonra external-managed inventory, Passenger/static/Node/DB/Docker/domain/cron/mail ve per-resource rollback'i izole Plesk fixture/test hostunda doğrula.

## Yayın kuralı

Bir maddenin kodunun repoda bulunması kabulün geçtiği anlamına gelmez. Node 24/full workspace, gerçek browser, HTTPS proxy, package/test-host ve gerektiğinde DNS/Ubuntu/Plesk doğrulaması yapılmadan ilgili özellik production-ready sayılmaz. Çalıştırılmayan testi geçmiş gibi yazma; GitHub Actions kullanma.
