# YunPanel — Yapılacaklar

Bu dosya yalnızca kalan geliştirme işlerini içerir. Tamamlanan işler geçmiş Git commitlerinde kalır; kodu tamamlanıp gerçek Node 24 / tarayıcı / Ubuntu / canlı servis kabulü bekleyen maddeler `todo.md` içine taşınır. Bağlayıcı geliştirme kuralları `agents.md` içindedir.

Hedef: site merkezli enterprise hosting paneli, açık domain/subdomain hiyerarşisi ve ayrı privileged agent yerine host üzerinde çalışan tam yetkili yerel backend. Kullanıcı ayrıca istemedikçe doğrudan `main` üzerinde küçük commitlerle ilerle; GitHub Actions kullanma. Root backend ve terminal güvenlik/yayın kabulü tamamlanmadan public açılmayacak.

## A. P0 — Authentication ve erişim sınırında kalan işler

- [ ] MFA/oturum için gerçek React tarayıcı otomasyonu ekle: iki sekme, gecikmiş istek, kayıp MFA cevabı, geri yüklenen sayfa, recovery kodu onayı, modal/focus, idle/absolute süre ve keep-alive davranışını kapsa.
- [ ] `core-app.js` ve domain route bileşimindeki `bootstrap-auth.js` / in-process uyumluluk bearer tokenını kaldır. Browser management route'ları yalnız authentication listener tarafından server-side eklenen doğrulanmış `request.auth` bağlamını kullansın; doğrudan raw `createApp().listen()` management erişimi fail-closed kalsın. Agent rotalarının ayrı credential'ları B geçişinde kaldırılacak.
- [ ] WebSocket/SSE/terminal eklendiğinde HTTP ile aynı session, rol, Origin ve Owner MFA sınırını uygula. Logout, parola/MFA/rol değişimi, kullanıcı disable/delete ve session revoke açık bağlantı/PTY yetkisini derhal düşürsün.
- [ ] IP allowlist'i ancak gerçek HTTPS/proxy kabulünden sonra isteğe bağlı ek ağ kontrolüne dönüştür. Trusted-proxy sözleşmesi, gerçek istemci IP'sine göre rate limit ve spoof testleri olmadan mevcut korumayı kaldırma.
- [ ] Auth eventlerini ortak audit modeline bağla; kullanıcı yönetimi ve management/job işlemlerinde actor/resource/action/result kaydı üret. Parola, cookie, env değeri, MFA secretı ve ham terminal çıktısı audit'e yazılmayacak.

**Kabul:** Kalan native/browser/canlı kabul işleri `todo.md` içinde. Güvenlik zinciri doğrulanmadan root/terminal public sürümü açılmaz.

## B. P1 — Ayrı agent'ı kaldır, tam yetkili yerel backend'e geç

- [ ] Sunucu başına yerel panel mimarisini uygula. Yönetim backend'i host üzerinde root yetkili systemd servisi olsun; ayrı `yun-agent`, enrollment, heartbeat, credential exchange veya işlem başına sudo/polkit izin akışı kalmasın.
- [ ] `apps/agent/src` içindeki çalışan Nginx, ACME, systemd, deploy, rollback, envanter ve paket yönetimi algoritmalarını panel backend'inin dahili host-service/adapter katmanına taşı. Transport bağımlılıklarını ayır; çalışan algoritmaları gereksiz yeniden yazma.
- [ ] `agent-client.js`, command claim/result, heartbeat ve secret-delivery akışlarını yerel executor'a geçir. Job queue, resource lock, reconciliation, hata/rollback ve restart sonrası idempotency korunmalı.
- [ ] Yerel server kaydını kurulum/migration sırasında açıkça oluştur veya mevcut local kayıtla eşleştir. Mevcut server/application/domain kimliklerini ve ilişkilerini koru; doğrulanmamış uzak kaydı bu hosta sessizce bağlama.
- [ ] Root yetkisini site uygulamalarına yayma. Node/static build, npm lifecycle, Git hook, cron ve site terminali dedicated site Unix kullanıcısıyla çalışsın; Owner Sunucu terminali root olabilir.
- [ ] Systemd unitleri, Debian maintainer scriptleri, installer, package listesi, workspace/env örnekleri ve dev komutlarını agentsiz yapıya geçir. Gerçek management/PTy işlemlerini engelleyen sandbox'ları bilinçli daralt; `chmod -R 777` veya genel ownership değişimi kullanma.
- [ ] Migration sırası: yedek -> job drain -> sürümlü state migration -> yeni backend health -> eski agent durdur/devre dışı -> doğrulama. `/etc/yunpanel`, `/var/lib/yunpanel`, auth SQLite, master key, vhost, sertifika, release ve kullanıcıları koru; rollback eski paket/unit/state'e dönebilsin.
- [ ] Geçiş tamamlanınca enrollment UI/agent mesajlarını kaldır ve eksik servis, gerçek OS hatası, kullanıcı yetkisi, yanlış config ve uygulanmamış modül durumlarını ayrı göster.

**Kabul:** Agent çalışmadan envanter, Nginx test/reload, Node deploy/restart/rollback, SSL ve paket işlemleri çalışmalı; Owner root terminal açabilmeli; panel dursa hosted servisler çalışmaya devam etmeli.

## C. P1 — Kalıcı Website modeli ve domain hiyerarşisi

- [ ] Kalıcı `Website` kimliğini hostname/domain kaydından ayır. Website: server, application/runtime, document root ve Unix user ilişkilerini; domain: website linki, explicit parent ve alias/canonical ilişkisini taşısın.
- [ ] `/websites/:websiteId` ekranını gerçek Website kaynağına geçir. Mevcut domain ID ve aynı server/porttan uygulama tahminini kalıcı bağ sayma; Node/static/Docker, env/log/files/backup ilişkileri açık backend foreign key'leriyle tutulmalı.
- [ ] Shared FQDN doğrulamasına IDN/punycode ekle. Reparent preview/migration'da duplicate hostname, nokta sınırı, same-server ve cycle kontrollerini koru; parent'i son iki label'dan tahmin etme.
- [ ] Site oluşturma akışında existing/new app, static/Node/Docker/reverse proxy, otomatik document root ve çakışmasız port tahsisi ekle. `www` alias mı bağımsız website mı kullanıcı açıkça seçsin.
- [ ] Website, DNS hosting ve mail-domain lifecycle'larını ayır. Subdomain mail alanını veya mailbox'ları parent'tan otomatik kopyalama.
- [ ] Silme/taşıma preview'unda child domain, application, mailbox, certificate ve backup etkisini göster; bağımlı kaynak varken varsayılan silme fail-closed olsun, örtülü cascade olmasın.
- [ ] Mevcut domain/application kayıtlarından sürümlü, tekrar çalıştırılabilir, yedekli Website migration + rollback geliştir. Mevcut trafik, IDs, secrets, cert ve release ilişkilerini koru.

## D. P1 — Enterprise arayüzde kalan geliştirme

- [ ] Route başına daha dar backend endpointleri, backend pagination, lazy module yükleme ve gerektiğinde virtualization ekle. Mevcut request-generation/stale-response/session guard'larını koru.
- [ ] Ortak data-table, field validation, Skeleton ve kalıcı notification center bileşenlerini tamamla. Eski gelişmiş formları aynı UX sözleşmesine taşı; dirty-form guard'ı domain quick-add, server enrollment/bakım gibi kalan formlara genişlet.
- [ ] Domain listesine kalıcı kolon/collapse tercihleri, application listesine ölçeklenebilir pagination ekle. URL arama/filtre/sort ve parent/child grubunu bozmayan pagination korunmalı.
- [ ] Site detail'in uygulama seçimini C'deki kalıcı Website binding'e geçir; runtime'a göre yalnız ilgili sekme/eylemleri göster. Static deploy bağlantısı ve Docker runtime yüzeyini tamamla.
- [ ] Global site switcher, notification center ve resource-linked audit detail ekle. Mail/DB modülleri geldikçe global görünümden site bağlamına geçişi bağla.
- [ ] Mail/files/DB/cron/backup/terminal placeholder'larını yalnız gerçek backend ve UI akışı tamamlandıktan sonra kaldır. Job history'yi canlı Node/Nginx logu gibi sunma.

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
- [ ] Logout/session revoke/user disable-delete/role-password-MFA değişiminde WS/PTy derhal kapansın. Process-group cleanup, idle timeout, session/output/backpressure limitleri olsun.
- [ ] Root terminal open/close metadata'sını audit'e yaz; raw keystroke/output/history merkezi audit'e varsayılan olarak yazılmasın.
- [ ] Site file manager: list/upload/download/mkdir/rename/text-edit/permission display/confirmed delete. Path traversal ve symlink escape engellensin; host dosya düzenleme ayrı Owner/Server bağlamında kalsın.

## G. P2 — Domain, DNS, Nginx ve SSL

- [ ] Site Domain/SSL ekranına alias/canonical edit, HTTPS redirect, renewal yönetimi ve actionable son-hata teşhisi ekle. Mevcut stage/activate, ACME issue/test/renew işlerini yeniden yazma.
- [ ] Hostname kapsamına uygun mevcut/custom certificate seçimi, certificate/key match, DNS-01 ve wildcard desteği ekle; apex/wildcard kapsamını ayrı değerlendir.
- [ ] Gerçek resolver ile A/AAAA/CNAME ve ACME readiness göster. Dış DNS'i YunPanel yönetiyorsa provider adapter üzerinden ayrı yetkili mutation kullan; hostname oluşturmayı DNS yayını sayma.
- [ ] Site bazlı upload size, proxy timeout, WebSocket, SPA fallback, cache/header/redirect ayarları ve advanced Nginx preview/diff/test/rollback ekle.
- [ ] DNS/certificate/reload hatalarını gerçek teşhisle bağla. Private key API listesine/frontend'e çıkmamalı; hatalı vhost değişimi diğer siteleri bozmamalı.

## H. P2 — Mail ve Roundcube

- [ ] Postfix, Dovecot, Rspamd ve Roundcube detection/install/config/health adapter'larını geliştir.
- [ ] Site Mail sekmesinde mail-domain enable/disable, mailbox create/delete, password, quota/usage, alias/forwarding lifecycle'ını tamamla; parent/subdomain mail kapsamını kullanıcı seçsin.
- [ ] MX/SPF/DKIM/DMARC ve PTR/rDNS için expected/current/action-needed teşhisi göster; provider port kısıtlarını ayrı raporla.
- [ ] SMTP/IMAP TLS, queue, logs ve service management'i bağla; unauthenticated relay engellensin.
- [ ] Roundcube'u gerçek webmail URL'sine bağla; panel session ile mailbox credential'ını karıştırma.
- [ ] Mailbox/domain delete için impact/backup/restore uygula; mail data/metadata backup modeline dahil olsun.

## I. P3 — Kalan operasyon modülleri

- [ ] MySQL/MariaDB site binding, DB/user CRUD, grants, password rotation, size/status, dump/restore ve connection-info akışlarını tamamla; uygulama DB user'ı minimum privilege alsın.
- [ ] Docker/Compose validation, build/pull/start/stop/restart, env/registry credentials, logs/health, Nginx target ve deploy history ekle; volume/bind inventory + backup politikasını göster.
- [ ] Şifreli application/config/env/DB/volume/mail backup, local/S3-compatible target, retention/checksum, restore preview/progress, pre-restore backup ve outage handling geliştir.
- [ ] Site cron: user/cwd/env/timezone/enable-disable/last-run/output. Site işleri site user, sistem işleri açık Owner/Server bağlamında çalışsın.
- [ ] Gerçek metric history, inode/disk threshold, service/app events, deploy/backup/SSL notifications ve bounded log download ekle. Unknown/stale metric sıfır veya yeşil gösterilmesin.
- [ ] Audit/job detail: actor, resource link, stage, safe error/log, search/filter, cancel/retry. Riskli retry idempotency + lock şartıyla çalışsın.
- [ ] Plesk read-only importer, external-managed state ve Passenger/static/Node/DB/Docker/domain/cron/mail migration + per-resource rollback araçlarını tamamla.

## J. P0–P3 — Test, migration ve yayın kapıları

- [ ] Bootstrap-token temizliği ve agentsiz mimari ilerledikçe mevcut core/deploy/rollback/ACME/job testlerini yeni authorization/local-executor sınırına taşı; test-only network backdoor ekleme.
- [ ] Website migration, resource-scoped access, WebSocket/PTy ve yeni secret yüzeyleri için native/process/browser testleri ekle.
- [ ] Yeni routed UI için component + gerçek browser testleri yaz: login -> site -> child -> Node -> SSL -> mail -> terminal; loading/empty/error/permission/dirty-form/refresh/long-table durumlarını kapsa.
- [ ] Agentsiz package upgrade, schema migration, PTY dependency, restart reconciliation, job-running self-update ve disk-full rollback senaryolarını tamamla.
- [ ] Master-key/backup/restore/resource-exhaustion/panel-outage tatbikatlarını gerçek desteklenen runtime ve test hostunda çalıştır; çalıştırılmayan testi geçmiş sayma.
- [ ] Agentsiz mimari uygulandıkça install/package/dev docs'taki eski agent varsayımlarını temizle; hedef mimariyi uygulanmış davranış gibi belgeleme.
- [ ] `todo.md` içindeki Node 24, browser, HTTPS, package, Ubuntu/DNS/Plesk ve canlı rollback kabulünü tamamlamadan production-ready etiketi verme.

**Yayın sırası:** A güvenlik sınırı -> B agentsiz root backend -> C kalıcı Website modeli -> D UI olgunlaştırma -> E/F/G günlük hosting -> H mail -> I kalan modüller. Arayüz geliştirmesi paralel ilerleyebilir; UI tek başına root/backend veya production-ready kabulü değildir.
