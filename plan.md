# YunPanel — Plesk Referanslı Kalan Geliştirme Planı

Bu dosya **yalnız kalan ürün/kod işlerini** tutar. Yapılmış işlerin ayrıntılı geçmişi `docs/history/`, hedef mimari `docs/architecture.md`, recovery sözleşmesi `docs/provisioning-recovery.md`, bağlayıcı kurallar `agents.md`, gerçek Ubuntu/browser/provider kabul testleri `todo.md` içindedir.

Son Website isolation/SFTP ilerlemesi: `docs/history/website-isolation-sftp-progress-2026-09-17.md`.

## 0 — Değiştirilemez ürün kararı

- YunPanel hosting davranışında Plesk Obsidian referanstır; Plesk'in iç implementasyonu kopyalanmaz.
- Hazır ve olgun servis varken File Manager, terminal, database client, authoritative DNS, webmail, monitoring veya backup motoru yeniden yazılmaz.
- Ana hazır servisler: PowerDNS Authoritative, Postfix, Dovecot, Rspamd, Roundcube, MariaDB/MySQL, phpMyAdmin, elFinder, OpenSSH internal-sftp, ttyd, Nginx, PHP-FPM, Passenger, restic/rclone, Netdata, GoAccess, CrowdSec.
- Her bağımsız Website dedicated Unix user/group alır. `shared-site` açıkça seçilmedikçe domain/subdomain başka Website'in OS kimliğini paylaşmaz.
- Roundcube domain başına kurulmaz; tek shared instance `webmail.<domain>` DNS/TLS/Nginx mapping'leriyle kullanılır.
- Nginx shared kalır; PHP site başına PHP-FPM pool/socket, Node Passenger `passenger_user/group`, static site site-owned private publish tree + yalnız Nginx read ACL kullanır.
- Homegrown `site-file-manager`, custom node-pty terminal ve benzeri yüzeyler yalnız hazır replacement acceptance geçene kadar migration fallback'idir; genişletilmez.
- Ekran/model/route varlığı özellik tamamlandı anlamına gelmez. Gerçek servis, izolasyon, lifecycle, health ve failure/recovery acceptance geçmeden `DONE` denmez.

# P0 — Plesk core parity

## P0.1 — Website Unix identity ve filesystem isolation

- [ ] Isolation migration apply ayrı exact-change preview/digest + typed-confirmation operation olsun; yalnız operation-owned değişiklikleri uygulayıp geri alabilsin ve kör recursive `chown` yapmasın.
- [ ] Legacy Website migration apply önce canonical Unix identity/path/runtime/SFTP drift raporu ve exact değişiklik preview'sı versin; operation-owned olmayan dosya/user/runtime üzerinde destructive ownership repair yapmasın.

Gerçek Ubuntu isolation/SFTP kabul kapıları `todo.md` içindedir.

## P0.2 — Sunucu kimliği, ns1/ns2 ve PowerDNS Authoritative

- [ ] Durable PowerDNS journal için operator-visible recovery/control surface tamamla: current/latest operation state, recovery reason, inspect evidence, explicit retry/rollback/resolve aksiyonları, destructive aksiyonlarda typed confirmation + audit.
- [ ] `recovery_pending` durumunda hiçbir package/config/service mutation'ı kör replay edilmesin.

Gerçek host, public DNS, delegation/glue ve browser kabul kapıları `todo.md` içindedir.

## P0.3 — Versioned DNS Zone Template ve Domain DNS yönetimi

- [ ] Local mail lifecycle tamamlanınca mail capability/DKIM public-key intent'ini zone lifecycle'a bağla; re-apply `mail` source'u desired state ile güvenle reconcile etsin; kapalı servis dead mail/webmail/SRV/discovery kaydı üretmesin.
- [ ] `autodiscover` / `autoconfig` yalnız gerçek endpoint hazır olduğunda service-aware DNS desired state'e girsin.
- [ ] DNSSEC key rollover/rotation lifecycle ekle: yeni KSK/CSK üret/publish/activate, parent DS propagation doğrula, eski DS retirement doğrula, eski key deactivate/delete; rollover sırasında secure delegation kesilmesin ve private key public state/job/audit'e çıkmasın.
- [ ] Zone suspend/delete/compensation ownership evidence'ını P0.9 lifecycle'ına bağla; manual kayıt içeren zone destructive cleanup'ta fail-closed kalsın.

Gerçek PowerDNS, resolver, registrar ve browser kabul kapıları `todo.md` içindedir.

## P0.4 — Mail: Postfix + Dovecot + Rspamd + shared Roundcube

- [ ] `MAIL_CONFIG_APPLY` / `MAIL_CONFIG_ROLLBACK` durable job execution zincirini production worker'a bağla: claim/lease/restart semantics, staging manager + activator + validators + backup/rollback, readiness evidence, inspect/reconcile ve replay fence.
- [ ] SQL-backed virtual mail domain/mailbox/alias/quota/password-hash modeli ekle; Website user ile mail storage identity ayrı olsun.
- [ ] Dedicated mail storage identity kullan; Website UID Maildir owner olmasın.
- [ ] Local mail enable domain oluştursun fakat bilinen/default parola mailbox yaratmasın.
- [ ] SMTP 25 + submission 587; 465/993 policy; plain auth yalnız TLS altında.
- [ ] DKIM key lifecycle; private key secret-safe, public key DNS intent.
- [ ] SPF/DMARC/DKIM desired state'i mail operation evidence'ına bağla.
- [ ] Sender-login/relay/rate abuse/Rspamd policy tamamla.
- [ ] Forwarding/alias/SRS lifecycle tamamla.
- [ ] ClamAV optional profile; health yoksa aktif gösterme.
- [ ] Sunucu başına tek shared Roundcube + dedicated FPM pool/socket + protected config.
- [ ] Local-mail domain -> `webmail.<domain>` DNS/TLS/Nginx -> shared Roundcube mapping'i.
- [ ] Full email + password Dovecot IMAP login ve authenticated Postfix submission.
- [ ] Domain disable/delete yalnız kendi Roundcube/webmail mapping'ini kaldırsın; shared instance başka domainler kullanıyorsa kalsın.
- [ ] Gerçek autodiscover/autoconfig endpoint.
- [ ] External DNS domain için exact pending DNS requirements/provider apply.

Gerçek inbound/outbound SMTP, IMAP, Roundcube ve anti-abuse kabul kapıları `todo.md` içindedir.

## P0.5 — Website DB ownership + phpMyAdmin

- [ ] MariaDB/MySQL secure install/health baseline; admin secret encrypted store.
- [ ] DB Website'e explicit bağlı; deterministic unique DB/user naming.
- [ ] Site DB user yalnız bağlı schema'larda grant alır; `*.*` yok.
- [ ] Site Databases CRUD + rotate/revoke + drop preview.
- [ ] Website create'te opsiyonel initial DB.
- [ ] Shared hardened phpMyAdmin.
- [ ] `Open phpMyAdmin` site DB user scope'uyla supported signon/short-lived handoff; root browser'a verilmesin.
- [ ] Import/export/dump vendor tooling.
- [ ] DB create/drop/grant/rotation durable evidence/rollback.

## P0.6 — elFinder; homegrown File Manager removal

- [ ] elFinder shared app/client.
- [ ] Connector gerçek Website UID/GID altında çalışsın; preferred site PHP-FPM pool/socket.
- [ ] Root canonical Website HOME/SFTP root'tan server-side resolve edilsin.
- [ ] Session -> short-lived audience-bound Website token.
- [ ] Upload/download/edit/rename/move/copy/delete/mkdir/archive via elFinder.
- [ ] Traversal/symlink/archive escape/special file/secret/cross-site testleri.
- [ ] Vendor endpoint public bypass olmasın.
- [ ] Acceptance sonrası custom `site-file-manager` kaldır.
- [ ] elFinder site-UID acceptance vermezse homegrown'a dönme; Filestash + localhost SFTP değerlendir.

## P0.7 — IntegratedToolGateway

- [ ] Owner/session authorization + Website scope + short-lived audience token + same-origin proxy + revoke/logout.
- [ ] Vendor admin portları public açılmasın.
- [ ] phpMyAdmin/elFinder token başka Website'e replay edilemesin.
- [ ] ttyd on-demand one-shot: site terminali site user/cwd, server terminali Owner root.
- [ ] ttyd acceptance sonrası custom node-pty/xterm backend kaldır.
- [ ] Roundcube Owner panel gateway'ine bağlı olmasın; mailbox auth kullansın.

## P0.8 — Transactional Website/domain provisioning

### Preflight

- [ ] FQDN/IDN/duplicate/parent/alias conflict preflight'ini final create flow'da birleştir.
- [ ] Runtime, local/external DNS, local/external/disabled mail, DB, IPv4/IPv6, certificate ve SFTP intent'lerini tek preview'da göster.
- [ ] Package/service blocker'larını apply öncesi doğrula.
- [ ] Exact resource preview üret.

### Apply

- [ ] Website/Application/operation reserve lifecycle'ını finalize et.
- [ ] Nginx stage/configtest/activate lifecycle'ını full Website create zincirinde finalize et.
- [ ] DB seçildiyse scoped DB/user/grant step'i bağla.
- [ ] Local mail domain + DKIM + DNS intent step'ini bağla.
- [ ] `webmail.<domain>` mapping + shared Roundcube step'ini bağla.
- [ ] Certificate step'ini bağla.
- [ ] Cross-service health postcondition'larını bağla.
- [ ] Mandatory resource'lar health-gated olmadan Website `ready` olamasın.

### Recovery

- [ ] Her step durable evidence/ownership tutsun; restart önce inspect yapsın.
- [ ] Failure açık `partial/failed`; sahte ready olmasın.
- [ ] Retry yalnız failed/unapplied step; revision drift fail-closed.
- [ ] Compensation reverse order ve yalnız operation-owned resource.
- [ ] Atomic config + service configtest before reload.

## P0.9 — Suspend/delete/rollback

- [ ] Suspend data silmeden web/runtime erişimini durdursun.
- [ ] Domain remove ve Website delete ayrı operation olsun.
- [ ] Delete impact tüm Unix/runtime/Nginx/cert/DNS/mail/DB/SFTP/log/backup bağımlılıklarını göstersin.
- [ ] Mail/DB/file deletion typed confirmation + retention.
- [ ] Reverse dependency cleanup ownership evidence ile yapılsın.
- [ ] Partial deletion retryable state bıraksın.

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
- [ ] CrowdSec engine/bouncer; duplicate Fail2ban authority olmasın.

## P1.4 — Site features/settings

- [ ] Site-user cron/timer CRUD.
- [ ] WP-CLI site user.
- [ ] Composer site user.
- [ ] Redis/Memcached isolation policy.
- [ ] Settings ekranlarını gerçek backend state'iyle tamamla.

# P2 — Migration temizliği ve son ürün yüzeyi

- [ ] elFinder acceptance sonrası custom `site-file-manager` kaldır.
- [ ] ttyd acceptance sonrası custom node-pty terminal kaldır.
- [ ] Passenger acceptance sonrası direct-systemd yalnız legacy migration adapter'ı olarak kalsın; migration sonunda kaldır.
- [ ] restic acceptance sonrası custom backup archive yollarını kaldır.
- [ ] Agentless local backend acceptance sonrası retained legacy agent transport/package/state kaldır.
- [ ] Plesk read-only importer en son: Website/Domain/identity/runtime/DB/DNS/mail/cron/cert/backup preview.
- [ ] Backend/functionality tamamlandıktan sonra enterprise UI/UX polish.

# Uygulama sırası — blocker yoksa sapma yok

1. **Website Unix isolation** — isolation migration apply ve legacy migration hardening.
2. **PowerDNS operator recovery** — durable journal status/evidence, explicit retry/rollback/resolve, typed confirmation ve fail-closed recovery control surface.
3. **Mail durable execution** — `MAIL_CONFIG_APPLY/ROLLBACK` production worker/executor wiring, readiness evidence ve replay-safe recovery.
4. **Versioned DNS Zone Template** — mail source entegrasyonu, autodiscover endpoint gate, DNSSEC rollover, zone suspend/delete ownership.
5. **Database + phpMyAdmin**.
6. **elFinder**.
7. **Transactional create/delete provisioning** parçalarını tek lifecycle'a birleştir.
8. **TLS/autodiscover/recovery hardening**.
9. Runtime migration/backup/monitoring/security/site extras.
10. Legacy cleanup ve en son UI/UX polish.

Her küçük dilim source test kontratıyla ayrı commit edilir. GitHub Actions kullanılmaz. Gerçek Ubuntu/package/public DNS/SMTP/browser/provider acceptance bu ortamda yapılamıyorsa `todo.md`'ye bırakılır ve ilgili P0 kapısı acceptance geçmeden `DONE` olmaz.
