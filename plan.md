# YunPanel — Kalan Geliştirme Planı

Bu dosya yalnız tamamlanmamış ürün/kod işlerini tutar. Hedef ürün mimarisi `docs/architecture.md`, provisioning recovery sözleşmesi `docs/provisioning-recovery.md`, bağlayıcı geliştirme kuralları `agents.md`, gerçek Ubuntu/browser/provider kabul işleri `todo.md` içindedir.

2026-09-14 yön değişikliği: YunPanel olgun hosting araçlarının yerine kendi File Manager, terminal, database client, DNS server, monitoring veya backup arşiv motorunu yazmayacaktır. Mevcut özel uygulamalar yalnız replacement acceptance tamamlanana kadar migration fallback'idir. Yeni çalışma site-merkezli provisioning ve hazır servis adapter'larına gider.

## P0 — Ürün omurgasını site-merkezli hale getir

- [ ] Mevcut durable `WebsiteProvisioningPlan`ı kalan gerçek kaynak adapter'larına bağla: certificate, DNS, mail/webmail, database, SFTP, logs/analytics ve backup aynı Website kimliği/step/evidence modeli altında ilerlesin. Metadata yazılması tek başına `ready` sayılmasın.
- [ ] Provisioning recovery contract'ını kalan adapter'lara yay. Explicit failed-step retry, durable compensation API/state, secret-safe latest-operation read model, Site overview step-level continue/retry/compensate UI, Unix identity + Nginx + static runtime operation-owned rollback/compensation, downstream-active step varken önceki kaynağı geri almayı engelleyen reverse-order compensation guard, startup `listInterrupted()` inspect-first reconcile ve handler-kind bazlı actionable remediation guidance mevcut. Kalan mutating adapter'lar aynı ownership/evidence/recovery sözleşmesini kullanmalı; evidence/ownership olmadan başarı veya destructive cleanup üretme, restart sonrası host mutation'ı körlemesine tekrar etme.
- [ ] Kalan host adapter'larını mevcut canonical Website/Application identity/path contract'ına bağla. SFTP, logs/analytics ve backup scope aynı `yunapp-*`, `/var/lib/yunpanel/data/<applicationId>`, release/current ve control-plane backup authority bilgisini tüketmeli; path/user formülünü adapter içinde yeniden üretme ve drift'i fail-closed bırak.
- [ ] Independent subdomain ile `shared-site` subdomain'i explicit modelle. Alias runtime/user/mailbox üretmesin; independent Website ayrı izolasyon alsın.
- [ ] Application'ı Website alt kaynağı yap. Yeni runtime/app yalnız site ekranından oluşturulsun; günlük navigasyondaki global `/applications` kaldırılıp yalnız Owner Sunucu > Tanılama envanteri olarak kalsın.
- [ ] Site silme/move preview'ını yeni runtime, DNS, database user/grant, mail/webmail, SFTP, GoAccess, restic ve cron ilişkileriyle tamamla; örtülü cascade yapma.

Kabul: yeni bir Website tek akışta dedicated kimlik ve seçilen kaynakları üretir; başka Website kullanıcısı/process'i onun home, env, database, socket, terminal veya dosyalarına erişemez; başarısız adım siteyi hazır göstermez.

## P0 — Runtime adapter'ları: Passenger ve PHP-FPM

- [ ] Mevcut Ubuntu 24.04 Passenger install/inspect adapter'ını upgrade, snapshot/rollback ve failure-injection contract'ıyla tamamla; global Passenger/Nginx runtime doğrulaması ve postcondition'lar başarısız mutation'ı eski good state'e döndürsün.
- [ ] Mevcut Node Website → Passenger → Nginx provisioning yolunu production golden path'e tamamla. Passenger package dependency, env/log target, startup/runtime postcondition ve varsayılan runtime seçimi tek akışta fail-closed olsun; user kontrollü raw Passenger/Nginx directive kabul etmesin.
- [ ] Mevcut direct-systemd Node uygulamaları için read-only migration preview ekle. Release/env/health korunarak Passenger'a geçiş health-gated olsun; başarısız geçiş eski systemd servisini çalışır bıraksın. Yeni Website'te systemd adapter varsayılan olmasın.
- [ ] PHP-FPM adapter'ı ekle: distro PHP ile site başına pool/socket, Unix user/group, document root, bounded ini/resource limits, configtest/reload/rollback. Çoklu PHP sürümü ayrı doğrulanmış repository kararı olmadan açılmasın.
- [ ] Static deploy/rollback job intent'ini Website kimliği ve binding revision'ına explicit bağla; canonical-first deploy ve identity-aware rollback router üzerindeki proven-legacy fallback yalnız persisted migration işleri için tanınsın ve real-host acceptance sonrası kaldırılsın. Versioned job schema/idempotency compatibility korunmalı; yeni unbound deploy/rollback legacy yoluna düşmemeli.
- [ ] Python adapter'ını P1'e hazır interface olarak tanımla; venv + Gunicorn/Uvicorn ayrı site user/systemd unit kullanacak, P0 Node/PHP'yi geciktirmeyecek.

Kabul: Passenger Node ve PHP-FPM process/pool gerçek site UID/GID ile çalışır; iki site birbirinin file/env/socket'ini okuyamaz; deploy rollback ve panel restart hosted app'i bozmaz.

## P0 — Hazır yönetim araçları gateway'i

- [ ] Ortak `IntegratedToolGateway` ekle: Owner/session authorization, Website scope, short-lived audience token, same-origin reverse proxy, WebSocket/HTTP upgrade, logout/revoke ve health/version contract'ı. Vendor admin portları yalnız loopback/Unix socket dinlesin.
- [ ] ttyd adapter'ı ekle. Her terminal on-demand one-shot process/socket açsın; site terminali site user/cwd, Sunucu terminali Owner root olsun. Origin/replay/session revocation, resize, Unicode, TUI, idle/output/process-group cleanup test edilsin.
- [ ] ttyd acceptance sonrası özel `node-pty`/xterm WebSocket backend/frontend ve native packaging bağı kaldırılmadan önce migration/rollback ve açık terminal cleanup testi yap.
- [ ] elFinder adapter'ı ekle. Shared UI kullanılabilir fakat connector her istekte yalnız Website root'unu görsün ve site user/PHP-FPM pool'u altında çalışsın; YunPanel session dışından connector erişimi olmasın. Upload/edit/archive policy ve symlink/path escape test edilsin.
- [ ] elFinder acceptance sonrası özel `site-file-manager` API/UI'nin çakışan ürün yüzeyini kaldır; gerekiyorsa yalnız immutable artifact/evidence helper'larını koru.
- [ ] phpMyAdmin'i shared servis olarak kur/yapılandır; YunPanel signon bridge siteye bağlı least-privilege database credential'ıyla çalışsın. Root DB credential browser'a/session'a verilmesin; site scope'u olmayan database phpMyAdmin girişinde görünmesin.
- [ ] PostgreSQL desteği seçildiğinde ayrı PostgreSQL role/ownership adapter'ı ve pgAdmin 4 gateway'i ekle; MySQL/MariaDB P0'ı geciktirme.

Kabul: araç URL'sini bilen unauthenticated kullanıcı, Read Only kullanıcı veya başka Website token'ı erişemez; logout/revoke canlı WebSocket/session'ı kapatır; servis secret'ı URL/localStorage/job/audit/loga çıkmaz.

## P0 — PowerDNS ve nameserver yönetimi

- [ ] PowerDNS Authoritative package/config/health adapter'ı ve local-only HTTP API credential store'u ekle. API portunu public açma.
- [ ] Zone/RRset modelini PowerDNS canonical state'ine bağla: SOA, NS, A, AAAA, CNAME, MX, TXT, CAA, SRV, TTL ve DNSSEC; preview/diff/apply/rollback ve serial davranışı test edilsin.
- [ ] Settings'e nameserver seti, glue hedefleri, primary/secondary durumu, default SOA/TTL ve DNSSEC policy ekle. Tek sunucu varsa iki bağımsız authoritative NS varmış gibi healthy gösterme; external secondary veya ikinci host gereksinimini açık blocker yap.
- [ ] New Website local-DNS seçeneğini provisioning'e bağla. Apex/www/webmail/mail ve seçilen runtime kayıtları policy'den üretilsin; mevcut dış Cloudflare zone'ları otomatik PowerDNS'e taşınmasın.
- [ ] Registrar delegation/readiness'i gözlemle; parent zone/glue değişikliğini provider adapter'ı yoksa yapılmış sayma.
- [ ] Mevcut Cloudflare record ve Certbot DNS-01 adapter'larını external-DNS seçeneği olarak koru; local PowerDNS ile lifecycle kimliklerini karıştırma.

Kabul: yeni local-DNS Website PowerDNS'de gerçek zone ve NS kayıtlarıyla answer verir; DNSSEC açılırsa DS bilgisi sunulur; yanlış delegation panelde actionable görünür.

## P0 — Mail ve gerçek Roundcube webmail

- [ ] Mevcut Postfix/Dovecot/Rspamd desired-state/apply/rollback parçalarını Website provisioning'e bağla; mailbox/alias/quota/DKIM state'i site mail sekmesinden yönetilsin.
- [ ] Roundcube'u sunucu başına shared package + dedicated PHP-FPM pool/socket + protected config/database ile kur. Gerçek IMAP/SMTP/TLS health olmadan hazır gösterme.
- [ ] Local mail seçilen her ana domain için `webmail.<domain>` PowerDNS/external-DNS intent'i, certificate ve Nginx vhost'u shared Roundcube'a bağla. Domain başına Roundcube kopyası kurma.
- [ ] İlk mailbox oluşturmayı explicit parola adımı yap; varsayılan parola veya public registration üretme. İstenirse `postmaster`/`abuse` alias policy ile oluşturulsun.
- [ ] Mail submission, sender-login, DKIM, SPF/DMARC önerileri, queue/log, forwarding/SRS ve restore zincirini gerçek teslim kanıtıyla tamamla.
- [ ] ClamAV'ı opsiyonel profile yap; RAM/disk yeterliliği ve daemon health görünmeden antivirus aktif gösterme.

Kabul: `webmail.<domain>` gerçek Roundcube login ekranı açar; yalnız o domain'in geçerli mailbox hesabı IMAP/SMTP ile çalışır; yeni Website seçimine göre DNS/vhost/certificate lifecycle oluşur.

## P0 — Database ownership ve yönetim

- [ ] Database schema + database user/grant'i Website'e explicit bağla; her site user yalnız kendi schema'larında minimum gereken yetkiye sahip olsun. Credential encrypted store'da kalsın ve rotation/revoke desteklensin.
- [ ] Database/server envanterini read-only canlı GET yap; günlük UI'daki inspect/“sunucuyu tara” job akışını kaldır. Create/drop/grant/backup/restore mutation'ları durable job kalsın.
- [ ] Site Databases sekmesine schema/user/backup özetini ve phpMyAdmin gateway girişini koy; global database sayfası yalnız host engine/health/admin tanılaması olsun.
- [ ] MariaDB/MySQL dump/restore'u restic pre-hook/artifact akışına bağla; ikinci genel archive motoru yazma.

Kabul: Site A database credential'ı Site B schema'sını listeleyemez/değiştiremez; phpMyAdmin signon scope'u aynı sınırı korur; create/drop sonrası canlı liste ekstra scan işi olmadan yenilenir.

## P1 — restic/rclone backup ve restore

- [ ] Yeni özel aggregate archive/finalization geliştirmesini durdur. Mevcut resource/dependency preview ve durable job ilkelerini restic adapter'ına taşı; custom archive formatını büyütme.
- [ ] Local ve S3-compatible restic repository lifecycle'ı ekle: init/test/unlock/check, encrypted password credential, tags/snapshots, policy/schedule, retention/forget/prune ve health.
- [ ] rclone remote registry/test ekle; restic `rclone:` backend veya açık remote target kullan. Credential argv/URL/job/audit/loga çıkmasın.
- [ ] Website backup setini release/persistent data/env metadata, DNS/Nginx config, database dump, Maildir ve Compose volumes ile ilişkilendir. DB/mail için vendor dump/quiesce hooks kullan; çalışan kaynağı sessiz live tar ile kopyalama.
- [ ] Restore preview exact snapshot/resource/dependency revision ve typed confirmation istesin; pre-restore snapshot, health gate ve deterministic rollback uygulasın.
- [ ] Site Backup sekmesine last success, next run, size, repository health, snapshots, restore drill ve retention koy.

Kabul: restic repository vendor `check` ile doğrulanır; gerçek Website restore eski state'e dönebilir; panel özel arşiv formatı üretmez; remote failure mevcut snapshot/state'i bozmaz.

## P1 — Monitoring, analytics ve güvenlik

- [ ] Netdata'yı loopback-only servis ve YunPanel authenticated gateway ile bağla; Dashboard/Sunucu ekranı gerçek Netdata verisini kullanırken kendi metric history motorunu büyütme.
- [ ] GoAccess'i siteye özel Nginx access log ve generated report/WebSocket ile bağla; başka site logu görünmesin; log format/rotation/restart lifecycle'ı yönetilsin.
- [ ] nftables ownership policy'sini tanımla; panel port/service allowlist'i dışındaki mevcut admin kurallarını ezme. UFW ve doğrudan nftables mutation'ını aynı state'in iki yazarı yapma.
- [ ] CrowdSec engine + nftables/firewall bouncer health/decisions adapter'ını ekle; SSH/SMTP/web koleksiyonları ve safe ban/unban preview'ı oluştur.
- [ ] Settings ve bildirim merkezi Netdata/service/runtime/DNS/mail/backup/security health olaylarını birleştirsin.

## P1 — Site özellikleri ve dolu Settings

- [ ] Site-user cron/systemd timer CRUD, timezone/cwd/bounded env, enable-disable, last/next run ve bounded output ekle.
- [ ] OpenSSH internal-sftp site erişimi, public key lifecycle ve chroot/path policy ekle. FTP varsayılan olarak kurulmasın.
- [ ] WordPress detection + WP-CLI; PHP Website için Composer adapter'ı ekle. Her komut site user/cwd ile çalışsın.
- [ ] Redis/Memcached adapter'larında per-site ACL/socket/namespace veya explicit isolated instance policy'si olmadan shared erişim verme.
- [ ] Settings backend/schema/UI'sını `docs/architecture.md` bölüm 6'daki Panel, Network, Website defaults, DNS/SSL, Mail/Webmail, Databases, Backup, Security ve Monitoring alanlarıyla doldur.
- [ ] Eksik dependency için gerçek install/configure/diagnose akışı göster; placeholder ve sahte başarı kullanma.

## P2 — Docker, Python ve migration temizliği

- [ ] Managed Compose projesini Website altına taşı; dedicated project/network/volume identity, per-site logs/terminal/backup ve Nginx target üret.
- [ ] Gelişmiş global Docker yönetimi gerekiyorsa Portainer'ı opsiyonel authenticated gateway olarak değerlendir; YunPanel içinde ikinci genel Docker UI yazma.
- [ ] Python runtime adapter'ını venv + Gunicorn/Uvicorn ile tamamla.
- [ ] ttyd/elFinder/Passenger/restic replacements gerçek acceptance geçince özel terminal/file-manager/direct-systemd/custom-backup çakışan yollarını küçük migration commitleriyle kaldır.
- [ ] Agentless migration/rollback kabulünden sonra retained legacy agent transport/paket/state yüzeyini fiziksel olarak kaldır.
- [ ] Plesk read-only importer'ı en son ekle; Passenger/PHP/static/Node, Website/Domain, database, DNS, mail, cron ve backup mapping'i explicit preview/rollback ile çalışsın.

## DEFERRED — Son UI/UX polish

- [ ] Backend capability'leri tamamlandıktan sonra site-merkezli navigasyon, responsive layout, table/form polish ve accessibility çalışmasını ayrı tasarım aşamasında tamamla.
- [ ] Gerçek Chromium/Firefox, mobil viewport, klavye ve ekran okuyucu acceptance'ını `todo.md` kapılarıyla tamamla.

## Uygulama sırası

1. Website provisioning + resource ownership + global Application akışının site altına taşınması.
2. Passenger Node + PHP-FPM golden path.
3. Ortak tool gateway; ttyd, elFinder ve phpMyAdmin.
4. PowerDNS/NS ve new-site DNS provisioning.
5. Roundcube + mail provisioning + `webmail.<domain>`.
6. Database ownership/signon ve canlı inventory düzeltmesi.
7. restic/rclone backup/restore.
8. Netdata, GoAccess, CrowdSec/firewall.
9. Cron/SFTP/WP-CLI/Composer/cache ve dolu Settings.
10. Docker/Python, replacement cleanup, legacy agent temizliği, en son Plesk importer ve UI polish.

Her dilim source testleri, package manifest değişimi ve `todo.md` gerçek-host acceptance maddesiyle birlikte ilerler. Plan değişikliği implementasyon veya canlı kabul sayılmaz.