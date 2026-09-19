# YunPanel — Plesk Referanslı Kalan Geliştirme Planı

Bu dosya **yalnız kalan ürün/kod işlerini** tutar. Yapılmış işlerin ayrıntılı geçmişi `docs/history/`, hedef mimari `docs/architecture.md`, recovery sözleşmesi `docs/provisioning-recovery.md`, bağlayıcı kurallar `agents.md`, gerçek Ubuntu/browser/provider kabul testleri `todo.md` içindedir.

Son Website isolation/SFTP ilerlemesi: `docs/history/website-isolation-sftp-progress-2026-09-17.md`.
Son mail durable apply/recovery ilerlemesi: `docs/history/mail-durable-apply-recovery-2026-09-17.md`.
Son local PowerDNS DKIM retirement ilerlemesi: `docs/history/dns-local-dkim-retirement-2026-09-17.md`.
Son mail discovery DNS gate ilerlemesi: `docs/history/dns-mail-discovery-gate-2026-09-17.md`.
Son DNSSEC rollover adapter ilerlemesi: `docs/history/dnssec-rollover-progress-2026-09-17.md`.
Son DNS zone compensation ownership ilerlemesi: `docs/history/dns-zone-compensation-ownership-2026-09-17.md`.
Son database canlı envanter ilerlemesi: `docs/history/database-live-inventory-2026-09-17.md`.
Son database güvenlik ve Website resource ilerlemesi: `docs/history/database-security-baseline-2026-09-17.md`, `docs/history/database-website-resources-2026-09-17.md`.
Son phpMyAdmin managed-package ilerlemesi: `docs/history/phpmyadmin-package-baseline-2026-09-17.md`.
Son phpMyAdmin protected signon/gateway ilerlemesi: `docs/history/phpmyadmin-signon-handoff-progress-2026-09-18.md`.
Son phpMyAdmin browser handoff UI ilerlemesi: `docs/history/phpmyadmin-browser-handoff-2026-09-18.md`.
Son Website database data scope ilerlemesi: `docs/history/database-website-data-scope-2026-09-18.md`.
Son Website database delete lifecycle ilerlemesi: `docs/history/database-delete-lifecycle-2026-09-18.md`.
Son elFinder scoped handoff/FPM ilerlemesi: `docs/history/elfinder-scoped-handoff-progress-2026-09-18.md`.
Son ttyd/IntegratedToolGateway ilerlemesi: `docs/history/ttyd-integrated-gateway-progress-2026-09-18.md`.
Son Domain suspension ve DNS retirement ilerlemesi: `docs/history/domain-suspension-dns-retirement-progress-2026-09-18.md`.
Son Domain removal continuation ilerlemesi: `docs/history/domain-removal-continuation-progress-2026-09-19.md`.
Son Domain removal authoritative DNS child-operation ilerlemesi: `docs/history/domain-removal-authoritative-dns-progress-2026-09-19.md`.
Son Domain removal child Domain orchestration ilerlemesi: `docs/history/domain-removal-child-domain-progress-2026-09-19.md`.
Son Domain removal child authoritative DNS ilerlemesi: `docs/history/domain-removal-child-dns-progress-2026-09-19.md`.
Son Domain removal certificate retirement ilerlemesi: `docs/history/domain-removal-certificate-progress-2026-09-19.md`.
Son Domain removal Mail Domain intent ilerlemesi: `docs/history/domain-removal-mail-intent-progress-2026-09-19.md`.
Son Domain removal Mail Domain parent-handler ilerlemesi: `docs/history/domain-removal-mail-parent-handler-progress-2026-09-19.md`.
Son Domain removal Mail Domain child-registry ilerlemesi: `docs/history/domain-removal-mail-child-registry-progress-2026-09-19.md`.
Son Passenger/provisioning canlı kabulü: `docs/history/passenger-provisioning-live-acceptance-2026-09-19.md`.

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

## P0.3 — Versioned DNS Zone Template ve Domain DNS yönetimi

Kaynakta authoritative zone retirement impact, exact provisioning-origin ownership evidence, explicit snapshot retention policy, private retained snapshot journal, exact snapshot-bound PowerDNS delete primitive ve inspect-only restart recovery hazırdır. Durable DNS retirement service/runtime production API bootstrap'ında tek shared instance olarak root-private operation store ile initialize edilir. Domain removal parent journal'ının `authoritative_dns` step'i exact zone snapshot + ownership evidence + retention policy kimliğini pinleyerek bu runtime'ı private child operation olarak kullanır; startup child mutation'ı replay etmez. Standalone destructive DNS delete route'u özellikle açılmadı ve full public Domain delete apply yüzeyi henüz yoktur.

- [ ] DNSSEC açık zone deletion'da parent DS retirement/propagation tamamlanmadan destructive PowerDNS step'ini açma.

Gerçek PowerDNS, resolver, registrar ve browser kabul kapıları `todo.md` içindedir.

## P0.4 — Mail: Postfix + Dovecot + Rspamd + shared Roundcube

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

## P0.6 — elFinder; homegrown File Manager removal

Kaynak kod tarafındaki shared vendor package, hardened connector, per-Website FPM materialization, private Nginx gateway, Owner handoff/session bridge ve Files UI wiring tamamlandı. Gerçek Ubuntu/browser/filesystem isolation kabul kapıları `todo.md` T-TOOLS altındadır.

- [ ] T-TOOLS elFinder kabulü geçtikten sonra custom `site-file-manager` HTTP/worker/backend/UI fallback yollarını kaldır; package upgrade/rollback'te orphan session/process bırakma.
- [ ] elFinder site-UID acceptance gerçek hostta başarısız olursa homegrown'a dönme; Filestash + localhost SFTP alternatifini ayrı adapter olarak değerlendir.

## P0.7 — IntegratedToolGateway

Kaynak kod tarafında reusable phpMyAdmin/elFinder/ttyd gateway descriptor sözleşmesi, session-bound ttyd access gate, masked distro ttyd runtime, on-demand one-shot Unix-socket sessions, Website UID/GID drop, same-origin HTTP/WebSocket proxy, 15 saniyelik live reauthorization, Owner-bound explicit close ve ttyd-primary Terminal UI tamamlandı. Gerçek Ubuntu/browser/TUI kabul kapıları `todo.md` T-TOOLS altındadır.

- [ ] T-TOOLS ttyd kabulü geçtikten sonra custom `node-pty` process manager, legacy `/api/terminal` WebSocket transport, embedded xterm fallback ve native node-pty package/build bağımlılığını kaldır; package upgrade/rollback ve açık session cleanup'ını doğrula.
- [ ] Roundcube Owner panel gateway'ine bağlı olmasın; shared webmail yüzeyi mailbox auth kullansın.

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

Domain-level web traffic suspend/resume source lifecycle tamamlandı: exact Nginx checksum-bound deactivation receipt, explicit `suspended` Domain state, durable suspend→resume operation, typed preview/retry/resume confirmation, restart inspect-only reconciliation ve failure compensation kaynakta vardır. Exact suspended revision/checksum/operation evidence altında Website ve certificate binding'lerini idempotent detach eden removal primitive'leri ile child/Website/certificate dependency kalmadığında typed confirmation isteyen Domain metadata finalization primitive'i de kaynakta hazırdır. Domain delete tarafında resource-impact digest + exact Domain revision/checksum + dependency kimliklerini pinleyen side-effect-free removal planı, root-private durable parent operation journal'ı, deepest-first descendant sırası ve ilk `routing_suspend` step'inin mevcut durable DomainSuspensionRuntime child operation'ına bağlanması kaynakta eklendi. Parent plan her descendant'ın exact server/parent/hostname/Website/certificate/state/revision/checksum/suspension intent'ine ek olarak child-specific authoritative DNS preview/snapshot/ownership/retention intent'ini pinler. `child_domain` step'i yalnız parent-owned durable child removal operation yaratır; explicit parent continuation başına tek child adımı ilerletir, Website detach sonrasında child local zone'u aynı private DNS retirement runtime'ıyla kaldırır, completed child evidence'ını reconcile eder ve restartta child veya DNS mutation replay etmez. Eksik affected-Domain DNS impact coverage, unpinned dependency ya da child DNS policy/ownership/snapshot drift'i mutation öncesi fail-closed kalır. Journal'ın Website binding, authoritative DNS ve son Domain metadata step'leri exact suspension/ownership/policy evidence, step/revision-bound typed continuation ve inspect-only restart recovery ile çalışır; completed child/postcondition mutation replay edilmeden kapanır, incomplete child explicit continuation bekler. Certificate step'i artık affected root/descendant certificate state/source/renewal/validity/update intent'ini journal'a pinler; parent descendant certificate'ı duplicate etmeden child operation'a bırakır, exact suspended binding'i detach eder ve registry kaydını aynı operation sahibi immutable `retired` state'e geçirerek otomatik renewal'ı durdurur. Restart exact retirement evidence'ını mutation replay etmeden kapatır; incomplete veya drifted state explicit continuation/fail-closed kalır. ACME/custom certificate materyali bilinçli olarak korunur ve henüz tanımlanmamış retention/GC lifecycle'ına bırakılır. Mail Domain dependencies de exact id/domainName/webDomain/managementMode/status/revision/update intent'iyle pinlenir; descendant mail intent'i yalnız exact child plan subset'ine devredilir ve eksik/drifted child preview mutation öncesi bloklanır. Parent `mail_domain` step handler'ı exact parent-owned child preview/operation kimliğini doğrular; local sonuçta disable/config job'ını gerektiğinde, verified data-delete job ve backup kimliğini her durumda zorunlu kılar, external sonucu ise ayrı metadata-unlink yöntemiyle ve yerel job kanıtı olmadan kabul eder. Restart completed child evidence'ını mutation replay etmeden kapatır; incomplete child yalnız typed explicit continuation ile child retry'a döner. Root-private durable Mail Domain child registry de `pending → disabling → cleaning → deleting_data → finalizing → removed` fazlarını, source revision ve exact config/cleanup/backup/data-delete kanıtlarını atomik olarak saklar; external akış yalnız `pending → finalizing → removed` ve metadata-unlink kanıtını kabul eder. Gerçek Mail Domain child orchestrator/runtime ve production wiring henüz hazır olmadığından parent handler dependency yokken fail-closed kalır. Mail child runtime ve external-DNS destructive handler'ları tamamlanmadan bu journal full delete orchestrator veya public delete apply yüzeyi sayılmaz.

- [ ] Website-wide suspend tüm bağlı Domain route'larını ve seçilen runtime/process erişimini operation-owned tek lifecycle'da durdursun; bir Domain suspend başarısızsa partial state/retry açık kalsın.
- [ ] Domain removal parent journal'ındaki kalan webmail/mail/external-DNS lifecycle'larını tamamla. Hazır durable Mail Domain child registry'yi kullanan orchestrator/runtime'ı parent `mail_domain` handler sözleşmesine bağla: local akışta config disable, mailbox/alias/DKIM/webmail cleanup, verified backup-bound data delete ve finalization; external akışta provider ownership sınırını aşmadan metadata unlink. Hazır deepest-first child operation → certificate registry retirement → Website binding detach → authoritative DNS retirement → metadata finalization zincirini yalnız önceki dependency evidence tamamlandıktan sonra çalıştır; gerçek child/external-DNS lifecycle olmadan step'i başarılı sayma ve standalone authoritative DNS delete route'u açma.
- [ ] Retired ACME/custom certificate materyali için paylaşım/ownership-aware retention ve GC lifecycle'ı tanımla; registry retirement'ı fiziksel silme sayma, aktif veya başka Domain tarafından kullanılan materyali kaldırma.
- [ ] Mevcut delete impact graph'ında henüz unavailable/eksik kalan Unix/runtime/DB/SFTP/log/backup bağımlılık provider'larını tamamla; parent removal preview bunların tamamını operation intent'ine pinlemeden public apply açma.
- [ ] Domain delete reverse order: routing suspend/deactivate → certificate/webmail/mail/external-DNS bağımlılıkları → authoritative DNS retirement → Domain metadata finalization. Her destructive step operation-owned evidence kullansın.
- [ ] Website delete bağlı Domain delete operation'ları bitmeden Website/Application/Unix/runtime/file cleanup'a geçmesin.
- [ ] Mail/DB/file deletion typed confirmation + retention ve mevcut backup evidence zincirlerini üst delete operation'a bağla.
- [ ] Partial deletion retryable state bıraksın; restart hiçbir destructive step'i kör replay etmesin.

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

1. **Domain/Website delete orchestrator** — hazır Domain suspend/resume, authoritative DNS retirement, resource-impact, mail/DB delete safety ve ownership evidence parçalarını reverse-order durable P0.9 lifecycle'a bağla.
2. **Mail core parity** — SQL-backed virtual domain/mailbox/alias/quota/storage identity, authenticated SMTP/IMAP, DKIM/SPF/DMARC policy ve shared Roundcube/webmail lifecycle'ını tamamla.
3. **Transactional create/delete provisioning** — Website/Domain/runtime/DNS/mail/DB/certificate/SFTP adımlarını tek durable lifecycle ve reverse-order compensation zincirine birleştir.
4. **TLS/autodiscover/recovery hardening** ve cross-service health kapıları.
5. Runtime migration/backup/monitoring/security/site extras.
6. Legacy cleanup ve en son UI/UX polish.

Her küçük dilim source test kontratıyla ayrı commit edilir. GitHub Actions kullanılmaz. Gerçek Ubuntu/package/public DNS/SMTP/browser/provider acceptance bu ortamda yapılamıyorsa `todo.md`'ye bırakılır ve ilgili P0 kapısı acceptance geçmeden `DONE` olmaz.
