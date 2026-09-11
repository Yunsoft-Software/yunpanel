# YunPanel — Kalan Geliştirme Planı

Bu dosyada yalnız **kalan kod/geliştirme işleri** tutulur. Tamamlanan işler Git geçmişinde kalır; gerçek Node 24, browser, Ubuntu, package, DNS ve canlı rollback kabulü `todo.md` içindedir. Bağlayıcı kurallar `agents.md`, agentless güvenlik/migration prosedürleri `docs/local-executor-safety.md` ve `docs/local-runtime-migration.md` içindedir.

Doğrudan güncel `main` üzerinde küçük, tek amaçlı commitlerle ilerle. GitHub Actions kullanma. Çalıştırılmayan testi geçmiş sayma.

**2026-09-10 kararı:** Görsel UI/UX, layout, styling, component polish ve responsive tasarım bu akışta donduruldu. Backend functionality tamamlandıktan sonra ayrı modele verilecek. Güvenlik veya backend kontratı için zorunlu olmadıkça `apps/web` tasarımına dokunma.

## B. P1 — Agentless yerel backend geçişinde kalan kod

- [ ] Gerçek migration + rollback kabulü tamamlandıktan sonra retained legacy heartbeat/command/environment/result transport rotalarını, agent credential surface'ini ve eski enrolled-host compatibility kodunu kaldır.
- [ ] Aynı kabul sonrası `yun-agent.service`, agent package/env/install compatibility ve artık gereksiz registry credential alanlarını kaldır. Upgrade disabled agent'ı tekrar enable etmemeli.
- [ ] Yeni site yüzeylerinde workload isolation invariantını koru: Git hook, cron ve site terminali dedicated `yunapp-*` kullanıcıyla; yalnız Owner Server terminali root.
- [ ] Migration live-apply katmanını yalnız gerçek test-host kabulünden sonra aç: staged tree'den per-target replacement, owner/mode/ACL/xattr policy, `yunapp-*` identity drift çözümü, pre-apply backup, health validation ve deterministic rollback. `/etc/passwd` veya `/etc/group` kör overwrite edilmez.

## C. P1 — Kalıcı Website modeli ve domain yaşam döngüsü

Kalıcı Website registry/API/persistence, revisioned update/rebind impact akışı, explicit Domain `websiteId`, Website/Application startup foreign-key doğrulaması, IDN→punycode canonicalization, explicit Website→Domain read, read-only migration preview, deterministic preview digest, durable ve tekrar çalıştırılabilir Website-create/bind migration'ı, guarded site-create orchestration'ı, fail-closed Website/Domain move-delete impact preview'ı, migration-only binding rollback ledger'ı ve persistent compatibility/enforced policy status/finalize/rollback source seviyesinde mevcut. Site-create existing/new static/Node ve external proxy kaynaklarını, backend-managed portu, explicit `www` alias/child seçimini, stale preview korumasını ve kesinti sonrası deterministic devamı kapsar; Docker target dürüstçe deferred kalır. DNS hosting ve mail-domain ayrı kalıcı kimlik/lifecycle kayıtlarıdır; DNS yalnız açık `external/unverified`, mail ise açık `external/unverified` veya yan etkisiz `local/disabled` olarak başlar. İsteğe bağlı web Domain ilişkisi exact tutulur ve Website/hostname create bunları örtülü üretmez. Move-delete preview child/linked Domain, Website/Application, DNS zone, mail-domain, mailbox, certificate ve aktif job durumunu gerçek kaynaklardan listeler; backup/cron association registry'leri gelene kadar unavailable blocker üretir ve apply/cascade sunmaz. Enforced policy yeni managed domainlerde explicit Website binding ister; legacy state compatibility rollback için okunabilir kalır.

## D. DEFERRED — Görsel UI/UX

Aktif geliştirme dışı. Enterprise layout/component styling/data-table görünümü/skeleton/notification/responsive polish/typography/site-detail görsel düzeni en sonda ayrı modele verilecek.

## E. P2 — Node.js, static ve Git functionality

Node runtime major/startup/package-manager/mode/document-root ayarları revisioned preview/apply ile yönetilir; çalışan release ayrı `activeRuntime` snapshot'ını korur. Explicit systemd enable/disable/start/stop aktif release'e bağlı, onaylı durable job'dur ve kesinti sonrası exact intent + host final-state kanıtıyla kurtarılır. Host Node 22/24 LTS inventory/install ayrı managed dizinlerde checksum doğrulamalı ve atomiktir; Application `nodeMajor` seçimi deploy/systemd/build PATH'ini aynı site runtime'ına bağlar, panelin `/usr/local/bin/node` runtime'ını değiştirmez. Mevcut deploy/restart/status/rollback akışları korunur.

Git deploy branch/tag/full commit hedefini explicit ve bounded job metadata'sı olarak taşır; host exact ref'i site kullanıcısıyla fetch eder, commit hedefi farklı SHA'ya çözülürse fail-closed kalır ve seçilen hedef release geçmişine yazılır.
Private GitHub token veya unencrypted SSH deploy key mevcut master-key kasasında Application'a özel şifrelenir; normal env, generic job/recovery/result/audit ve build lifecycle ortamına girmez. Token fixed askpass ile, SSH key strict known-host doğrulaması ve fetch sonrası silinen `0600` geçici dosyayla yalnız site kullanıcısının Git clone/fetch işleminde materialize edilir.
Signed GitHub webhook exact raw-body HMAC, repository/configured-branch/full-commit doğrulamasıyla aynı durable deploy kuyruğunu kullanır. Delivery UUID private job idempotency state'idir; restart sonrası replay aynı job'a döner ve kalıcı resource lock aynı Application'daki eşzamanlı işleri engeller. GitHub Actions kullanılmaz.
Application environment katı ve bounded `.env` merge/replace import, optimistic revision, change count/timestamp metadata'sı ve explicit `saved_on_disk` / `applied_to_running_process` durumunu taşır. Node deploy/restart/rollback yalnız kuyruğa alınan exact env revision'ını materialize eder; successful reconciliation aynı release/revision çiftini applied işaretler, secret değerler job/result/audit'e girmez.
Owner-only local log backend Node journalını, allowlist'li systemd unitlerini, Nginx access/error dosyalarını ve job'a özel deploy çıktısını bounded/redacted okur. Exact query alanları zaman/seviye/arama filtresi ve source-specific cursor paging taşır; JSON, finite NDJSON snapshot ve text download verir. Keyfi unit/path, remote legacy host ve Read Only erişimi kapalıdır; deploy store job başına/global retention sınırlarıyla private modda kalır.
Static/SPA trafiği explicit Domain `spaFallback` state'iyle canonical static Application/Website köküne bağlıdır. Docker Website hedefi ayrı private workload registry kimliğini, same-server loopback endpointini, unique binding'i, revisioned Website update'i, guarded site-create akışını ve impact envanterini taşır; şimdilik yalnız açık `external/unverified` tracking sunar ve container lifecycle sonucu iddia etmez. Passenger yeni runtime değildir; yalnız legacy host discovery/ilerideki Plesk importer compatibility yüzeyinde kalır. Managed Docker/Compose lifecycle işi I bölümündedir.

## H. P2 — Mail ve Roundcube

- [ ] Postfix managed-set staging/parameter integration/apply/test/rollback; Dovecot managed config staging/apply/test/rollback; Rspamd managed config staging/apply/test/rollback; Roundcube için Nginx/PHP-FPM/veritabanı yapılandırma ve geri alma akışı.
- [ ] Mail-domain enable/disable, mailbox CRUD, password rotation, quota/usage, alias/forwarding lifecycle.
- [ ] MX/SPF/DKIM/DMARC/PTR expected-current-action-needed diagnostics.
- [ ] SMTP/IMAP TLS, queue ve bounded logs; open relay fail-closed.
- [ ] Roundcube webmail endpoint/health; panel session ve mailbox credentials ayrı kalmalı.
- [ ] Mailbox/domain delete impact ve mail data backup/restore.

## I. P2/P3 — Kalan operasyon modülleri

- [ ] DB: Website/site binding, DB user CRUD, grants, password rotation, connection info, dump/restore ve minimum-privilege application user. Credentials encrypted store'dan execution-time materialize edilmeli.
- [ ] Docker/Compose: validation, build/pull/start/stop/restart, env/registry credentials, logs/health, Website/Nginx target, deploy history, volume/bind inventory + backup policy.
- [ ] Genel backup ürünü: encrypted app/config/env/DB/volume/mail backup, local/S3-compatible target, retention/checksum, restore preview/progress, pre-restore backup ve failure rollback. Migration snapshot mekanizması bunun yerine kullanılmaz.
- [ ] Cron: site user/cwd/env/timezone/enable-disable/last-run/bounded output; system cron yalnız explicit Owner/Server context.
- [ ] Metric history, inode/disk threshold, service/app events, deploy/backup/SSL notifications ve bounded log download.
- [ ] Job detail backend: stage/progress, resource link, safe error/log metadata, search/filter ve yalnız idempotency+lock ile güvenli retry.
- [ ] Plesk read-only importer + external-managed state; Passenger/static/Node/DB/Docker/domain/cron/mail migration ve per-resource rollback.

## J. P0–P3 — Test, migration ve yayın kod işleri

- [ ] Yeni Website/migration/resource/terminal/secret yüzeyleri geldikçe native/process/source parity testleri ekle.
- [ ] Agentless package upgrade/schema migration/PTY dependency/restart reconciliation/job-running self-update/disk-full rollback senaryolarını tamamla.
- [ ] Migration kabulünden sonra install/package/docs/registry'deki retained agent varsayımlarını aynı değişimle temizle.
- [ ] `todo.md` kabulü tamamlanmadan production-ready etiketi verme.

**Uygulama sırası:** A'da dış ortama bağlı olmayan güvenlik işi → B'de kabul beklemeyen agentless iş → C Website/domain modeli → E/F/G günlük hosting functionality → H mail → I kalan modüller → en son D görsel UI/UX.
