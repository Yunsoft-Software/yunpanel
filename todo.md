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

- [ ] **Sağlanan YunPanel test sunucusuna SSH erişimini tekrar doğrula.**
  - 2026-09-09 tarihinde mevcut geliştirme runner'ından yapılan TCP kontrolünde SSH portu `connection refused` döndürdü; SSH authentication aşamasına geçilemedi.
  - Aynı runner imajında `ssh` client binary'si bulunmuyor ve paket repository/DNS erişimi olmadığı için bu oturumda client kurulamadı.
  - Sunucu IP'si, root parolası veya başka credential değerleri bu dosyaya/Git geçmişine yazılmamalıdır.
  - Sonraki denemede önce sunucu tarafında SSH servisinin 22/TCP üzerinde dinlediği ve firewall/provider ACL'in erişime izin verdiği doğrulanmalı.
  - Erişim sağlanınca aşağıdaki Ubuntu/systemd testleri bekletilmeden yürütülüp sonuçları bu dosyaya işlenmeli.

---

# P0 — İlk envanter ve güvenli test ortamı

- [ ] **YunPanel için ayrı bir Ubuntu 24.04 LTS test sunucusu hazırla.**
  - Production Plesk sunucusunda ilk geliştirme/test yapılmamalı.
  - Minimum olarak public/private IP, SSH erişimi ve sudo/root yetkisi sağlanmalı.
  - Test sunucusu mümkünse production'a benzer Node/Docker/MySQL koşullarına sahip olmalı.

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

- [ ] YunPanel için dedicated Linux system user/group oluştur.
- [ ] `yun-agent` için systemd service kur.
- [ ] Agent config/secrets için root-protected dizin oluştur.
- [ ] Agent'ın ihtiyaç duyduğu sudo/polkit/privilege modelini test sunucusunda uygula.
- [ ] Agent'ın normal panel backend'inden ayrı kullanıcı altında çalıştığını doğrula.
- [ ] Agent tarafından kullanılacak filesystem dizinlerinin ownership/permission modelini doğrula.
- [ ] Agent bağlantısı için firewall/network erişimini aç.
- [ ] Agent'ın yalnızca beklenen port/interface üzerinde dinlediğini doğrula.
- [ ] Agent restart sonrası otomatik ayağa kalkıyor mu doğrula.
- [ ] Agent credential rotation prosedürünü gerçek sunucuda test et.

---

# P0 — Nginx gerçek sunucu doğrulamaları

Nginx adapter/template kodu hazırlandıktan sonra:

- [ ] Test sunucusuna üretilen ilk static vhost config'ini uygula.
- [ ] `nginx -t` doğrulamasını gerçek sunucuda çalıştır.
- [ ] Geçerli config sonrası reload'un kesintisiz olduğunu doğrula.
- [ ] Bilerek hatalı config ile YunPanel'in çalışan config'i bozmadığını doğrula.
- [ ] Duplicate domain ekleme korumasını gerçek Nginx state ile test et.
- [ ] `www`/non-`www` alias ve redirect davranışını gerçek DNS/domain ile test et.
- [ ] Large upload/proxy timeout gerektiren Node uygulaması için gerçek davranışı test et.
- [ ] WebSocket/socket.io kullanan uygulamada proxy upgrade header davranışını test et.

---

# P0 — SSL / gerçek domain testleri

SSL kodu hazırlandıktan sonra gerçek DNS gerektiren işler:

- [ ] Test domainini YunPanel test sunucusuna yönlendir.
- [ ] HTTP-01 ile ilk Let's Encrypt certificate issuance testini yap.
- [ ] HTTP -> HTTPS redirect'i doğrula.
- [ ] Renewal dry-run/yenileme testini gerçek sunucuda yap.
- [ ] Sertifika yenileme sonrası Nginx reload davranışını doğrula.
- [ ] Yanlış DNS durumunda hata mesajının panelde doğru göründüğünü doğrula.
- [ ] Expired/invalid certificate failure senaryosu için güvenli test yap.
- [ ] Wildcard/DNS-01 gerekiyorsa hangi DNS providerların destekleneceğine karar ver ve credentialları güvenli şekilde hazırla.

---

# P0 — İlk static migration denemesi

- [ ] Production olmayan veya düşük riskli bir static React/Vite sitesi seç.
- [ ] Plesk'teki mevcut dosya ve domain ayarlarının snapshot/backup'ını al.
- [ ] Aynı siteyi YunPanel test sunucusunda Git -> build -> Nginx -> SSL akışıyla deploy et.
- [ ] SPA routing varsa direct route refresh testini yap.
- [ ] Static asset caching davranışını kontrol et.
- [ ] DNS cutover öncesi hosts override ile test et.
- [ ] DNS'i YunPanel sunucusuna geçir.
- [ ] HTTP/HTTPS, www/non-www ve önemli route'ları doğrula.
- [ ] Rollback prosedürünü gerçekten uygula ve eski sürüme dönebildiğini doğrula.

---

# P1 — Node.js/systemd gerçek sunucu testleri

Node deployment hazırlandıktan sonra:

- [ ] Düşük riskli bir Node.js uygulaması seç.
- [ ] Plesk env değerlerini güvenli şekilde YunPanel secret store'a taşı.
- [ ] Doğru Node.js runtime sürümünü test sunucusunda kur/doğrula.
- [ ] systemd unit'i gerçek sunucuda oluştur ve çalıştır.
- [ ] Uygulamanın dedicated Unix user altında çalıştığını doğrula.
- [ ] Nginx reverse proxy üzerinden uygulamayı doğrula.
- [ ] WebSocket/socket.io varsa gerçek bağlantı testi yap.
- [ ] Uygulamayı reboot sonrası otomatik başlatma testinden geçir.
- [ ] Process crash sonrası restart policy davranışını test et.
- [ ] Health check başarısız yeni deploy'da eski release'in servis vermeye devam ettiğini doğrula.
- [ ] Manual rollback yap ve target release health-check başarısızsa önceki release'in geri geldiğini doğrula.
- [ ] Manual restart yap ve restart sonrası localhost health doğrulamasını kontrol et.
- [ ] Control-plane current release ile sunucu `current` symlink'i farklıyken restart/rollback/status operasyonlarının drift hatası verdiğini doğrula.
- [ ] Node process status sorgusunda systemd active/sub state, PID, restart count ve health sonucunun doğru döndüğünü doğrula.
- [ ] Custom startup file ve npm start script kullanan uygulamada deploy/restart/rollback boyunca runtime ayarlarının korunmasını doğrula.
- [ ] Journal/application loglarının YunPanel'e güvenli aktarıldığını doğrula.
- [ ] Secret içeren örnek loglarla redaction davranışını doğrula; plaintext secret generic job result/audit kayıtlarına düşmemeli.

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

- [ ] Test sunucusunda UFW/nftables/aktif firewall modelini belirle.
- [ ] YunPanel agent için gereken minimum portları aç.
- [ ] Public erişim gerekmiyorsa agent'ı private interface/VPN üzerinden bağlama seçeneğini test et.
- [ ] SSH, HTTP, HTTPS, mail ve DB portlarını ihtiyaca göre doğrula.
- [ ] Panel API/agent communication için TLS/mTLS certificate deployment'ını test et.
- [ ] Reboot sonrasında firewall kurallarının korunduğunu doğrula.

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
- [ ] Reboot sonrası tüm YunPanel-managed servisler otomatik ayağa kalkıyor.
- [ ] Agent erişilemediğinde web trafiğinin etkilenmediği doğrulandı.
- [ ] Control plane kapalıyken çalışan uygulamaların servis vermeye devam ettiği doğrulandı.
- [ ] Nginx hatalı değişiklik rollback'i doğrulandı.
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
- mTLS private keys.

---

# Tamamlanmış dış işler

Henüz yok.
