# YunPanel External / Plesk TODO

Bu dosya yalnızca bu geliştirme ortamından doğrudan yapılamayan, gerçek Plesk/Ubuntu sunucusu erişimi gerektiren veya production/test sunucusunda doğrulanması gereken işleri takip eder.

Normal kod geliştirme işleri buraya taşınmamalıdır; onlar `plan.md` kapsamında uygulanmalıdır.

## Kullanım kuralı

Bir madde buraya ancak aşağıdaki nedenlerden biriyle girer:

- gerçek sunucuya SSH/root erişimi gerekir,
- Plesk panelinde manuel kontrol/değişiklik gerekir,
- gerçek DNS kaydı değiştirmek gerekir,
- gerçek domain üzerinde SSL/mail doğrulaması gerekir,
- production verisi/servisi üzerinde test gerekir,
- firewall/port/provider/network işlemi gerekir,
- gerçek backup/restore veya migration tatbikatı gerekir,
- bu ortamın erişemediği secret/credential gerekir.

Her tamamlanan maddede mümkünse sonuç, tarih ve kısa doğrulama notu bırakılmalıdır.

`todo.md`, geliştirme bittikten sonra topluca düzenlenen bir liste değildir. Kod geliştirmesi sırasında harici doğrulama ihtiyacı oluştuğu anda aynı çalışma turunda buraya eklenmeli; doğrulama denendiğinde başarı/başarısızlık sonucu ve tarih aynı turda işlenmelidir. `plan.md`, `todo.md` ve gerçek kod durumu bilinçli olarak birbirinden kopuk bırakılmamalıdır.

## 2026-09-09 test sunucusu erişim durumu

- [x] **Sağlanan YunPanel test sunucusuna SSH erişimini tekrar doğrula.**
  - 2026-09-09 tarihinde 22/TCP bağlantısı, SSH host-key doğrulaması ve root parola authentication akışı başarıyla tamamlandı.
  - İlk envanterde `Ubuntu 22.04.5 LTS` olan host, aynı gün kullanıcı talebiyle ve yerel/sunucu tarafında doğrulanmış yedek alındıktan sonra `Ubuntu 24.04.5 LTS` sürümüne yükseltildi.
  - Yükseltme sonrasında kernel `6.8.0-139-generic`, systemd 255.4, Nginx 1.24.0, Node.js 24.20.0 ve Certbot 2.9.0 doğrulandı; bekleyen paket, başarısız systemd unit'i veya reboot gereksinimi kalmadı.
  - İlk salt-okunur envanterde Plesk, Nginx, Apache, Passenger, Node.js, Docker, MySQL/MariaDB, Certbot ve mail stack kurulu değildi; bu çalışma kapsamında yalnızca YunPanel testleri için gereken Nginx, Node.js ve Certbot kuruldu. Plesk/Apache/Passenger/Docker/database/mail stack halen kurulu değildir.
  - Sunucu IP'si, root parolası veya başka credential değerleri bu dosyaya/Git geçmişine yazılmamalıdır.
  - Kimlik bilgileri yalnızca Git tarafından ignore edilen, `0600` izinli yerel dosyada tutulmaktadır.

---

# P0 — İlk envanter ve güvenli test ortamı

- [x] **YunPanel için ayrı bir Ubuntu 24.04 LTS test sunucusu hazırla.**
  - Production Plesk sunucusunda ilk geliştirme/test yapılmamalı.
  - Minimum olarak public/private IP, SSH erişimi ve sudo/root yetkisi sağlanmalı.
  - Test sunucusu mümkünse production'a benzer Node/Docker/MySQL koşullarına sahip olmalı.
  - 2026-09-09: Sağlanan ve production dışı olduğu belirtilen boş test hostu, upgrade öncesi yedek alınarak Ubuntu 22.04.5 LTS'den Ubuntu 24.04.5 LTS'ye yükseltildi. Kalıcı Netplan yapılandırması `/32` adres ve on-link gateway ile düzeltildi; iki reboot sonrasında SSH, network ve YunPanel servisleri doğrulandı.

- [ ] **Mevcut Plesk sunucusunun tam servis envanterini çıkar.**
  - Ubuntu sürümü.
  - Plesk sürümü/build.
  - Nginx sürümü.
  - Apache sürümü ve gerçekten hangi sitelerde gerekli olduğu.
  - Passenger sürümü.
  - Kurulu Node.js sürümleri.
  - MySQL/MariaDB sürümü.
  - Docker Engine/Compose sürümü.
  - Postfix/Qmail hangisinin kullanıldığı.
  - Dovecot durumu.
  - Rspamd/SpamAssassin durumu.
  - Roundcube sürümü ve erişim domaini.
  - Certbot/ACME/Plesk Let's Encrypt extension durumu.

- [ ] **Plesk'teki mevcut domain/application envanterini dışa aktar.**
  - Domain.
  - Document root.
  - App tipi: static / Node Passenger / Docker / diğer.
  - Repo varsa repo URL ve branch.
  - Startup file.
  - Node version.
  - Environment variable isimleri (secret değerleri repo/dökümana plaintext koyma).
  - Database bağlantıları.
  - Cron jobs.
  - SSL durumu.
  - Mail kullanıp kullanmadığı.

- [ ] **Plesk'te hangi uygulamaların gerçekten Apache gerektirdiğini belirle.**
  - Eğer ihtiyaç yoksa YunPanel V1'de Apache desteği ertelenecek.
  - `.htaccess` kullanan veya Apache-specific rewrite kullanan projeler ayrıca listelenmeli.

- [ ] **Production değişikliklerinden önce güncel Plesk backup al ve restore edilebilirliğini doğrula.**
  - Sadece backup job'unun başarılı görünmesi yeterli değil.
  - En az bir test restore senaryosu ayrı test alanında doğrulanmalı.

---

# P0 — Plesk/SSH üzerinden okunması gereken yapılandırmalar

- [ ] **Bir örnek Passenger Node uygulamasının gerçek Plesk config'ini incele ve güvenli örnek çıkar.**
  - Nginx vhost parçaları.
  - Apache vhost parçaları varsa.
  - Passenger application root.
  - startup file.
  - Node interpreter path.
  - environment mode.
  - restart davranışı.
  - log path'leri.
  - Kullanıcı/grup ownership bilgileri.
  - Secret değerleri örnek çıktıda maskelenmeli.

- [ ] **Bir örnek static React build domaininin Plesk config'ini incele.**
  - document root,
  - SPA fallback davranışı,
  - cache headers,
  - gzip/brotli durumu,
  - SSL redirect,
  - www/non-www redirect,
  - log path'leri.

- [ ] **Bir örnek Docker projesinin Plesk tarafındaki gerçek kurulumunu incele.**
  - container/project isimleri,
  - network,
  - volume/bind mounts,
  - environment kaynakları,
  - public port mapping,
  - Nginx reverse proxy hedefi,
  - restart policy,
  - persistent data lokasyonları.

- [ ] **Plesk'in mevcut Nginx template/custom include davranışlarından kullanılanları listele.**
  - Özel `Additional nginx directives` alanı kullanılan domainleri işaretle.
  - Bu özel directive'ler migration öncesi manuel incelenmeli.

---

# P0 — YunPanel test agent kurulumu

Bu maddeler agent kodu hazırlandıktan sonra test Ubuntu sunucusunda yapılacak.

- [ ] YunPanel `.deb` paketini test sunucusundaki APT repository üzerinden kur ve mevcut `/etc/yunpanel` ile `/var/lib/yunpanel` durumunun korunduğunu doğrula.
- [ ] Paneldeki `system.upgrade` akışıyla daha yeni YunPanel paketine geç; job sonucu, gecikmeli servis restartı, yeni sürüm ve mevcut domain/application sağlığını doğrula.

- [x] YunPanel için dedicated Linux system user/group oluştur.
- [x] `yun-agent` için systemd service kur.
- [x] Agent config/secrets için root-protected dizin oluştur.
- [ ] Agent'ın ihtiyaç duyduğu sudo/polkit/privilege modelini test sunucusunda uygula.
- [x] Agent'ın normal panel backend'inden ayrı kullanıcı altında çalıştığını doğrula.
- [x] Agent tarafından kullanılacak filesystem dizinlerinin ownership/permission modelini doğrula.
- [x] Agent bağlantısı için firewall/network erişimini aç.
- [x] Agent'ın yalnızca beklenen port/interface üzerinde dinlediğini doğrula.
- [x] Agent restart sonrası otomatik ayağa kalkıyor mu doğrula.
- [ ] Agent credential rotation prosedürünü gerçek sunucuda test et.

2026-09-09 doğrulaması: control plane `yunpanel` kullanıcısıyla, ayrıcalıklı ajan root ile ayrı systemd servislerinde çalıştırıldı. API `127.0.0.1:3001`, ajan `127.0.0.1:4010` üzerinde dinliyor; dışarıya ajan portu açılmadı. Ajan identity/config dizini `0700`, dosyaları `0600`; uygulama environment dizini `0700`, dosyası `0600` doğrulandı. Ajan ve API reboot sonrasında otomatik başladı ve enrollment identity yeniden kullanıldı. Bu test separation'ı kanıtlar; ajanı root yerine sınırlı sudo/polkit yetkilerine indirme maddesi halen açıktır. Hostta UFW inaktif olduğundan "network erişimi" yalnızca gerekli loopback akışı ile dışarıdan erişilen SSH/HTTP portlarının çalıştığını ifade eder, kalıcı firewall policy doğrulaması değildir.

---

# P0 — Nginx gerçek sunucu doğrulamaları

Nginx adapter/template kodu hazırlandıktan sonra:

- [x] Test sunucusuna üretilen ilk static vhost config'ini uygula.
- [x] `nginx -t` doğrulamasını gerçek sunucuda çalıştır.
- [x] Geçerli config sonrası reload'un kesintisiz olduğunu doğrula.
- [x] Bilerek hatalı config ile YunPanel'in çalışan config'i bozmadığını doğrula.
- [x] Duplicate domain ekleme korumasını gerçek Nginx state ile test et.
- [ ] `www`/non-`www` alias ve redirect davranışını gerçek DNS/domain ile test et.
- [ ] Large upload/proxy timeout gerektiren Node uygulaması için gerçek davranışı test et.
- [x] WebSocket/socket.io kullanan uygulamada proxy upgrade header davranışını test et.

2026-09-09 doğrulaması: gerçek Nginx üzerinde static SPA ve loopback Node proxy vhostları API -> job -> ajan akışıyla stage/activate edildi. Bilerek bozuk aday config `nginx_config_invalid` ile reddedildi ve aktif config checksum/traffic korundu. Duplicate domain API'de `409 domain_conflict` verdi ve aktif config değişmedi. WebSocket fixture'ı Nginx üzerinden gerçek `101 Switching Protocols` yanıtı verdi; reboot sonrasında da aynı sonuç alındı. Gerçek DNS gerektiren yönlendirmeler ile large-upload/timeout senaryosu açık bırakıldı.

---

# P0 — SSL / gerçek domain testleri

SSL kodu hazırlandıktan sonra gerçek DNS gerektiren işler:

- [x] Test domainini YunPanel test sunucusuna yönlendir.
- [x] HTTP-01 ile ilk Let's Encrypt certificate issuance testini yap.
- [x] HTTP -> HTTPS redirect'i doğrula.
- [x] Renewal dry-run/yenileme testini gerçek sunucuda yap.
- [ ] Sertifika yenileme sonrası Nginx reload davranışını doğrula.
- [ ] Yanlış DNS durumunda hata mesajının panelde doğru göründüğünü doğrula.
- [ ] Expired/invalid certificate failure senaryosu için güvenli test yap.
- [ ] Wildcard/DNS-01 gerekiyorsa hangi DNS providerların destekleneceğine karar ver ve credentialları güvenli şekilde hazırla.

2026-09-09 doğrulaması: `cryptoraichu.website` apex A kaydı test sunucusuna çözülürken mevcut diğer DNS kayıtlarına dokunulmadı. Domain YunPanel API -> job -> ajan akışıyla önce HTTP olarak stage/activate edildi; Let's Encrypt staging HTTP-01 doğrulaması, üretim sertifika issuance'ı ve üretim sertifikasına karşı renewal dry-run başarıyla tamamlandı. Sertifika CN/SAN alanı `cryptoraichu.website`, geçerlilik sonu 2026-12-08 olarak dışarıdan doğrulandı; HTTP `301` ile HTTPS'e yönleniyor ve HTTPS panel/health yanıtı `200`. Certbot timer aktif/enable edildi ve gerçek yenilemeler için önce `nginx -t`, sonra reload yapan deploy hook kurularak manuel çalıştırıldı; sertifika henüz yeni olduğundan gerçek post-renew reload maddesi zorla ikinci üretim sertifikası alınmadan açık bırakıldı. Panel geçidi yalnızca onaylanan istemci IPv4 adresini kabul ediyor, loopback `127.0.0.1:4300` üzerinde dinliyor ve genel admin API rotalarını yayınlamıyor.

---

# P0 — İlk static migration denemesi

- [x] Production olmayan veya düşük riskli bir static React/Vite sitesi seç.
- [ ] Plesk'teki mevcut dosya ve domain ayarlarının snapshot/backup'ını al.
- [ ] Aynı siteyi YunPanel test sunucusunda Git -> build -> Nginx -> SSL akışıyla deploy et.
- [x] SPA routing varsa direct route refresh testini yap.
- [x] Static asset caching davranışını kontrol et.
- [ ] DNS cutover öncesi hosts override ile test et.
- [ ] DNS'i YunPanel sunucusuna geçir.
- [ ] HTTP/HTTPS, www/non-www ve önemli route'ları doğrula.
- [x] Rollback prosedürünü gerçekten uygula ve eski sürüme dönebildiğini doğrula.

2026-09-09 doğrulaması: YunPanel React/Vite kaynağı test fixture'ı olarak dedicated application user ile GitHub'dan çekilip iki ayrı release halinde build edildi. Nginx SPA direct-route isteği hem deploy hem rollback sonrasında `200` verdi; yayın dizinleri `0755`, dosyalar `0644` doğrulandı. Static asset cache header davranışı ayrı yönetilen static fixture üzerinde doğrulandı. İkinci release'ten ilk release'e gerçek rollback başarılı oldu; kasıtlı `current` symlink drift'i `static_rollback_release_drift` ile hiçbir rollback mutasyonu yapılmadan reddedildi. Bu test HTTP ve Host header override kullandı; gerçek DNS/SSL içeren tam migration maddesi tamamlanmış sayılmadı.

---

# P1 — Node.js/systemd gerçek sunucu testleri

Node deployment ve protected runtime-environment backend'i hazırlandıktan sonra:

- [ ] Düşük riskli bir Node.js uygulaması seç.
- [ ] Plesk env değerlerini güvenli şekilde YunPanel secret store'a taşı.
- [ ] Production control plane için güçlü `YUNPANEL_SECRET_MASTER_KEY` üret, repo dışında güvenli secret store'a yerleştir ve recovery kopyasının nerede tutulacağını belirle.
- [ ] Master key olmadan secret write'ın fail-closed davrandığını gerçek API sürecinde doğrula.
- [x] Secret registry state dosyasında plaintext secret bulunmadığını ve dosya permissionının `0600` olduğunu doğrula.
- [ ] Agent'ın yalnızca kendi server'ına bağlı Node uygulamanın environment bundle'ını alabildiğini gerçek iki-server/enrollment senaryosunda doğrula.
- [ ] Production agent-control plane hattında environment fetch'in HTTPS üzerinden gittiğini doğrula.
- [x] `/etc/yunpanel/apps` dizininin `0700`, `<application-id>.env` dosyasının `0600` olduğunu gerçek filesystem üzerinde doğrula.
- [x] Secret'ın systemd unit textine, process command line'a, generic job payload/result/history'ye veya normal admin environment listesine plaintext düşmediğini doğrula.
- [x] Environment variable değiştirip manual restart sonrası yeni değerin process tarafından görüldüğünü doğrula.
- [x] Environment variable değiştirip yeni deploy ve manual rollback sırasında aynı desired environment'ın atomik biçimde materialize edildiğini doğrula.
- [ ] Master key yedekleme/rotation/recovery prosedürünü production öncesi yaz ve test et; key kaybının mevcut ciphertext'i okunamaz hale getirdiği kabul edilmeli ve recovery yolu kanıtlanmalı.
- [x] Doğru Node.js runtime sürümünü test sunucusunda kur/doğrula.
- [x] systemd unit'i gerçek sunucuda oluştur ve çalıştır.
- [x] Uygulamanın dedicated Unix user altında çalıştığını doğrula.
- [x] Nginx reverse proxy üzerinden uygulamayı doğrula.
- [x] WebSocket/socket.io varsa gerçek bağlantı testi yap.
- [x] Uygulamayı reboot sonrası otomatik başlatma testinden geçir.
- [x] Process crash sonrası restart policy davranışını test et.
- [ ] Health check başarısız yeni deploy'da eski release'in servis vermeye devam ettiğini doğrula.
- [ ] Manual rollback yap ve target release health-check başarısızsa önceki release'in geri geldiğini doğrula.
- [x] Manual restart yap ve restart sonrası localhost health doğrulamasını kontrol et.
- [x] Control-plane current release ile sunucu `current` symlink'i farklıyken restart/rollback/status operasyonlarının drift hatası verdiğini doğrula.
- [x] Node process status sorgusunda systemd active/sub state, PID, restart count ve health sonucunun doğru döndüğünü doğrula.
- [ ] Custom startup file ve npm start script kullanan uygulamada deploy/restart/rollback boyunca runtime ayarlarının korunmasını doğrula.
- [ ] Journal/application loglarının YunPanel'e güvenli aktarıldığını doğrula.
- [ ] Secret içeren örnek loglarla redaction davranışını doğrula; plaintext secret generic job result/audit kayıtlarına düşmemeli.

2026-09-09 doğrulaması: Node.js `24.20.0` checksum doğrulamasıyla kuruldu. Public örnek uygulama dedicated user/systemd unit ile iki kez deploy edildi; environment değişikliği manual restart, yeni deploy ve rollback boyunca process'e ulaştı. Secret control-plane JSON/job state, systemd unit, command line ve admin metadata içinde bulunmadı. Nginx proxy, localhost health, reboot auto-start ve `SIGKILL` sonrası `on-failure` restart doğrulandı. Status active state/PID/restart count/health döndürdü. Kasıtlı release drift durumunda status, restart ve rollback sırasıyla `node_status_release_drift`, `node_restart_release_drift` ve `node_rollback_release_drift` verdi; PID, environment ve symlink operasyonlar tarafından değiştirilmedi. HTTPS control-plane, iki-server ownership, master-key recovery/rotation, unhealthy target rollback ve log streaming/redaction maddeleri açık bırakıldı.

---

# P1 — Passenger compatibility araştırması ve migration testi

- [ ] Passenger'da kalması gereken en az bir mevcut uygulamayı belirle.
- [ ] Plesk Passenger config'ini export/incele.
- [ ] Aynı uygulamanın Plesk dışı Passenger config'ini test sunucusunda oluştur.
- [ ] Node interpreter/version seçimini doğrula.
- [ ] Startup file davranışını doğrula.
- [ ] Passenger restart mekanizmasını doğrula.
- [ ] Log location ve permissionları doğrula.
- [ ] Plesk kontrolü kaldırıldığında uygulamanın reboot sonrası çalıştığını doğrula.
- [ ] Migration öncesi geri dönüş prosedürünü yaz ve test et.

---

# P1 — Docker / Compose gerçek testleri

Docker entegrasyonu hazırlandıktan sonra:

- [ ] Test sunucusunda Docker Engine ve Compose plugin sürümünü doğrula.
- [ ] Düşük riskli bir Compose projesini YunPanel üzerinden deploy et.
- [ ] Private image registry kullanılıyorsa credential yöntemini test et.
- [ ] BuildKit/build işlemlerini test et.
- [ ] Container health checks'i doğrula.
- [ ] Nginx -> container reverse proxy bağlantısını doğrula.
- [ ] Restart sonrası containerların doğru policy ile ayağa kalktığını doğrula.
- [ ] Named volume ve bind mount envanterini gerçek projede doğrula.
- [ ] Container silinse dahi persistent verinin korunduğunu doğrula.
- [ ] Failed compose deploy sonrası önceki çalışan servis durumunu test et.
- [ ] Docker log streaming'i gerçek container üzerinde test et.

---

# P1 — MySQL/MariaDB gerçek testleri

Database adapter hazırlandıktan sonra:

- [ ] Test sunucusunda desteklenen MySQL/MariaDB sürümünü kur/doğrula.
- [ ] YunPanel agent için root yerine mümkünse sınırlı provisioning credential oluştur.
- [ ] Database create/delete test et.
- [ ] Database user create/grant/revoke test et.
- [ ] Password rotation test et.
- [ ] Uzak erişim gerekiyorsa bind/firewall modelini belirle.
- [ ] DB dump al.
- [ ] Ayrı database'e restore et ve veri bütünlüğünü doğrula.
- [ ] Büyükçe bir test DB'sinde backup/restore süresini ve disk kullanımını gözlemle.
- [ ] Failed restore senaryosunda önceki veriyi koruma prosedürünü doğrula.

---

# P1 — Backup hedefleri ve disaster recovery

Backup özelliği hazırlandıktan sonra:

- [ ] Production için kullanılacak backup target'ı seç.
  - S3-compatible storage / remote server / Restic repository.
- [ ] Gerçek backup credentiallarını repo dışında güvenli şekilde tanımla.
- [ ] Test sunucusunda tam application backup al.
- [ ] Static app files restore et.
- [ ] Node app files + env/config metadata restore et.
- [ ] MySQL dump restore et.
- [ ] Docker named volume restore et.
- [ ] Backup checksum/integrity verification çalıştır.
- [ ] Bir test uygulamasını tamamen silip sadece YunPanel backup'ından yeniden oluşturma tatbikatı yap.
- [ ] Backup sunucusu erişilemezken hata davranışını doğrula.
- [ ] Disk dolu senaryosunun güvenli hata verdiğini doğrula.
- [ ] Retention cleanup'ın yanlış backup silmediğini gerçek repository üzerinde test et.
- [ ] Encryption key/repository password recovery prosedürünü güvenli yerde belgele.

---

# P1 — Cron ve filesystem permission testleri

- [ ] Test application user ile cron job oluştur.
- [ ] Cron'un root yerine doğru kullanıcıyla çalıştığını doğrula.
- [ ] Working directory ve env aktarımını doğrula.
- [ ] Cron output/error log yakalamayı test et.
- [ ] File manager jail/root path davranışını gerçek filesystem üzerinde test et.
- [ ] `../` traversal testleri yap.
- [ ] Symlink ile uygulama kökü dışına kaçış testleri yap.
- [ ] Upload ownership/permissionlarını doğrula.
- [ ] Büyük dosya upload limitlerini test et.

---

# P1 — Firewall ve network

- [x] Test sunucusunda UFW/nftables/aktif firewall modelini belirle.
- [x] YunPanel agent için gereken minimum portları aç.
- [ ] Public erişim gerekmiyorsa agent'ı private interface/VPN üzerinden bağlama seçeneğini test et.
- [ ] SSH, HTTP, HTTPS, mail ve DB portlarını ihtiyaca göre doğrula.
- [ ] Panel API/agent communication için TLS/mTLS certificate deployment'ını test et.
- [ ] Reboot sonrasında firewall kurallarının korunduğunu doğrula.

2026-09-09 doğrulaması: UFW inaktif bulundu. SSH/22 ve HTTP/80 dış ağdan erişilebilir; ajan ve control-plane API yalnızca loopback üzerinde olduğundan ek public ajan portu açılmadı. Bu sonuç bir firewall hardening doğrulaması değildir; HTTPS/443, mail, DB, VPN/private-interface ve TLS/mTLS maddeleri henüz test edilmedi.

---

# P2 — Mail stack kurulumu ve Plesk mail envanteri

Mail modülü kodlanmadan/migration yapılmadan önce:

- [ ] Plesk'te kullanılan gerçek mail stack'i netleştir.
- [ ] Tüm mail domainlerini listele.
- [ ] Tüm mailbox isimlerini ve quota bilgilerini export et.
- [ ] Alias/forwarding kayıtlarını export et.
- [ ] Catch-all varsa listele.
- [ ] DKIM durumunu/domain başına selectorları listele.
- [ ] SPF kayıtlarını listele.
- [ ] DMARC kayıtlarını listele.
- [ ] MX kayıtlarını listele.
- [ ] Reverse DNS/PTR kayıtlarının hangi provider panelinden yönetildiğini not et.
- [ ] Roundcube URL ve mevcut config özelleştirmelerini listele.
- [ ] Mailbox passwordları plaintext export edilmiyorsa migration reset stratejisini belirle.

---

# P2 — Test mail sunucusu

Mail kodu hazırlandıktan sonra ayrı test domainiyle:

- [ ] Postfix kurulumunu doğrula.
- [ ] Dovecot IMAP/LMTP yapılandırmasını doğrula.
- [ ] Rspamd kurulumunu doğrula.
- [ ] Roundcube kurulumunu doğrula.
- [ ] TLS certificate bağla.
- [ ] Mail domain oluştur.
- [ ] Mailbox oluştur.
- [ ] Alias/forwarding test et.
- [ ] Quota test et.
- [ ] DKIM imzasını doğrula.
- [ ] SPF kaydını yayınla ve doğrula.
- [ ] DMARC kaydını yayınla ve doğrula.
- [ ] MX kaydını yayınla.
- [ ] PTR/rDNS kaydını provider üzerinden ayarla.
- [ ] Gmail'e outbound mail gönder ve spam/headers sonucunu incele.
- [ ] Gmail'den inbound mail al.
- [ ] Outlook/Hotmail ile inbound/outbound test et.
- [ ] SMTP auth test et.
- [ ] IMAP TLS test et.
- [ ] Roundcube login/send/receive test et.
- [ ] Mail queue yönetimini test et.
- [ ] Rspamd spam davranışını test et.
- [ ] Mail backup/restore test et.

---

# P2 — DNS/provider tarafı

YunPanel ilk sürümde DNS hosting yazmasa bile migration sırasında aşağıdaki dış işlemler gerekebilir:

- [ ] Domainlerin DNS providerlarını listele.
- [ ] TTL'leri kritik migrationlardan önce geçici düşürme planı hazırla.
- [ ] Static/Node/Docker migrationları için A/AAAA kayıt değişikliklerini yap.
- [ ] Mail migrationı için MX değişiklik planı hazırla.
- [ ] SPF/DKIM/DMARC kayıtlarını güncelle.
- [ ] PTR/rDNS için hosting/IP provider panelinde işlem yap.
- [ ] DNSSEC aktif domainlerde migration etkisini kontrol et.

---

# P2 — Plesk'ten gerçek migration sırası

Aşağıdaki sıra production riski azaltmak için önerilir:

- [ ] 1. Düşük riskli static site.
- [ ] 2. İkinci static site.
- [ ] 3. Düşük riskli stateless Node app.
- [ ] 4. DB kullanan Node app.
- [ ] 5. WebSocket/socket.io kullanan Node app.
- [ ] 6. Passenger'da kalması gereken bir legacy app.
- [ ] 7. Docker Compose app.
- [ ] 8. Docker volume kullanan stateful app.
- [ ] 9. Kritik olmayan gerçek mail domaini.
- [ ] 10. Kritik production mail/domainler.

Her migration maddesi için:

- backup,
- hosts-file/pre-cutover test,
- DNS cutover,
- health verification,
- log kontrolü,
- rollback yöntemi,
- observation period

ayrı ayrı tamamlanmalı.

---

# P2 — Plesk bağımlılığını kaldırmadan önce doğrulamalar

- [ ] En az birkaç gerçek static site YunPanel altında stabil çalışıyor.
- [ ] En az birkaç gerçek Node app YunPanel altında stabil çalışıyor.
- [ ] En az bir Docker production workload stabil çalışıyor.
- [ ] Database backup/restore gerçek veriyle test edildi.
- [ ] Application full disaster recovery tatbikatı yapıldı.
- [ ] SSL renewal gerçek domain üzerinde en az bir kez doğrulandı.
- [x] Reboot sonrası tüm YunPanel-managed servisler otomatik ayağa kalkıyor.
- [x] Agent erişilemediğinde web trafiğinin etkilenmediği doğrulandı.
- [x] Control plane kapalıyken çalışan uygulamaların servis vermeye devam ettiği doğrulandı.
- [x] Nginx hatalı değişiklik rollback'i doğrulandı.
- [ ] Failed deploy rollback'i doğrulandı.
- [ ] Disk-full davranışı test edildi.
- [ ] Backup target outage davranışı test edildi.
- [ ] Secret'ların logs/audit çıktısına sızmadığı gerçek loglarla kontrol edildi.
- [ ] Mail gereken sunucularda mail migration ve restore doğrulandı.

---

# P3 — Yeni sunucuya Plesk kurmadan YunPanel kurulum tatbikatı

Bu milestone gerçek Plesk replacement kriteridir.

- [ ] Temiz Ubuntu 24.04 LTS sunucu provision et.
- [ ] Plesk KURMA.
- [ ] YunPanel agent installer çalıştır.
- [ ] Nginx kur/doğrula.
- [ ] Node.js runtime kur/doğrula.
- [ ] Docker/Compose kur/doğrula.
- [ ] MySQL/MariaDB kur/doğrula.
- [ ] SSL/ACME kur/doğrula.
- [ ] Bir static production benzeri app deploy et.
- [ ] Bir Node production benzeri app deploy et.
- [ ] Bir Docker production benzeri app deploy et.
- [ ] Database create/backup/restore yap.
- [ ] Full app backup/restore yap.
- [ ] Mail gerekiyorsa mail stack + Roundcube kur ve test et.
- [ ] Sunucuyu reboot et.
- [ ] Tüm servisleri ve siteleri tekrar doğrula.
- [ ] YunPanel control plane'i kısa süre durdur ve hosted applicationların çalışmaya devam ettiğini doğrula.

Başarı kriteri: Bu sunucunun günlük normal işletimi için Plesk'e ihtiyaç duyulmaması.

---

# Credentials / secrets — repo dışında tutulacaklar

Aşağıdaki değerler gerektiğinde kullanıcı/Plesk/sunucu tarafında hazırlanmalı; bu dosyaya veya Git reposuna gerçek değerleri yazılmamalıdır:

- SSH private keys,
- root/sudo passwords,
- Plesk admin credentials,
- MySQL root/provisioning credentials,
- GitHub private repository deploy keys/tokens,
- Docker registry credentials,
- S3/backup credentials,
- Restic repository password,
- SMTP/mail admin secrets,
- DNS provider API tokens,
- ACME DNS challenge tokens,
- YunPanel agent bootstrap/enrollment secrets,
- YunPanel `YUNPANEL_SECRET_MASTER_KEY` ve recovery kopyası,
- mTLS private keys.

---

# Tamamlanmış dış işler

- 2026-09-09 — Sağlanan hostta SSH/host-key doğrulaması, salt-okunur envanter ve dışarıdan 22/80 port erişimi tamamlandı. Host Ubuntu 22.04.5 LTS olduğu için Ubuntu 24.04 hedef-platform exit kriteri açık bırakıldı.
- 2026-09-09 — Nginx, Node.js 24, YunPanel API ve ayrıcalıklı ajan kuruldu; enrollment identity, loopback binding, korumalı config/state izinleri, systemd enablement ve reboot sonrası geri geliş doğrulandı.
- 2026-09-09 — Static Nginx, geçersiz config koruması, duplicate domain, proxy ve gerçek WebSocket upgrade testleri tamamlandı.
- 2026-09-09 — Static Git/build/release/SPA/rollback yaşam döngüsü ve static release-drift koruması gerçek sunucuda tamamlandı. Test sırasında keşfedilen restrictive-umask traversal hatası kodda giderilip regresyon testi eklendi.
- 2026-09-09 — Node deploy/restart/rollback/status, protected environment, secret sızıntı kontrolleri, crash recovery, Nginx proxy ve release-drift korumaları gerçek sunucuda tamamlandı.
- 2026-09-09 — Ajan ve control plane birlikte durdurulduğunda static, Node ve proxy trafiğinin hizmet vermeye devam ettiği doğrulandı.
