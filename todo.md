# YunPanel — Gerçek Ortam / Kabul TODO

Bu dosyada yalnız kaynak testleriyle güvenilir biçimde tamamlanamayacak gerçek Ubuntu, package, browser, DNS/provider, mail delivery, storage ve rollback kabulleri tutulur. Kod işleri `plan.md`, hedef mimari `docs/architecture.md`, bağlayıcı kurallar `agents.md` içindedir.

IP adresi `.44` ile biten Plesk sunucusu kesinlikle kapsam dışıdır. Bütün SSH/package/deploy testleri yalnız repo dışı `.local/test-server.env` içindeki açık YunPanel test sunucusunda, hedef adresin `.44` olmadığı doğrulandıktan sonra yapılır. Secret/parola/cookie/MFA/private key ekran görüntüsü, rapor, log veya repoya yazılmaz.

## T-CODEX-HANDOFF — mevcut P0 turu

Bu maddeler kaynak kod connector ortamında yazılabilir fakat shell/package/live-host yetkisi olmadığı için burada doğrulanamaz. Codex bunları küçük adımlarla uygulasın/doğrulasın; GitHub Actions kullanmasın ve `.44` ile biten Plesk sunucusuna kesinlikle dokunmasın.

- [ ] Güncel `main` çekildikten sonra Node `>=24.11.1` ve npm `>=11` ile temiz `npm ci` ardından `npm run check` çalıştır. Provisioning/Passenger/test failure varsa yalnız ilgili küçük fixleri ayrı commitlerle at; test çıktısında secret bırakma.
- [ ] Passenger control-plane kaynak testlerini gerçek checkout üzerinde özellikle çalıştır: `packages/protocol/test/domain-passenger-stage.test.js`, `packages/protocol/test/node-passenger-migration.test.js`, `apps/api/test/job-registry-passenger-migration.test.js`, `apps/api/test/local-job-executor.test.js`, `apps/api/test/application-passenger-migration-*.test.js`, `apps/api/test/website-domain-target.test.js`, `apps/api/test/domain-stage-target-job-registry.test.js` ve `apps/api/test/passenger-domain-stage-reconciliation.test.js`. Migration queue/result sanitization, private reconciliation payload snapshot, persisted Passenger binding, Passenger-aware normal `domain.stage`, proxy-only Nginx ayarlarının Passenger payload'a taşınmaması ve binding Domain revision/checksum ilerlemesi birlikte geçsin. Bu connector oturumunda source testleri koşturulamadı.
- [ ] `apps/api` provisioning registry/orchestrator/HTTP testlerini gerçek checkout üzerinde çalıştır; failed step'in explicit `retry` ile `pending` durumuna dönüp normal durable apply yolundan ilerlediğini, non-failed step retry'sinin reddedildiğini ve operation+step-bound confirmation olmadan mutation yapılmadığını doğrula. Bu connector oturumunda source testleri koşturulamadı.
- [ ] Provisioning reverse-order compensation testlerini gerçek checkout üzerinde çalıştır: downstream `applying`, `succeeded`, `failed` veya `compensating` iken daha erken step compensation'ı `website_provisioning_compensation_order_invalid` ile reddedilsin ve HTTP projection `canCompensate=false` göstersin; downstream `pending`, `blocked` veya `compensated` olduğunda güvenli erken-step compensation tekrar açılabilsin. Bu connector oturumunda source testleri koşturulamadı.
- [ ] Güncel provisioning compensation source testlerini gerçek checkout üzerinde çalıştır: Unix identity `operationId`/evidence wiring'i, Nginx rollback receipt'i, static runtime exact-release rollback/drift guard'ı, compensation restart reconcile'ı ve exact `compensate-site-provisioning:<operationId>:<stepId>` confirmation kontratı geçsin. `useradd` sonrası durable UID/GID checkpoint varsa evidence kaybında operation-owned identity cleanup çalışsın; `useradd` sonucu belirsizken checkpoint oluşmadıysa `userdel`/`groupdel`/home delete kesinlikle yapılmasın. Bu connector oturumunda source testleri koşturulamadı.
- [ ] `packages/host-runtime` canonical Website/Application identity/path testlerini gerçek checkout üzerinde çalıştır: `application-identity`, `website-path-contract`, `website-identity-path-manager` ve `website-static-deployment-manager` testleri geçsin. UUID/path escape, custom managed roots, canonical HOME=`/var/lib/yunpanel/data/<applicationId>`, `tmp=0700`, logs/home=`0750`, SFTP root=HOME ve backup artifact authority'nin control-plane/root-private kalması regresyon üretmesin.
- [ ] Static runtime source testlerinde `website-static-deployment-manager`, `static-deployment-legacy-fallback`, `static-deployment-router`, `static-deployment-root-routing`, `static-rollback-router` ve `static-rollback-root-routing` birlikte geçsin: canonical identity deploy ve rollback'tan önce seçilsin; yalnız önceden var olan exact `yunapp-*` + group + HOME=`/var/lib/yunpanel/build/<applicationId>` legacy fallback'e uygun sayılsın; eksik/mismatched identity yeni user yaratmasın veya `current` symlink'ini değiştirmesin; fallback içinde `/usr/sbin/useradd` fiziksel olarak reddedilsin; canonical deploy `runuser` HOME'unu `/var/lib/yunpanel/data/<applicationId>` olarak sabitlesin. Retained agent'ın explicit legacy deploy/rollback subpath testleri de regresyon vermesin.
- [ ] `.local/test-server.env` içindeki YunPanel test hostunun `.44` olmadığını doğrula; Ubuntu 24.04 üzerinde `nginx`, `libnginx-mod-http-passenger`/Passenger, `passenger-config`, managed Node 22/24 pathleri ve `nginx -t` gerçek durumunu kaynaktaki inspector beklentileriyle karşılaştır.
- [ ] Yeni durable Website provisioning store ile API restart testi yap: apply sonrası operation JSON diskte kalsın; `applying` durumda servis kesilip açıldığında aynı mutation ikinci kez körlemesine çalışmasın ve inspect/reconcile yolu kullanılsın.
- [ ] İki test Website oluşturup `yunapp-*` kullanıcı/group/home sahipliğini, çapraz home/release/data erişim reddini ve Passenger `passenger_user/group` gerçek UID/GID eşleşmesini doğrula.
- [ ] Test hostunda canonical static Website deploy/rollback mevcut provisioned `yunapp-*` hesabını kullansın ve hesabın HOME'unu `/var/lib/yunpanel/build/<applicationId>` olarak değiştirmesin. Ayrı migration fixture'ında yalnız önceden var olan HOME=`/var/lib/yunpanel/build/<applicationId>` legacy hesabı fallback ile deploy/rollback edebilsin; hesap yoksa, group/home drift varsa veya deploy sırasında identity kaybolursa `useradd` çalışmasın ve rollback `current` symlink'ine dokunmadan fail-closed kalsın. `/var/lib/yunpanel/backups/resources` site user'a chown edilmesin ve root/control-plane private scope olarak kalsın.
- [ ] Passenger package/config veya Node binary eksikliği senaryolarında provisioning `ready` olmasın; actionable blocked/failed state API'de kalsın. Düzelttikten sonra exact `continue-site-provisioning:<operationId>` confirmation ile işlem kaldığı step'ten devam etsin.
- [ ] Bu turda production wiring tamamlandıktan sonra clean `.deb` build/install/upgrade smoke yap; provisioning state ve Website identity ownership receipt dosyalarının package upgrade sırasında korunup root-owned private izinlerde kaldığını doğrula.

## T-BASE — P0 güncel güvenlik ve package kapısı

- [ ] Güncel `main` için desteklenen Node 24 ile temiz `npm ci`, `npm run check` ve matching Ubuntu mimarisinde `.deb` build çalışsın.
- [ ] Clean install ve önceki paketten upgrade; auth DB/master key, Domain/Website/Application kimlikleri, release'ler, Nginx/certificate, mail/database state'i ve root-owned private izinleri korusun.
- [ ] Production exact `YUNPANEL_LOCAL_SERVER_ID` + OS hostname olmadan başlamasın; uzak/eski server detail/mutation ve retained agent transport fail-closed kalsın.
- [ ] Gerçek HTTPS Owner setup/login/TOTP/recovery/session/logout/logout-all/idle/absolute timeout, CSRF, rate-limit ve trusted-proxy sınırı Chromium/Firefox'ta çalışsın.
- [ ] Read Only yalnız izinli GET/HEAD yüzeylerine erişsin; tool gateway, terminal, phpMyAdmin signon, filesystem connector, mutation/jobs/users/audit secret alanları backend'de 403 kalsın.
- [ ] Audit actor/action/resource/outcome/time tutarken password/cookie/CSRF/env/service credential, vendor token, terminal content, mailbox content ve raw provider response taşımadığını doğrula.

## T-PROVISIONING — P0 yeni Website ve izolasyon

- [ ] Fresh Ubuntu hostta yeni Website preview/apply operation'ı dedicated Unix user/group, home, document root/release, data/tmp/log/backup scope ve seçilen runtime'ı oluşturabilsin; metadata-only state `ready` görünmesin.
- [ ] İki Website ile çapraz izolasyonu gerçek UID/GID altında test et: file/env/release/data/log/socket/terminal/database credential erişimi reddedilsin.
- [ ] Independent subdomain ayrı identity alırken `shared-site` açık seçimi parent identity'yi paylaşsın; alias user/runtime/mailbox üretmesin.
- [ ] Provisioning'i her step sınırında kes: intent sonrası, host mutation sonrası evidence öncesi ve compensation sırasında. Restart kör mutation tekrarlamasın; partial state ve düzeltme adımı görünür olsun.
- [ ] Gerçek failure injection ile bir provisioning step'ini `failed` duruma düşür; yalnız exact `retry-site-provisioning:<operationId>:<stepId>` confirmation ile retry edilebildiğini, aynı Website identity/path contract'ında normal durable apply/inspect yolundan ilerlediğini ve non-failed/yanlış-step/duplicate retry'nin fail-closed kaldığını doğrula.
- [ ] Gerçek Ubuntu failure injection ile Unix identity, Nginx ve static runtime compensation'ını ters sırada doğrula: Nginx/static runtime gibi downstream step `applying`/`succeeded`/`failed`/`compensating` iken `unix_identity` geri alma isteği 409 ile reddedilsin ve user/group/home'a dokunulmasın; downstream operation-owned kaynaklar compensate edildikten sonra identity cleanup açılabilsin. Yalnız exact `compensate-site-provisioning:<operationId>:<stepId>` confirmation mutation yapsın; önceden var olan identity/vhost/release korunsun. Compensation ortasında restart sonrası inspect/reconcile devam etsin; UID/GID/checksum/current-release drift veya ownership checkpoint eksikliği destructive cleanup yerine actionable fail-closed state bıraksın.
- [ ] Site move/delete impact gerçek DNS, mail/webmail, database/grant, SFTP, GoAccess, restic, cron ve active job ilişkilerini göstersin; implicit cascade yapmasın.

## T-RUNTIME — P0 Passenger, PHP-FPM ve hosted app sürekliliği

- [ ] Ubuntu 24.04 paketinde Nginx Passenger kurulumu/version/configtest/health çalışsın. Yeni Node Website explicit `passenger_user/group`, startup file, Node binary ve env ile site UID/GID altında başlasın.
- [ ] Passenger shared-hosting izolasyonunu iki gerçek Node app ile doğrula; başka site startup file/user seçimi veya raw Passenger/Nginx directive privilege escalation üretemesin.
- [ ] Mevcut direct-systemd Node app için migration preview/apply provası yap. Sağlıklı geçişte aynı release/env/URL Passenger'a taşınsın; health/config/reload failure eski systemd app ve Nginx trafiğini çalışır bıraksın.
- [ ] Passenger migration başarılı olduğunda `ApplicationRuntimeBinding` disk store'da `active` olarak kalsın; API restartından sonra normal Domain stage/re-stage eski `127.0.0.1:<systemd-port>` hedefine dönmek yerine Passenger `appRoot/startupFile/nodeBinary` hedefini yeniden materyalize etsin. Domain desired revision ilerlediğinde başarılı stage binding içindeki exact Domain revision + Nginx checksum evidence'ını ilerletsin; restart/reconciliation retry aynı evidence'ı ikinci bir farklı binding state'i üretmeden idempotent tamamlasın.
- [ ] `cleanup_required` Passenger migration senaryosunda trafik Passenger'da kalırken eski `yunpanel-node-*.service` gerçekten stopped/disabled olsun veya durum açıkça cleanup-required kalsın. API/process restartından sonra aynı migration apply/reconciliation güvenli biçimde devam etsin; legacy systemd route normal Domain restage ile geri gelmesin.
- [ ] Migration hostunda `yunapp-*` UID/GID/HOME ve izinleri doğrula: HOME=`/var/lib/yunpanel/data/<applicationId>`, managed home/log `0750`, tmp `0700`, login shell/nologin policy canonical contract'la eşleşsin; Passenger process gerçekten bu user/group altında çalışsın.
- [ ] Site başına PHP-FPM pool/socket gerçek UID/GID, private tmp/session path, bounded ini/resource policy ile çalışsın; başka site socket/document root erişimi reddedilsin.
- [ ] Static Website gerçek provisioned site user altında build/deploy/rollback etsin; process environment `HOME=/var/lib/yunpanel/data/<applicationId>` olsun, build workspace ayrı `/var/lib/yunpanel/build/<applicationId>` altında kalabilsin ve deploy motoru ikinci Unix identity yaratmasın. Eski build-home identity yalnız kanıtlı migration fallback olarak kabul edilsin; fresh/unproven identity için fallback user yaratmasın veya rollback symlink mutation'ı yapmasın.
- [ ] Static, Passenger Node ve PHP Website; YunPanel API/web restartı ve package upgrade sırasında hizmet vermeye devam etsin.

## T-TOOLS — P0 ttyd, elFinder, phpMyAdmin/pgAdmin gateway

- [ ] ttyd yalnız loopback/Unix socket ve on-demand one-shot session olarak başlasın. Owner root terminali ile Website site-user terminalinde exact user/cwd, Ctrl+C/Ctrl+D, Unicode/IME, resize, `vim`/`top`, parallel sessions ve disconnect cleanup çalışsın.
- [ ] Yanlış Origin/cookie/MFA/role/audience/Website, expired/replayed tool token ve doğrudan ttyd port/socket erişimi reddedilsin. Logout/logout-all/session revoke/user disable açık terminali ve process group'u derhal kapatsın; audit output/keystroke tutmasın.
- [ ] elFinder connector yalnız seçilen Website root'unu ve site UID/GID'yi kullansın. Upload/download/edit/rename/move/mkdir/archive; traversal, absolute path, symlink escape, special file, oversize ve çapraz-site denemeleri gerçek filesystem üzerinde doğrulansın.
- [ ] elFinder/ttyd replacement kabulü tamamlanınca özel site-file-manager ve node-pty/xterm yollarının kaldırılması upgrade/rollback ile denenip açık session/orphan bırakmadığı doğrulansın.
- [ ] phpMyAdmin shared endpoint'i yalnız YunPanel signon üzerinden açılsın; Site A least-privilege DB kullanıcısı Site B schema'sını listeleyemesin. Root DB credential browser, PHP session dump, process env, URL, job, audit veya loga çıkmasın.
- [ ] PostgreSQL/pgAdmin açıldığında aynı Website role/scope, gateway auth ve çapraz-site reddi gerçek PostgreSQL ile doğrulansın.

## T-DNS — P0 PowerDNS ve nameserver

- [ ] PowerDNS Authoritative real Ubuntu package, SQL backend, API'nin loopback-only oluşu, secret izinleri, service restart/upgrade ve health endpoint'i doğrulansın.
- [ ] Zone/RRset create-update-delete/no-op; SOA serial, NS, A/AAAA/CNAME/MX/TXT/CAA/SRV, TTL, wildcard, IDN ve DNSSEC API üzerinden gerçek authoritative cevapla doğrulansın.
- [ ] New Website local-DNS provisioning'i apex/www/mail/webmail kayıtlarını seçilen policy'ye göre oluştursun; external-DNS Website'e örtülü PowerDNS zone eklemesin.
- [ ] En az iki bağımsız authoritative endpoint veya onaylı secondary DNS ile delegation/transfer/failover testi yap. Tek host iki NS adıyla healthy gösterilmesin; glue/parent delegation eksikliği actionable kalsın.
- [ ] DNSSEC enable/disable, DS bilgisi, rollover ve yanlış parent DS failure'ı gerçek resolver ile test edilsin.
- [ ] Mevcut Cloudflare record ve Certbot DNS-01 akışı external-DNS modunda least-privilege tokenla çalışsın; PowerDNS state'iyle karışmasın; token hiçbir public yüzeye çıkmasın.

## T-MAIL — P0 Postfix/Dovecot/Rspamd/Roundcube

- [ ] Local mail seçilen Website provisioning'i mail domain desired state, gerekli DNS intent'leri, TLS identity ve `webmail.<domain>` Nginx route'unu oluştursun; mail seçilmediyse bunları üretmesin.
- [ ] Shared Roundcube package + dedicated PHP-FPM pool/socket + protected config/database gerçek Ubuntu hostta kurulsun. Her local mail domainin `webmail.<domain>` URL'si aynı shared instance'a güvenle ulaşsın; domain başına kopya oluşmasın.
- [ ] Roundcube login'i gerçek Dovecot IMAP ve Postfix submission ile geçerli enabled mailbox'ta çalışsın; yanlış/disabled/başka domain credential reddedilsin. Varsayılan parola/public registration bulunmasın.
- [ ] SMTP 25 relay policy, submission 587 STARTTLS/auth/sender-login, Maildir LMTP, quota, alias/forwarding/SRS, Rspamd Milter, DKIM signing ve SPF/DMARC DNS sonuçları gerçek inbound/outbound teslimle doğrulansın.
- [ ] Mail config/DKIM/Roundcube apply işlemlerinde validator, replace, reload, health ve durable completion kesintileri eski çalışan config'e deterministic rollback etsin; secret/hash/PEM/mail body/path public response/job/audit/log/receipt'e çıkmasın.
- [ ] ClamAV profile açıldığında package/resource/health ve EICAR mail testi geçsin; kapalı/eksik durumda antivirus aktif gösterilmesin.

## T-DATABASE — P0 site ownership ve canlı envanter

- [ ] Website'e bağlı MySQL/MariaDB schema + user/grant gerçek local socket üzerinden oluşsun; Site A kullanıcısı Site B schema/table/metadata'sına erişemesin; rotation/revoke eski credential'ı kapatsın.
- [ ] Database/server GET her sayfa açılışı ve refreshte canlı inventory versin; “sunucuyu tara” job'u gerektirmesin. Create/drop/grant mutation'ları durable job ve post-condition kanıtıyla kalsın.
- [ ] phpMyAdmin signon sonrası görünen schema seti aynı grant sınırıyla eşleşsin; direct phpMyAdmin URL YunPanel session olmadan erişilemesin.
- [ ] MariaDB/MySQL backup/restore vendor dump + restic akışında checksum, consistency, pre-restore snapshot ve rollback ile doğrulansın.

## T-BACKUP — P1 restic/rclone

- [ ] Local restic repository init/backup/snapshot/check/restore/forget/prune akışını gerçek Website release/data/env metadata, Nginx/DNS config, DB dump ve Maildir ile doğrula.
- [ ] S3-compatible ve rclone remote için encrypted credential, target test, network interruption, partial upload, retry/idempotency, checksum ve retention doğrulansın; secret argv/URL/process list/job/audit/log/browser'a çıkmasın.
- [ ] Çalışan Passenger/PHP/Docker, database ve mail kaynaklarında quiesce/vendor dump hooks tutarlı snapshot üretsin; panel sessiz live filesystem kopyasını başarılı backup saymasın.
- [ ] Restore exact snapshot/resource/dependency revision, typed confirmation ve pre-restore snapshot kullansın; runtime/database/mail health failure eski state'e dönsün.
- [ ] Gerçek disaster-recovery provasında boş hosta gerekli config/state/artifact restore edilip en az bir Website, database ve mailbox doğrulansın; sonuç ve tarih secret-free rapora yazılsın.

## T-OBSERVABILITY-SECURITY — P1 Netdata, GoAccess, CrowdSec

- [ ] Netdata yalnız loopback dinlesin ve YunPanel authenticated reverse proxy arkasında gerçek CPU/RAM/load/disk/inode/service/container verisi göstersin; doğrudan port public erişilemesin.
- [ ] GoAccess her Website'in ayrı Nginx logundan static ve real-time rapor üretsin; Site A raporu Site B hostname/path/client verisini göstermesin; WebSocket proxy/restart/rotation çalışsın.
- [ ] nftables ownership/reconcile gerçek hostta mevcut SSH yönetim erişimini kilitlemeden uygulanıp rollback edilsin. UFW/direct nftables çifte-yazar drift'i tespit edilip mutation bloklansın.
- [ ] CrowdSec engine + firewall bouncer gerçek SSH/SMTP/Nginx logunu okuyup test decision'ını nftables'a uygulasın; ban/unban, IPv4/IPv6, restart ve health görünürlüğü çalışsın.

## T-SITE-FEATURES-SETTINGS — P1

- [ ] Site cron/systemd timer gerçek site UID/GID/cwd/env ile çalışsın; last/next run ve bounded/redacted output doğru olsun; başka Website'e veya root'a yükselmesin.
- [ ] OpenSSH internal-sftp key lifecycle/chroot/path/permission isolation iki Website hesabıyla doğrulansın. FTP varsayılan olarak dinlemesin.
- [ ] WordPress Website'te WP-CLI ve PHP Website'te Composer yalnız site user/cwd ile çalışsın; Redis/Memcached açılırsa per-site ACL/socket/namespace çapraz erişimi engellesin.
- [ ] Settings Panel, Network/NS, Website defaults, DNS/SSL, Mail/Webmail, Databases, Backup/storage, Security, Monitoring/logs, Users/audit ve package versions alanlarını gerçek persisted state/health ile göstersin; boş placeholder kalmasın.

## T-DOCKER-PYTHON-MIGRATION — P2

- [ ] Managed Compose Website kendi project/network/volume/log/terminal/backup scope'uyla başka Website'ten izole çalışsın; Docker Engine/Compose dışındaki genel yönetim yeniden yazılmasın.
- [ ] Portainer adapter'ı açılırsa yalnız authenticated Owner gateway'i, local endpoint ve secret-safe session ile erişilsin; direct port public olmasın.
- [ ] Python venv + Gunicorn/Uvicorn Website gerçek site user/systemd sandbox, Nginx health ve rollback ile çalışsın.
- [ ] Agentless migration/rollback bütün yeni vendor config/state, `yunapp-*` identity, release, PowerDNS, restic, Roundcube, tool gateway ve secrets'i korusun; ardından legacy agent fiziksel olarak kaldırılabilsin.
- [ ] Plesk importer yalnız `.44` olmayan açık fixture veya offline export üzerinde read-only discovery yaparak Passenger/PHP/static/Node, domain/DNS, DB, mail, cron ve backup mapping preview'ı üretsin.

## T-UI — Son kabul

- [ ] Günlük navigasyonda uygulamalar yalnız ait oldukları Website altında görünsün; global Application ekranı yalnız Owner tanılama envanteri olsun.
- [ ] Website tabs runtime/capability'ye göre Hosting, Deploy, DNS, SSL, Mail/Webmail, Databases/phpMyAdmin, Files/elFinder, Logs/GoAccess, Terminal/ttyd, Backup, Cron ve Settings'i gerçek çalışır durumla göstersin.
- [ ] Gerçek Chromium/Firefox, mobil viewport, klavye ve ekran okuyucu ile deep-link/reload/back-forward, loading/error/missing dependency, modal confirmation ve uzun job progress davranışı doğrulansın.

## Yayın kuralı

Repoda adapter veya test bulunması canlı kabul anlamına gelmez. İlgili bölümün gerçek Ubuntu/package/browser/DNS/mail/storage/rollback kanıtı tamamlanmadan capability production-ready gösterilmez. GitHub Actions kullanılmaz.