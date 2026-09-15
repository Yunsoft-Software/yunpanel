# YunPanel — Plesk Referanslı Kalan Geliştirme Planı

Bu dosya yalnız tamamlanmamış ürün/kod işlerini, source-complete fakat gerçek host kabulü bekleyen kapıları ve uygulama sırasını tutar. Hedef mimari `docs/architecture.md`, recovery sözleşmesi `docs/provisioning-recovery.md`, bağlayıcı kurallar `agents.md`, gerçek Ubuntu/browser/provider kabul işleri `todo.md` içindedir.

## 0 — Değiştirilemez ürün kararı

- YunPanel hosting davranışında Plesk Obsidian referanstır; Plesk'in iç implementasyonu kopyalanmaz.
- Hazır ve olgun servis varken File Manager, terminal, database client, authoritative DNS, webmail, monitoring veya backup motoru yeniden yazılmaz.
- Ana hazır servisler: PowerDNS Authoritative, Postfix, Dovecot, Rspamd, Roundcube, MariaDB/MySQL, phpMyAdmin, elFinder, OpenSSH internal-sftp, ttyd, Nginx, PHP-FPM, Passenger, restic/rclone, Netdata, GoAccess, CrowdSec.
- Her bağımsız Website dedicated Unix user/group alır. `shared-site` açıkça seçilmedikçe domain/subdomain başka Website'in OS kimliğini paylaşmaz.
- Roundcube domain başına kurulmaz; tek shared instance `webmail.<domain>` DNS/TLS/Nginx mapping'leriyle kullanılır.
- Nginx shared kalır; PHP site başına PHP-FPM pool/socket, Node Passenger `passenger_user/group`, static site ise site-owned private publish tree + yalnız Nginx read ACL modeli kullanır.
- Homegrown `site-file-manager`, custom node-pty terminal ve benzeri yüzeyler yalnız hazır replacement acceptance geçene kadar migration fallback'idir; genişletilmez.
- Ekran/model/route varlığı özellik tamamlandı anlamına gelmez. Gerçek servis, izolasyon, lifecycle, health ve failure/recovery acceptance geçmeden `DONE` denmez.

### Plesk davranış kontratı

1. Server-wide DNS template yeni local-DNS zoneların kaynağıdır.
2. Template değişiklikleri mevcut zonelara yalnız preview + explicit apply ile taşınır; manual kayıtlar sessizce ezilmez.
3. Local mail açık domain `mail`, MX, `webmail`, SPF/DKIM/DMARC ve gerçekten desteklenen discovery kayıtlarını alır.
4. `webmail.<domain>` shared Roundcube'a gider.
5. Hosting filesystem işlemleri gerçek OS identity/permission sınırında yapılır.
6. Database Website ile ilişkilidir; phpMyAdmin site-scoped DB user ile açılır, root browser'a verilmez.
7. File Manager Website root sınırını UI filtresiyle değil site UID/GID ile uygular.

Plesk referansları:

- DNS template: https://docs.plesk.com/en-US/obsidian/administrator-guide/dns/dns-settings.72226/
- Website/system user: https://docs.plesk.com/en-US/obsidian/administrator-guide/creating-websites.80014/
- Subscription/File Manager ownership: https://docs.plesk.com/en-US/obsidian/customer-guide/customer-account-administration.69297/
- Webmail: https://docs.plesk.com/en-US/obsidian/administrator-guide/mail/webmail-software.66411/
- phpMyAdmin/database access: https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/website-databases/accessing-databases.71841/

## 1 — Tamamlanma raporlama kontratı

Plesk core parity aşağıdaki 7 kapının tümü gerçek Ubuntu host üzerinde geçmeden tamamlanmış sayılamaz:

- [ ] Website OS isolation
- [ ] Authoritative DNS + ns1/ns2 + zone template
- [ ] Mail + Roundcube + external send/receive
- [ ] Database ownership + phpMyAdmin
- [ ] Ready-made File Manager + cross-site isolation
- [ ] TLS/certificate lifecycle
- [ ] Transactional create/delete/reconcile provisioning

Kaynak kod tarafı hazırlanmış fakat gerçek host kabulü yapılamamış iş `CODE COMPLETE / HOST ACCEPTANCE PENDING` olarak tutulur; host testi `todo.md`'dedir.

---

# P0 — Plesk core parity

## P0.1 — Website Unix identity ve filesystem isolation

### Source durumu — 2026-09-15

Aşağıdaki isolation parçaları production provisioning path'ine bağlandı; gerçek host acceptance henüz kapanmadı:

- [x] Canonical `yunapp-*` Website identity/path provisioning mevcut ve site-create durable planında kullanılıyor.
- [x] HOME/SFTP root `/var/lib/yunpanel/data/<applicationId>`; release root `/var/lib/yunpanel/apps/<applicationId>`; log/tmp path policy canonical contract'a bağlı.
- [x] PHP runtime `container lockdown -> site PHP-FPM pool/socket` zinciriyle site UID/GID altında hazırlanıyor.
- [x] Passenger runtime canonical `passenger_user/group` kullanıyor; shared Nginx service `UMask=0027` policy ile doğrulanıyor.
- [x] PHP-FPM shared service `UMask=0027` policy ile doğrulanıyor; PHP Domain restage bu policy drift ederse fail-closed oluyor.
- [x] Hosted Website provisioning'e OpenSSH `internal-sftp` chroot step'i bağlandı; shell/forwarding/TTY kapalı, site root bind mount ile sınırlandırılıyor.
- [x] Static publish artifact'ı world-readable bırakılmıyor; site UID/GID `0750/0640`, `www-data` yalnız named read/traverse ACL alıyor ve retained release'ler normalize ediliyor.
- [x] PHP control-plane container'ları root-owned, release content site-owned olacak şekilde lockdown ediliyor.
- [x] Existing Website için mutation yapmayan inspect-only isolation audit/migration preview servisi eklendi.
- [x] Sahte `wwwMode=independent` aynı Website/user'ı paylaşmıyor gibi gösterilmek yerine fail-closed bloklanıyor.

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

### Source durumu — 2026-09-15

- [x] Server-wide authoritative DNS identity backend modeli eklendi: public IPv4/IPv6, ns1/ns2 FQDN+IP/local/external bilgisi, SOA defaults, TTL, DNSSEC default, secondary DNS hedefleri, revision ve preview/apply digest.
- [x] DNS identity update exact confirmation/revision kontrolü kullanıyor.
- [x] Aynı host/IP üstündeki ns1/ns2 gerçek redundancy gibi gösterilmiyor; warning state üretiliyor.
- [x] External secondary seçilip transfer target eksik bırakılırsa warning üretiliyor.
- [x] PowerDNS host manager source path'i eklendi: `pdns-server` + `pdns-backend-sqlite3` + `sqlite3` install/inspect, vendor include-dir doğrulaması, gsqlite3 schema initialization, protected config/database ve `pdns.service` lifecycle.
- [x] PowerDNS managed config ve SQLite DB path'leri symlink/non-regular file drift'inde mutation öncesi fail-closed korunuyor.
- [x] API key `YUNPANEL_SECRET_MASTER_KEY` altında AES-256-GCM encrypted durable store'da tutuluyor; public state yalnız configured/revision bilgisi veriyor.
- [x] `pdnsutil hash-password` ile config'e yalnız hashed API key yazılıyor; raw key yalnız loopback API çağrısında kısa süreli materialize ediliyor.
- [x] PowerDNS API `127.0.0.1:8081` ile loopback-only; `pdns_server --config=check` geçmeden service activation/restart yapılmıyor.
- [x] `pdns-recursor` installed ise authoritative apply fail-closed; YunPanel recursor kurmuyor/açmıyor.
- [x] Local readiness API health + UDP/53 + TCP/53 + recursion-denied probe ile health-gated; açık recursive resolver davranışı `ready` olamıyor.
- [x] Secondary DNS source policy explicit IP allowlist kullanıyor; AXFR allowlist/notify yalnız configured secondary adreslerine açılıyor.
- [x] DNS identity ve authoritative lifecycle authenticated HTTP/API'ye ve production bootstrap'a bağlandı; local-server scope dışı legacy/remote server ID fail-closed.
- [x] Read Only yalnız DNS identity/authoritative GET status yüzeylerini görebiliyor; preview/apply mutation Owner-management altında kalıyor.

### Kalan kod işleri

- [ ] Settings > Network/DNS React UI'ını yeni DNS identity/authoritative API'sine bağla. Server FQDN kaynağı mevcut local server registry/OS hostname contract'ı ile tutarlı kalsın; ikinci bağımsız hostname authority yaratma.
- [ ] Parent zone/glue/delegation inspector ekle. Registrar kontrolü mümkün değilse exact ns1/ns2 hostname/IP talimatı ve `pending_glue` / `pending_delegation` state göster.
- [ ] Public UDP/TCP 53 reachability ile local socket health'i ayrı state olarak modelle; public probe yapılamıyorsa local health'i public-ready diye gösterme.
- [ ] Authoritative NS setini local zone provisioning ve Zone Template'in tek kaynağı yap; adapter kendi NS değerini uydurmasın.
- [ ] Secondary DNS transfer/notify policy'sini zone lifecycle ve gerçek AXFR/NOTIFY evidence'ına bağla.
- [ ] PowerDNS config/package upgrade/rollback lifecycle'ını durable operation evidence ile transactional hale getir; current source manager failure state verir fakat host-level rollback acceptance henüz yok.

### Host acceptance — `todo.md`

- [ ] Fresh Ubuntu 24.04'te PowerDNS package/backend/config/service/upgrade health geçer.
- [ ] API yalnız loopback'ten erişilir; raw API key public yüzeye sızmaz.
- [ ] Local UDP/TCP 53 probe ve public `dig @ns1` / `dig @ns2` SOA, NS, A authoritative cevapları geçer.
- [ ] Recursion isteği RA=false/REFUSED davranışıyla açık resolver olmadığını kanıtlar.
- [ ] Registrar/glue/delegation uyuşmazlığında state `ready` olmaz.

## P0.3 — Versioned Plesk-style DNS Zone Template ve zone yönetimi

- [ ] `DnsZoneTemplate` modeli: `<domain>`, `<server-ipv4>`, `<server-ipv6>`, `<ns1>`, `<ns2>`, `<mail-host>`, `<webmail-host>`.
- [ ] Yeni local-DNS domain operation evidence'ına template version/snapshot kaydet.
- [ ] Template değişikliği yeni zoneları etkilesin; mevcut zonelara preview + explicit apply gerekir.
- [ ] Record source/ownership metadata: `template`, `mail`, `runtime`, `manual`; manual edit sessizce ezilmesin.
- [ ] PowerDNS zone CRUD: SOA, NS, A, AAAA, CNAME, MX, TXT, CAA, SRV, TTL, serial.
- [ ] Validation: owner/FQDN, CNAME coexistence, MX/SRV priority/weight/port, TXT, apex, wildcard, IDN.
- [ ] DNSSEC enable/disable/key lifecycle + DS output; parent DS yoksa secure delegation gösterme.

### Servis-aware default zone

Her local-DNS Website:

- [ ] SOA
- [ ] apex NS -> ns1
- [ ] apex NS -> ns2
- [ ] apex A -> selected/server IPv4
- [ ] apex AAAA yalnız IPv6 varsa
- [ ] `www` alias/CNAME policy

Local mail açıksa:

- [ ] `mail.<domain>` A/AAAA
- [ ] MX -> `mail.<domain>`
- [ ] `webmail.<domain>` service-aware record
- [ ] SPF
- [ ] DKIM public key
- [ ] DMARC
- [ ] IMAPS/SMTPS SRV yalnız servis gerçekten açıksa
- [ ] autodiscover/autoconfig yalnız gerçek endpoint varsa

FTP:

- [ ] Default `ftp.<domain>` üretme; V1 yalnız OpenSSH SFTP. Gerçek FTP servisi ileride explicit açılırsa template service-aware ekleyebilir.

Kabul:

- [ ] Yeni local-DNS domain tek operation'da default zone alır.
- [ ] Manual record template re-apply sırasında korunur veya explicit conflict olur.
- [ ] Kapalı servis için dead `webmail`/MX/DKIM/discovery record oluşmaz.

## P0.4 — Mail: Postfix + Dovecot + Rspamd + shared Roundcube

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

Roundcube:

- [ ] Sunucu başına tek shared Roundcube + dedicated FPM pool/socket + protected config.
- [ ] Local-mail domain -> `webmail.<domain>` DNS/TLS/Nginx -> shared Roundcube.
- [ ] Full email + password Dovecot IMAP login, authenticated Postfix submission.
- [ ] Domain disable/delete yalnız kendi mapping'ini kaldırır; shared instance başka domainler kullanıyorsa kalır.
- [ ] Gerçek autodiscover/autoconfig endpoint.
- [ ] External DNS domain için exact pending DNS requirements/provider apply.

Kabul gerçek hostta inbound/outbound, relay denial, TLS, DKIM/SPF/DMARC ve multi-domain Roundcube ile yapılır.

## P0.5 — Website DB ownership + phpMyAdmin

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

- [ ] Owner/session authorization + Website scope + short-lived audience token + same-origin proxy + revoke/logout.
- [ ] Vendor admin portları public açılmaz.
- [ ] phpMyAdmin/elFinder token başka Website'e replay edilemez.
- [ ] ttyd on-demand one-shot: site terminali site user/cwd, server terminali Owner root.
- [ ] ttyd acceptance sonrası custom node-pty/xterm backend kaldır.
- [ ] Roundcube Owner panel gateway'ine bağlı değildir; mailbox auth kullanır.

## P0.8 — Transactional Website/domain provisioning

Preflight:

- [ ] FQDN/IDN/duplicate/parent/alias conflict.
- [ ] Runtime, local/external DNS, local/external/disabled mail, DB, IPv4/IPv6, certificate, SFTP preview.
- [ ] Package/service blockers apply öncesi.
- [ ] Exact resource preview.

Apply sırası:

1. [ ] Website/Application/operation reserve.
2. [x] Dedicated Unix user/group + canonical paths.
3. [x] Runtime site UID/GID ile prepare — mevcut static/Passenger/PHP source path'i isolation-aware.
4. [ ] Nginx stage/configtest/activate lifecycle'ını full Website create zincirinde finalize et.
5. [ ] Local DNS ise PowerDNS zone exact template snapshot.
6. [ ] DB seçildiyse scoped DB/user/grant.
7. [ ] Local mail domain + DKIM + DNS intents.
8. [ ] webmail mapping + shared Roundcube.
9. [x] Hosted Website SFTP isolation step durable provisioning planına bağlandı; File Manager/log/cron scope henüz tamamlanmadı.
10. [ ] Certificates.
11. [ ] Cross-service health postconditions.
12. [ ] Mandatory resources health-gated ise `ready`.

Recovery:

- [ ] Her step durable evidence/ownership; restart önce inspect.
- [ ] Failure açık `partial/failed`; sahte ready yok.
- [ ] Retry yalnız failed/unapplied step; revision drift fail-closed.
- [ ] Compensation reverse order ve yalnız operation-owned resource.
- [ ] Atomic config + service configtest before reload.

## P0.9 — Suspend/delete/rollback

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

1. **Website Unix isolation** — source temel büyük ölçüde hazır; independent subdomain, audit API, SFTP key lifecycle ve gerçek host acceptance açık.
2. **PowerDNS + server ns1/ns2** — host manager/secret/local readiness/API production path source-complete; sıradaki aktif iş glue/delegation/public reachability + zone authority entegrasyonu.
3. **Versioned DNS Zone Template**.
4. **Mail + shared Roundcube**.
5. **Database + phpMyAdmin**.
6. **elFinder**.
7. **Transactional create/delete provisioning** parçalarını tek lifecycle'a birleştir.
8. **TLS/autodiscover/recovery hardening**.
9. Runtime migration/backup/monitoring/security/site extras.
10. Legacy cleanup ve en son UI/UX polish.

Her küçük dilim source test kontratıyla ayrı commit edilir. GitHub Actions kullanılmaz. Gerçek Ubuntu/package/public DNS/SMTP/browser/provider acceptance bu ortamda yapılamıyorsa `todo.md`'ye bırakılır ve ilgili P0 kapısı host acceptance geçmeden `DONE` olmaz.
