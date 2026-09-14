# YunPanel hedef mimarisi

Bu belge YunPanel'in bağlayıcı ürün mimarisini tanımlar. `agents.md` uygulama kurallarını, `plan.md` kalan kod işlerini, `todo.md` ise yalnız gerçek ortam kabul testlerini tutar.

## 1. Ürün sınırı

YunPanel bir dosya yöneticisi, web terminali, veritabanı istemcisi, mail istemcisi, DNS sunucusu, metrik veritabanı veya yedek arşiv formatı icat etmeyecektir. YunPanel'in işi şunlardır:

- Owner authentication, authorization, MFA, session ve audit sınırını sağlamak;
- Website, domain/subdomain, runtime, Unix kullanıcısı, database, mailbox, DNS zone ve backup ilişkilerini tutmak;
- olgun servisleri güvenli adapter'larla kurmak, yapılandırmak, doğrulamak ve güncellemek;
- uzun veya etkili işlemleri durable job, resource lock, health gate ve rollback ile yürütmek;
- hazır araçları YunPanel oturumunun ve site yetkisinin arkasında site bağlamında göstermek.

Bir özellik için olgun ve bakımı süren bir araç varsa YunPanel aynı ürünün ikinci bir sürümünü yazmaz. Özel kod yalnız kimlik/izin köprüsü, bounded configuration, lifecycle orchestration, health/evidence ve UI entegrasyonunda kullanılır.

## 2. Mevcut durumun dürüst özeti

2026-09-14 kaynak denetimine göre:

- Node.js uygulamaları Passenger ile çalışmıyor. Her uygulama ayrı `yunapp-*` hesabı ve ayrı systemd unit'iyle çalışıyor.
- Static ve Node workload için Unix kullanıcı, release dizini, build/deploy ve process izolasyonu var; fakat bu henüz eksiksiz Plesk-benzeri Website provisioning değildir.
- `/applications` bütün uygulamaları sunucu genelinde gösteriyor. Hedef site-merkezli ürün modeline aykırıdır.
- Dosya ekranı YunPanel'in kendi `site-file-manager` API/UI uygulamasıdır; elFinder/Filestash entegrasyonu değildir.
- Terminal YunPanel'in kendi `node-pty` + xterm.js WebSocket uygulamasıdır; ttyd entegrasyonu değildir.
- Database ekranı kendi inventory/create/delete akışıdır; phpMyAdmin veya pgAdmin yoktur.
- DNS tarafında external lifecycle/Cloudflare adapter'ı vardır; authoritative NS sunucusu ve PowerDNS zone yönetimi yoktur.
- Roundcube için package/config orchestration parçaları vardır; fakat yeni siteyle otomatik `webmail.<domain>`, çalışan webmail endpoint'i ve tam kabul edilmiş lifecycle yoktur.
- Settings yalnız hesap, güncelleme ve birkaç gelişmiş bağlantı gösterir; sunucu varsayımları ve servis politikaları yönetilemez.

Bu temeller güvenlik ve migration için korunabilir; yukarıdaki özel ürün yüzeyleri genişletilmeyecek, aşağıdaki hazır servis adapter'ları kabul edildikçe emekli edilecektir.

## 3. Kaynak ve izolasyon modeli

Ana kaynak `Website`'tır. Normal kullanıcı akışı Web Siteleri listesinden bir Website'e girer ve yalnız o Website'in kaynaklarını görür.

Her bağımsız Website şu kimlikleri sahiplenir:

- immutable Website ID;
- dedicated Unix user/group (`yunapp-*` mevcut kimlikleri migration sırasında korunur);
- home, document root/current release, persistent data, tmp, logs ve backup scope;
- tek bir runtime adapter'ı ve ona bağlı bir veya daha çok site-içi app/process;
- açık Domain/subdomain/alias ilişkileri;
- siteye bağlı database + least-privilege database user/grant;
- isteğe bağlı mail domain, mailbox/alias ve `webmail.<domain>` erişimi;
- DNS zone/record ownership, certificate, cron, SFTP ve trafik raporu.

Alias hiçbir Unix kullanıcısı, mailbox veya runtime üretmez. Bağımsız subdomain ayrı Website olarak oluşturulursa ayrı kullanıcı/runtime alır; parent Website altında çalışan subdomain açıkça `shared-site` seçilirse parent kimliğini paylaşır. Bu karar hostname parçalarından tahmin edilmez.

Bir Website'in uygulamaları başka Website ekranında görünmez. Sunucu genelindeki process/application envanteri yalnız Owner'ın Sunucu > Gelişmiş/Tanılama alanında bulunabilir; günlük navigasyonda global `Uygulamalar` ürünü yoktur.

## 4. Hazır servis kararları

| Alan | Karar | YunPanel'in sorumluluğu |
| --- | --- | --- |
| Web server | Nginx | Site vhost template'i, config test, atomic activate/rollback |
| Node.js | **Phusion Passenger + Nginx varsayılanı** | Runtime sürümü, startup file, `passenger_user/group`, env, health ve deploy; mevcut systemd process modeli yalnız migration/compatibility adapter'ı |
| PHP | PHP-FPM, site başına pool/socket | Distro PHP ile başla; çoklu sürümü ancak doğrulanmış paket kaynağıyla ekle; pool kullanıcı/limit/ini ayrımı |
| Python | venv + Gunicorn/Uvicorn | Ayrı site user/systemd unit; Node Passenger geçişini bloke etmez |
| Files | **elFinder** | YunPanel session-bound connector token; yalnız site root; connector site kullanıcısı/PHP-FPM pool'u altında. Arşivlenmiş `filebrowser/filebrowser` kullanılmaz |
| Terminal | **ttyd** | Kalıcı public ttyd yok; loopback/Unix socket üzerinde on-demand, one-shot session; site user veya Owner root target; YunPanel auth/revocation gateway'i |
| MySQL/MariaDB UI | **phpMyAdmin** | Shared tek kurulum; site database user/grant; YunPanel signon handoff; site ekranında scope edilmiş giriş |
| PostgreSQL UI | **pgAdmin 4** | PostgreSQL desteği açıldığında ayrı adapter ve site database role; P0 MySQL/MariaDB'yi geciktirmez |
| Mail | Postfix + Dovecot + Rspamd | Domain/mailbox/alias/DKIM/quota desired state, config validation, delivery/auth health ve rollback |
| Webmail | **Roundcube** | Sunucu başına shared kurulum; her local mail domain için `webmail.<domain>` DNS + Nginx route; IMAP mailbox auth. Domain başına ikinci Roundcube kurulmaz |
| Mail antivirus | ClamAV, opsiyonel | Kaynak yeterliliği/health; eksikse mail hazırmış gibi gösterme |
| Authoritative DNS/NS | **PowerDNS Authoritative + HTTP API** | Zone/RRset/DNSSEC lifecycle, SOA/NS defaults, API secret; registrar delegation ayrı gözlem. Tek host iki bağımsız NS varmış gibi gösterilmez |
| ACME | Mevcut Certbot adapter'ı | Çalışan Certbot/Cloudflare kodu korunur; sırf alternatif var diye acme.sh ile ikinci motor eklenmez |
| SFTP | OpenSSH internal-sftp | Site user chroot/path/keys; FTP varsayılan değil, yalnız açık ihtiyaçla ProFTPD/Pure-FTPd adapter'ı |
| Docker | Docker Engine/Compose | Website'e bağlı proje, network/volume ownership; gelişmiş genel UI gerekiyorsa opsiyonel Portainer gateway'i |
| Monitoring | **Netdata** | Loopback agent + YunPanel authenticated reverse proxy; kendi time-series motorunu yazma |
| Site analytics | **GoAccess** | Siteye özel Nginx access logundan rapor/real-time WebSocket; site sekmesinde göster |
| Firewall/abuse | nftables + **CrowdSec** | Tek firewall ownership modeli, allowlisted port/service policy, CrowdSec decisions/bouncer health. UFW ve özel nftables state'i çakıştırma |
| Backup | **restic** | Repository/retention/policy, consistent pre-hooks, snapshot evidence ve restore orchestration; özel archive formatı yazma |
| Remote backup | **rclone** | restic rclone backend veya doğrulanmış remote target; credential store ve target test |
| Cron | systemd timers veya cron | Site user/cwd/env, enable/disable, output/status ve association |
| WordPress | WP-CLI | Website context, site user ve bounded command adapters |
| PHP packages | Composer | Site user altında, Website context'inde |
| Cache | Redis/Memcached | Shared serviste per-site ACL/socket/db policy veya explicit isolated instance; secret ve namespace ayrımı |

Passenger ve PM2 aynı uygulamanın iki supervisor'ı yapılmaz. Yeni Node Website'lerde Passenger varsayılandır; PM2 ancak sonradan açıkça seçilen compatibility adapter'ı olarak değerlendirilebilir.

## 5. Yeni Website provisioning sözleşmesi

“Site oluşturuldu” cevabı yalnız metadata kaydı anlamına gelmez. Yeni Website akışı durable, yeniden başlatılabilir bir provisioning operation üretir:

1. İstek preview'ı runtime, domain, IP, DNS/mail seçenekleri, oluşturulacak kaynaklar ve çakışmaları gösterir.
2. Website kimliği ile dedicated Unix user/group ve private/public dizin sınırları hazırlanır.
3. Seçilen runtime adapter'ı kurulur: Passenger Node, PHP-FPM, static, Python veya Managed Compose.
4. Nginx vhost hazırlanır ve `nginx -t` sonrası etkinleştirilir.
5. Local DNS seçildiyse PowerDNS zone; SOA/NS ve gerekli A/AAAA/CNAME/MX/TXT kayıtları oluşturulur. Parent registrar delegasyonu yalnız doğrulanır, otomatik yapılmış sayılmaz.
6. Local mail seçildiyse mail domain hazırlanır; `webmail.<domain>` DNS/vhost shared Roundcube'a bağlanır. Varsayılan/parolası bilinen mailbox oluşturulmaz; ilk mailbox ayrı explicit adımda parola ile açılır.
7. İsteğe bağlı database schema + siteye özel database user/grant oluşturulur; root credential frontend'e verilmez.
8. SFTP, logs, GoAccess, cron ve restic policy site kimliğine bağlanır.
9. DNS, HTTP, runtime, certificate, mail ve hazır araç health sonuçları kaydedilir. Zorunlu adım başarısızsa operation `ready` olmaz; uygulanmış adımlar compensation/rollback kanıtıyla ele alınır.

Provisioning policy Settings'te değiştirilebilir: varsayılan runtime, PHP/Node sürümü, local DNS/mail/database oluşturma, nameserver seti, IPv4/IPv6, backup policy ve security profile.

## 6. UI bilgi mimarisi

### Website ekranı

- Genel bakış
- Hosting / Runtime
- Git & Deploy
- Domainler & DNS
- SSL
- Mail / Webmail
- Databases / phpMyAdmin (ve varsa pgAdmin)
- Files / elFinder
- Logs & Traffic / GoAccess
- Terminal / ttyd
- Backup / Restore
- Scheduled Tasks
- Settings

Sekmeler runtime ve kurulu capability'ye göre gösterilir; eksik dependency sahte empty-state değil, gerçek kurulum/teşhis eylemi verir.

### Sunucu ekranı

Sunucu geneli yalnız host kaynakları içindir: servisler/paketler, Netdata, firewall/CrowdSec, Docker/Portainer, mail queue, PowerDNS/NS, storage, updates, root terminal ve tanılama. Servis ve database envanteri normal GET'te canlı okunur; kullanıcıya “sunucuyu tara” diye job başlatılmaz. Mutation'lar durable job kalır.

### Settings

Settings boş bir bağlantı listesi değildir. En az şu bölümler bulunur:

- Panel: public URL, hostname, timezone, update channel, trusted proxy;
- Network: public IP'ler, ports, authoritative nameserver seti, secondary DNS durumu;
- Website defaults: runtime, Node/PHP sürümü, user quota/limits, web root ve log retention;
- DNS & SSL: PowerDNS health/API, default TTL/SOA/NS, DNSSEC, Certbot/provider;
- Mail & Webmail: mail hostname, Roundcube URL, TLS, spam/antivirus policy;
- Databases: enabled engines, phpMyAdmin/pgAdmin health, database defaults;
- Backup & storage: restic repository, rclone target, schedule, retention, last restore test;
- Security: firewall policy, CrowdSec, SSH/SFTP, session/MFA policy;
- Monitoring & logs: Netdata, GoAccess ve retention;
- Users, audit, package/service versions ve diagnostics.

## 7. Entegrasyon güvenlik standardı

- Hazır servislerin yönetim portları public dinlemez; mümkünse Unix socket, değilse yalnız loopback kullanır.
- Dış UI her zaman YunPanel same-origin gateway ve backend authorization arkasındadır. Bir iframe veya gizli URL tek başına yetkilendirme değildir.
- Gateway site/Owner scope'u kısa ömürlü, audience-bound token veya trusted auth header ile taşır; browser'a kalıcı service credential verilmez.
- Tool process'i doğru site UID/GID ve cwd ile çalışır. Site A token'ı Site B root'una, database user'ına, ttyd socket'ine veya loguna erişemez.
- Vendor config'i bounded template/adapter üretir; serbest directive/argv/shell girişi yoktur. Apply öncesi vendor validator, sonrası health check ve rollback vardır.
- Vendor sürümleri ve security support paket manifestinde izlenir. Arşivlenen veya security fix almayan ürün yeni kurulumda bloklanır.
- Secrets URL, browser storage, process list, generic job result, audit veya loga yazılmaz.

## 8. Kaynakta korunacak ve emekli edilecek parçalar

Korunacak: auth/MFA/session/audit, local root control plane, durable jobs/locks/recovery ilkeleri, Domain/Website kimlikleri, Nginx/Certbot adapter'ları, secret store, site Unix kullanıcıları, release/deploy/rollback, mail desired-state ve health doğrulama temelleri.

Kademeli emekli edilecek veya compatibility durumuna çekilecek:

- özel `node-pty`/xterm terminal, ttyd acceptance sonrasında;
- özel file-manager UI/API, elFinder acceptance sonrasında;
- özel database yönetim UI'sinin phpMyAdmin/pgAdmin ile çakışan bölümleri;
- büyütülmekte olan özel aggregate archive/remote backup motoru, restic+rclone adapter'ı hazır olduğunda;
- global `/applications` günlük navigasyonu;
- yeni Node uygulamalar için direct systemd runtime, Passenger migration tamamlandığında.

Eski kod yeni adapter production acceptance geçmeden silinmez. Migration identity, permissions, release path ve rollback kanıtını korur; yeni ve eski runtime aynı Website için aynı anda aktif edilmez.

## 9. Resmi teknik dayanaklar

- Passenger Nginx user switching ve `passenger_user/group`: <https://www.phusionpassenger.com/docs/references/config_reference/nginx/>
- ttyd reverse-proxy auth, UID/GID, cwd, origin, one-shot ve Unix socket seçenekleri: <https://github.com/tsl0922/ttyd>
- PowerDNS Authoritative Zones API/DNSSEC: <https://doc.powerdns.com/authoritative/http-api/zone.html>
- phpMyAdmin signon authentication: <https://docs.phpmyadmin.net/en/latest/setup.html#signon-authentication-mode>
- Roundcube Nginx kurulumu: <https://github.com/roundcube/roundcubemail/wiki/Installation>
- elFinder connector root/access control: <https://github.com/Studio-42/elFinder/wiki/Connector-configuration-options>
- restic rclone backend: <https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html>
- Netdata Nginx reverse proxy: <https://learn.netdata.cloud/docs/netdata-agent/configuration/securing-agents/running-the-agent-behind-a-reverse-proxy/nginx>
- GoAccess real-time HTML/WebSocket: <https://goaccess.io/man>
- CrowdSec firewall bouncer: <https://docs.crowdsec.net/u/bouncers/firewall/>
- Arşivlendiği için kullanılmayacak File Browser: <https://github.com/filebrowser/filebrowser>
