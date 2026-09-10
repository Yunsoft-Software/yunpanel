# YunPanel — Yapılacaklar

Bu dosya yalnızca kalan geliştirme işlerini içerir. Tamamlanan işler Git commitlerinde kalır; kodu tamamlanıp gerçek Node 24 / tarayıcı / Ubuntu / package / canlı servis kabulü bekleyen maddeler `todo.md` içine taşınır. Bağlayıcı geliştirme kuralları `agents.md`, yerel yürütücü güvenlik sınırı `docs/local-executor-safety.md`, agentless migration/recovery prosedürü `docs/local-runtime-migration.md` içindedir.

Hedef: site merkezli enterprise hosting paneli, açık domain/subdomain hiyerarşisi ve ayrı privileged agent yerine host üzerinde çalışan tam yetkili yerel backend. Kullanıcı ayrıca istemedikçe doğrudan `main` üzerinde küçük commitlerle ilerle; GitHub Actions kullanma. Root backend ve terminal güvenlik/yayın kabulü tamamlanmadan public yüzeyi genişletme.

**2026-09-10 yürütme kararı:** Görsel tasarım, UI/UX yeniden tasarımı, layout/styling, component polish ve benzeri `apps/web` işleri bu geliştirme akışında donduruldu. Bunlar en sonda ayrı bir modele verilecek. Backend işlevi veya güvenlik kontratı için zorunlu olmadıkça frontend dosyalarına dokunma; önce backend, veri modeli, host operasyonları, migration, terminal altyapısı, DNS/SSL/mail/DB/Docker/backup/cron/audit functionality tamamlanmalı.

## A. P0 — Authentication ve erişim sınırında kalan işler

- [ ] MFA/oturum için gerçek React tarayıcı otomasyonu ekle: iki sekme, gecikmiş istek, kayıp MFA cevabı, geri yüklenen sayfa, recovery kodu onayı, modal/focus, idle/absolute süre ve keep-alive davranışını kapsa.
- [ ] WebSocket/SSE/terminal eklendiğinde HTTP ile aynı session, rol, Origin ve Owner MFA sınırını uygula. Logout, parola/MFA/rol değişimi, kullanıcı disable/delete ve session revoke açık bağlantı/PTY yetkisini derhal düşürsün.
- [ ] IP allowlist'i ancak gerçek HTTPS/proxy kabulünden sonra isteğe bağlı ek ağ kontrolüne dönüştür. Trusted-proxy sözleşmesi, gerçek istemci IP'sine göre rate limit ve spoof testleri olmadan mevcut korumayı kaldırma.
- [ ] Auth eventlerini ortak audit modeline bağla; kullanıcı yönetimi ve management/job işlemlerinde actor/resource/action/result kaydı üret. Parola, cookie, env değeri, MFA secretı ve ham terminal çıktısı audit'e yazılmayacak.

**Kabul:** Kalan native/browser/canlı kabul işleri `todo.md` içinde. Güvenlik zinciri doğrulanmadan root/terminal public sürümü açılmaz.

## B. P1 — Agentless yerel backend geçişinde kalan işler

Agentless local executor, exact `YUNPANEL_LOCAL_SERVER_ID` + OS hostname doğrulaması, exclusive host lock, root `yunpanel-api.service`, execution-time application env materialization, host inventory/services/Docker/Nginx snapshot yenilemesi, fresh credentialless `local-runtime create`, mevcut enrolled kimlik için `status/bind/release`, durable recovery sidecar ve terminal reconciliation mevcut. Default `npm run dev` artık agent başlatmıyor; web enrollment-token ve yeni enrollment HTTP/client yüzeyleri kaldırıldı. Running recovery payload'ı public job API'sine açılmadan private persisted job-store context reader üzerinden doğrulanıyor. Güncel async queue için source-level running recovery kapsamı read-only `system.packages.inspect`, `system.services.inspect`, `database.inspect`, `app.node.status`; Nginx `domain.stage/activate`; static deploy/rollback; Node deploy/rollback/restart; DB create/delete; managed-service start/stop/install/restart; YunPanel package upgrade ve SSL issue/renew varyantlarını operation-specific host kanıtı veya private receipt ile kapsıyor. Queue/recovery parity source invariantı ve payload-backed durable lifecycle testleri mevcut; generic `force-success`, kör mutation retry veya kanıtsız journal temizleme yok. Ownership mutationları verified backup gate ister; rollback tarafında non-destructive preview, archive member/type/link doğrulaması, `yunapp-*` Unix identity drift karşılaştırması, metadata/ACL/xattr blok planı ve yalnız private staging root altında no-owner/no-permission restore staging mevcut. Post-migration `local-runtime validate` exact local binding, API/agent systemd state, idle queue/recovery, fresh local inventory/services snapshot, current API version ve loopback `/api/health` kanıtını read-only doğruluyor. Legacy compatibility error/result/log yüzeyi authored safe diagnostics ile fail-closed. Aşağıdakiler hâlâ geliştirme işidir:

- [ ] Retained legacy heartbeat/command/result/environment backend transport rotalarını ve agent credential yüzeyini kademeli kaldır. Local ownership altında mevcut 409 `server_managed_locally` sınırını koru; rollback gerektiren eski enrolled hostların kimlik/state ilişkisini gerçek migration kabulü bitmeden bozma.
- [ ] `yun-agent.service`, agent compatibility re-export'ları ve package/env compatibility katmanını ancak gerçek migration + rollback kabulünden sonra kaldır. Debian maintainer scriptleri disabled agent'ı upgrade sırasında tekrar enable etmemeli.
- [ ] Site workload izolasyonunu yeni yüzeylerde de koru. Mevcut Node/static clone/npm/build ve Node systemd runtime dedicated `yunapp-*` kullanıcılarıyla çalışıyor; eklenecek Git hook, cron ve site terminali de dedicated site Unix user'ıyla çalışmalı. Yalnız Owner Server terminali root olabilir.
- [ ] Migration ve rollback otomasyonunu tamamla: mevcut verified backup/preview/archive-link/Unix-identity/metadata-plan/private-stage zincirinden sonra live apply için per-target replacement, ownership/mode/ACL/xattr doğrulaması, `yunapp-*` identity drift çözüm politikası, pre-apply backup, agent disable/enable sırası, functional validation orchestration ve herhangi bir ara hata için deterministik rollback ekle. `/etc/passwd` veya `/etc/group` kör overwrite edilmemeli; `/etc/yunpanel`, `/var/lib/yunpanel`, auth SQLite, master key, vhost, cert, release ve users korunmalı. Gerçek test-host kanıtından önce live state taşıma/apply açılmamalı.

**Kabul:** Agent kapalıyken inventory, Nginx, Node deploy/restart/rollback, SSL, managed services, DB ve package management gerçek test hostunda çalışmalı; hosted servisler panel restartında ayakta kalmalı. Bütün operation-specific recovery komutları gerçek host evidence/receipt ile fail-closed doğrulanmalı. Backup preview/stage gerçek GNU tar ve gerçek `yunapp-*` kimlikleriyle doğrulanmalı; `local-runtime validate` gerçek packaged API/systemd/loopback health üzerinde geçmeli; live restore/apply ayrı kabul olmadan açılmamalı. Gerçek kabul `todo.md` T-LOCAL-EXECUTOR/T-MIGRATION/T-LIVE altında.

## C. P1 — Kalıcı Website modeli ve domain hiyerarşisi

- [ ] Kalıcı `Website` kimliğini hostname/domain kaydından ayır. Website; server, application/runtime, document root ve Unix user ilişkilerini; domain ise website linki, explicit parent ve alias/canonical ilişkisini taşısın.
- [ ] Website API/resource katmanını gerçek Website kaynağına geçir. Mevcut domain ID ve aynı server/porttan application tahminini kalıcı bağ sayma; Node/static/Docker, env/log/files/backup ilişkileri açık backend foreign key'leriyle tutulmalı. Görsel site-detail entegrasyonu tasarım aşamasına bırakılabilir.
- [ ] Shared FQDN doğrulamasına IDN/punycode ekle. Reparent preview/migration'da duplicate hostname, nokta sınırı, same-server ve cycle kontrollerini koru; parent'i son iki label'dan tahmin etme.
- [ ] Site oluşturma backend akışında existing/new app, static/Node/Docker/reverse proxy, otomatik document root ve çakışmasız port tahsisi ekle. `www` alias mı bağımsız website mı API/model düzeyinde explicit seçim olsun.
- [ ] Website, DNS hosting ve mail-domain lifecycle'larını ayır. Subdomain mail alanını veya mailbox'ları parent'tan otomatik kopyalama.
- [ ] Silme/taşıma preview API'sinde child domain, application, mailbox, certificate ve backup etkisini üret; bağımlı kaynak varken varsayılan silme fail-closed olsun, örtülü cascade olmasın.
- [ ] Mevcut domain/application kayıtlarından sürümlü, tekrar çalıştırılabilir, yedekli Website migration + rollback geliştir. Mevcut trafik, IDs, secrets, cert ve release ilişkilerini koru.

## D. DEFERRED — Görsel UI/UX tasarımı

Bu bölüm aktif geliştirme akışının dışındadır ve en sonda ayrı modele verilecektir. Enterprise layout, component tasarımı, data-table görünümü, skeleton/notification görselleri, responsive polish, typography/spacing, site-detail görsel düzeni ve diğer frontend tasarım işleri için bu aşamada commit üretme. Backend/API kontratlarını tasarım modelinin sonradan bağlayabileceği kadar açık ve kararlı tut.

## E. P2 — Site içi Node.js, static ve Git işlevleri

- [ ] Node/Git backend API'larına enable/disable, start/stop, runtime, app/document root, startup file/npm script, package manager ve çalışma modu yönetimini ekle. Mevcut deploy/restart/status/rollback akışlarını yeniden yazma.
- [ ] Kurulu Node sürümlerini hosttan okuyup eksik runtime kurma ve site runtime seçimini ekle. Panelin kendi Node runtime'ını değiştirme; port tahsisi çakışmasız otomatik olsun, manuel seçenek advanced API/config olarak kalsın.
- [ ] Dependency install/build, repository/branch/commit seçimi ve private Git deploy key/token yönetimini tamamla. Bütün build/deploy scriptleri site Unix user'ıyla çalışsın.
- [ ] Env backend'ine import validation, change metadata ve “diskte kaydedildi / çalışan sürece uygulandı” state ayrımını ekle. Mevcut masking ve typed delete confirm kontratını koru.
- [ ] Node stdout/stderr, systemd, Nginx ve deploy logları için bounded stream/search/filter/download backend'i geliştir; redaction uygula. Görsel log ekranı son tasarım aşamasına bırakılabilir.
- [ ] Static/SPA ve Docker runtime backend'lerini aynı Website/site modeline bağla. Passenger compatibility adapter'ını gerçek Plesk örnekleriyle tamamla; yeni Node app varsayılanı systemd kalsın.
- [ ] Git webhook deploy'u signature doğrulaması, replay/duplicate koruması ve resource lock ile YunPanel job sistemine bağla; GitHub Actions ekleme.

## F. P2 — Terminal altyapısı ve dosya yöneticisi backend'i

- [ ] Gerçek PTY backend'i geliştir. Site terminali dedicated site user/doğru cwd; Server terminali Owner için root olmalı. xterm.js/görsel terminal entegrasyonu son tasarım aşamasına bırakılabilir; tek-shot HTTP exec yapma.
- [ ] WebSocket upgrade'de session/role/Origin/Owner-MFA doğrula; terminal capability süreli ve session-bound olsun. Kalıcı credential URL/query içine koyma.
- [ ] PTY resize, Ctrl+C/Ctrl+D, Unicode, fullscreen TUI gereksinimleri için backend stream/protocol desteğini; multi-session ve disconnect cleanup davranışını tamamla.
- [ ] Logout/session revoke/user disable-delete/role-password-MFA değişiminde WS/PTY derhal kapansın. Process-group cleanup, idle timeout, session/output/backpressure limitleri olsun.
- [ ] Root terminal open/close metadata'sını audit'e yaz; raw keystroke/output/history merkezi audit'e varsayılan olarak yazılmasın.
- [ ] Site file manager backend'i: list/upload/download/mkdir/rename/text-edit/permission display/confirmed delete. Path traversal ve symlink escape engellensin; host dosya düzenleme ayrı Owner/Server bağlamında kalsın.

## G. P2 — Domain, DNS, Nginx ve SSL functionality

- [ ] Domain/SSL backend'ine alias/canonical edit, HTTPS redirect, renewal yönetimi ve actionable son-hata teşhisi ekle. Mevcut stage/activate, ACME issue/test/renew işlerini yeniden yazma.
- [ ] Hostname kapsamına uygun mevcut/custom certificate seçimi, certificate/key match, DNS-01 ve wildcard desteği ekle; apex/wildcard kapsamını ayrı değerlendir.
- [ ] Gerçek resolver ile A/AAAA/CNAME ve ACME readiness üret. Dış DNS'i YunPanel yönetiyorsa provider adapter üzerinden ayrı yetkili mutation kullan; hostname oluşturmayı DNS yayını sayma.
- [ ] Site bazlı upload size, proxy timeout, WebSocket, SPA fallback, cache/header/redirect ayarları ve advanced Nginx preview/diff/test/rollback backend'ini ekle.
- [ ] DNS/certificate/reload hatalarını gerçek teşhisle bağla. Private key API listesine/frontend'e çıkmamalı; hatalı vhost değişimi diğer siteleri bozmamalı.

## H. P2 — Mail ve Roundcube functionality

Postfix/Dovecot/Rspamd paket install/start/stop/restart managed-service katmanında mevcut; mail ürününün yapılandırma/lifecycle katmanı eksik:

- [ ] Postfix, Dovecot, Rspamd ve Roundcube config/health adapter'larını geliştir; Roundcube detection/install'i managed-service kataloğuna uygun biçimde ekle.
- [ ] Mail-domain backend'inde enable/disable, mailbox create/delete, password, quota/usage, alias/forwarding lifecycle'ını tamamla; parent/subdomain mail kapsamı explicit seçim olsun.
- [ ] MX/SPF/DKIM/DMARC ve PTR/rDNS için expected/current/action-needed teşhisi üret; provider port kısıtlarını ayrı raporla.
- [ ] SMTP/IMAP TLS, queue ve logs yönetimini bağla; unauthenticated relay engellensin.
- [ ] Roundcube için gerçek webmail endpoint/health entegrasyonunu sağla; panel session ile mailbox credential'ını karıştırma.
- [ ] Mailbox/domain delete için impact/backup/restore uygula; mail data/metadata backup modeline dahil olsun.

## I. P2/P3 — Kalan operasyon modülleri

DB foundation MySQL/MariaDB socket detection, non-system DB inventory/size, create/drop manager, protocol, durable job registry, authenticated API ve temel `/databases` Owner functionality'sini içeriyor. Managed-service katmanı Nginx, MariaDB, MySQL, Docker, Cron, Postfix, Dovecot ve Rspamd install/lifecycle'ını destekliyor. Kalan geliştirme:

- [ ] MySQL/MariaDB site binding, DB user CRUD, grants, password rotation, connection-info, dump/restore ve minimum-privilege application user akışlarını tamamla. Password/credential job JSON'una yazılmayacak; secret materyali ayrı şifreli store üzerinden execution-time materialize edilmeli.
- [ ] Docker/Compose validation, build/pull/start/stop/restart, env/registry credentials, logs/health, Nginx target ve deploy history ekle; volume/bind inventory + backup politikasını gösteren backend metadata'sı üret.
- [ ] Şifreli application/config/env/DB/volume/mail backup, local/S3-compatible target, retention/checksum, restore preview/progress, pre-restore backup ve outage handling geliştir.
- [ ] Site cron: user/cwd/env/timezone/enable-disable/last-run/output. Site işleri site user, sistem işleri açık Owner/Server bağlamında çalışsın.
- [ ] Gerçek metric history, inode/disk threshold, service/app events, deploy/backup/SSL notifications ve bounded log download backend'ini ekle. Unknown/stale metric sıfır veya yeşil sayılmasın.
- [ ] Audit/job detail backend'i: actor, resource link, stage, safe error/log, search/filter, cancel/retry. Riskli retry idempotency + lock şartıyla çalışsın.
- [ ] Plesk read-only importer, external-managed state ve Passenger/static/Node/DB/Docker/domain/cron/mail migration + per-resource rollback araçlarını tamamla.

## J. P0–P3 — Test, migration ve yayın kapıları

- [ ] Agentsiz mimari ilerledikçe mevcut core/deploy/rollback/ACME/job testlerini local-executor sınırına taşı; test-only network backdoor ekleme.
- [ ] Website migration, resource-scoped access, WebSocket/PTY ve yeni secret yüzeyleri için native/process testleri ekle. Görsel/component/browser polish testleri tasarım aşamasına bırakılabilir; auth/security browser kabulü `todo.md` gereği korunur.
- [ ] Agentsiz package upgrade, schema migration, PTY dependency, restart reconciliation, job-running self-update ve disk-full rollback senaryolarını tamamla.
- [ ] Master-key/backup/restore/resource-exhaustion/panel-outage tatbikatlarını gerçek desteklenen runtime ve test hostunda çalıştır; çalıştırılmayan testi geçmiş sayma.
- [ ] Migration kabulü tamamlandıkça install/package docs ve compatibility yüzeylerinden kalan agent varsayımlarını temizle; rollback gerektiren davranışı erken kaldırma.
- [ ] `todo.md` içindeki Node 24, auth/security browser, HTTPS, package, Ubuntu/DNS/Plesk ve canlı rollback kabulünü tamamlamadan production-ready etiketi verme.

**Yayın sırası:** A güvenlik sınırı -> B agentless root backend/migration -> C kalıcı Website modeli -> E/F/G günlük hosting functionality -> H mail -> I kalan modüller -> en sonda ayrı model ile D görsel UI/UX tasarımı. Tasarım çalışması backend functionality veya production-ready kabulü yerine geçmez.
