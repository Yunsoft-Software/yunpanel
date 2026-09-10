# YunPanel — Kalan Geliştirme Planı

Bu dosyada yalnız **kalan kod/geliştirme işleri** tutulur. Tamamlanan işler Git geçmişinde kalır; gerçek Node 24, browser, Ubuntu, package, DNS ve canlı rollback kabulü `todo.md` içindedir. Bağlayıcı kurallar `agents.md`, agentless güvenlik/migration prosedürleri `docs/local-executor-safety.md` ve `docs/local-runtime-migration.md` içindedir.

Doğrudan güncel `main` üzerinde küçük, tek amaçlı commitlerle ilerle. GitHub Actions kullanma. Çalıştırılmayan testi geçmiş sayma.

**2026-09-10 kararı:** Görsel UI/UX, layout, styling, component polish ve responsive tasarım bu akışta donduruldu. Backend functionality tamamlandıktan sonra ayrı modele verilecek. Güvenlik veya backend kontratı için zorunlu olmadıkça `apps/web` tasarımına dokunma.

## A. P0 — Authentication ve erişim sınırı

- [ ] WebSocket/SSE/PTY geldiğinde HTTP ile aynı session/role/Origin/Owner-MFA sınırını ortak revocation kanalına bağla; logout, password/MFA/role değişimi ve user disable/delete açık bağlantıları kapatsın.

## B. P1 — Agentless yerel backend geçişinde kalan kod

- [ ] Gerçek migration + rollback kabulü tamamlandıktan sonra retained legacy heartbeat/command/environment/result transport rotalarını, agent credential surface'ini ve eski enrolled-host compatibility kodunu kaldır.
- [ ] Aynı kabul sonrası `yun-agent.service`, agent package/env/install compatibility ve artık gereksiz registry credential alanlarını kaldır. Upgrade disabled agent'ı tekrar enable etmemeli.
- [ ] Yeni site yüzeylerinde workload isolation invariantını koru: Git hook, cron ve site terminali dedicated `yunapp-*` kullanıcıyla; yalnız Owner Server terminali root.
- [ ] Migration live-apply katmanını yalnız gerçek test-host kabulünden sonra aç: staged tree'den per-target replacement, owner/mode/ACL/xattr policy, `yunapp-*` identity drift çözümü, pre-apply backup, health validation ve deterministic rollback. `/etc/passwd` veya `/etc/group` kör overwrite edilmez.

## C. P1 — Kalıcı Website modeli ve domain yaşam döngüsü

Kalıcı Website registry/API/persistence, explicit Domain `websiteId`, Website/Application startup foreign-key doğrulaması, IDN→punycode canonicalization, explicit Website→Domain read, read-only migration preview, deterministic preview digest, durable ve tekrar çalıştırılabilir Website-create/bind orchestration'ı, migration-only binding rollback ledger'ı ve persistent compatibility/enforced policy status/finalize/rollback source seviyesinde mevcut. Enforced policy yeni managed domainlerde explicit Website binding ister; legacy state compatibility rollback için okunabilir kalır.

- [ ] Website update/rebind lifecycle'ı ekle: isim, runtime/application binding ve proxy hedef değişiklikleri explicit revision/impact kontrolüyle yapılsın; application birden fazla Website'e yanlışlıkla bağlanamasın.
- [ ] Reparent preview + apply geliştir. Duplicate hostname, dot-boundary, same-server ve cycle kontrolleri korunmalı; parent hiçbir zaman suffix keserek tahmin edilmemeli.
- [ ] Site-create orchestration ekle: existing/new static veya Node application, external reverse proxy ve ileride Docker target; canonical document root ve collision-free port backend tarafından üretilsin. `www` alias mı bağımsız hostname mı explicit seçim olsun.
- [ ] Website, web hostname/domain, DNS hosting ve mail-domain lifecycle'larını ayır; hostname create DNS publish veya mailbox create anlamına gelmesin.
- [ ] Website/domain move-delete impact preview API'si ekle. Child domain, application, certificate, mailbox, backup ve ileride cron/Docker bağımlılıkları listelensin; varsayılan davranış fail-closed, örtülü cascade yok.

## D. DEFERRED — Görsel UI/UX

Aktif geliştirme dışı. Enterprise layout/component styling/data-table görünümü/skeleton/notification/responsive polish/typography/site-detail görsel düzeni en sonda ayrı modele verilecek.

## E. P2 — Node.js, static ve Git functionality

- [ ] Node application management: enable/disable, explicit start/stop, runtime, startup file/npm script, package manager, mode ve document-root yönetimi. Mevcut deploy/restart/status/rollback akışını yeniden yazma.
- [ ] Hosttaki kurulu Node sürümlerini inspect et; eksik runtime install/select ve collision-free port allocation ekle. Panelin kendi Node runtime'ı site runtime seçimiyle değişmemeli.
- [ ] Git deploy'a explicit commit/tag seçimi ve private deploy key/token secret store ekle. Clone/fetch/install/build site Unix user'ıyla çalışmalı.
- [ ] Env import validation, change metadata ve `saved-on-disk` / `applied-to-running-process` ayrımı ekle.
- [ ] Node/systemd/Nginx/deploy için bounded, redacted log stream/search/filter/download backend'i geliştir.
- [ ] Static/SPA ve Docker runtime'larını kalıcı Website modeline bağla; Passenger yalnız compatibility adapter olarak kalsın.
- [ ] Signed Git webhook deploy: replay/duplicate koruması + resource lock + durable YunPanel job. GitHub Actions yok.

## F. P2 — Terminal ve file manager backend

- [ ] Gerçek PTY backend'i: site terminali dedicated user/cwd, Owner Server terminali root. Tek-shot HTTP exec terminal yerine geçmez.
- [ ] WebSocket upgrade session/role/Origin/Owner-MFA doğrulaması ve short-lived session-bound capability ekle.
- [ ] PTY resize, Ctrl+C/Ctrl+D, Unicode/fullscreen TUI, multi-session, reconnect/disconnect cleanup, process-group cleanup, idle/output/backpressure limitleri.
- [ ] Session/user/MFA/password/role revocation açık PTY/WS bağlantısını derhal kapatsın.
- [ ] Terminal open/close/session metadata'sını common audit'e yaz; raw keystroke/output/history merkezi audit'e yazılmasın.
- [ ] Site file manager: list/upload/download/mkdir/rename/text edit/permission display/confirmed delete; traversal ve symlink escape fail-closed. Owner host-files context'i ayrı kalsın.

## G. P2 — Domain, DNS, Nginx ve SSL

- [ ] Alias/canonical edit ve HTTPS redirect lifecycle'ı ekle; son hata için actionable diagnosis üret.
- [ ] Existing/custom certificate seçimi, certificate/private-key match, DNS-01 ve wildcard desteği ekle.
- [ ] Resolver tabanlı A/AAAA/CNAME + ACME readiness modeli geliştir; external DNS mutation yalnız provider adapter üzerinden explicit yetkiyle yapılsın.
- [ ] Site bazlı Nginx settings: upload size, proxy timeout, WebSocket, SPA fallback, cache/header/redirect; preview/diff/test/rollback backend'i ekle.
- [ ] DNS/certificate/reload error diagnosis güvenli ve bounded olsun; private key API/public job/audit'e çıkmasın.

## H. P2 — Mail ve Roundcube

- [ ] Postfix/Dovecot/Rspamd/Roundcube config ve health adapter'ları; Roundcube detection/install.
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
