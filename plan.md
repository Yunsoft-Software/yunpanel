# YunPanel — Plesk Referanslı Kalan Geliştirme Planı

Bu dosya yalnız tamamlanmamış ürün/kod işlerini ve bunların kabul kapılarını tutar. Hedef ürün mimarisi `docs/architecture.md`, provisioning recovery sözleşmesi `docs/provisioning-recovery.md`, bağlayıcı geliştirme kuralları `agents.md`, gerçek Ubuntu/browser/provider kabul işleri `todo.md` içindedir.

## 0 — Değiştirilemez ürün kararı: Plesk davranışı referans, hazır servis zorunlu

2026-09-15 ürün kararı:

- YunPanel'in hosting davranışı ve kullanıcı beklentisi için ana referans Plesk Obsidian'dır. Plesk'in birebir kodu/altyapısı kopyalanmaz; domain oluşturma, DNS template, webmail, sistem kullanıcısı, database ve araç erişimi gibi davranışlar referans alınır.
- YunPanel olgun bir servis/uygulama varken File Manager, web terminali, database client, authoritative DNS, webmail, monitoring veya backup arşiv motorunu yeniden yazmaz.
- Hazır servisler: PowerDNS Authoritative, Postfix, Dovecot, Rspamd, Roundcube, MariaDB/MySQL, phpMyAdmin, elFinder, OpenSSH internal-sftp, ttyd, Nginx, PHP-FPM, Passenger, restic/rclone, Netdata, GoAccess ve CrowdSec. Bunların çevresinde yalnız auth/scope bridge, lifecycle orchestration, config validation, health/evidence ve rollback kodu yazılır.
- Plesk'ten daha gevşek izolasyon kabul edilmez. Plesk çoğunlukla subscription başına system user kullanır; YunPanel'de **her bağımsız Website kendi dedicated Unix user/group'una sahip olur**. `shared-site` açıkça seçilmedikçe domain/subdomain başka Website'in OS kimliğini paylaşmaz.
- Roundcube domain başına tekrar kurulmaz. Sunucuda tek shared Roundcube bulunur; local mail kullanan her domain için `webmail.<domain>` DNS + TLS + Nginx vhost shared Roundcube'a bağlanır.
- Nginx worker'ı site başına kullanıcıyla çalıştırılmaz. Nginx shared kalır; PHP site başına PHP-FPM pool/socket ile, Node Passenger `passenger_user/group` ile site UID/GID altında çalışır.
- Homegrown `site-file-manager`, `node-pty` terminal ve benzeri özel ürün yüzeyleri yalnız hazır replacement gerçek acceptance geçene kadar migration fallback'idir; genişletilmez.
- UI ekranı, route, model veya metadata var diye özellik tamamlanmış sayılmaz. Gerçek host üzerinde çalışan servis + izolasyon + health + lifecycle acceptance geçmeden `ready` değildir.

### Plesk'ten alınan davranış kontratı

Aşağıdakiler YunPanel için ürün kontratıdır:

1. **DNS template:** Plesk'te server-wide DNS template vardır; yeni domainin zone'u bu template'ten doldurulur. YunPanel de versioned server-wide Zone Template kullanacak.
2. **Template senkronizasyonu:** Template değişikliği yeni zonelara otomatik uygulanır; mevcut zonelara explicit preview/apply ile taşınır. Kullanıcının elle değiştirdiği kayıtlar sessizce ezilmez.
3. **Webmail:** `webmail.<domain>` domain bağlamında çalışan shared webmail servisine gider. YunPanel'de bu servis Roundcube'dur.
4. **Mail DNS:** Local mail açıkken `mail.<domain>`, MX, webmail, SPF/DKIM/DMARC ve desteklenen mail discovery kayıtları provisioning'in parçasıdır.
5. **System user:** Hosting filesystem işlemleri OS kimliği altında yapılır. YunPanel bunu Plesk'ten daha katı biçimde Website başına ayrı kimlik olarak uygular.
6. **Database:** Database Website ile ilişkilidir ve en az bir scoped DB user üzerinden yönetilir. MySQL/MariaDB yönetim aracı phpMyAdmin'dir; root credential kullanıcıya verilmez.
7. **File access:** Dosya işlemi Website filesystem sınırı içinde yapılır. YunPanel'de bu sınır UI path filtresi değil gerçek OS user/permission sınırıdır.

Plesk referansları:

- DNS Settings / server-wide DNS template: https://docs.plesk.com/en-US/obsidian/administrator-guide/dns/dns-settings.72226/
- Creating Websites / system user: https://docs.plesk.com/en-US/obsidian/administrator-guide/creating-websites.80014/
- Customer Account Administration / subscription system user ve File Manager ownership: https://docs.plesk.com/en-US/obsidian/customer-guide/customer-account-administration.69297/
- Webmail Software: https://docs.plesk.com/en-US/obsidian/administrator-guide/mail/webmail-software.66411/
- Access from Webmail: https://docs.plesk.com/en-US/obsidian/administrator-guide/69294/
- Accessing Databases / phpMyAdmin: https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/website-databases/accessing-databases.71841/

## 1 — Tamamlanma raporlama kontratı

Önceki yaklaşık yüzde tahminleri geçersizdir. Bundan sonra YunPanel için "x% tamamlandı" yalnız aşağıdaki P0 acceptance matrisinden ölçülür; ekran/route/model sayısından yüzdelik çıkarılmaz.

Bir P0 alanı ancak kendi acceptance maddelerinin **tamamı** gerçek Ubuntu host üzerinde geçtiyse `DONE` olabilir:

- [ ] Website OS isolation
- [ ] Authoritative DNS + ns1/ns2 + zone template
- [ ] Mail + Roundcube + external send/receive
- [ ] Database ownership + phpMyAdmin
- [ ] Ready-made File Manager + cross-site isolation
- [ ] TLS/certificate lifecycle
- [ ] Transactional create/delete/reconcile provisioning

Bu yedi çekirdek kapıdan biri dahi gerçek host acceptance bekliyorsa panel "Plesk core parity tamamlandı" diye raporlanmaz. Kaynak testleri geçip gerçek host acceptance yapılamıyorsa madde `CODE COMPLETE / HOST ACCEPTANCE PENDING` olarak tutulur ve gerçek ortam işi `todo.md`'ye yazılır.

---

# P0 — Plesk core parity

## P0.1 — Website başına gerçek Unix user/group ve filesystem izolasyonu

Bu iş DNS/mail/database/file-manager'dan önce güvenlik temeli olarak tamamlanacak.

- [ ] Her bağımsız Website için canonical `createWebsitePathContract` / `createApplicationIdentity` üzerinden dedicated Unix user/group oluştur. Mevcut deterministic `yunapp-*` kimlikleri migration sırasında korunur; domain adı doğrudan Linux username yapılmaz.
- [ ] Site HOME ve SFTP root mevcut mimari kontrata göre `/var/lib/yunpanel/data/<applicationId>` olur. Runtime release alanı `/var/lib/yunpanel/apps/<applicationId>`, current release `current` symlink'i, logs `0750`, private tmp `0700` kalır.
- [ ] Site dosya ve persistent data ownership'i yalnız site UID/GID'de olsun. Panel/root yalnız control-plane operasyonları için erişir; hosted application'a root verilmez.
- [ ] Varsayılan permission/umask policy tanımla (`027` hedefi); world-readable env/secrets oluşturma.
- [ ] PHP için site başına PHP-FPM pool/socket üret: `user=<site-user>`, `group=<site-group>`. Shared pool ile iki siteyi çalıştırma.
- [ ] Node/Passenger vhost `passenger_user/group` ile canonical site kimliğini kullanır. Yeni Node Website direct-systemd golden path'e düşmez.
- [ ] Nginx shared servis olarak kalır; yalnız gereken static/document-root read/traverse izni verilir. Nginx process'ini site UID'si yapma.
- [ ] OpenSSH internal-sftp site user'ı aynı site root'una sınırlar. SSH shell varsayılan kapalı; Owner server terminali ayrı root ttyd oturumudur.
- [ ] Independent subdomain ayrı Website ise ayrı user/group alır. Alias user/runtime/mailbox yaratmaz. `shared-site` açık seçim olmadan parent user paylaşılmaz.
- [ ] Mevcut Website'ler için inspect-only isolation drift raporu ve explicit migration planı üret; körlemesine recursive `chown` yapma.

Kabul:

- [ ] Site A UID'si Site B home/env/release/log/tmp dosyalarını okuyamaz/yazamaz.
- [ ] Site A PHP/Node process'i gerçek OS üzerinde Site A UID/GID ile çalışır.
- [ ] Site A SFTP oturumu Site B path'ine `..`, symlink veya absolute path ile kaçamaz.
- [ ] Panel restart/reconcile mevcut user/path ownership'i bozmaz ve idempotent kalır.

## P0.2 — Sunucu kimliği, ns1/ns2 ve PowerDNS Authoritative

- [ ] PowerDNS Authoritative paket/install/config/upgrade/health adapter'ını tamamla. Recursor gibi davranmasın; public recursive DNS açılmasın.
- [ ] PowerDNS HTTP API yalnız loopback/Unix-network sınırında kalsın; API key encrypted secret store'da tutulur ve browser'a verilmez.
- [ ] Settings > Network/DNS altında şu server identity alanlarını yönetilebilir yap:
  - panel/server FQDN hostname;
  - primary public IPv4 ve opsiyonel IPv6;
  - `ns1` FQDN + IPv4/IPv6;
  - `ns2` FQDN + IPv4/IPv6;
  - default SOA primary NS, RNAME, refresh/retry/expire/minimum;
  - default TTL;
  - DNSSEC default policy;
  - varsa external secondary/slave DNS hedefi.
- [ ] `ns1`/`ns2` hostname'lerinin parent zone/glue gereksinimini tespit et. Registrar glue panel tarafından yönetilmiyorsa yapılmış gibi gösterme; exact hostname/IP talimatı ve `pending delegation/glue` durumu göster.
- [ ] UDP 53 ve TCP 53 local/public health ayrımını ölç. Firewall kapalıysa veya PowerDNS answer vermiyorsa DNS `ready` olmasın.
- [ ] `ns1` ve `ns2` aynı host/IP ise sistem çalışabilir fakat redundancy varmış gibi healthy gösterme. İkinci IP veya external secondary gereksinimini warning/blocker policy olarak sun.
- [ ] Authoritative NS setini domain provisioning ve zone template'in tek kaynağı yap; adapter'lar kendi NS değerini üretmesin.

Kabul:

- [ ] Delegated test domain için `dig @ns1 ... SOA`, `NS`, `A` ve `dig @ns2 ...` authoritative cevap verir.
- [ ] TCP/UDP 53 ikisi de geçer; recursion isteği açık resolver gibi cevaplanmaz.
- [ ] Registrar başka NS'ye işaret ediyorsa YunPanel bunu `ready` değil `delegation pending/mismatch` gösterir.

## P0.3 — Plesk tarzı versioned DNS Zone Template ve tam zone yönetimi

Server-wide Zone Template birinci sınıf ürün kaynağı olacak.

- [ ] Versioned `DnsZoneTemplate` modeli oluştur. Placeholder'lar en az `<domain>`, `<server-ipv4>`, `<server-ipv6>`, `<ns1>`, `<ns2>`, `<mail-host>`, `<webmail-host>` desteklesin.
- [ ] Her local-DNS domain yaratılırken kullanılan template version/snapshot'ı operation evidence olarak kaydet.
- [ ] Template değişiklikleri varsayılan olarak yalnız yeni zoneları etkiler. Mevcut zonelara `Preview changes` + explicit `Apply to this zone` / `Apply to all eligible zones` akışı ekle.
- [ ] Template kaynaklı kayıt ile user-created/edited kaydı ayıran ownership/source metadata tut. Template sync user-modified kaydı sessizce silmesin/değiştirmesin.
- [ ] Zone CRUD PowerDNS canonical state'ine bağlı olsun. Destek: `SOA`, `NS`, `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `CAA`, `SRV`; TTL ve PowerDNS serial davranışı doğrulansın.
- [ ] Validation: duplicate/invalid owner name, bad FQDN, MX/SRV priority/weight/port, TXT, CNAME coexistence conflict, apex kuralları ve zone dışı hedef formatı.
- [ ] DNSSEC enable/disable/key lifecycle ve DS bilgisini ekle; registrar'a DS yazılmadıysa yalnız zone imzalandı diye delegation secure gösterme.

### Yeni domain için servis-aware default zone

Local DNS seçilen yeni ana domain aşağıdaki kayıtları seçili servislere göre üretir:

**Her local-DNS Website:**

- [ ] SOA
- [ ] apex `NS -> ns1`
- [ ] apex `NS -> ns2`
- [ ] apex `A -> site/server IPv4`
- [ ] apex `AAAA -> IPv6` yalnız gerçek IPv6 varsa
- [ ] `www` CNAME/apex alias policy

**Local mail açık ise:**

- [ ] `mail.<domain>` A/AAAA
- [ ] apex MX -> `mail.<domain>`
- [ ] `webmail.<domain>` A/AAAA veya service-aware alias
- [ ] SPF TXT
- [ ] DKIM selector TXT; key generation tamamlandıktan sonra gerçek public key ile
- [ ] `_dmarc` TXT; güvenli başlangıç policy'si config'ten
- [ ] `_imaps._tcp` / `_smtps._tcp` ve diğer discovery kayıtları yalnız ilgili servis/port gerçekten açıksa
- [ ] `autodiscover`/`autoconfig` DNS veya HTTP endpoint kayıtları yalnız gerçek YunPanel mail-autodiscover endpoint'i kurulduysa

**FTP:**

- [ ] `ftp.<domain>` kaydı varsayılan oluşturma. YunPanel V1 OpenSSH SFTP kullanır. İleride gerçek FTP servisi explicit etkinleştirilirse template bunu service-aware ekleyebilir.

- [ ] Domain DNS ekranında zone tamamını görüntüle, create/edit/delete yap, source (`template`, `mail`, `runtime`, `manual`) ve drift göster.
- [ ] External DNS/Cloudflare kullanan domaini sessizce PowerDNS'e migrate etme; local/external authority explicit seçimdir.

Kabul:

- [ ] Yeni local-DNS domain tek operation içinde zone'u default kayıtlarla alır.
- [ ] Elle değiştirilmiş kayıt template re-apply sırasında korunur veya kullanıcıya açık conflict olarak gösterilir.
- [ ] `webmail`, MX veya DKIM gibi servis kaydı ilgili servis kapalıyken dead record olarak yaratılmaz.

## P0.4 — Mail: Postfix + Dovecot + Rspamd + shared Roundcube

Mevcut yarım mail ayarları Plesk benzeri domain lifecycle'a bağlanacak; mail `ready` yalnız gerçek SMTP/IMAP/webmail health ile verilecek.

- [ ] Postfix + Dovecot + Rspamd install/config/inspect/validate/reload/rollback adapter'larını tek mail service manager altında tamamla.
- [ ] Mail domain, mailbox, alias/forwarder, quota ve password hash state'ini SQL-backed virtual mail modeline bağla. Website system user ile mailbox OS identity'sini karıştırma.
- [ ] Mail storage dedicated mail identity (`vmail` benzeri) altında tutulur; Website Unix user mailbox Maildir owner'ı yapılmaz.
- [ ] Local mail seçilen domain provisioning sırasında mail domainini oluşturur fakat varsayılan/parolası bilinen mailbox oluşturmaz. İlk mailbox explicit parola ile yaratılır; `postmaster`/`abuse` alias'ları policy ile eklenebilir.
- [ ] `mail.<domain>` SMTP/Submission/IMAP endpoint'ini oluştur ve doğrula: inbound SMTP 25, submission 587; 465 ve IMAPS 993 policy'ye göre. Plain auth yalnız TLS altında.
- [ ] DKIM key domain provisioning sırasında üret; private key secret-safe kalır, public TXT DNS intent'ine eklenir.
- [ ] SPF/DMARC/DKIM DNS desired-state ile mail state aynı operation evidence'ında ilişkilendirilsin.
- [ ] Outbound sender-login/auth policy, relay denial, rate/abuse limitleri ve Rspamd integration doğrulansın.
- [ ] Queue/log görünümü gerçek Postfix/Rspamd verisinden gelsin; sahte `sent` state üretme.
- [ ] Forwarder/alias lifecycle'ı ve gerekiyorsa SRS desteği ekle.
- [ ] ClamAV opsiyonel profile olsun; RAM/disk/daemon health yetersizse antivirus aktif gösterilmesin.

### Roundcube/webmail kontratı

- [ ] Roundcube sunucu başına **tek shared package/application** olarak kurulsun; protected config + dedicated service PHP-FPM pool/socket kullanılsın.
- [ ] Her local-mail ana domain için `webmail.<domain>` DNS intent'i, ACME certificate ve Nginx vhost shared Roundcube'a bağlansın.
- [ ] `https://webmail.<domain>` login ekranı full email address + mailbox password ile Dovecot IMAP'a authenticate etsin; gönderim authenticated Postfix submission üzerinden olsun.
- [ ] Domain silme/mail disable işlemi o domainin webmail DNS/vhost/cert mapping'ini kaldırır; shared Roundcube paketini başka domainler kullanıyorsa kaldırmaz.
- [ ] Mail autodiscover/autoconfig gerçek endpoint'i ekle; Outlook/Thunderbird/Apple için desteklenen config çıktısı server policy'den üretilsin. Endpoint yokken sadece DNS kaydı üretme.
- [ ] External DNS kullanan local-mail domain için panel exact gerekli MX/mail/webmail/SPF/DKIM/DMARC kayıtlarını `pending external DNS` olarak gösterir; provider adapter varsa apply eder.

Kabul:

- [ ] `webmail.<domain>` gerçek Roundcube login ekranı açar ve valid mailbox ile login olur.
- [ ] Aynı Roundcube instance ikinci domain için de çalışır; domain başına application kopyası yoktur.
- [ ] Gerçek dış test mailbox'ından inbound mail gelir; YunPanel mailbox'ından dış adrese outbound mail gider.
- [ ] SMTP relay unauthenticated kullanıcıya kapalıdır; TLS/certificate doğrulanır.
- [ ] DKIM signature doğrulanır; SPF/DMARC DNS kayıtları authoritative veya external DNS üzerinde beklenen state'tedir.
- [ ] Mail disable/delete başka domainin mailbox/webmail state'ini bozmaz.

## P0.5 — Website database ownership + phpMyAdmin

- [ ] MariaDB/MySQL service install/health/secure-baseline adapter'ını tamamla. Root/admin credential encrypted store dışında tutulmaz ve frontend'e verilmez.
- [ ] Database, Website ile explicit ilişkilendirilir. DB isimleri ve kullanıcıları deterministic/unique prefix policy ile üretilir; raw domain adına güvenilmez.
- [ ] Her Website için oluşturulan database user yalnız o Website'e bağlı schema/database'lerde grant alabilir. `*.*` veya başka Website database'lerine privilege verme.
- [ ] Site Databases ekranında gerçek CRUD: create database, create/rotate/revoke user, grant role, connection info, drop preview.
- [ ] Website create akışına `Create initial database` seçeneği ekle. Runtime/app bunu gerektiriyorsa initial schema + scoped user aynı provisioning operation'ında yaratılabilir; blank/static Website'e gereksiz database zorla yaratılmaz.
- [ ] phpMyAdmin server başına tek shared hardened install olarak kurulsun.
- [ ] Site Databases ekranındaki `Open phpMyAdmin` Website/site DB user scope'uyla açılsın. Desteklenen signon/short-lived handoff kullanılabilir; root DB credential URL, localStorage veya browser session payload'ına yazılmaz.
- [ ] Direct phpMyAdmin admin/login yüzeyinin panel auth ve deployment policy'si net olsun; YunPanel one-click akışı site scope'unu atlayamasın.
- [ ] Import/export/dump işlemleri vendor tooling ile ve Website scope altında yapılır; ikinci SQL client yazılmaz.
- [ ] Create/drop/grant/rotation durable job + evidence + rollback/compensation contract'ını kullanır.

Kabul:

- [ ] Site A DB user `SHOW DATABASES`/grant seviyesinde Site B'nin private schema'sını okuyamaz/yazamaz.
- [ ] Site A phpMyAdmin handoff'u Site B database'ine erişemez.
- [ ] DB password rotation sonrası uygulama/panel state tutarlı kalır; eski credential revoke edilir.
- [ ] Site silme preview'sı DB ve data-loss etkisini açık gösterir; explicit data retention seçimi olmadan sessiz destructive cascade yapılmaz.

## P0.6 — Homegrown File Manager'ı kaldır, hazır elFinder'ı gerçek OS izolasyonuyla bağla

- [ ] Mevcut özel `site-file-manager` API/UI genişletmesini durdur.
- [ ] elFinder shared application/client olarak kur/yapılandır; fakat connector root/panel UID ile arbitrary `root_path` parametresi alarak çalışmasın.
- [ ] Her Website File Manager connector isteği gerçek site UID/GID altında çalışsın. Tercih edilen model siteye ait PHP-FPM pool/socket üzerinden connector execution'dır.
- [ ] Connector root'u canonical Website HOME/SFTP root'tan server-side resolve edilir; browser/path parametresinden güvenilmez.
- [ ] YunPanel authenticated session -> short-lived, audience-bound Website token -> connector mapping uygula. Token başka Website ID ile reuse edilemesin.
- [ ] Upload, download, edit, rename, move, copy, delete, mkdir, archive create/extract işlemleri hazır elFinder üzerinden çalışsın.
- [ ] Path traversal, symlink escape, archive extraction escape/zip-slip, hidden secret exposure, permission escalation ve cross-site read/write testlerini ekle.
- [ ] Vendor/admin endpoint'i public doğrudan açma; same-origin authenticated gateway veya güvenli vhost policy kullan.
- [ ] elFinder acceptance gerçek hostta geçince özel `site-file-manager` backend/frontend ürün yüzeyini küçük migration commit'iyle kaldır. Yalnız reusable path/evidence helper'ları gerekiyorsa tutulur.
- [ ] elFinder site-UID isolation acceptance'ını güvenilir biçimde sağlayamazsa homegrown manager'a geri dönme; mimari karar güncellenerek Filestash + localhost SFTP gibi ikinci olgun ürün değerlendirilir.

Kabul:

- [ ] Site A File Manager Site B dosyasını göremez, okuyamaz, yazamaz veya symlink/archive trick ile kaçamaz.
- [ ] File Manager'da oluşturulan dosyanın owner'ı gerçek Site A Unix user/group olur.
- [ ] Connector URL'si/token'ı bilen logged-out kullanıcı erişemez; logout/revoke sonrası session çalışmaz.
- [ ] Ana dosya yönetimi homegrown `site-file-manager` üzerinden yapılmaz.

## P0.7 — IntegratedToolGateway: phpMyAdmin, elFinder ve ttyd için ortak auth/scope

- [ ] Ortak `IntegratedToolGateway` ekle: Owner/session authorization, Website scope, short-lived audience token, same-origin reverse proxy, WebSocket/HTTP upgrade, revoke/logout ve health/version contract.
- [ ] Vendor admin portları public internete açılmaz; loopback/Unix socket veya explicit protected vhost kullanılır.
- [ ] phpMyAdmin ve elFinder Website context token'ı başka siteye replay edilemez.
- [ ] ttyd on-demand one-shot process/socket açar; site terminali site user/cwd, Sunucu terminali yalnız Owner root olur.
- [ ] ttyd acceptance sonrası custom `node-pty` + xterm.js backend/frontend migration fallback'i kaldırılır.
- [ ] Roundcube public `webmail.<domain>` ürünü olduğundan Owner panel gateway'ine bağımlı yapılmaz; kendi mailbox auth'u ve mail-domain lifecycle'ı kullanır.

Kabul:

- [ ] Unauthenticated veya wrong-Website session integrated araca erişemez.
- [ ] Logout/revoke aktif tool session/WebSocket'i sonlandırır.
- [ ] Vendor secret/DB root credential/token URL, localStorage, audit, job veya application loguna sızmaz.

## P0.8 — Transactional Website/domain provisioning: tek butonda gerçekten Plesk gibi kur

Yeni Website/domain oluşturma yalnız DB metadata insert'i değildir. Her create operation durable, idempotent, resumable ve reverse-order compensatable olacak.

### Preflight

- [ ] FQDN/IDN normalize + duplicate/parent/alias conflict kontrolü.
- [ ] Runtime, local/external DNS, local/external/disabled mail, database seçimi, IPv4/IPv6, certificate ve SFTP policy preview.
- [ ] Gerekli package/service health; PowerDNS, Nginx, runtime, MariaDB ve mail dependencies eksikse apply başlamadan blocker göster.
- [ ] Oluşturulacak OS user, paths, DNS records, DB, mail domain, vhosts ve certificates exact preview.

### Apply sırası

1. [ ] Website/application identity ve operation ID reserve et.
2. [ ] Dedicated Unix user/group + canonical home/data/release/log/tmp path'lerini oluştur.
3. [ ] Runtime adapter'ını site UID/GID ile hazırla: Passenger/PHP-FPM/static/Python/Compose.
4. [ ] Nginx site vhost'unu stage et; `nginx -t` geçmeden activate/reload yapma.
5. [ ] Local DNS ise PowerDNS zone'u exact Zone Template snapshot'ından oluştur.
6. [ ] Database seçildiyse scoped DB/schema + DB user/grant oluştur.
7. [ ] Local mail ise mail domain + DKIM key oluştur; mail service-aware DNS kayıtlarını zone/external DNS intent'ine ekle.
8. [ ] `webmail.<domain>` Nginx mapping + shared Roundcube lifecycle'ını hazırla.
9. [ ] SFTP/File Manager scope, logs/analytics ve cron boundary'yi Website identity'ye bağla.
10. [ ] ACME certificate'ları seçili website/mail/webmail hostnames için al ve bağla. DNS henüz delegated değilse operation açık `pending certificate/delegation` state taşısın; sahte success verme.
11. [ ] Nginx/PHP/Passenger/PowerDNS/Postfix/Dovecot/Roundcube/DB/tool health postcondition'larını ölç.
12. [ ] Zorunlu seçili kaynakların hepsi health-gated ise Website `ready` commit et.

### Failure/recovery

- [ ] Her step durable evidence + ownership kaydeder; panel restart sonrası körlemesine step'i tekrar etmez, önce inspect eder.
- [ ] Failure'da resource state `partial/failed` açık görünür; Website `ready` olmaz.
- [ ] Retry yalnız failed/unapplied step'ten devam eder; upstream revision drift varsa fail-closed olur.
- [ ] Compensation reverse order ile çalışır ve yalnız operation-owned resource'u kaldırır. Kullanıcının mevcut zone/DB/file kaynağını sahiplik kanıtı olmadan silmez.
- [ ] Config write atomic olur; `nginx -t`, PHP-FPM config test, `doveconf`, Postfix check ve PowerDNS health geçmeden ilgili service reload edilmez.

Kabul — fresh-host golden test:

- [ ] Yeni delegated domain tek Website create operation'ından sonra HTTP/HTTPS cevap verir.
- [ ] Zone'da servis-aware default kayıtlar vardır ve ns1/ns2 authoritative answer verir.
- [ ] Dedicated Unix user vardır ve runtime o UID/GID ile çalışır.
- [ ] Local mail seçildiyse `mail` + `webmail` + MX/SPF/DKIM/DMARC state hazırdır ve Roundcube login olur.
- [ ] DB seçildiyse site-scoped DB/user vardır ve phpMyAdmin açılır.
- [ ] File Manager yalnız site root'unu görür ve oluşturduğu dosya site user'a aittir.
- [ ] Aynı provisioning request/reconcile ikinci kez çalıştırıldığında duplicate user/zone/vhost/db/mailbox oluşturmaz.

## P0.9 — Suspend, delete ve rollback Plesk seviyesinde lifecycle

- [ ] Website suspend web/runtime erişimini durdurur fakat data retention policy'ye göre dosya/DB/mail verisini sessizce silmez.
- [ ] Domain remove ile Website delete ayrı işlemdir. Alias/subdomain dependency açık preview edilir.
- [ ] Website delete preview: Unix user/home, runtime, Nginx, cert, DNS zone, mail domain/mailboxes, DB/schema/users, SFTP, logs, backup ilişkileri ve data-loss etkisini listeler.
- [ ] Mailbox/DB/file data deletion için typed confirmation ve retention seçenekleri kullan.
- [ ] Delete reverse dependency order'da ve ownership evidence ile çalışır. Shared Roundcube/phpMyAdmin/PowerDNS/MariaDB package'ı bir site silindi diye kaldırılmaz.
- [ ] Delete failure `partial deletion` state bırakır ve kalan resource'ları gösterir; retry idempotent olur.

---

# P1 — Core parity sonrasında kalan hosting fonksiyonları

## P1.1 — Runtime adapter'larını production golden path'e tamamla

- [ ] Yeni Node Website release hazırlama ile supervisor activation'ı ayır; direct-systemd unit yaratmadan Passenger binding -> Nginx -> health zincirini kullan.
- [ ] Passenger dependency/env/log/startup/config validation ve rollback fail-closed olsun.
- [ ] PHP-FPM distro PHP + site pool/socket adapter'ını tamamla; çoklu PHP sürümü doğrulanmış repository olmadan açılmasın.
- [ ] Static deploy/rollback Website identity + binding revision ile durable/idempotent çalışsın.
- [ ] Python adapter: site user venv + Gunicorn/Uvicorn systemd unit.
- [ ] Managed Docker Compose Website altında dedicated project/network/volume identity kullansın.

## P1.2 — Backup/restore: restic + rclone

- [ ] Özel archive formatı geliştirmeyi durdur; restic repository lifecycle: init/test/check/unlock/snapshot/retention/forget/prune.
- [ ] rclone remote registry/test ve encrypted credential store.
- [ ] Website backup setine files/persistent data/env metadata, database dump, mail data, DNS/Nginx config ve Compose volume hooks bağla.
- [ ] Restore preview + pre-restore snapshot + health gate + deterministic rollback.

## P1.3 — Monitoring, analytics ve security

- [ ] Netdata loopback-only + authenticated YunPanel gateway.
- [ ] GoAccess site-specific Nginx access logs + report/WebSocket.
- [ ] nftables tek firewall ownership policy; UFW ile aynı state'in iki yazarı olma.
- [ ] CrowdSec engine/bouncer health + SSH/SMTP/web collections + safe ban/unban.
- [ ] Fail2ban/CrowdSec duplicate ownership yaratma; seçilen abuse engine tek authority olsun.

## P1.4 — Site özellikleri

- [ ] Site-user cron/systemd timer CRUD, timezone/cwd/env, enable/disable, last/next run, bounded output.
- [ ] WordPress detection + WP-CLI site user altında.
- [ ] PHP Composer Website context'inde site user altında.
- [ ] Redis/Memcached için per-site ACL/socket/namespace veya isolated instance policy.
- [ ] Settings: Panel, Network, Website defaults, DNS/SSL, Mail/Webmail, Databases, Backup, Security, Monitoring gerçek backend state'iyle doldur.

---

# P2 — Migration temizliği ve son ürün yüzeyi

- [ ] elFinder acceptance sonrası custom `site-file-manager` kaldır.
- [ ] ttyd acceptance sonrası custom `node-pty` terminal kaldır.
- [ ] Passenger acceptance sonrası yeni site path'inde direct-systemd compatibility üretimini kaldır; yalnız legacy migration adapter'ı olarak tut, migration bitince fiziksel temizle.
- [ ] restic acceptance sonrası custom backup archive yollarını kaldır.
- [ ] Agentless local backend acceptance tamamlanınca retained legacy agent transport/package/state yüzeyini kaldır.
- [ ] Plesk read-only importer'ını en son ekle: Website/Domain, Unix identity mapping, runtime, DB, DNS, mail, cron, cert ve backup mapping preview + rollback ile.
- [ ] Backend/functionality tamamlandıktan sonra site-merkezli enterprise UI/UX, responsive layout, table/form polish ve accessibility ayrı tasarım aşamasında yapılır.

---

# Uygulama sırası — bundan sapma ancak açık blocker ile

1. **Website Unix isolation** — dedicated user/group/path + runtime UID acceptance.
2. **PowerDNS + server ns1/ns2** — authoritative server identity ve delegation health.
3. **Versioned DNS Zone Template** — Plesk tarzı service-aware default records + zone CRUD.
4. **Mail + shared Roundcube** — mail domain, DKIM, `mail`, `webmail`, external send/receive.
5. **Database + phpMyAdmin** — Website scoped schema/user/grant + one-click safe access.
6. **elFinder** — site UID connector + homegrown file manager removal acceptance.
7. **Transactional create/delete provisioning** — yukarıdaki parçaları tek idempotent Website lifecycle'a birleştir.
8. **TLS/autodiscover/recovery hardening** — golden fresh-host P0 acceptance matrixini kapat.
9. **Runtime migration/backup/monitoring/security/site extras.**
10. **Legacy cleanup ve en son UI/UX polish.**

Her küçük dilim source testleriyle commit edilir. GitHub Actions kullanılmaz. Bu ortamda gerçek Ubuntu, public DNS delegation, SMTP deliverability, browser/provider veya package install gerektiren acceptance yapılamıyorsa ilgili exact komut/expected result `todo.md`'ye bırakılır; plan maddesi host acceptance geçmeden `DONE` yapılmaz.