# YunPanel — Yapılacaklar

Bu dosya yalnızca kalan geliştirme işlerini içerir. Tamamlanan işler Git commitlerinde kalır; kodu tamamlanıp gerçek Node 24 / tarayıcı / Ubuntu / package / canlı servis kabulü bekleyen maddeler `todo.md` içine taşınır. Bağlayıcı geliştirme kuralları `agents.md`, yerel yürütücü güvenlik sınırı `docs/local-executor-safety.md`, agentless migration/recovery prosedürü `docs/local-runtime-migration.md` içindedir.

Hedef: site merkezli enterprise hosting paneli, açık domain/subdomain hiyerarşisi ve ayrı privileged agent yerine host üzerinde çalışan tam yetkili yerel backend. Kullanıcı ayrıca istemedikçe doğrudan `main` üzerinde küçük commitlerle ilerle; GitHub Actions kullanma. Root backend ve terminal güvenlik/yayın kabulü tamamlanmadan public yüzeyi genişletme.

## A. P0 — Authentication ve erişim sınırında kalan işler

- [ ] MFA/oturum için gerçek React tarayıcı otomasyonu ekle: iki sekme, gecikmiş istek, kayıp MFA cevabı, geri yüklenen sayfa, recovery kodu onayı, modal/focus, idle/absolute süre ve keep-alive davranışını kapsa.
- [ ] WebSocket/SSE/terminal eklendiğinde HTTP ile aynı session, rol, Origin ve Owner MFA sınırını uygula. Logout, parola/MFA/rol değişimi, kullanıcı disable/delete ve session revoke açık bağlantı/PTY yetkisini derhal düşürsün.
- [ ] IP allowlist'i ancak gerçek HTTPS/proxy kabulünden sonra isteğe bağlı ek ağ kontrolüne dönüştür. Trusted-proxy sözleşmesi, gerçek istemci IP'sine göre rate limit ve spoof testleri olmadan mevcut korumayı kaldırma.
- [ ] Auth eventlerini ortak audit modeline bağla; kullanıcı yönetimi ve management/job işlemlerinde actor/resource/action/result kaydı üret. Parola, cookie, env değeri, MFA secretı ve ham terminal çıktısı audit'e yazılmayacak.

**Kabul:** Kalan native/browser/canlı kabul işleri `todo.md` içinde. Güvenlik zinciri doğrulanmadan root/terminal public sürümü açılmaz.

## B. P1 — Agentless yerel backend geçişinde kalan işler

Agentless local executor, exact `YUNPANEL_LOCAL_SERVER_ID` + OS hostname doğrulaması, exclusive host lock, root `yunpanel-api.service`, execution-time application env materialization, host inventory/services/Docker/Nginx snapshot yenilemesi, fresh credentialless `local-runtime create`, mevcut enrolled kimlik için `status/bind/release`, durable recovery sidecar ve terminal reconciliation mevcut. Default `npm run dev` artık agent başlatmıyor; web enrollment-token yüzeyi kaldırıldı. Running recovery için payload'sız `system.packages.inspect`/`database.inspect`, doğrulanmış Nginx staged config için `domain.stage` ve private receipt + exact current-release kanıtı için static deploy recovery yolları mevcut. Aşağıdakiler hâlâ geliştirme işidir:

- [ ] Running **mutating** job recovery kapsamını yalnız operasyon-spesifik, dış host kanıtı üretilebilen işlemlerde genişlet. Şu anda `domain.activate`, static rollback, Node deploy/rollback/restart, package upgrade, managed-service mutationları, DB create/delete ve SSL issue/renew için kanıtlı recovery yok. Generic `force-success`, kör retry veya kanıtsız journal temizleme ekleme.
- [ ] Legacy enrollment/heartbeat/command/result/environment backend transport rotalarını ve agent credential yüzeyini kademeli kaldır. Local ownership altında mevcut 409 `server_managed_locally` sınırını koru; rollback gerektiren eski enrolled hostların kimlik/state ilişkisini gerçek migration kabulü bitmeden bozma.
- [ ] `yun-agent.service`, agent compatibility re-export'ları ve package/env compatibility katmanını ancak gerçek migration + rollback kabulünden sonra kaldır. Debian maintainer scriptleri disabled agent'ı upgrade sırasında tekrar enable etmemeli.
- [ ] Site workload izolasyonunu yeni yüzeylerde de koru. Mevcut Node/static clone/npm/build ve Node systemd runtime dedicated `yunapp-*` kullanıcılarıyla çalışıyor; eklenecek Git hook, cron ve site terminali de dedicated site Unix user'ıyla çalışmalı. Yalnız Owner Server terminali root olabilir.
- [ ] Migration ve rollback otomasyonunu tamamla: verified backup -> job drain/recovery clear -> state migration veya fresh local create -> local backend health -> agent disable -> functional validation. `/etc/yunpanel`, `/var/lib/yunpanel`, auth SQLite, master key, vhost, cert, release ve users korunmalı. Gerçek test-host kanıtından önce otomasyon state taşımamalı.
- [ ] Kalan legacy hata yollarını güvenli tanı kataloğuna bağla. Raw command/error/env/secret/path sızıntısı API, job state, audit veya operator çıktısına dönmemeli.

**Kabul:** Agent kapalıyken inventory, Nginx, Node deploy/restart/rollback, SSL, managed services, DB ve package management gerçek test hostunda çalışmalı; hosted servisler panel restartında ayakta kalmalı. Gerçek kabul `todo.md` T-LOCAL-EXECUTOR/T-MIGRATION/T-LIVE altında.

## C. P1 — Kalıcı Website modeli ve domain hiyerarşisi

- [ ] Kalıcı `Website` kimliğini hostname/domain kaydından ayır. Website; server, application/runtime, document root ve Unix user ilişkilerini; domain ise website linki, explicit parent ve alias/canonical ilişkisini taşısın.
- [ ] `/websites/:websiteId` ekranını gerçek Website kaynağına geçir. Mevcut domain ID ve aynı server/porttan uygulama tahminini kalıcı bağ sayma; Node/static/Docker, env/log/files/backup ilişkileri açık backend foreign key'leriyle tutulmalı.
- [ ] Shared FQDN doğrulamasına IDN/punycode ekle. Reparent preview/migration'da duplicate hostname, nokta sınırı, same-server ve cycle kontrollerini koru; parent'i son iki label'dan tahmin etme.
- [ ] Site oluşturma akışında existing/new app, static/Node/Docker/reverse proxy, otomatik document root ve çakışmasız port tahsisi ekle. `www` alias mı bağımsız website mı kullanıcı açıkça seçsin.
- [ ] Website, DNS hosting ve mail-domain lifecycle'larını ayır. Subdomain mail alanını veya mailbox'ları parent'tan otomatik kopyalama.
- [ ] Silme/taşıma preview'unda child domain, application, mailbox, certificate ve backup etkisini göster; bağımlı kaynak varken varsayılan silme fail-closed olsun, örtülü cascade olmasın.
- [ ] Mevcut domain/application kayıtlarından sürümlü, tekrar çalıştırılabilir, yedekli Website migration + rollback geliştir. Mevcut trafik, IDs, secrets, cert ve release ilişkilerini koru.

## D. P1 — Enterprise arayüzde kalan geliştirme

Managed-service Owner UI gerçek inspect/install/start/stop/restart job akışını; Veritabanları ekranı gerçek MySQL/MariaDB inventory/create/delete job akışını kullanıyor. Read Only hesaplar bu nested management route'larını mount etmiyor. Server enrollment-token formu kaldırıldı. Kalan arayüz işleri:

- [ ] Route başına daha dar backend endpointleri, backend pagination, lazy module yükleme ve gerektiğinde virtualization ekle. Mevcut request-generation/stale-response/session guard'larını koru.
- [ ] Ortak data-table, field validation, Skeleton ve kalıcı notification center bileşenlerini tamamla. Eski gelişmiş formları aynı UX sözleşmesine taşı; dirty-form guard'ı domain quick-add ve kalan bakım/management formlarına genişlet.
- [ ] Domain listesine kalıcı kolon/collapse tercihleri, application listesine ölçeklenebilir pagination ekle. URL arama/filtre/sort ve parent/child grubunu bozmayan pagination korunmalı.
- [ ] Site detail'in uygulama seçimini C'deki kalıcı Website binding'e geçir; runtime'a göre yalnız ilgili sekme/eylemleri göster. Static deploy bağlantısı ve Docker runtime yüzeyini tamamla.
- [ ] Global site switcher, notification center ve resource-linked audit detail ekle. Mail/DB modülleri geldikçe global görünümden site bağlamına geçişi bağla.
- [ ] Files/cron/backup/terminal placeholder'larını yalnız gerçek backend ve UI akışı tamamlandıktan sonra kaldır. Mail placeholder'ını H tamamlanmadan kaldırma. Job history'yi canlı Node/Nginx logu gibi sunma.

Gerçek render, responsive, keyboard/focus ve route kabulü `todo.md` içindedir.

## E. P2 — Site içi Node.js, static ve Git yönetimi

- [ ] Node/Git ekranlarına enable/disable, start/stop, runtime, app/document root, startup file/npm script, package manager ve çalışma modu yönetimini ekle. Mevcut deploy/restart/status/rollback akışlarını yeniden yazma.
- [ ] Kurulu Node sürümlerini hosttan okuyup eksik runtime kurma ve site runtime seçimini ekle. Panelin kendi Node runtime'ını değiştirme; port tahsisi çakışmasız otomatik olsun, manuel seçenek advanced kalsın.
- [ ] Dependency install/build, repository/branch/commit seçimi ve private Git deploy key/token yönetimini tamamla. Bütün build/deploy scriptleri site Unix user'ıyla çalışsın.
- [ ] Env editörüne import validation, change metadata ve “diskte kaydedildi / çalışan sürece uygulandı” ayrımını ekle. Mevcut masking, typed delete confirm ve restart/deploy uyarısını koru.
- [ ] Node stdout/stderr, systemd, Nginx ve deploy loglarını site bağlamında bounded canlı izleme/arama/filtre/download ile bağla; redaction uygula.
- [ ] Static/SPA ve Docker runtime'larını aynı site kabuğuna bağla. Passenger compatibility adapter'ını gerçek Plesk örnekleriyle tamamla; yeni Node app varsayılanı systemd kalsın.
- [ ] Git webhook deploy'u signature doğrulaması, replay/duplicate koruması ve resource lock ile YunPanel job sistemine bağla; GitHub Actions ekleme.

## F. P2 — Entegre terminal ve dosya yöneticisi

- [ ] xterm.js + backend PTY ile gerçek interaktif terminal geliştir. Site terminali dedicated site user/doğru cwd; Server terminali Owner için root olmalı. Sahte terminal veya tek-shot HTTP exec yapma.
- [ ] WebSocket upgrade'de session/role/Origin/Owner-MFA doğrula; terminal capability süreli ve session-bound olsun. Kalıcı credential URL/query içine koyma.
- [ ] Resize, Ctrl+C/Ctrl+D, copy/paste, Unicode, fullscreen TUI, multi-tab ve disconnect/reconnect davranışlarını tamamla.
- [ ] Logout/session revoke/user disable-delete/role-password-MFA değişiminde WS/PTY derhal kapansın. Process-group cleanup, idle timeout, session/output/backpressure limitleri olsun.
- [ ] Root terminal open/close metadata'sını audit'e yaz; raw keystroke/output/history merkezi audit'e varsayılan olarak yazılmasın.
- [ ] Site file manager: list/upload/download/mkdir/rename/text-edit/permission display/confirmed delete. Path traversal ve symlink escape engellensin; host dosya düzenleme ayrı Owner/Server bağlamında kalsın.

## G. P2 — Domain, DNS, Nginx ve SSL

- [ ] Site Domain/SSL ekranına alias/canonical edit, HTTPS redirect, renewal yönetimi ve actionable son-hata teşhisi ekle. Mevcut stage/activate, ACME issue/test/renew işlerini yeniden yazma.
- [ ] Hostname kapsamına uygun mevcut/custom certificate seçimi, certificate/key match, DNS-01 ve wildcard desteği ekle; apex/wildcard kapsamını ayrı değerlendir.
- [ ] Gerçek resolver ile A/AAAA/CNAME ve ACME readiness göster. Dış DNS'i YunPanel yönetiyorsa provider adapter üzerinden ayrı yetkili mutation kullan; hostname oluşturmayı DNS yayını sayma.
- [ ] Site bazlı upload size, proxy timeout, WebSocket, SPA fallback, cache/header/redirect ayarları ve advanced Nginx preview/diff/test/rollback ekle.
- [ ] DNS/certificate/reload hatalarını gerçek teşhisle bağla. Private key API listesine/frontend'e çıkmamalı; hatalı vhost değişimi diğer siteleri bozmamalı.

## H. P2 — Mail ve Roundcube

Postfix/Dovecot/Rspamd paket install/start/stop/restart managed-service katmanında mevcut; mail ürününün yapılandırma/lifecycle katmanı eksik:

- [ ] Postfix, Dovecot, Rspamd ve Roundcube config/health adapter'larını geliştir; Roundcube detection/install'i managed-service kataloğuna uygun biçimde ekle.
- [ ] Site Mail sekmesinde mail-domain enable/disable, mailbox create/delete, password, quota/usage, alias/forwarding lifecycle'ını tamamla; parent/subdomain mail kapsamını kullanıcı seçsin.
- [ ] MX/SPF/DKIM/DMARC ve PTR/rDNS için expected/current/action-needed teşhisi göster; provider port kısıtlarını ayrı raporla.
- [ ] SMTP/IMAP TLS, queue ve logs yönetimini bağla; unauthenticated relay engellensin.
- [ ] Roundcube'u gerçek webmail URL'sine bağla; panel session ile mailbox credential'ını karıştırma.
- [ ] Mailbox/domain delete için impact/backup/restore uygula; mail data/metadata backup modeline dahil olsun.

## I. P2/P3 — Kalan operasyon modülleri

DB foundation MySQL/MariaDB socket detection, non-system DB inventory/size, create/drop manager, protocol, durable job registry, authenticated API ve `/databases` Owner UI'ını içeriyor. Managed-service katmanı Nginx, MariaDB, MySQL, Docker, Cron, Postfix, Dovecot ve Rspamd install/lifecycle'ını destekliyor. Kalan geliştirme:

- [ ] MySQL/MariaDB site binding, DB user CRUD, grants, password rotation, connection-info, dump/restore ve minimum-privilege application user akışlarını tamamla. Password/credential job JSON'una yazılmayacak; secret materyali ayrı şifreli store üzerinden execution-time materialize edilmeli.
- [ ] Docker/Compose validation, build/pull/start/stop/restart, env/registry credentials, logs/health, Nginx target ve deploy history ekle; volume/bind inventory + backup politikasını göster.
- [ ] Şifreli application/config/env/DB/volume/mail backup, local/S3-compatible target, retention/checksum, restore preview/progress, pre-restore backup ve outage handling geliştir.
- [ ] Site cron: user/cwd/env/timezone/enable-disable/last-run/output. Site işleri site user, sistem işleri açık Owner/Server bağlamında çalışsın.
- [ ] Gerçek metric history, inode/disk threshold, service/app events, deploy/backup/SSL notifications ve bounded log download ekle. Unknown/stale metric sıfır veya yeşil gösterilmesin.
- [ ] Audit/job detail: actor, resource link, stage, safe error/log, search/filter, cancel/retry. Riskli retry idempotency + lock şartıyla çalışsın.
- [ ] Plesk read-only importer, external-managed state ve Passenger/static/Node/DB/Docker/domain/cron/mail migration + per-resource rollback araçlarını tamamla.

## J. P0–P3 — Test, migration ve yayın kapıları

- [ ] Agentsiz mimari ilerledikçe mevcut core/deploy/rollback/ACME/job testlerini local-executor sınırına taşı; test-only network backdoor ekleme.
- [ ] Website migration, resource-scoped access, WebSocket/PTY ve yeni secret yüzeyleri için native/process/browser testleri ekle.
- [ ] Routed UI için component + gerçek browser testlerini tamamla: login -> site -> child -> Node -> SSL -> mail -> terminal; loading/empty/error/permission/dirty-form/refresh/long-table durumlarını kapsa.
- [ ] Agentsiz package upgrade, schema migration, PTY dependency, restart reconciliation, job-running self-update ve disk-full rollback senaryolarını tamamla.
- [ ] Master-key/backup/restore/resource-exhaustion/panel-outage tatbikatlarını gerçek desteklenen runtime ve test hostunda çalıştır; çalıştırılmayan testi geçmiş sayma.
- [ ] Migration kabulü tamamlandıkça install/package docs ve compatibility yüzeylerinden kalan agent varsayımlarını temizle; rollback gerektiren davranışı erken kaldırma.
- [ ] `todo.md` içindeki Node 24, browser, HTTPS, package, Ubuntu/DNS/Plesk ve canlı rollback kabulünü tamamlamadan production-ready etiketi verme.

**Yayın sırası:** A güvenlik sınırı -> B agentless root backend/migration -> C kalıcı Website modeli -> D UI olgunlaştırma -> E/F/G günlük hosting -> H mail -> I kalan modüller. Arayüz geliştirmesi paralel ilerleyebilir; UI tek başına root/backend veya production-ready kabulü değildir.
