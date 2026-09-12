# YunPanel — Uygulama Durumu ve Kalan Geliştirme Planı

Bu dosya 2026-09-12 tarihli Owner talimatıyla hem kaynakta hazır olan işleri hem de kalan geliştirmeyi birlikte gösterir. Bağlayıcı mimari ve güvenlik kuralları `agents.md`; bu ortam dışında yapılacak gerçek Ubuntu, HTTPS/browser, DNS/provider, package ve rollback kabulleri `todo.md` içindedir.

## Durum işaretleri

- `[x] Kaynakta hazır`: production kodu ve ilgili otomatik/source testleri repoda mevcut. Satırda ayrıca canlı kabul yazmıyorsa gerçek host/provider/browser kabulünün tamamlandığı anlamına gelmez.
- `[ ] Kalan`: kod, entegrasyon veya açıkça belirtilen kabul kanıtı eksik.
- `todo.md` kapıları tamamlanmadan ürünün bütünü için “production-ready” denmez.

Geliştirme doğrudan güncel `main` üzerinde küçük, tek amaçlı commitlerle yürür. GitHub Actions kullanılmaz. Görsel UI/UX polish işi backend functionality tamamlanana kadar ertelenmiştir.

## A. Authentication, kullanıcı, yetki ve audit

- [x] İlk Owner için süreli/tek kullanımlık setup, Argon2id parola, server-side session, güvenli cookie, CSRF, login rate-limit ve trusted-proxy sözleşmesi hazır.
- [x] TOTP, recovery code, MFA policy, parola değiştirme ve bütün oturumları iptal etme akışları hazır.
- [x] Owner kullanıcı yönetimi, son aktif Owner koruması ve backend'de uygulanan Read Only yetki sınırı hazır.
- [x] Ortak audit deposu actor/action/resource/outcome/zaman metadata'sını secret, request body ve ham terminal çıktısı olmadan kaydediyor.
- [x] Owner Denetim ekranında actor, resource, action, outcome ve zaman filtreleri ile cursor sayfalama hazır; backend Owner-only çalışıyor.
- [ ] Gerçek HTTPS browserda setup/login/TOTP/recovery/password/session/logout, iki sekme yarışları, idle/absolute timeout ve bütün revoke yollarını tamamla.
- [ ] Read Only hesabının mutation, job, user, audit ve hassas nested endpointlerdeki gerçek listener 403 matrisini tamamla.
- [ ] Trusted-proxy spoof/rate-limit, audit DB/WAL izinleri, upgrade/restore sürekliliği ve secret absence kabulünü tamamla.

Gerçek ortam kabul ayrıntıları: `todo.md` içindeki `T-AUTH-AUDIT`.

## B. Tek sunucu ve agentsiz yerel backend

- [x] Production yalnız exact `YUNPANEL_LOCAL_SERVER_ID` ile OS hostname'i eşleşen tek yerel sunucuyu açıyor; uzak/eski server seçimi ve mutation'ı kapalı.
- [x] Retained agent heartbeat/command/environment/result transportu production yerel panelinde `404 agent_transport_removed` döndürüyor.
- [x] Root yetkili `yunpanel-api` içindeki local executor; host inventory, allowlist'li systemd servisleri, Docker ve Nginx snapshot'larını aynı yerel server kaydına bağlıyor.
- [x] Kalıcı job kuyruğu, resource lock, private recovery intent/receipt ve operasyona özel reconciliation altyapısı hazır.
- [x] Agentless migration için backup/verify/preview/stage, local identity create/bind/release/validate ve deterministic rollback temelleri hazır.
- [x] `.44` ile biten Plesk sunucusunun hiçbir geliştirme/test/deploy işleminde kullanılmaması bağlayıcı repo kuralı.
- [ ] Live-apply katmanına per-target replace, UID/GID drift çözümü, owner/mode/ACL/xattr politikası, pre-apply backup, health gate ve deterministic rollback ekle.
- [ ] İzole gerçek Ubuntu hostta migration + rollback kabulünü tamamla.
- [ ] Kabulden sonra retained agent transport/storage kodunu, enrollment credential yüzeyini, `yun-agent.service` ve package/env/install compatibility parçalarını fiziksel olarak kaldır.
- [ ] Disk-full, read-only filesystem ve lost-acknowledgement durumlarında ambiguous mutation'ın kör retry edilmediğini gerçek hostta doğrula.
- [ ] Yeni Git hook, cron, build ve runtime yüzeylerinde `yunapp-*` workload isolation invariantını koru; yalnız Owner Sunucu terminali root kalmalı.

Gerçek ortam kabul ayrıntıları: `T-AGENTLESS` ve `T-MIGRATION`.

## C. Website, Domain, Nginx, SSL ve DNS

- [x] Kalıcı Website kimliği; Domain `websiteId` ilişkisi; Website/Application foreign-key startup doğrulaması ve IDN→punycode canonicalization hazır.
- [x] Apex, bağımsız subdomain ve alias için explicit parent/target modeli; duplicate/cycle/cross-server/dot-boundary kontrolleri ve reparent preview/apply hazır.
- [x] Compatibility→enforced Website migration preview/digest/create/bind/finalize/rollback ledger'ı kalıcı ve tekrar çalıştırılabilir.
- [x] Guarded site-create; existing/new static/Node, external proxy ve external/unverified Docker workload hedeflerini, managed portu ve explicit `www` alias/child seçimini kapsıyor.
- [x] Website/Domain move-delete impact preview; child/linked Domain, Application, Docker workload, DNS zone, mail domain/mailbox, certificate ve aktif job bağımlılıklarını listeliyor.
- [x] Revisioned Nginx routing/settings preview→stage→activate→rollback; static SPA/cache/header ve proxy timeout/upload/WebSocket/header ayarları hazır.
- [x] ACME issue/renew, custom certificate import/select ve Cloudflare DNS-01 credential temelleri hazır.
- [x] DNS zone lifecycle, readiness kontrolü ve Cloudflare A/AAAA/CNAME preview/apply/recovery altyapısı hazır.
- [ ] Canlı state'teki Website'e bağlı olmayan external-proxy Domain kayıtlarını açık create/bind migration'ıyla eşleştir; otomatik tahmin yapma.
- [ ] Backup ve cron association registry'leri geldiğinde impact preview'a gerçek bağımlılık sağlayıcılarını bağla; o zamana kadar blocker “unavailable” kalmalı.
- [ ] Gerçek DNS/Nginx/HTTPS üzerinde redirect, SPA, WebSocket, header, IDN, certificate issue/renew/import/select ve rollback hata matrisini tamamla.
- [ ] Cloudflare DNS-01 ile DNS record mutation/readiness zincirini least-privilege token ve gerçek resolver ile tamamla.
- [ ] Website migration, policy finalize/rollback ve site-create akışını gerçek test domainiyle uçtan uca doğrula.

Gerçek ortam kabul ayrıntıları: `T-WEBSITE` ve `T-FEATURE-ACCEPTANCE`.

## D. Static, Node.js, Git, env, dosya ve log

- [x] Static/Node deploy, active release, health, restart, rollback ve kesinti sonrası recovery hazır.
- [x] Node runtime/startup/package-manager/mode/document-root revisioned preview/apply; enable/disable/start/stop ve active-runtime ayrımı hazır.
- [x] Node 22/24 managed runtime inventory/install; checksum doğrulama, atomik kurulum ve seçilen runtime'ın build/systemd PATH'ine taşınması hazır.
- [x] Explicit branch/tag/full SHA Git deploy ve çözülen commit'in release geçmişine yazılması hazır.
- [x] Şifreli GitHub token/SSH deploy key kasası, strict known-host ve sadece fetch sırasında materialization hazır.
- [x] Signed GitHub webhook; raw-body HMAC, repo/branch/SHA kontrolü, delivery idempotency ve aynı Application resource lock ile hazır.
- [x] Şifreli Application env merge/replace, optimistic revision ve `saved_on_disk`/`applied_to_running_process` ayrımı hazır.
- [x] Owner-only bounded/redacted Node journal, Nginx ve deploy log API/UI yüzeyi hazır.
- [x] Website/site-user sınırında list/create/edit/rename/delete/download sunan dosya API ve arayüzü hazır.
- [ ] Gerçek private GitHub repo için token ve SSH key deploy; webhook erişim/imza/replay/lock kabulünü tamamla.
- [ ] Packaged API/UI üzerinde env import/apply, stale revision, secret leakage ve restart/deploy davranışını tamamla.
- [ ] Gerçek rotation dosyalarıyla log cursor/redaction/retention/permission testlerini tamamla.
- [ ] Gerçek `yunapp-*` kullanıcılarıyla traversal, ara/final symlink, siteler arası kaçış, atomik yazma ve limit matrisini tamamla.
- [ ] Panel update/disk-full/recovery sırasında aktif static ve Node sitelerin kesintisiz kaldığını doğrula.

Gerçek ortam kabul ayrıntıları: `T-SERVICES-DB`, `T-PACKAGE-LIVE` ve `T-FEATURE-ACCEPTANCE`.

## E. Terminal

- [x] Gerçek PTY + xterm.js, Owner root Sunucu terminali ve `yunapp-*` site terminali hazır.
- [x] Session-bound capability; cookie/MFA/role/Origin kontrolü, replay koruması ve URL token yasağı hazır.
- [x] Resize, Unicode, kontrol karakterleri, eşzamanlı oturum sınırı, idle/output/backpressure limitleri ve process-group cleanup hazır.
- [x] Logout, session revoke, parola/MFA/rol/kullanıcı değişiminde açık terminal yetkisini kaldıran altyapı hazır.
- [x] Audit yalnız terminal açılış/kapanış metadata'sını tutuyor; keystroke, output ve history kaydedilmiyor.
- [ ] Chromium ve Firefox'ta root/site user/cwd, Ctrl+C/Ctrl+D, `vim`/`top`, resize, Unicode/IME ve beş paralel oturumu headed olarak doğrula.
- [ ] Logout/logout-all/session delete/expiry ve kullanıcı güvenlik değişikliklerinin açık WebSocket/process group'u anında kapattığını gerçek browserda doğrula.

Gerçek ortam kabul ayrıntıları: `T-FEATURE-ACCEPTANCE` terminal maddesi.

## F. Veritabanı

- [x] MariaDB↔MySQL conflict fail-closed detection, engine/version ve non-system database inventory hazır.
- [x] Unix socket root auth ile database create/delete kalıcı job'ları, recovery ve system-name/injection kontrolleri hazır.
- [x] Temel veritabanı listeleme/oluşturma/silme arayüzü gerçek API'ye bağlı.
- [ ] Database'i Website/Application ve site kullanıcısına kalıcı olarak bağla.
- [ ] DB user CRUD, minimum-privilege grants, parola rotation ve şifreli connection credential lifecycle ekle.
- [ ] Dump/restore, restore preview, pre-restore backup, progress ve failure rollback ekle.
- [ ] Gerçek MySQL/MariaDB hostta inspect→create→inspect→drop→inspect ve secret-free receipt kabulünü tamamla.

## G. Mail ve Roundcube

- [x] Web Domain'den ayrı mail-domain kimliği; `external/unverified` ve yan etkisiz `local/disabled` başlangıç durumları hazır.
- [x] Şifreli mailbox registry; create/list/detail, parola rotation, enable/disable ve confirmed delete kaynak akışları hazır.
- [x] Postfix managed recipient/map, Dovecot passwd/config ve Rspamd loopback Milter config preview üreticileri hazır.
- [x] Aggregate mail config preview digest/order/readiness blocker sözleşmesi hazır; protected hash/config içeriği public çıktıya girmiyor.
- [x] Secret-free managed mail apply plan; sabit `postmap`/`postconf`/validator/reload/health sırası ve komut allowlist kontrolleri hazır.
- [x] Protected Dovecot materyalini public plana taşımadan private `0700` staging, digest/mode/symlink doğrulaması ve transaction-scoped pre-apply backup hazır; rollback için `/etc/postfix/main.cf` snapshot'ı zorunlu.
- [x] Mail servis health/inspect ve Roundcube package detection/install temeli hazır; kurulum sonucu dürüstçe `installed`, `active=false` kalıyor.
- [ ] Staged bundle'ı canlı hedeflere güvenli replace et; `postmap`/`postconf` sonrası Postfix, Dovecot ve Rspamd config test→reload→health→deterministic rollback zincirini tamamla.
- [ ] Mail-domain enable/disable, quota/usage, alias ve forwarding lifecycle ekle.
- [ ] MX/SPF/DKIM/DMARC/PTR expected/current/action-needed diagnostics ekle.
- [ ] SMTP/IMAP TLS, bounded queue/log görünümü ve open-relay fail-closed kabulü ekle.
- [ ] Roundcube için Nginx/PHP-FPM/database config, web endpoint, health ve rollback ekle.
- [ ] Mailbox/domain delete impact ile mail data backup/restore ekle.

Üst seviye Mail modülü bu kalan apply/lifecycle işleri tamamlanana kadar hazır sayılmaz.

## H. Docker ve Compose

- [x] Private external/unverified Docker workload registry, same-server loopback endpoint doğrulaması, unique Website binding ve impact envanteri hazır.
- [x] Mevcut sonuçlar container lifecycle yapılmış gibi gösterilmiyor; workload yalnız açıkça `external/unverified` izleniyor.
- [ ] Compose parse/validation ve revisioned project/env/registry credential modeli ekle.
- [ ] Build/pull/start/stop/restart kalıcı job'ları, resource lock, recovery ve deploy history ekle.
- [ ] Container log/health, Website/Nginx target ve actionable diagnosis ekle.
- [ ] Volume/bind inventory ile backup/restore policy ekle.
- [ ] Gerçek Docker Engine/Compose hostunda bütün lifecycle ve rollback akışını doğrula.

Üst seviye Docker rotası lifecycle hazır olana kadar dürüst placeholder durumundadır.

## I. Genel backup ve restore

- [x] Agentless migration snapshot/verify/stage/rollback mekanizması hazır; bu mekanizma genel ürün backup'ı olarak gösterilmiyor.
- [ ] Application release/config/env, database, Docker volume ve mail verisini kapsayan backup manifesti ekle.
- [ ] Local ve S3-compatible target, şifreleme, checksum, retention ve credential lifecycle ekle.
- [ ] Restore preview, veri kaybı etkisi, progress, pre-restore backup, health gate ve deterministic failure rollback ekle.
- [ ] Disk-full, bozuk archive/checksum, kesinti ve kısmi restore recovery testlerini ekle.
- [ ] Gerçek büyük veri ve object-storage fixture'ıyla backup→verify→restore kabulünü tamamla.

Üst seviye Backup rotası ürün backup'ı hazır olana kadar dürüst placeholder durumundadır.

## J. Cron

- [ ] Website/Application'a bağlı site-user cron registry ve CRUD ekle.
- [ ] Schedule, timezone, cwd, bounded env, enable/disable, last/next run ve bounded output ekle.
- [ ] Cron command'ını shell-string birleştirmeden doğrulanmış execution contract'ına bağla.
- [ ] System cron'u yalnız explicit Owner/Sunucu bağlamında ayrı kaynak türü olarak uygula.
- [ ] Site isolation, eşzamanlılık, restart ve gerçek cron daemon kabulünü tamamla.

## K. Job detayları, metrik ve bildirimler

- [x] Kalıcı job queue; queued/running/succeeded/failed/cancelled durumları, temel list/detail/cancel ve resource lock hazır.
- [x] Secret-free public job sonucu ile private recovery intent/receipt ayrımı hazır.
- [ ] Job detail'e stage/progress, resource link, safe error/log metadata, arama/filtre ve güvenli retry ekle.
- [ ] CPU/RAM/load/disk/inode/service/Application metric history ve retention ekle.
- [ ] Disk/inode threshold, service/app, deploy, backup ve SSL event modelini ekle.
- [ ] Panel içi bildirim merkezi ve seçilecek dış kanallar için secret-safe delivery/retry ekle.

## L. Plesk read-only importer

- [ ] Plesk state'ini değiştirmeyen, bounded ve secret-safe discovery/import preview ekle.
- [ ] Passenger/static/Node, Domain, database, Docker, cron ve mail kaynaklarını external-managed olarak modelle.
- [ ] Kaynak başına conflict, dependency, explicit confirmation, migration job ve deterministic rollback ekle.
- [ ] `.44` Plesk sunucusuna hiçbir amaçla bağlanma; geliştirme offline fixture veya `.local/test-server.env` içinde açıkça onaylı, `.44` olmayan test hostuyla yapılmalı.

## M. Package, yayın ve canlı kabul

- [x] 2026-09-12 doğrulanmış baseline kaynak ağacı Node 24 ile API 1129, web 153, agent 74, config 35, host-runtime 100, protocol 24 ve shared 27 olmak üzere toplam 1542 otomatik testten geçti; lint/build yeşildi.
- [ ] Bu baseline sonrasındaki managed-mail apply-plan/staging/backup değişiklikleri için targeted config-templates + host-runtime testlerini ve ardından güncel `main` full Node 24 lint/build/test kontrolünü yeniden çalıştır.
- [x] Linux amd64 `0.3.0-9` paketi üretildi ve yalnız onaylı `.44` olmayan YunPanel test sunucusuna yüklendi; API/web/nginx aktif, eski `yun-agent` inactive/disabled doğrulandı.
- [x] Canlı Owner API smoke'ta tek yerel server, Website/Application/Domain/certificate/job envanteri; site dosya listesi, Node logu, site terminal capability hedefi ve audit filtre/pagination sözleşmesi doğrulandı.
- [ ] Matching Ubuntu arm64 hostta native `node-pty` dahil clean install ve doğru mimarili `.deb` üretimini doğrula.
- [ ] İzole Ubuntu hostta clean install ve eski package upgrade; auth/master key/state/Website/audit/migration şema ve izinlerini doğrula.
- [ ] `0.3.0-4` ↔ güncel agentless package/state rollback provası yap.
- [ ] Panel restart/upgrade boyunca hosted static/Node uygulamaların çalışmaya devam ettiğini doğrula.
- [ ] `todo.md` içindeki kalan bütün P0/P1 yayın kapıları tamamlanmadan genel live/production dağıtımı yapma.

## N. Arayüz durumu ve ertelenen tasarım

- [x] Gerçek URL routing/deep-link; login/setup/MFA; Website list/detail; Application, Domain, Server, Database, Job, Audit ve User yönetim yüzeyleri backend API'lerine bağlı.
- [x] Site dosya, Node/Nginx log, terminal, env, runtime/process ve ilgili preview/confirmation akışları reusable React JS/JSX bileşenleriyle hazır.
- [x] Eksik modüller sahte başarı veya inert kontrol yerine açık unavailable/placeholder durumu gösteriyor.
- [ ] Mail, Docker, Backup, Cron, metric/notification ve Plesk importer backend functionality'si tamamlandıkça gerçek rotalarını bağla.
- [ ] Backend functionality bittikten sonra enterprise layout/styling, component/data-table polish, responsive ve accessibility çalışmasını ayrı tasarım aşamasında yap.
- [ ] Son aşamada gerçek Chromium/Firefox headed browser, mobil viewport, klavye ve ekran okuyucu kabulünü tamamla.

## Uygulama sırası

1. P0 güvenlik, tek-sunucu fail-closed davranışı ve mevcut canlı işlevlerde regresyon bırakma.
2. Mail apply/lifecycle ve gerçek servis config test/rollback zinciri.
3. Veritabanı user/grant/credential ve dump/restore yaşam döngüsü.
4. Docker/Compose lifecycle ve Website/Nginx entegrasyonu.
5. Genel backup/restore ürünü.
6. Cron, ardından job detail/metrik/bildirim katmanı.
7. Plesk read-only importer.
8. İzole migration/rollback kabulünden sonra retained agent kodu ve paket yüzeyinin fiziksel temizliği.
9. Bütün backend functionality tamamlandıktan sonra ertelenen enterprise UI/UX ve headed browser kabulü.

Her adımda ilgili otomatik testler eklenir, aynı turda `plan.md`/`todo.md` gerçek duruma göre daraltılır ve küçük commit doğrudan `main` üzerine gönderilir.
