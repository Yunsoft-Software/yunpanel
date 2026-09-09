# YunPanel — Yapılacaklar

Bu plan yalnızca kalan geliştirme işlerini içerir. Tamamlanan alt maddeler çıkarılır; geçmiş Git commitlerinde kalır. Kod hazır olup gerçek ortam kabulü bekleyen işler `todo.md` içinde açık tutulur. Bağlayıcı kurallar `agents.md`; authentication, MFA, domain ve yeni arayüzün uygulanmış kapsamı `docs/authentication.md`, `docs/owner-mfa-policy.md`, `docs/domain-hierarchy.md`, `docs/website-workspace.md` içindedir.

Hedef: site merkezli enterprise panel, açık domain/subdomain hiyerarşisi ve ayrı sunucu agent'ı yerine tam yetkili yerel backend. Yeni arayüzü tamamlanmış hosting backend'i sayma. Kullanıcı açıkça başka branch istemedikçe doğrudan `main` üzerinde küçük commitlerle ilerle; GitHub Actions kullanma. Root backend ve terminal kalan güvenlik/yayın kabulünden önce public açılmayacak.

## A. P0 — Kalan authentication ve erişim işleri

- [ ] Ek Owner oluşturma, kullanıcı düzenleme/devre dışı bırakma/silme ve gerekiyorsa kaynak bazlı Read Only rolünü backend + UI ile tamamla. Son aktif Owner silinememeli, devre dışı bırakılamamalı veya yetkisi düşürülememeli. Rol/aktivite değişimi oturumları ve MFA challenge'larını iptal etmeli. Eşzamanlı değişikliklerde transaction ve revision kontrolü kullan. Bu turda kullanıcı deposunun GitHub yazımı engellendi; yerel taslağı repoya eklenmiş sayma. Handoff ve gerçek entegrasyon `todo.md` T-USER içinde.
- [ ] Yeni kullanıcı yönetimi rotalarını kendi hesap ayarları istisnasına koyma; mevcut Owner MFA yönetim kontrolünden geçir. Read Only erişimini yalnız açık kaynak/işlem izinleriyle genişlet; frontend buton gizlemek backend yetkilendirmesi değildir.
- [ ] MFA/oturum için gerçek React tarayıcı otomasyonu ekle: iki sekme, gecikmiş istek, kayıp MFA yanıtı, geri yüklenen sayfa, recovery kodlarını onaylama, modal/focus ve süre uzatma. MFA master-key değişimi için uygulama secretlarıyla uyumlu, geri alınabilir rotation aracını geliştir.
- [ ] `core-app.js` ve domain route bileşiminde kalan `bootstrap-auth.js` / in-process uyumluluk tokenını kaldırıp doğrulanmış kullanıcı bağlamını doğrudan kullan. Authentication listener'ını atlayan alternatif `createApp().listen()` yolu ekleme. Agentsiz geçişte eski enrollment/agent rotalarını ve credential'larını kaldır.
- [ ] WebSocket/SSE/terminal eklendiğinde HTTP ile aynı oturum, rol, Origin ve Owner MFA kontrolünü uygula. Loopback geliştirme istisnasını public root/terminal yoluna taşıma. Logout, parola/MFA/rol değişimi ve kullanıcı iptalinde açık bağlantı/PTY yetkisini derhal kaldır.
- [ ] IP allowlist'i güvenlik kabulü sonrası isteğe bağlı ek ağ kontrolüne dönüştür. Açık trusted-proxy sözleşmesi, gerçek istemciye göre rate limit ve spoof testleri ekle; doğrulanmadan mevcut ağ kısıtını kaldırma.
- [ ] Auth eventlerini tam audit modeline/ekranına bağla; kullanıcı yönetimi ve yönetim/job işlemlerinde actor/resource/result kayıtlarını tamamla. Parola, cookie, env değeri ve ham terminal çıktısı kaydetme.

**Kabul:** `todo.md` T-USER/T1/T1a/T1b/T1c. Gerçek HTTPS, kullanıcı yaşam döngüsü, tam workspace ve ileride canlı bağlantı iptali doğrulanmadan root/terminal public sürümü açılmaz.

## B. P1 — Ayrı agent'ı kaldır, tam yetkili yerel backend'e geç

- [ ] Sunucu başına yerel panel kurulumunu uygula. Yönetim backend'i host üzerinde root yetkili systemd servisi; root terminali aynı backend'in PTY oturumu olacak. Ayrı `yun-agent`, enrollment, heartbeat, credential exchange veya işlem başına sudo/polkit izin akışı olmayacak.
- [ ] `apps/agent/src` içindeki Nginx, ACME, systemd, deploy, rollback, envanter ve paket yöneticilerini panelin dahili adapter/host-service katmanına taşı. Çalışan algoritmaları yeniden yazma; transport bağımlılıklarını ayır ve testlerini taşı. Başka isim altında ikinci privileged daemon kurma.
- [ ] `agent-client.js`, agent endpointleri, job claim/report ve secret-delivery akışlarını yerel yürütücüye geçir. Kuyruk, resource lock, reconciliation, hata/rollback ve servis yeniden başlatılınca işlerin kaybolmaması/iki kez yürütülmemesi korunmalı.
- [ ] Yerel server kaydını kurulumda otomatik oluştur; mevcut server/application/domain kimliklerini ve bağlantılarını koru. Lokal olduğu doğrulanmayan eski kayıtları bu sunucuya sessizce bağlama. Uzak çoklu sunucu yönetimi geçişin önkoşulu değil.
- [ ] Root yetkisini uygulamalara yayma. Node/static build, npm lifecycle scriptleri, Git hook'ları, uygulama süreçleri/cron'u/site terminali dedicated site kullanıcısıyla çalışacak. Owner Sunucu terminalinde root kullanabilecek.
- [ ] Systemd unitleri, Debian maintainer scriptleri, installer, paket listesi, workspace, env örnekleri ve dev komutlarını agentsiz yapıya geçir. Sandbox/ownership gerçek yönetim ve PTY'yi engellememeli; `chmod -R 777`, genel sahiplik değişimi veya güvenliği topluca kapatma kullanma.
- [ ] Yedek -> job drain -> versioned state migration -> yeni backend health -> eski agent'ı durdur/devre dışı bırak sırasını ve eski paket/unit/state'e rollback'i uygula. `/etc/yunpanel`, `/var/lib/yunpanel`, auth SQLite, master key, vhost, sertifika, release ve kullanıcıları koru. Servis kullanıcısı değişince auth dosyası/CLI ownership geçişini açıkça yap.
- [ ] Geçiş tamamlanınca arayüzde korunan eski enrollment araçlarını ve agent mesajlarını kaldır. Eksik servis, gerçek OS hatası, kullanıcı yetkisi, yanlış config ve uygulanmamış modül durumlarını ayrı göster.

**Kabul:** Agent çalışmazken envanter, Nginx test/reload, Node deploy/restart/rollback, SSL ve paket işlemleri çalışmalı. Owner root terminal açabilmeli; panel durunca hosted servisler çalışmaya devam etmeli.

## C. P1 — Kalıcı Website modeli ve hiyerarşi

- [ ] Kalıcı website kimliği ile hostname kaydını ayır. Website sunucu, uygulama/runtime, document root ve Unix kullanıcı bağlarını taşımalı; domain kaydı website bağlantısı, açık parent ve ayrı alias hedefi taşımalı. Mevcut `primaryDomain`, `aliases`, `parentDomainId`, sertifika ve release ilişkilerini koru.
- [ ] Yeni `/websites/:websiteId` uyumluluk ekranını gerçek Website kaynağına taşı. Şimdilik kullanılan domain ID ve aynı sunucu/porttan uygulama aday eşleştirmesini kalıcı atama sayma. Node/static/Docker uygulama bağlama, runtime/env/log/dosya/yedek ilişkilerini açık backend referanslarıyla tamamla. Alias bağımsız uygulama/mail alanı yaratmamalı.
- [ ] Shared FQDN doğrulamasına IDN/punycode desteği; mevcut kayıtlar için açık parent seçimi/reparent önizlemesi ekle. Son iki parçadan parent tahmin etme. Taşıma/migration yollarında nokta sınırı, duplicate hostname, aynı sunucu ve cycle kontrollerini koru.
- [ ] Mevcut site oluşturma formuna aynı akışta yeni uygulama oluşturma, Docker/yönlendirme, otomatik document root ve çakışmasız port tahsisi ekle. Var olan parent/prefix, isimden sunucu/uygulama seçimi ve HTTPS adımlarını yeniden yazma. `www` alias mı bağımsız site mi açık seçilsin.
- [ ] Mail domaini, website ve DNS hosting yaşam döngülerini ayır. Ana domain mailbox'larını subdomainlere otomatik kopyalama; subdomain mail alanı bilinçli seçim olmalı.
- [ ] Silme/taşıma önizlemesinde child domain, uygulama, mailbox, sertifika ve yedek etkisini göster. Varsayılan davranış bağımlı kaynak varken silmeyi durdurmak; örtülü cascade veya başka sitenin verisini silmek yok.
- [ ] Düz domain/application kayıtlarından sürümlü, tekrar çalıştırılabilir, yedekli Website migration ve rollback geliştir. Salt okumada parent atama; mevcut trafik, ID, secret ve sertifika ilişkilerini bozma.

**Kabul:** Ana domain, iki bağımsız subdomain ve alias doğru ağaçta, ayrı kalıcı kaynak ilişkileriyle çalışmalı. Port aday eşleştirmesi migration kabulünün yerine geçmez; `todo.md` T3/T3a/T-UI.

## D. P1 — Kalan enterprise arayüz ve kullanılabilirlik işleri

- [ ] Yeni routed workspace'i gerçek React/Vite ve HTTPS ortamında test et; `todo.md` T-UI'daki masaüstü/mobil, klavye, focus, modal, geri/ileri ve doğrudan URL sorunlarını düzelt. Sadece JSX/CSS sözdizimi kontrolüne dayanarak tasarım/erişilebilirlik kabulü verme. Gövde/etiket okunurluğunu, kontrastı ve uzun alan adlarını gerçek render üzerinden düzelt.
- [ ] Mevcut beş koleksiyonun global polling'ini sayfaya özgü/lazy veri yüklemeye optimize et; büyük koleksiyonlar için backend sayfalama ve gerektiğinde sanallaştırma ekle. Yeni bağımsız veri durumlarını, tek in-flight isteği ve session-aware istemciyi koru.
- [ ] Ortak tablo, alan doğrulaması, Skeleton ve bildirim merkezi bileşenlerini tamamla; görsel olarak uyarlanmış eski gelişmiş formları aynı bileşen sözleşmesine taşı. Yeni form/route dirty guard'ını eski domain quick-add, sunucu kayıt ve bakım formlarına da yay. Başarısız istek, polling veya bağlam değişimi yazılanları sessizce silmemeli.
- [ ] Domain listesine kalıcı aç/kapat, kolon/yoğunluk/görünüm tercihleri; uygulama listesine ölçeklenebilir sayfalama ekle. Mevcut URL arama/filtre/sıralama ve parent grubunu bozmayan sayfalama korunmalı. Gerçek site disk/traffic/son olay ölçümleri backend gelince eklenmeli; eksik değerleri sıfır gösterme.
- [ ] Site detayındaki uyumluluk uygulama seçimini C'deki kalıcı bağlama geçir; runtime'a göre ilgili sekmeler/eylemler göster. Yeni uygulama/site tek akışı ve gelişmiş ayarları tamamla; teknik ID/token ezberletme. Statik uygulamaların site içi deploy bağlantısını ve Docker runtime yüzeyini tamamla.
- [ ] Global site değiştirici, kalıcı bildirim merkezi ve kaynak linkli tam audit detaylarını ekle. Mevcut site aramasını ve işlem durumu penceresini yeniden yazma. Mail/DB modülleri gelince global görünümden site bağlamına geçişi bağla.
- [ ] Mail, dosyalar, DB, cron, yedek ve terminal sekmelerindeki uygulanmamış durumları ancak ilgili backend ve gerçek UI akışları tamamlandığında kaldır. Placeholder veya menü varlığını bitmiş modül sayma. Log sekmesindeki job geçmişini canlı Node/Nginx logu gibi sunma.

**Kabul:** 1440×900, 1920×1080, 1280×800, 390×844. Ana domain -> child -> Node/SSL/mail işlemleri bağlam kaybetmeden tamamlanmalı; gerçek back/forward/reload/dirty-form ve erişim iptali testi yapılmalı. Yeni görünümün mevcut kapsamı `docs/website-workspace.md` içinde.

## E. P2 — Kalan site içi Node.js, static ve Git yönetimi

- [ ] Yeni site Node/Git ekranlarına backend'i eksik kontrolleri ekle: etkinleştir/devre dışı bırak, başlat/durdur, runtime düzenleme, uygulama/document root, startup file/npm script, package manager ve çalışma modu. Bağlanan mevcut deploy/restart/status/rollback işlemlerini yeniden geliştirme.
- [ ] Kurulu Node sürümlerini gerçek hosttan göster; panelden eksik runtime kurulumu ve site sürüm seçimi sağla. Panelin kendi Node sürümünü değiştirme. Çakışmasız otomatik port tahsisi, gerektiğinde gelişmiş manuel seçenek ekle.
- [ ] Site içinden bağımlılık kurma, build, repository/branch/commit seçimini tamamla. Private Git deploy key/token yönetimi ekle; bütün build/deploy scriptleri site kullanıcısıyla çalışmalı.
- [ ] Env editörüne import doğrulaması, değişiklik metadata'sı ve kalıcı kaydedildi/çalışan sürece uygulandı ayrımı ekle. Mevcut masked editör, silme teyidi ve restart/deploy uyarısını koru. Startup seçimi deploy/restart/rollback boyunca korunmalı; şifreleme altyapısını yeniden yazma.
- [ ] Node stdout/stderr, systemd, Nginx ve deploy loglarını site bağlamında canlı izleme, arama, filtre ve sınırlı indirmeye bağla. Redaction ve akış sınırları uygula; hassas çıktıyı genel job result/audit'e kopyalama.
- [ ] Static/SPA ve Docker runtime'larını aynı site kabuğunda uygun kontrollere bağla. Passenger compatibility adapter'ını gerçek Plesk örnekleriyle tamamla; yeni Node uygulamalarında systemd varsayılanını koru.
- [ ] Git webhook deploy'u imza doğrulaması, replay/duplicate kontrolü ve kaynak kilitleriyle YunPanel job sistemine bağla; GitHub Actions ekleme.

**Kabul:** Custom startup tercihi bütün yaşam döngüsünde korunmalı; unhealthy release veya build hatası çalışan sürümü bozmamalı. İşin sonucu ve güvenli logu aynı site bağlamında görülebilmeli.

## F. P2 — Entegre terminal ve dosya yöneticisi

- [ ] xterm.js + backend PTY ile gerçek interaktif terminal geliştir. Site terminali dedicated site kullanıcısı/doğru dizinde, Sunucu terminali Owner için root olarak çalışmalı; host/kullanıcı/dizin görünür olmalı. Sahte çıktı veya HTTP tek satırlık exec ekranı yapma.
- [ ] WebSocket upgrade'de oturum, rol, Origin ve Owner MFA kontrolü; oturuma bağlı süreli/tek kullanımlık terminal yetkilendirmesi ekle. URL query'sine kalıcı credential koyma. Owner root terminaline agent komut allowlist'i dayatma.
- [ ] Resize, Ctrl+C/Ctrl+D, kopyala/yapıştır, Unicode, fullscreen program, çoklu sekme ve kopma durumlarını destekle. Yeniden bağlanma yetkiyi yeniden doğrulamalı; başka kullanıcı terminali devralamamalı.
- [ ] Logout, iptal, kullanıcı kapatma ve rol/parola/MFA değişiminde WebSocket/PTY erişimini derhal kes. Process-group cleanup, idle timeout, session/output/backpressure limitleri uygula. Uzun deploy/backup işi terminalden bağımsız kalıcı job olmalı.
- [ ] Root terminal açılış/kapanış metadata'sını audit'e yaz; ham tuş/çıktı/shell geçmişini varsayılan merkezi loglama. Çıktıyı HTML çalıştırma; link/clipboard entegrasyonlarını güvenli tut.
- [ ] Site dosyalarında listeleme, upload/download, mkdir, rename, metin düzenleme, owner/izin gösterimi ve teyitli silme ekle. Path traversal/symlink kaçışını engelle. Owner'ın host dosyası işlemleri açık Sunucu bağlamında kalmalı; gerekiyorsa owner-only sistem editörü ekle.

**Kabul:** Gerçek Ubuntu/TLS proxy altında interaktif kullanım ve resize çalışmalı. Logout/rol iptali sonrası komut gönderilememeli ve yetim PTY kalmamalı.

## G. P2 — Kalan domain, DNS, Nginx ve SSL işleri

- [ ] Site Domainler/SSL sekmelerine alias/canonical düzenleme, HTTPS redirect, otomatik yenileme yönetimi ve eyleme dönük son hata teşhisini ekle. Bağlanan stage/activate, ACME issue/test ve renewal/dry-run işlemlerini yeniden yazma.
- [ ] Subdomain/alias için bağımsız veya uygun mevcut sertifika seçimini doğrula; yanlış hostname'e sertifika bağlama. Custom certificate yükleme/key eşleşmesi ve DNS-01/wildcard desteğini tamamla; apex/wildcard kapsamını ayrı değerlendir.
- [ ] Gerçek resolver ile A/AAAA/CNAME ve ACME readiness göster. Dış DNS kullanıldığında hostname oluşturmayı DNS yayını sayma; provider adapter'ıyla kayıt yazmayı ayrı yetkilendirilmiş özellik olarak ekle.
- [ ] Site bazlı upload size, proxy timeout, WebSocket, SPA fallback, cache/header ve redirect ayarlarını ekle. Gelişmiş Nginx editöründe preview/diff, syntax test ve başarısız değişiklikte rollback kullan.
- [ ] DNS/expired/invalid certificate ve post-renew reload hatalarını gerçek teşhisle bağla. Özel anahtarları API listesi/frontend'e döndürme; hatalı config başka siteleri bozmamalı.

**Kabul:** Her hostname doğru hedef/sertifikayı sunmalı; hatalı Nginx/SSL değişikliği geri alınabilmeli ve diğer siteler korunmalı.

## H. P2 — Mail ve Roundcube

- [ ] Postfix, Dovecot, Rspamd, Roundcube detection/kurulum/config adapter'ları ve sağlık ekranı geliştir. Uygulanmamış kod, eksik servis ve izin hatasını ayır.
- [ ] Site Mail sekmesinde mail domaini enable/disable, mailbox create/delete, parola, kota/kullanım, alias/forwarding akışlarını backend + UI ile tamamla. Ana/subdomain mail kapsamını açık seçtir.
- [ ] MX/SPF/DKIM/DMARC ve PTR/rDNS'i beklenen/mevcut/değişiklik gereken halinde göster. Provider port kısıtlarını teşhis et; dış işlemi yapmadan tamamlandı deme.
- [ ] SMTP/IMAP TLS, kuyruk, log ve servis yönetimini bağla. Kimlik doğrulamasız relay'i engelle; SMTP kabulünü inbox teslim garantisi sunma.
- [ ] Roundcube'u gerçek webmail adresine bağla. Panel oturumu ile mailbox parolasını karıştırma; ayrı SSO tasarlanana kadar standart login kullan.
- [ ] Mailbox/domain silmede veri etkisi, yedek ve geri dönüş uygula. Mail dosyaları/metadata ve restore'u backup modeline dahil et.

**Kabul:** Gerçek test domaininde mailbox, TLS send/receive, alias/kota/Roundcube, DNS doğrulamaları ve mail restore tamamlanmalı.

## I. P3 — Kalan operasyon modülleri

- [ ] MySQL/MariaDB site ilişkisi, database/user create/delete, grant/revoke, password rotation, boyut/durum, dump/restore ve bağlantı bilgisi ekranlarını tamamla. Provisioning secret sunucuda kalmalı; uygulama DB kullanıcısı gereksiz yetki almamalı.
- [ ] Docker/Compose config doğrulama, build/pull, start/stop/restart, env/registry credential, log/health, Nginx hedefi ve deploy history geliştir. Named volume/bind mount envanteri ve backup politikasını göster; yeniden deploy persistent veri kaybetmemeli.
- [ ] Şifreli application/config/env/DB/volume/mail yedeği, local/S3-compatible hedef, retention/checksum, restore preview/progress, pre-restore yedeği ve hata bildirimleri geliştir. Restic değerlendirmesi/adapter seçimini tamamla; SSH/SFTP'yi gerçek ihtiyaçla ekle.
- [ ] Site cron'u için kullanıcı, dizin, env, timezone, enable/disable, son çalışma ve çıktı ekle. Site işleri site kullanıcısıyla, Owner sistem işleri açık Sunucu bağlamında çalışmalı.
- [ ] Gerçek metrik geçmişi, inode/disk eşikleri, uygulama/servis olayları, başarısız deploy/backup/SSL bildirimleri ve bounded log indirme ekle. Mevcut envanter kartlarını yeniden yazma; bilinmeyen/stale veriyi belirt.
- [ ] Tam audit ve iş detaylarında actor, kaynak linki, aşama, güvenli hata/log, arama/filtre, iptal/tekrar deneme davranışlarını tamamla. Mevcut job listesi/dialogunu koru; riskli retry'da idempotency/kaynak kilidi uygula.
- [ ] Plesk salt-okunur envanter/importer, external-managed kaynak durumu, Passenger/static/Node/DB/Docker/domain/cron/mail migration ve kaynak başına rollback araçlarını tamamla. Mail taşımasını DNS/restore doğrulamasından sonra yap.

**Kabul:** Her modül gerçek lifecycle işlemlerini yapmalı; application/DB/volume/mail restore testleri geçmeden production migration yok.

## J. P0–P3 — Kalan test, geçiş ve yayın kapıları

- [ ] Kullanıcı/Owner/MFA, WebSocket, Website migration, read-only ve yeni secret yüzeylerinin testlerini ekle. Mevcut deploy/rollback/ACME/job testlerini agentsiz yapıya taşı. Gerçek core Express + domain route + session boundary + entry point entegrasyonunu tam workspace'te doğrula.
- [ ] Yeni routed UI'nin component ve tarayıcı testlerini yaz: login -> site -> subdomain -> Node -> SSL -> mail -> terminal. Loading/empty/error/permission/missing-dependency, uzun domainler, çok kayıtlı tablolar, dirty-form ve refresh'i kapsa. Saf modellerin testini render kabulü sayma.
- [ ] Mevcut APT altyapısı üzerinde agentsiz upgrade, schema migration, PTY dependency ve rollback testlerini tamamla. Job sürerken self-update, restart reconciliation ve disk-full durumlarını kapsa. Yeni router dahil tam bağımlılık kurulumu ve frontend build'i aday paketle birlikte doğrulanmalı.
- [ ] Master-key rotation/recovery, backup target outage, başarısız restore, eşzamanlı işler, kaynak tükenmesi ve panel kesintisi tatbikatlarını tamamla. Çalıştırılmayan güvenlik veya görsel testi geçmiş sayma.
- [ ] Agentsiz mimari uygulandıkça docs/install/package/dev komutlarındaki eski agent varsayımlarını temizle. Hedef mimariyi mevcut davranış gibi belgeleme.
- [ ] `todo.md` içindeki T-USER/T-UI ve gerçek Ubuntu/DNS/Plesk/browser kabulünü tamamla. Production verisine dokunmadan yedek/rollback kapısı işlet; GitHub Actions kullanma.

**Yayın sırası:** Kalan A güvenlik işleri -> B agentsiz geçiş -> C/D kalıcı site modeli ve arayüz kabulü -> E/F/G günlük hosting -> H mail -> I kalan modüller. Arayüz geliştirmesi paralel yürüyebilir; yeni görünüm tek başına root/backend veya production-ready kabulü değildir.
