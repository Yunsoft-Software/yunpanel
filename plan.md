# YunPanel — Yapılacaklar

Bu plan yalnızca kalan geliştirme işlerini içerir. Tamamlanan ve doğrulanan alt maddeler listeden çıkarılacak; geçmiş Git commitlerinde kalacak. Kod tamamlanıp gerçek sunucu doğrulaması bekleyen işler `todo.md` içinde açık tutulacak. Bağlayıcı kurallar `agents.md`, mevcut authentication kurulumu ve sınırları `docs/authentication.md`, MFA taslağının kapsamı ve test sınırları `docs/mfa.md` içindedir.

Öncelik: domain/subdomain hiyerarşisi bulunan, Plesk benzeri site detaylarından yönetilen enterprise bir panel. Ayrı sunucu agent'ı kaldırılacak; yerel sunucunun tam yönetim yetkisi panel backend'inde olacak. Enterprise UI çalışması bekletilmeyecek; ancak tam yetkili backend ve terminal, kalan authentication yayın kapısı geçilmeden dış erişime açılmayacak.

## A. P0 — Kalan authentication ve erişim işleri

- [ ] Hazır `LoginForm.jsx` ve `MfaPanel.jsx` bileşenlerini `AuthGate.jsx` içine bağla; MFA-required 202 cevabını tam kullanıcı oturumu sayma. `mfa.css`, oturum yenileme callback'i, güncel session listesi ve tek sefer gösterilen recovery kodlarının güvenle kapatılması birlikte çalışmalı. Backend TOTP/recovery/yerel kurtarma akışını yeniden yazma; kalan iş arayüz bağlantısıdır. Bu bağlantının GitHub yazımı bu turda araç tarafından engellendi; bağlanmış sayılmaz.
- [ ] Eski oturumdan gelen gecikmiş HTTP yanıtının yeni cookie'yi silmesi yarışını çöz ve regresyon testi ekle. `auth-http.js` içindeki yetkisiz cevapların cookie yenileme/iptal sözleşmesini incele; JavaScript generation kontrolü tarayıcının uyguladığı `Set-Cookie` etkisini geri alamaz. Bu takip düzeltmesinin yazımı da engellendi; yalnız istemci testlerini uçtan uca çözüm sayma.
- [ ] Root/terminal dış erişim sürümü için Owner MFA enrollment zorunluluğunu ve kontrollü istisna/kurtarma politikasını backend'de uygula. Mevcut MFA yalnızca kayıtlı doğrulayıcısı olan hesapta zorunludur. Normal her işlem için tekrar parola istenmemeli.
- [ ] MFA arayüzünde gerçek tarayıcı testlerini tamamla: kurulum, yanlış/tekrar kullanılan kod, süre dolumu, recovery kullanımı/yenileme, kaldırma, oturum rotasyonu ve kaybolan yanıt. QR eklenirse secret'ı üçüncü tarafa göndermeden yerel üret; hazır bileşen şimdilik manuel anahtar girişidir. Schema v2 ve anahtar kurtarma kabulü `todo.md` içinde kalır.
- [ ] Ek Owner oluşturma, kullanıcı düzenleme/devre dışı bırakma ve gerekiyorsa kaynak bazlı Read Only rolünü backend + UI ile geliştir. Son aktif Owner silinememeli/devre dışı bırakılamamalı; rol değişimi mevcut oturumlarda etkili olmalı. Read Only için mevcut kapalı yönetim sınırını yalnızca açık kaynak/işlem izinleriyle genişlet.
- [ ] Kullanıcıya idle/absolute süre dolmadan anlaşılır uyarı ve oturumu uzatma kontrolü ekle. Gerçek React tarayıcı testleriyle iki sekme, çıkış sırasında bekleyen istek, eski yanıtın yeni girişi etkilemesi, sayfa geri yükleme ve hesap penceresi/focus davranışını kapsa.
- [ ] Kalan core HTTP handler'larında `bootstrap-auth.js` / in-process uyumluluk tokenını kaldırıp doğrulanmış kullanıcı bağlamını doğrudan kullan. Ağ listener'ını atlayan yeni `createApp().listen()` yolu ekleme. Agentsiz geçişte eski enrollment/agent rotalarını ve credential'larını da kaldır.
- [ ] WebSocket/SSE/terminal eklendiğinde HTTP ile aynı oturum/rol/Origin kontrolünü kur; logout, parola/MFA/rol değişimi ve kullanıcı iptalinde canlı bağlantı/PTY yetkisini derhal kaldır. Şimdilik kapalı upgrade yolunu korumasız açma.
- [ ] IP allowlist'i güvenlik kabulü sonrası isteğe bağlı ek ağ kontrolüne dönüştür. Açık trusted-proxy sözleşmesi, gerçek istemciye göre rate limit ve proxy header spoof testlerini ekle; bu geçiş doğrulanmadan mevcut ağ kısıtını kaldırma.
- [ ] Auth eventlerini tam audit modeline ve ekranına bağla; kullanıcı yönetimi ve tüm yönetim/job işlemlerinde actor/resource/result kayıtlarını tamamla. Parola, cookie, env değeri veya ham terminal çıktısı kaydetme.

**Kabul:** MFA taslağı, AuthGate bağlantısı ve cookie yarışının çözümü olmadan birleştirilmemeli/dağıtılmamalı. Gerçek HTTPS ve tarayıcı kabulü `todo.md` T-MFA/T1/T1a üzerinden tamamlanmalı. Kullanıcı yaşam döngüsü ve ileride canlı bağlantı iptali doğrulanmadan root/terminal public sürümü açılmamalı. Kodun test edilmesi canlı deployment kanıtı sayılmayacak.

## B. P1 — Ayrı agent'ı kaldır, tam yetkili yerel panel backend'ine geç

- [ ] Yönetim modelini sunucu başına kurulan yerel panel olarak uygula. Yönetim backend'i host üzerinde root yetkili systemd servisi olacak; root terminali de aynı backend'in yönettiği PTY oturumu olacak. Ayrı `yun-agent` servisi, agent enrollment, heartbeat, credential exchange ve işlem başına sudo/polkit izin tanımlama akışları hedef mimaride olmayacak.
- [ ] `apps/agent/src` içindeki Nginx, ACME, systemd, deploy, rollback, envanter ve paket yöneticilerini panelin dahili adapter/host-service katmanına taşı. Çalışan algoritmaları yeniden yazma; transport bağımlılıklarını ayır, ilgili testleri taşı. Yeni bir isim altında ikinci privileged daemon kurma.
- [ ] `apps/api/src/agent-client.js`, API'deki agent endpointleri, job claim/report ve secret-delivery akışlarını yerel yürütücüye taşı. Kuyruk, resource lock, reconciliation ve hata/rollback davranışını koru; kalıcı işlerin servis yeniden başlatılmasında kaybolmasını veya iki kez yürütülmesini engelle.
- [ ] Yerel server kaydını kurulumda otomatik oluştur; mevcut server/application/domain kimliklerini ve bağlantılarını koru. Lokal olduğu doğrulanmayan eski server kayıtlarını sessizce yerel sunucuya bağlama. Çoklu uzak sunucu yönetimi bu geçişin önkoşulu olmayacak.
- [ ] Panelin root yetkisini uygulama süreçlerine yayma: Node/static build, npm lifecycle scriptleri, Git hook'ları, uygulama cron'u ve site terminali dedicated uygulama kullanıcısıyla çalışacak. Sunucu terminalini Owner root olarak kullanabilecek.
- [ ] Systemd unitleri, Debian maintainer scriptleri, installer, paket listesi, workspace, env örnekleri ve geliştirme komutlarını agentsiz mimariye geçir. Sandbox/ownership ayarlarının gerçek yönetim işlemlerini ve root PTY'yi engellemediğini test et; çözüm olarak `chmod -R 777`, global sahiplik değişimi veya genel güvenlik kapatma kullanma.
- [ ] Geçişi yedek -> job drain -> versioned state migration -> yeni backend health kontrolü -> eski agent'ı durdur/devre dışı bırak sırasıyla uygula. Hata halinde eski paket/unit/state'e dönüşü tasarla. `/etc/yunpanel`, `/var/lib/yunpanel`, auth SQLite verisi, environment master key, mevcut vhost, sertifika ve release dizinlerini koru; servis kullanıcısı değişince auth dosyası ownership geçişini açıkça yap.
- [ ] Arayüzden agent durumu, enrollment butonları ve agent'a izin verme mesajlarını kaldır. Eksik dependency, gerçek işletim sistemi hatası, kullanıcı yetkisi, yanlış yapılandırma ve henüz uygulanmamış özellik için ayrı durum/hata kodu göster.

**Kabul:** `yun-agent` çalışmazken panelden envanter, Nginx doğrulama/reload, Node restart/deploy, SSL ve paket işlemleri çalışmalı. Owner sunucu terminalinde root oturumu açabilmeli. Panel durduğunda barındırılan siteler ve servisler çalışmaya devam etmeli.

## C. P1 — Domain/subdomain hiyerarşisi ve website veri modeli

- [ ] Kalıcı website kimliği ile hostname kaydını ayır. Website; sunucu, uygulama/runtime, document root ve Unix kullanıcı bağlarını taşımalı. Domain kaydı; website bağlantısı, kayıt tipi (`domain`, `subdomain`, `alias`), açık `parentDomainId` ve alias hedefi taşımalı. Var olan `primaryDomain`/`aliases` verisini kayıpsız migrate et.
- [ ] Ana domain altında subdomainleri ağaç olarak göster. Her subdomain bağımsız site detayına, runtime'a, document root'a, env'e, SSL'e, loglara ve yedeklere sahip olabilmeli. Alias ise başka siteye işaret etmeli; otomatik olarak ayrı uygulama/mail alanı yaratmamalı.
- [ ] Üst domain ilişkisini açık parent referansıyla kur; `com.tr`/`co.uk` gibi adlarda son iki parçayı keserek parent tahmin etme. FQDN normalizasyonu, IDN/punycode, nokta sınırı, yinelenen hostname ve döngü kontrolü ekle.
- [ ] Ana domain içinden “Subdomain ekle” akışında parent otomatik gelsin; prefix, bağımsız runtime veya yönlendirme, document root ve HTTPS tercihi seçilebilsin. `www` alias mı ayrı site mi açıkça seçilsin.
- [ ] Mail domaini ve website ilişkisini açık tut. Ana domainin mailbox listesi subdomainlere otomatik kopyalanmayacak; subdomain adına mail açılması bilinçli seçim olacak. DNS hosting ile web hostname yönetimi aynı şey sayılmayacak.
- [ ] Silme/taşıma işleminde alt domain, uygulama, mailbox, sertifika ve yedek bağımlılıklarını göster. Bağımlı kaynak varken varsayılan davranış silmeyi durdurmak olacak; örtülü cascade veya başka sitenin verisini silmek olmayacak.
- [ ] Mevcut düz domain/application kayıtları için sürümlü, tekrar çalıştırılabilir, yedekli migration ve geri dönüş geliştir. Domain adı, sertifika ilişkisi, release, env ve mevcut trafik değişmeden hiyerarşi oluşmalı.

**Kabul:** Bir ana domain, iki bağımsız subdomain ve bir alias doğru ağaçta görünmeli. Her site kendi Node/SSL/log ekranını açmalı; alias ve subdomain birbirine karışmamalı. Reload sonrası ilişkiler kalıcı olmalı.

## D. P1 — Enterprise UI/UX ve site merkezli gezinme

- [ ] `apps/web/src/App.jsx` içindeki tek bileşen/`activeView` yaklaşımını gerçek URL routing, layout, route-level data loading ve modül bileşenlerine ayır. Derin link, tarayıcı geri/ileri, sayfa yenileme ve açık sekme bağlamı korunmalı.
- [ ] Ana menüyü Dashboard, Web Siteleri, Sunucu, Veritabanları, Docker, Mail, Yedekler, İşler, Audit ve Ayarlar olarak düzenle. Applications/Domains ayrımını günlük işin ana yolu olmaktan çıkar; mevcut kayıtlara ulaşılabilir migration/deep-link yolu bırak.
- [ ] Tutarlı tasarım tokenları oluştur: 8px boşluk ölçeği, okunabilir 14–16px gövde metni, kompakt tablo yoğunluğu, tek vurgu rengi, nötr yüzeyler ve tutarlı ikonlar. Masaüstünde yaklaşık 240px sidebar kullan; dar ekranda kapanabilir yap. Dekoratif kart kalabalığı ve anlamsız büyük boşluklar yerine operasyon yoğunluğunu gözet.
- [ ] Ortak Button, Input, Select, DataTable, Tabs, Drawer, Modal, StatusBadge, Toast, EmptyState ve Skeleton bileşenleri üret. Loading, boş veri, yetkisizlik, eksik kurulum ve hata halleri görsel olarak ayrı olsun. Klavye gezinmesi, görünür focus, label ve modal focus yönetimi sağla.
- [ ] Web Siteleri ekranında açılır domain ağacı, arama, filtre, sıralama, sayfalama ve görünüm tercihi sun. Satırlarda domain, runtime, uygulama durumu, SSL, disk/kullanım özeti ve son olay göster. Uzun domainler taşmamalı; domain adı tıklanınca siteye girilmeli.
- [ ] Site detayına kalıcı başlık, domain/subdomain breadcrumb, runtime/SSL durumları, “Siteyi aç”, hızlı eylemler ve anlaşılır hata özeti ekle. Temel yolları `/websites/:websiteId/overview`, `/node`, `/domains`, `/ssl`, `/mail`, `/files`, `/databases`, `/logs`, `/cron`, `/backups`, `/terminal`, `/settings` olarak tasarla.
- [ ] Site sekmelerini Genel Bakış, Node.js/Uygulama, Git/Deploy, Domainler, SSL, Mail, Dosyalar, Veritabanları, Loglar, Zamanlanmış İşler, Yedekler, Terminal ve Ayarlar olarak uygula. Runtime'a uygun sekmeler gösterilsin; Node sitesi yönetmek için farklı global menüler dolaşılmasın.
- [ ] Site oluşturmayı “Domain -> runtime -> kaynak/document root -> HTTPS -> oluştur” akışıyla tasarla. Kullanıcıdan server ID, application ID, loopback portu veya agent tokenı ezberlemesini isteme; gerekli teknik detaylar gelişmiş bölümde bulunsun.
- [ ] Formlarda alan bazlı doğrulama, kaydedilmemiş değişiklik uyarısı, doğru loading state, hatadan sonra değerlerin korunması ve uzun işlem için job drawer ekle. Browser `prompt`/`alert` yerine panel bileşenleri kullan; API 202 cevabını işlem tamamlandı diye gösterme.
- [ ] `404 => protected` eşlemesini kaldır. 401 login, 403 yetkisizlik, 404 bulunamayan kaynak, 409 çatışma ve dependency/runtime hatalarını ayrı işle. Bir tablonun hatası diğer veriyi silmesin; bilinmeyen ölçüm 0 gösterilmesin. Otomatik yenileme açık formu bozmamalı.
- [ ] Global arama/site değiştirici, bildirim merkezi ve kaynakla bağlantılı job/audit detayları ekle; mevcut hesap/oturum kontrollerini yeni layouta entegre et. Global Mail/Database ekranlarından ilgili site detayına gidilebilsin.
- [ ] Placeholder veya çalışmayan butonu tamamlanmış özellik sayma. Servis kurulmamışsa gerçek teşhis ve uygulanabilir kurulum akışı göster; kodu olmayan modülü ayrı “henüz desteklenmiyor” durumuyla belirt. Desteklenmeyen modüller gerçek backend + ekran olmadan bu plandan çıkarılmayacak.

**Kabul:** 1440×900, 1920×1080, 1280×800 ve 390×844 görünümlerini incele. Ana domain -> subdomain -> Node restart, SSL yenileme ve mailbox oluşturma işlemleri bağlam kaybetmeden tamamlanmalı. Geri/ileri ve reload aynı siteyi/sekmesini korumalı.

## E. P2 — Site içinden Node.js, static ve Git yönetimi

- [ ] Var olan deploy/restart/rollback/env/status işlemlerini site detayına taşı ve eksik kontrolleri tamamla: runtime etkinleştir/devre dışı bırak, başlat/durdur/yeniden başlat, Node sürümü, uygulama kökü, document root, startup file/npm script, package manager ve çalışma modu.
- [ ] Kurulu Node sürümlerini gerçek hosttan göster; eksik runtime için panelden kurulum/sürüm yönetimi akışı sağla. Sistem/panel Node sürümünü değiştirmeden site runtime'ı seçilebilsin. Port tahsisini çakışma kontrollü otomatik yap, gerektiğinde gelişmiş ayarda göster.
- [ ] Site içinden bağımlılık kurma, build çalıştırma, Git repository/branch/commit seçimi ve deploy history ekranlarını tamamla. Private repository deploy key/token yönetimini korumalı olarak ekle; build/deploy scriptlerini site kullanıcısıyla çalıştır.
- [ ] Env editörüne masked secret değiştirme, import doğrulaması, değişiklik metadata'sı ve “kaydedildi / uygulamaya uygulanmadı” durumunu ekle. Startup/script tercihi deploy, restart ve rollback boyunca korunmalı. Mevcut şifreleme/deploy altyapısını tekrar geliştirme.
- [ ] Node stdout/stderr, systemd, Nginx ve deploy loglarını site bağlamında arama, filtreleme ve canlı izlemeye bağla. Akışı sınırla/redact et; hassas çıktıyı generic job result veya audit içine kopyalama.
- [ ] Static/SPA ve Docker runtime'ları için aynı site kabuğunda uygun kontrolleri sun. Passenger compatibility adapter'ını gerçek Plesk örnekleriyle tamamla; yeni Node uygulamalarında systemd varsayılanını koru.
- [ ] Git webhook deploy seçeneğini imza doğrulaması, replay/duplicate kontrolü ve kaynak kilitleriyle YunPanel job sistemine bağla; GitHub Actions ekleme.

**Kabul:** Site ekranından seçilen custom startup uygulaması deploy/restart/rollback sonrası aynı ayarlarla çalışmalı. Hatalı build veya unhealthy release çalışan sürümü bozmamalı; hata ve logu aynı ekranda görünmeli.

## F. P2 — Gerçek entegre terminal ve dosya yöneticisi

- [ ] xterm.js arayüzü + backend PTY ile gerçek interaktif terminal oluştur; sahte komut çıktısı veya tek satırlık HTTP exec ekranı yapma. Site terminali site kullanıcısı ve doğru çalışma dizininde, Sunucu terminali Owner için root olarak açılsın. Ekranda host, kullanıcı ve dizin net görünsün.
- [ ] WebSocket upgrade sırasında oturum, rol ve Origin kontrolü yap; süreli tek kullanımlık terminal yetkilendirmesini oturuma bağla. URL query'sine kalıcı credential koyma. Authenticated root terminalde normal shell kullanımını agent operasyon listesiyle sınırlama.
- [ ] Resize, Ctrl+C, Ctrl+D, kopyala/yapıştır, Unicode, fullscreen uygulamalar, çoklu sekme ve kopma durumlarını destekle. Yeniden bağlanma eski yetkiyi taşımamalı; başka kullanıcı terminal oturumunu devralamayacak.
- [ ] Logout, oturum iptali ve kullanıcı kapatmada WebSocket/PTY erişimini derhal kes; process-group cleanup, idle timeout, maksimum oturum ve çıktı backpressure limitlerini uygula. Uzun deploy/backup işleri terminal bağlantısından bağımsız job olarak devam etmeli.
- [ ] Root terminal açılış/kapanışını audit'e yaz; ham tuş vuruşlarını, terminal çıktısını veya shell geçmişini varsayılan olarak merkezi loglama. Terminal çıktısını HTML olarak çalıştırma; link/clipboard entegrasyonlarını güvenli tut.
- [ ] Site dosya yöneticisine listeleme, yükleme/indirme, dizin oluşturma, rename, güvenli metin düzenleme, owner/izin gösterimi ve teyitli silme ekle. Site görünümünde path traversal/symlink kaçışını engelle. Owner'ın host dosyaları üzerindeki tam yetkili işlemleri açık Sunucu bağlamında kalmalı; gerekirse owner-only sistem dosyası düzenleyicisi ekle.

**Kabul:** Gerçek Ubuntu'da terminal resize ve interaktif kullanım çalışmalı; site terminali site kullanıcısını, sunucu terminali root'u göstermeli. Logout veya rol iptalinden sonra açık terminalden yeni komut gönderilememeli ve yetim PTY kalmamalı.

## G. P2 — Site içinden domain, DNS, Nginx ve SSL

- [ ] Var olan domain/ACME işlemlerini site Domainler ve SSL sekmelerine bağla. Alias/canonical seçimleri, HTTPS redirect, sertifika kapsamı, kalan süre, otomatik yenileme ve son hata tek bağlamda yönetilsin.
- [ ] Subdomain ve alias eklemede bağımsız sertifika veya uygun mevcut sertifika seçimini doğrula; yanlış hosta sertifika bağlamayı engelle. Custom certificate yükleme/key eşleşmesi ve DNS-01/wildcard desteğini tamamla; wildcard ile apex kapsamını ayrı değerlendir.
- [ ] Gerçek DNS resolver kontrolüyle A/AAAA/CNAME ve ACME readiness göster; dış DNS provider kullanıldığında panelde hostname eklemenin DNS kaydı yayımlamadığını açıkça belirt. Desteklenen provider adapter'ı üzerinden kayıt yazma ayrı yetkilendirilmiş özellik olsun.
- [ ] Site bazlı upload size, proxy timeout, WebSocket, SPA fallback, cache/header ve yönlendirme ayarlarını ekle. Owner'a gelişmiş Nginx düzenleme alanı sun; preview/diff, syntax test ve başarısız değişiklikte geri dönüş kullan.
- [ ] Sertifika yenileme başarısızlığı, hatalı DNS, expired/invalid certificate ve post-renew reload durumlarını kullanıcıya eylem sunan mesajlarla bağla. Sertifika özel anahtarlarını API listesi veya frontend'e döndürme.

**Kabul:** Ana domain, subdomain ve alias kendi doğru hedefini/sertifikasını kullanmalı. Hatalı Nginx veya sertifika değişikliği diğer siteleri bozmamalı; çalışan config geri alınabilmeli.

## H. P2 — Site içinden mail ve Roundcube

- [ ] Postfix, Dovecot, Rspamd ve Roundcube için gerçek detection, kurulum/yapılandırma adapter'ları ve sağlık ekranı geliştir. Modül uygulanmamasını, kurulu servis eksikliğini ve izin hatasını birbirinden ayır.
- [ ] Site Mail sekmesinde mail domaini etkinleştir/devre dışı bırak, mailbox oluştur/sil, parola yenileme, kota/kullanım, alias ve forwarding akışlarını backend ve UI ile tamamla. Ana domain/subdomain mail kapsamını açıkça seçtir.
- [ ] MX, SPF, DKIM, DMARC ve PTR/rDNS gereksinimlerini beklenen/mevcut/değişiklik gereken şeklinde göster. DNS ve provider işlemini gerçekten yapmadan “ayarlandı” sonucu verme; provider port kısıtlarını teşhis et.
- [ ] SMTP/IMAP TLS durumu, mail kuyruğu, loglar ve servis yönetimini siteye bağla. Kimlik doğrulamasız relay'i engelle; gönderim başarısını inbox'a teslim garantisi olarak sunma.
- [ ] Roundcube erişimini gerçek webmail adresine bağla; panel oturumu ile mailbox parolasını karıştırma. SSO ayrı tasarlanana kadar standart Roundcube login kullan.
- [ ] Mailbox/domain silmede veri etkisi, yedek ve geri dönüş akışını uygula. Mail dosyası yedeği, mailbox metadata'sı ve restore'u backup modeline dahil et.

**Kabul:** Test domaininde mailbox oluşturma, TLS ile gönderme/alma, alias, kota ve Roundcube akışları doğrulanmalı; SPF/DKIM/DMARC kontrolü ve mail restore'u tamamlanmadan modül bitmiş sayılmamalı.

## I. P3 — Kalan operasyon modülleri

- [ ] MySQL/MariaDB site ilişkisi, database/user oluşturma-silme, grant/revoke, parola rotasyonu, boyut/durum, dump/restore ve bağlantı bilgileri ekranlarını tamamla. Provisioning secret sunucuda kalmalı; uygulama DB kullanıcıları gereksiz yetki almamalı.
- [ ] Docker/Compose proje yaşam döngüsü, compose doğrulama, build/pull, start/stop/restart, env/registry credential, log/health, Nginx hedefi ve deploy history geliştir. Named volume/bind mount envanteri ile backup politikasını görünür kıl; yeniden deploy'da persistent veri kaybetme.
- [ ] Şifreli application/config/env/DB/volume/mail yedeği, yerel ve S3-compatible hedef, retention, checksum, restore preview, job progress, pre-restore yedeği ve hata bildirimlerini geliştir. Restic değerlendirmesini ve seçilen adapter'ı tamamla; SSH/SFTP hedefini gerçek ihtiyaçla ekle.
- [ ] Site cron yönetiminde kullanıcı, dizin, env, zaman dilimi, enable/disable, son çalışma ve çıktı ekle. Uygulama işleri site kullanıcısıyla; owner-only sistem işleri açık Sunucu bağlamıyla çalışmalı.
- [ ] Gerçek metrik geçmişi, inode/disk eşikleri, uygulama/servis olayları, başarısız deploy/backup/SSL bildirimleri ve bounded log indirme ekle. Var olan envanter kartlarını sıfırdan yazma; bilinmeyen/stale veri durumlarını göster.
- [ ] Audit ekranı ve iş detaylarında arama/filtre, actor, kaynak linki, aşama, güvenli hata/log ve iptal/tekrar deneme davranışlarını tamamla. Riskli tekrar denemelerde idempotency ve kaynak kilidi uygula.
- [ ] Plesk salt-okunur envanter/importer, external-managed kaynak durumu, Passenger/static/Node/DB/Docker/domain/cron/mail migration ve kaynak başına geri dönüş araçlarını tamamla. Mail taşımasını DNS ve restore doğrulamasından sonra yap.

**Kabul:** Ekranı bulunan modül gerçek lifecycle işlemlerini yapmalı. Ayrı test kaynağında application, DB, Docker volume ve mail restore testleri başarılmadan production migration'a geçilmemeli.

## J. P0–P3 — Kalan test, geçiş ve yayın kapıları

- [ ] Kalan MFA UI/politika, kullanıcı yönetimi, WebSocket yetkisi, hierarchy migration, kaynak bazlı read-only ve yeni secret yüzeylerinin testlerini ekle; mevcut deploy/rollback/ACME/job testlerini agentsiz yapıya taşı. Gerçek core Express handler + oturum sınırı + entry point entegrasyonunu tam workspace'te testlerle kapsa. MFA'nın odaklı testlerini yeniden yazmak yerine native Node 24 ve tam regresyon kabulünü tamamla.
- [ ] UI component ve tarayıcı testleri ekle: login -> site -> subdomain -> Node -> SSL -> mail -> terminal. Loading/empty/error/permission/missing-dependency hallerini, uzun domainleri, çok kayıtlı tabloları ve form sırasında refresh'i kapsa.
- [ ] Mevcut APT kurulumunu yeniden geliştirmek yerine agentsiz paket yükseltmesi, schema migration, PTY bağımlılıkları ve geri dönüşü test et. Job sürerken self-update, restart sonrası reconciliation ve disk-full durumlarını kapsa. Auth paketinin gerçek install/upgrade kabulünü `todo.md` T1a'da tamamla.
- [ ] Master-key rotation/recovery, backup hedefi outage, başarısız restore, eşzamanlı işler, kaynak tükenmesi ve panel kesintisi tatbikatlarını tamamla. Test kanıtı olmayan güvenlik veya görsel kalite iddiası yazma.
- [ ] Agentsiz mimari uygulandıkça `docs/`, install/package dokümanı ve geliştirici komutlarındaki eski agent varsayımlarını temizle. Henüz uygulanmamış hedefi mevcut davranış gibi belgeleme.
- [ ] `todo.md` içindeki gerçek Ubuntu/DNS/Plesk/browser kontrollerini tamamla; production verisine dokunmadan yedek ve rollback kapısını işlet. GitHub Actions kullanma.

**Yayın sırası:** A'nın kalan güvenlik kapısı -> B agentsiz geçiş -> C/D site modeli ve enterprise UI -> E/F/G günlük hosting araçları -> H mail -> I kalan modüller. C/D tasarım ve bileşen geliştirmesi A/B ile paralel yürüyebilir. Her bölüm kendi test/kabul kapısını geçmeli; terminal ve tam yetkili yönetim A tamamlanmadan public olarak açılmamalı.
