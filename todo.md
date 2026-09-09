# YunPanel — Codex / Gerçek Ortam TODO

Yalnızca kalan dış ortam işleri ve doğrulamalar burada tutulur. Ürün/kod işleri ve uygulama sırası `plan.md`, bağlayıcı geliştirici kuralları `agents.md` içindedir. Tamamlanan alt maddeler listeden çıkarılır; tarih ve güvenli doğrulama kanıtı Git commitinde veya test raporunda kalır. Secret, sunucu parolası, session cookie ve kişisel veri repoya yazılmaz.

## Çalışma sınırı ve Codex başlangıcı

Bu planlama turunda canlı `https://cryptoraichu.website/` sayfası bu ortamdan alınamadığı için görsel veya interaktif canlı doğrulama yapılmış sayılmayacak. Depo incelemesi canlı servis yapılandırmasını kanıtlamaz. Aşağıdaki host, DNS, Plesk, credential ve gerçek tarayıcı işleri erişimi olan Codex ortamında yapılacaktır.

Codex önce güncel branch'i ve üç planlama dosyasını okumalı; kod işlerini `plan.md` sırasıyla küçük commitlerle uygulamalıdır. Bu dosya normal kod işlerini ertelemek için kullanılmaz. Hedef mimari geçişi doğrulamalarında tekrar istenen eski akışlar, yeni agentsiz backend için regresyon testidir; eski testin yapılmadığı anlamına gelmez.

## T0 — P0: Canlı paneli doğrula ve geçici erişimi koru

- [ ] `cryptoraichu.website` adresini gerçek tarayıcıda aç; Dashboard, Websites/Applications, Domains, Settings ve mevcut bütün menüleri dolaş. Görselleri, network hata kodlarını ve console hatalarını secret/kişisel verileri maskeleyerek kaydet. “Açılmıyor” sorunlarını oturum/yetki, IP kısıtı, endpoint yokluğu, eksik servis ve işletim sistemi hatası olarak ayır.
- [ ] Canlı paket/commit sürümünü ve aktif Nginx, web gateway, API ve agent unitlerini salt okunur olarak karşılaştır. Depodaki IP filtresi ve bootstrap-token proxy davranışının deployment'ta gerçekten etkin olup olmadığını doğrula; hiçbir koruma olmadığı veya herkese açık olduğu sonucunu kaynak koddan tek başına çıkarma.
- [ ] Yeni auth yayına girene kadar mevcut IP/erişim korumasını kaldırma. Gerçekten anonim yönetim erişimi bulunursa mevcut SSH/console erişimini kaybetmeden panel yüzeyine geçici IP kısıtı veya reverse-proxy authentication uygula; hosted sitelere aynı kısıtı yayma.
- [ ] Geçişten önce `/etc/yunpanel`, `/var/lib/yunpanel`, anahtarlar, paket/unitler, Nginx configleri, vhostlar ve release/symlink durumunun yedeğini al. Geri yükleme adımlarını ve bağımsız SSH/provider console erişimini doğrula; yedekleri public web root dışında tut.

## T1 — P0: Kullanıcı girişi ve dış erişim kabul testi — plan A

- [ ] Yerel kontrollü bootstrap ile Owner oluştur; kurulum akışının ikinci kez kullanılamadığını, default/public kayıt bulunmadığını doğrula. İlk parola ve recovery kodlarını repo dışında ilet/sakla.
- [ ] Gizli sekmede, izinli IP'den de dahil olmak üzere, login olmadan site/env/job/env-export/log/file/API verisi alınamadığını doğrula. Korunan API 401, yetkisiz kullanıcı 403 vermeli; sayfa yönlendirmesi veri endpointine koruma yerine geçmemeli.
- [ ] `/api/panel/*`, doğrudan API yolları, `/api/dev/*`, eski bootstrap/enrollment/agent yolları ve alternatif dinleme portlarında auth bypass olmadığını kontrol et. Normal yönetim ortak bootstrap tokenıyla devam etmemeli.
- [ ] Gerçek HTTPS reverse proxy arkasında cookie `Secure`/`HttpOnly`/host-only/SameSite davranışını, trusted-proxy/IP header politikasını, CSRF ve cross-origin reddini doğrula.
- [ ] Login rate limit, hatalı parola, idle/absolute timeout, oturum yenileme, logout, parola değişimi ve kullanıcı devre dışı bırakma senaryolarını dene. Read Only kullanıcı mutasyon ve terminal yapamamalı; son Owner silinememeli.
- [ ] TOTP kurulumu, hatalı kod, tek kullanımlık recovery kodu ve mail servisine ihtiyaç duymayan yerel parola kurtarmayı dene. Kurtarma/rol değişiminden sonra açık oturum ve terminal yetkilerini yeniden doğrula.

## T2 — P1: Agentsiz backend ve paket geçişi — plan B/J

- [ ] Yeni `.deb` paketini gerçek Ubuntu 24.04 üzerinde önce test ortamına kur/yükselt. PTY native dependency'leri, doğru Node ABI/runtime, dosya ownership'leri ve yeni backend systemd unitini doğrula.
- [ ] Bekleyen işleri güvenle durult; local server kaydını ve state migration'ı yedekle karşılaştır. Server/application/domain ID, env ciphertext/master key, current release, vhost ve sertifika ilişkileri korunmalı. Lokal olmayan eski server kayıtları bu hosta sessizce taşınmamalı.
- [ ] Yeni panel backend'inin gerekli host işlemlerini root olarak çalıştırdığını doğrula; API/socket yalnızca planlanan interface'te dinlesin. Ayrı agent/enrollment veya işlem başına sudoers/polkit izni gerekmemeli.
- [ ] Agent durdurulmuşken envanter, Nginx test/reload, ACME, Node deploy/restart/rollback, systemd ve paket işlemlerini dene. Başarıdan sonra eski agent servisini disable et; eski network listener, bootstrap/agent credentials ve unit referanslarını kontrollü temizle.
- [ ] Root backend'e rağmen uygulama süreçleri, install/build scriptleri ve site terminalinin dedicated site kullanıcısıyla çalıştığını doğrula. Site kullanıcısı panel master key, başka site env'i ve host yönetim dosyalarını okuyamamalı.
- [ ] Yeni kurulumda API/PTY/config izinleri gerçek operasyonları engelliyorsa hatalı unit/sandbox/ownership ayarını düzelt; global chmod/chown veya tüm korumaları kapatma kullanma.
- [ ] Yükseltme sırasında/sonrasında job drain, servis restartı, yarım kalan işin reconciliation'ı ve duplicate execution korumasını doğrula. Eski paket/state/unit'e rollback'i ayrı test alanında uygula.
- [ ] Reboot sonrası backend, Nginx ve managed uygulamaların açıldığını; panel durdurulunca hosted trafiğin devam ettiğini doğrula. Bu kontroller agentsiz mimari için yeniden yapılmalı.

## T3 — P1: Domain/subdomain migration ve enterprise ekranlar — plan C/D

- [ ] Canlı düz domain/application kayıtlarını yeni website + hostname hiyerarşisine test kopyası üzerinde migrate et. Kayıt sayısı, ID, alias, target, document root, env, release ve certificate bağlantılarını karşılaştır; migration tekrar çalışınca veri çoğalmamalı.
- [ ] Gerçek veya test DNS'inde bir ana domain, iki bağımsız subdomain ve bir alias hazırla. Ağaçta doğru parent/target görünmeli; subdomainlerin ayrı uygulama/env/SSL/logları, aliasın ortak hedefi doğrulanmalı.
- [ ] `www`/non-`www`, IDN/punycode, trailing-dot/uppercase normalizasyonu ve çok parçalı suffix kullanan adları test et. Başka bir hostname aynı kayıt/alias olarak tekrar yaratılamamalı; parent cycle kabul edilmemeli.
- [ ] Parent silme/taşıma önizlemesinin çocuk site, mailbox ve sertifika etkisini gösterdiğini doğrula. Test kaynaklarında bile örtülü cascade ile veri silinmemeli.
- [ ] Gerçek tarayıcıda 1440×900, 1920×1080, 1280×800 ve 390×844 görünümlerini kontrol et. Uzun domain, çok satırlı tablo, yatay taşma, açılır menü ve sidebar davranışını doğrula.
- [ ] Ana domain -> subdomain -> Node/SSL/Mail sekmeleri, doğrudan URL, reload, geri/ileri, site değiştirici ve logout akışlarını tamamla. Loading/empty/error/missing-service hallerini ve klavye/focus akışını dene.
- [ ] Form yazarken otomatik yenileme ve API hatası oluştur; değerler/sekme kaybolmamalı. Bir kaynak hatasında diğer veri silinmemeli; 404 genel “yetki yok” mesajı olmamalı.

## T4 — P2: Entegre terminal ve dosya işlemleri — plan F

- [ ] Gerçek Ubuntu ve TLS reverse proxy arkasında terminal WebSocket upgrade, resize, Unicode, Ctrl+C/Ctrl+D ve interaktif/fullscreen programları test et. Sunucu terminali root, site terminali doğru kullanıcı ve dizin göstermeli.
- [ ] Oturumsuz, Read Only, başka kullanıcının terminal kimliğiyle ve farklı Origin'den erişimleri dene; reddedilmeli. Terminal açma yetkisi yeniden oynatılarak başka bağlantıda kullanılamamalı.
- [ ] Logout, parola/rol değişimi, kullanıcı iptali, idle timeout ve tarayıcı kapanmasında yeni komut gönderilemediğini, PTY/process-group cleanup ve oturum limitlerinin çalıştığını doğrula.
- [ ] Yüksek çıktı ve kopma/yeniden bağlanma senaryolarında memory/backpressure ve sahiplik kontrolünü doğrula. Ham terminal içeriği/keystroke sıradan job/audit/server loglarına düşmemeli.
- [ ] Site dosya yöneticisinde gerçek filesystem üzerinde `../`, symlink kaçışı, upload ownership, büyük dosya sınırı, rename/edit/delete ve doğru çalışma dizinini test et. Owner sistem dosyası işlemi açık Sunucu bağlamında olmalı.

## T5 — P2: Node/static/Git, secret ve log doğrulamaları — plan E/J

- [ ] Custom startup file ve npm start script kullanan uygulamaları site ekranından deploy/restart/rollback et; Node sürümü, port, çalışma dizini ve başlangıç tercihi korunmalı. Runtime kurulumu panelin kendi Node sürümünü bozmamalı.
- [ ] Sağlıksız yeni release ve sağlıksız manuel rollback hedefi senaryolarında önceki çalışan sürüme dönüşü gerçek host üzerinde doğrula. Hatalı build, port çakışması ve stale `current` durumu doğru hata/job sonucunu vermeli.
- [ ] Private Git repository/deploy key ve gerekiyorsa webhook secretlarını repo dışında tanımla; fetch/build akışını site kullanıcısıyla dene. İmzalı webhook, tekrar gönderim ve yanlış branch davranışlarını doğrula.
- [ ] Production master key ve recovery kopyasını güvenli secret store'da hazırla; key yokken write fail-closed olmalı. Rotation, backup ve ciphertext recovery işlemlerini test kopyasında doğrula.
- [ ] Agentsiz geçiş sonrası secret'ın API listeleri, job payload/result, unit texti, process argümanları, log/audit ve frontend'de sızmadığını yeniden doğrula. Site izolasyonunu gerçek iki-site fixture ile dene; eski iki-agent credential testi yerine yeni yerel sınırları doğrula.
- [ ] Node/systemd/Nginx/deploy loglarında örnek hassas değerlerle redaction, arama, canlı akış, akış kesilmesi ve sınırlı indirmeyi dene. Test secretlarını gerçek credential yerine kullan.
- [ ] İlk gerçek Plesk static/Node migration'ında dosya/env/config yedeği al; hosts override -> Git/build -> Nginx/SSL -> DNS cutover -> health/route kontrolü -> rollback sırasını test et. Daha önceki fixture testi gerçek Plesk migration'ın yerine geçmez.

## T6 — P2: Nginx, SSL ve DNS — plan G

- [ ] Gerçek domainlerde `www`/non-`www`, canonical/alias ve HTTP->HTTPS yönlendirmelerini, her subdomainin ayrı hedefini doğrula. Subdomain yaratmak tek başına DNS kaydı yayınlanmış sayılmamalı.
- [ ] Büyük upload/proxy timeout gerektiren Node uygulamasını test et; WebSocket ve SPA/cache/header davranışlarını yeni site ayarları ve agentsiz yürütücüyle regresyondan geçir.
- [ ] Gerçek sertifika yenilenmesinden sonra Nginx test/reload ve yeni sertifikanın sunulduğunu doğrula. Gereksiz production issuance tekrarı yapma; staging/dry-run ile test edilebilenleri orada çalıştır.
- [ ] Yanlış DNS, expired/invalid certificate ve hatalı Nginx değişikliğinde doğru hata, önceki config'e dönüş ve diğer sitelerin sağlığını doğrula.
- [ ] Wildcard/DNS-01 için kullanılacak gerçek DNS providerını ve credentiallarını repo dışında hazırla. Apex/wildcard kapsamı, key/cert eşleşmesi, custom certificate ve alias kapsamını test et.
- [ ] DNS provider envanteri, A/AAAA/CNAME, MX/SPF/DKIM/DMARC, TTL ve DNSSEC etkisini gerçek taşınacak domainler için doğrula. PTR/rDNS değişikliklerini hosting/IP sağlayıcısında yap; panel bunu yapmadan “tamamlandı” dememeli.

## T7 — P2: Mail ve Roundcube — plan H

- [ ] Gerçek Plesk mail stack'ini, mailbox/kota, alias/forwarding/catch-all, MX/SPF/DKIM selector/DMARC ve Roundcube özelleştirmelerini export et. Mevcut parola hash uyumluluğunu araştır; uyumsuzsa güvenli reset/taşıma stratejisi belirle.
- [ ] Ayrı test domaininde Postfix, Dovecot IMAP/LMTP, Rspamd ve Roundcube kurulumunu/yapılandırmasını doğrula. SMTP/IMAP TLS, servis restartı, relay engeli ve gerekli port/provider kısıtlarını test et.
- [ ] Domain ve açıkça seçilmiş subdomain mail alanı oluştur; mailbox aç/kapat, parola değişimi, kota, alias ve forwarding işlemlerini site ekranından yap. Ana domain mailbox'ları otomatik subdomain hesabına dönüşmemeli.
- [ ] MX, SPF, DKIM, DMARC ve PTR/rDNS'i gerçek providerda yayımla/doğrula. İmzaları ve header sonuçlarını incele; Gmail ve Outlook ile gönderme/alma testi yap. SMTP kabulünü inbox teslim garantisi sayma.
- [ ] Roundcube login/send/receive, mail queue, Rspamd spam davranışı, loglar ve servis health ekranını doğrula.
- [ ] Mail yedeğini ayrı mailbox/domain'e geri yükle; içerik/kota/metadata bütünlüğünü doğrula. Silme ve başarısız restore için geri dönüşü kanıtla; production MX değişikliğini bundan önce yapma.

## T8 — P3: Docker/Compose ve veritabanları — plan I

- [ ] Gerçek Docker Engine/Compose ve private registry credential yöntemini doğrula. Düşük riskli projede build/pull, start/stop/restart, health, Nginx hedefi ve reboot policy testlerini yap.
- [ ] Named volume/bind mount envanterini, log akışını ve failed deploy sonrası önceki servis durumunu doğrula. Container değişirken persistent veri korunmalı; DB container yedeği için uygulama-tutarlı dump alınmalı.
- [ ] MySQL/MariaDB provisioning erişimini backend'in korumalı config'inde hazırla. Root host yönetimi uygulama database kullanıcılarına yayılmamalı; gerekiyorsa uzak DB bind/firewall erişimini ayrıca sınırla.
- [ ] Panelden database/user create/delete, grant/revoke, password rotation, size ve dump/restore testlerini yap. Ayrı test DB'sinde bütünlük, büyük veri disk/süre kullanımı ve başarısız restore geri dönüşünü doğrula.

## T9 — P3: Yedek, cron, ağ ve production dayanıklılığı — plan I/J

- [ ] Production backup hedefi ve credentiallarını repo dışında hazırla. Local/S3-compatible veya seçilmiş Restic/remote hedefte application files, env/config metadata, DB dump, Docker volume ve mail restore denemeleri yap.
- [ ] İzole bir test uygulamasını yalnızca backup'tan yeniden oluştur; checksum/integrity, encryption recovery ve retention doğruluğunu kanıtla. Disk-full, backup target outage ve yarım kalan restore için güvenli hata/geri dönüşü test et.
- [ ] Cron'u gerçek site kullanıcısı/dizin/env/zaman dilimiyle çalıştır; son çalışma ve output/error kayıtlarını doğrula. Owner sistem cron'u ayrı Sunucu bağlamında görünmeli.
- [ ] SSH erişimini koruyarak kalıcı firewall politikasını uygula. Panelin private/VPN erişimi seçilecekse dene; public API/terminal yalnızca planlanan TLS girişinden ulaşılmalı. Mail/DB portlarını ihtiyaca göre aç ve reboot sonrası kuralları doğrula; kaldırılan agent için public port bırakma.
- [ ] Eşzamanlı deploy/restore, Nginx config mutation, self-update, kaynak tükenmesi ve süreç kesilmesi senaryolarını test hostunda uygula. Job/result/audit tutarlılığını, hassas veri masking'ini ve hosted trafiğin etkisini kaydet.

## T10 — P3: Plesk envanteri ve gerçek migration — plan E/I

- [ ] Mevcut Plesk sürümü/OS, Nginx/Apache, Passenger, Node sürümleri, Docker/Compose, MySQL/MariaDB, ACME ve mail servis envanterini çıkar. Apache/`.htaccess` gerektiren siteleri ayır.
- [ ] Domain/document root, uygulama tipi, Git/branch, startup, Node version, env isimleri, DB, cron, SSL ve mail ilişkilerini export et. Secret değerleri güvenli taşı; envanter raporuna yazma.
- [ ] Örnek Passenger/static/Docker uygulamalarının gerçek vhost/include, interpreter, log, ownership, cache/SPA, volumes/network ve restart yapılandırmalarını maskeli örneklerle incele. Kullanılan özel Nginx directive'lerini ayır.
- [ ] Passenger'da kalması gereken uygulamayı Plesk dışı adapter ile test et: interpreter/startup, logs, restart, reboot ve rollback davranışı doğrulansın.
- [ ] Restore edilebilir Plesk yedeği sonrası migration'ı kaynak bazlı uygula: düşük riskli static -> stateless Node -> DB/WebSocket Node -> Passenger -> Docker/stateful workload -> kritik olmayan mail -> kritik hizmetler.
- [ ] Her taşımada hosts/pre-cutover testi, DNS/MX değişikliği, HTTP/HTTPS/önemli route ve log kontrolü, geri dönüş yöntemi ve gözlem süresi kaydet. Birkaç gerçek workload stabil olmadan Plesk'i geri dönüş seçeneği olarak kaldırma.

## T11 — Son kapı: Temiz sunucuda Plesksiz kurulum

- [ ] Temiz Ubuntu 24.04 üzerinde Plesk kurmadan agentsiz YunPanel paketini kur; Owner/TOTP, Nginx, Node, ACME ve gereken Docker/DB/mail bileşenlerini panel akışlarıyla hazırla.
- [ ] Ana domain + bağımsız subdomain + alias, static/Node/Docker uygulama, DB lifecycle, SSL ve gereken mail akışlarını uçtan uca test et. Site içi yönetim için ID/token/agent izni gerekmemeli.
- [ ] Application/DB/volume/mail yedeği ve restore, gerçek TLS renewal, reboot, root/site terminali ve panel kesintisi kontrollerini tamamla.
- [ ] Erişim, secret recovery, paket rollback ve service health kanıtlarını gözden geçir; açık kritik madde varken production-ready etiketi verme. Normal günlük yönetim ve test edilmiş kurtarma için Plesk'e bağımlılık kalmamalı.
