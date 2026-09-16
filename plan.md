# YunPanel — Plesk Referanslı Kalan Geliştirme Planı

Bu dosya **yalnız kalan ürün/kod işlerini ve gerçek ortam kabul kapılarını** tutar. Yapılmış işlerin ayrıntılı geçmişi `docs/history/`, hedef mimari `docs/architecture.md`, recovery sözleşmesi `docs/provisioning-recovery.md`, bağlayıcı kurallar `agents.md`, gerçek Ubuntu/browser/provider testleri `todo.md` içindedir.

Son DNS çalışma kaydı: `docs/history/dns-secondary-health-ui-2026-09-16.md`.

## 0 — Değiştirilemez ürün kararı

- YunPanel hosting davranışında Plesk Obsidian referanstır; Plesk'in iç implementasyonu kopyalanmaz.
- Hazır ve olgun servis varken File Manager, terminal, database client, authoritative DNS, webmail, monitoring veya backup motoru yeniden yazılmaz.
- Ana hazır servisler: PowerDNS Authoritative, Postfix, Dovecot, Rspamd, Roundcube, MariaDB/MySQL, phpMyAdmin, elFinder, OpenSSH internal-sftp, ttyd, Nginx, PHP-FPM, Passenger, restic/rclone, Netdata, GoAccess, CrowdSec.
- Her bağımsız Website dedicated Unix user/group alır. `shared-site` açıkça seçilmedikçe domain/subdomain başka Website'in OS kimliğini paylaşmaz.
- Roundcube domain başına kurulmaz; tek shared instance `webmail.<domain>` DNS/TLS/Nginx mapping'leriyle kullanılır.
- Nginx shared kalır; PHP site başına PHP-FPM pool/socket, Node Passenger `passenger_user/group`, static site site-owned private publish tree + yalnız Nginx read ACL kullanır.
- Homegrown `site-file-manager`, custom node-pty terminal ve benzeri yüzeyler yalnız hazır replacement acceptance geçene kadar migration fallback'idir; genişletilmez.
- Ekran/model/route varlığı özellik tamamlandı anlamına gelmez. Gerçek servis, izolasyon, lifecycle, health ve failure/recovery acceptance geçmeden `DONE` denmez.

## 1 — Plesk core parity kapıları

Aşağıdaki 7 kapının tümü gerçek Ubuntu host üzerinde geçmeden Plesk core parity tamamlanmış sayılmaz:

- [ ] Website OS isolation
- [ ] Authoritative DNS + ns1/ns2 + zone template
- [ ] Mail + Roundcube + external send/receive
- [ ] Database ownership + phpMyAdmin
- [ ] Ready-made File Manager + cross-site isolation
- [ ] TLS/certificate lifecycle
- [ ] Transactional create/delete/reconcile provisioning

---

# P0 — Plesk core parity

## P0.1 — Website Unix identity ve filesystem isolation

### Kalan kod işleri

- [ ] Gerçek `independent subdomain` create flow'u ayrı Website/Application identity oluştursun; alias hiçbir user/runtime/mailbox üretmesin; `shared-site` yalnız explicit seçim olsun.
- [ ] Inspect-only isolation audit'ini authenticated HTTP/API ve gerekli panel yüzeyine bağla; migration apply ayrı typed-confirmation operation olsun.
- [ ] SFTP public-key credential lifecycle ekle: Website key add/list/revoke/rotate, root-owned managed `authorized_keys` materialization, secret/private-key browser veya repo state'ine yazılmasın.
- [ ] SFTP credential değişiklikleri site provisioning ownership/evidence ile idempotent reconcile edilsin.
- [ ] Legacy Website migration apply kör recursive `chown` yapmasın; önce canonical identity/path/runtime drift raporu ve exact değişiklik preview'sı versin.

### Host acceptance — `todo.md`

- [ ] Site A UID'si Site B home/env/release/log/tmp/static publish dosyalarını okuyamaz/yazamaz.
- [ ] Node Passenger ve PHP-FPM process'leri gerçek OS üzerinde kendi site UID/GID'siyle çalışır.
- [ ] Static site yalnız Nginx read ACL ile servis edilir; başka `yunapp-*` kullanıcı okuyamaz.
- [ ] SFTP `..`, absolute path, symlink ve bind-mount escape ile başka siteye kaçamaz.
- [ ] Panel restart/reconcile ownership ve service policy'yi bozmaz; ikinci apply duplicate identity/chroot/pool oluşturmaz.

## P0.2 — Sunucu kimliği, ns1/ns2 ve PowerDNS Authoritative

### Kaldığımız nokta

Network/DNS Settings, DNS identity, local/public readiness ayrımı, delegation/glue inspector, Primary zone + NOTIFY provisioning, manual RRset SOA serial advancement + secondary NOTIFY, **Zone Template re-apply secondary topology/NOTIFY**, TCP SOA secondary serial inspector ve Domain-scoped secondary sync service source olarak mevcut. Secondary status service primary serial, PowerDNS `notified_serial` ve remote secondary observed SOA serial evidence'ını birbirinden ayırıyor. Authenticated `GET /api/domains/:domainId/dns/secondary` production composition'a bağlı; Domain DNS workspace primary serial, NOTIFY evidence ve her secondary observed serial/error state'ini gösteriyor. API explicit `healthGate / severity / recovery / automaticMutationAllowed` policy döndürüyor; drift/unverifiable kör re-apply veya duplicate mutation başlatmıyor ve frontend backend policy'yi source-of-truth kabul ediyor. Ayrıntı `docs/history/dns-secondary-health-ui-2026-09-16.md`.

### Kalan kod işleri

- [ ] PowerDNS config/package upgrade/rollback lifecycle'ını durable operation evidence ile transactional hale getir; restart/timeout sonrası inspect-first, configtest başarısızsa eski çalışan config korunmalı.

### Host/browser acceptance — `todo.md`

- [ ] Fresh Ubuntu 24.04'te PowerDNS package/backend/config/service/upgrade health geçer.
- [ ] API yalnız loopback'ten erişilir; raw API key public yüzeye sızmaz.
- [ ] Local UDP/TCP 53 ve dış vantage point public UDP/TCP 53 ayrı doğrulanır; firewall/NAT engeli local health'i public-ready yapmaz.
- [ ] Public `dig @ns1` / `dig @ns2` SOA/NS/A authoritative cevapları ve recursion-denied davranışı geçer.
- [ ] Registrar/glue/delegation uyuşmazlığında state `ready` olmaz.
- [ ] Network/DNS Settings Chromium/Firefox'ta DNS identity preview/typed-confirmation, PowerDNS apply, public/local state ve delegation/glue talimatlarını doğru render eder.
- [ ] En az iki authoritative endpoint veya onaylı secondary ile Primary/NOTIFY/AXFR, serial propagation ve failover doğrulanır; `notified_serial` remote SOA sync yerine başarı kanıtı sayılmaz.

## P0.3 — Versioned DNS Zone Template ve Domain DNS yönetimi

### Kaldığımız nokta

Create path, versioned template, durable re-apply, manual RRset CRUD, DNS panel, DNSSEC enable/disable + parent DS gate ve operation history source olarak mevcut. Manual RRset mutation ve Zone Template re-apply SOA serial/topology değişimini secondary varsa NOTIFY ile taşır. Ayrıntı `docs/history/dns-ui-secondary-progress-2026-09-16.md`.

### Kalan kod işleri

- [ ] Local mail lifecycle tamamlanınca mail capability/DKIM public key intent'ini zone lifecycle'a bağla; re-apply `mail` source'u da desired state ile güvenle reconcile edebilsin; kapalı servis dead mail/webmail/SRV/discovery kaydı üretmesin.
- [ ] `autodiscover` / `autoconfig` yalnız gerçek endpoint hazır olduğunda service-aware DNS desired state'e girsin.
- [ ] DNSSEC key rollover/rotation lifecycle ekle: yeni KSK/CSK üret/publish/activate, parent DS propagation doğrula, eski DS retirement doğrula, eski key deactivate/delete; rollover sırasında secure delegation kesilmesin ve private key public state/job/audit'e çıkmasın.
- [ ] Zone suspend/delete/compensation ownership evidence'ını P0.9 lifecycle'ına bağla; manual kayıt içeren zone destructive cleanup'ta fail-closed kalsın.

### Host/browser acceptance — `todo.md`

- [ ] Yeni local-DNS domain tek Website operation'ında default authoritative zone alır ve SOA/NS/A/AAAA/www policy gerçek `dig` ile doğrulanır.
- [ ] Manual RRset add/update/delete/no-op gerçek PowerDNS'te doğrulanır; mutation SOA serial'ı doğru artırır, managed RRset manual endpoint'ten değiştirilemez, stale `expectedSerial` 409 verir.
- [ ] Manual record template re-apply sırasında korunur veya explicit conflict olur; provider timeout/restart injection sonrası operation inspect-first duplicate mutation üretmez.
- [ ] Site Detail DNS browser yüzeyi root/subdomain ownership, managed read-only/manual editable, conflict/blocker/diff, operation history ve DNSSEC DS/parent state'lerini Chromium/Firefox'ta doğru gösterir.
- [ ] Kapalı servis için dead `webmail`/MX/DKIM/discovery record oluşmaz.
- [ ] DNSSEC enable/disable, parent DS propagation, mismatch/unverifiable state ve restart recovery gerçek resolver/registrar ile doğrulanır.

## P0.4 — Mail: Postfix + Dovecot + Rspamd + shared Roundcube

### Kalan kod işleri

- [ ] Postfix/Dovecot/Rspamd tek mail service manager: install/config/inspect/validate/reload/rollback.
- [ ] SQL-backed virtual mail domain/mailbox/alias/quota/password hash modeli; Website user ile mail storage identity ayrıdır.
- [ ] Dedicated mail storage identity; Website UID Maildir owner değildir.
- [ ] Local mail enable domain oluşturur fakat bilinen/default parola mailbox yaratmaz.
- [ ] SMTP 25 + submission 587; 465/993 policy; plain auth yalnız TLS altında.
- [ ] DKIM key lifecycle; private key secret-safe, public key DNS intent.
- [ ] SPF/DMARC/DKIM desired state mail operation evidence'ıyla bağlı olsun.
- [ ] Sender-login/relay/rate abuse/Rspamd policy.
- [ ] Forwarding/alias/SRS lifecycle.
- [ ] ClamAV optional profile; health yoksa aktif gösterme.
- [ ] Sunucu başına tek shared Roundcube + dedicated FPM pool/socket + protected config.
- [ ] Local-mail domain -> `webmail.<domain>` DNS/TLS/Nginx -> shared Roundcube.
- [ ] Full email + password Dovecot IMAP login, authenticated Postfix submission.
- [ ] Domain disable/delete yalnız kendi mapping'ini kaldırır; shared instance başka domainler kullanıyorsa kalır.
- [ ] Gerçek autodiscover/autoconfig endpoint.
- [ ] External DNS domain için exact pending DNS requirements/provider apply.

### Host acceptance — `todo.md`

- [ ] Inbound/outbound mail, relay denial, submission TLS/auth, IMAP, quota, DKIM/SPF/DMARC ve multi-domain Roundcube gerçek hostta geçer.

## P0.5 — Website DB ownership + phpMyAdmin

### Kalan kod işleri

- [ ] MariaDB/MySQL secure install/health baseline; admin secret encrypted store.
- [ ] DB Website'e explicit bağlı; deterministic unique DB/user naming.
- [ ] Site DB user yalnız bağlı schema'larda grant alır; `*.*` yok.
- [ ] Site Databases CRUD + rotate/revoke + drop preview.
- [ ] Website create'te opsiyonel initial DB.
- [ ] Shared hardened phpMyAdmin.
- [ ] `Open phpMyAdmin` site DB user scope'uyla supported signon/short-lived handoff; root browser'a verilmez.
- [ ] Import/export/dump vendor tooling.
- [ ] DB create/drop/grant/rotation durable evidence/rollback.

## P0.6 — elFinder; homegrown File Manager removal

### Kalan kod işleri

- [ ] elFinder shared app/client.
- [ ] Connector gerçek Website UID/GID altında çalışır; preferred site PHP-FPM pool/socket.
- [ ] Root canonical Website HOME/SFTP root'tan server-side resolve edilir.
- [ ] Session -> short-lived audience-bound Website token.
- [ ] Upload/download/edit/rename/move/copy/delete/mkdir/archive via elFinder.
- [ ] Traversal/symlink/archive escape/special file/secret/cross-site tests.
- [ ] Vendor endpoint public bypass olmasın.
- [ ] Acceptance sonrası custom `site-file-manager` kaldır.
- [ ] elFinder site-UID acceptance vermezse homegrown'a dönme; Filestash + localhost SFTP değerlendir.

## P0.7 — IntegratedToolGateway

### Kalan kod işleri

- [ ] Owner/session authorization + Website scope + short-lived audience token + same-origin proxy + revoke/logout.
- [ ] Vendor admin portları public açılmaz.
- [ ] phpMyAdmin/elFinder token başka Website'e replay edilemez.
- [ ] ttyd on-demand one-shot: site terminali site user/cwd, server terminali Owner root.
- [ ] ttyd acceptance sonrası custom node-pty/xterm backend kaldır.
- [ ] Roundcube Owner panel gateway'ine bağlı değildir; mailbox auth kullanır.

## P0.8 — Transactional Website/domain provisioning

### Kalan preflight

- [ ] FQDN/IDN/duplicate/parent/alias conflict preflight'ini final create flow'da birleştir.
- [ ] Runtime, local/external DNS, local/external/disabled mail, DB, IPv4/IPv6, certificate ve SFTP intent'lerini tek preview'da göster.
- [ ] Package/service blocker'larını apply öncesi doğrula.
- [ ] Exact resource preview üret.

### Kalan apply zinciri

- [ ] Website/Application/operation reserve lifecycle'ını finalize et.
- [ ] Nginx stage/configtest/activate lifecycle'ını full Website create zincirinde finalize et.
- [ ] DB seçildiyse scoped DB/user/grant step'i bağla.
- [ ] Local mail domain + DKIM + DNS intent step'ini bağla.
- [ ] `webmail.<domain>` mapping + shared Roundcube step'ini bağla.
- [ ] Certificate step'ini bağla.
- [ ] Cross-service health postcondition'larını bağla.
- [ ] Mandatory resource'lar health-gated olmadan Website `ready` olamasın.

### Kalan recovery

- [ ] Her step durable evidence/ownership; restart önce inspect.
- [ ] Failure açık `partial/failed`; sahte ready yok.
- [ ] Retry yalnız failed/unapplied step; revision drift fail-closed.
- [ ] Compensation reverse order ve yalnız operation-owned resource.
- [ ] Atomic config + service configtest before reload.

## P0.9 — Suspend/delete/rollback

### Kalan kod işleri

- [ ] Suspend data silmeden web/runtime erişimini durdurur.
- [ ] Domain remove ve Website delete ayrıdır.
- [ ] Delete impact tüm Unix/runtime/Nginx/cert/DNS/mail/DB/SFTP/log/backup bağımlılıklarını gösterir.
- [ ] Mail/DB/file deletion typed confirmation + retention.
- [ ] Reverse dependency cleanup ownership evidence ile.
- [ ] Partial deletion retryable state.

---

# P1 — Core parity sonrası

## P1.1 — Runtime golden path

- [ ] Passenger dependency/env/log/startup/config validation + rollback.
- [ ] PHP distro FPM production golden path; multi-version ancak doğrulanmış repo ile.
- [ ] Static durable release/rollback binding revision.
- [ ] Python site-user venv + Gunicorn/Uvicorn.
- [ ] Managed Compose dedicated project/network/volume identity.

## P1.2 — Backup/restore

- [ ] restic lifecycle: init/test/check/unlock/snapshot/retention/forget/prune.
- [ ] rclone remote registry/test + encrypted credential.
- [ ] Website backup set: files/data/env metadata/DB dump/mail/DNS/Nginx/Compose hooks.
- [ ] Restore preview + pre-restore snapshot + health rollback.

## P1.3 — Monitoring/security

- [ ] Netdata loopback + authenticated gateway.
- [ ] GoAccess site logs/report/WebSocket.
- [ ] nftables tek firewall authority.
- [ ] CrowdSec engine/bouncer; duplicate Fail2ban authority yok.

## P1.4 — Site features/settings

- [ ] Site-user cron/timer CRUD.
- [ ] WP-CLI site user.
- [ ] Composer site user.
- [ ] Redis/Memcached isolation policy.
- [ ] Settings ekranları gerçek backend state'iyle tamamlanır.

---

# P2 — Migration temizliği ve son ürün yüzeyi

- [ ] elFinder acceptance sonrası custom `site-file-manager` kaldır.
- [ ] ttyd acceptance sonrası custom node-pty terminal kaldır.
- [ ] Passenger acceptance sonrası direct-systemd yalnız legacy migration adapter'ı olarak kalsın; migration sonunda kaldır.
- [ ] restic acceptance sonrası custom backup archive yollarını kaldır.
- [ ] Agentless local backend acceptance sonrası retained legacy agent transport/package/state kaldır.
- [ ] Plesk read-only importer en son: Website/Domain/identity/runtime/DB/DNS/mail/cron/cert/backup preview.
- [ ] Backend/functionality tamamlandıktan sonra enterprise UI/UX polish.

---

# Uygulama sırası — blocker yoksa sapma yok

1. **Website Unix isolation** — independent subdomain, isolation audit API/apply, SFTP key lifecycle, host acceptance.
2. **PowerDNS + ns1/ns2** — sıradaki exact iş: PowerDNS durable config/package upgrade/rollback; inspect-first recovery ve configtest-before-reload.
3. **Versioned DNS Zone Template** — mail source entegrasyonu, autodiscover endpoint gate, DNSSEC rollover, zone suspend/delete ownership.
4. **Mail + shared Roundcube**.
5. **Database + phpMyAdmin**.
6. **elFinder**.
7. **Transactional create/delete provisioning** parçalarını tek lifecycle'a birleştir.
8. **TLS/autodiscover/recovery hardening**.
9. Runtime migration/backup/monitoring/security/site extras.
10. Legacy cleanup ve en son UI/UX polish.

Her küçük dilim source test kontratıyla ayrı commit edilir. GitHub Actions kullanılmaz. Gerçek Ubuntu/package/public DNS/SMTP/browser/provider acceptance bu ortamda yapılamıyorsa `todo.md`'ye bırakılır ve ilgili P0 kapısı host acceptance geçmeden `DONE` olmaz.
