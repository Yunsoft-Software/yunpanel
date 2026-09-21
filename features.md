# YunPanel — Kapsamlı Özellik ve Fonksiyon Envanteri (features.md)

Bu döküman, YunPanel bünyesinde bulunan her bir modülü, özelliği, ekranı, formu, butonu, parametreyi, arka plan servisini ve API yeteneğini hiçbir istisna ve atlama olmaksızın satır satır ve madde madde listeler.

---

## 1. MİMARİ VE GÜVENLİK TEMELLERİ

### 1.1. Sunucu Yönetim Modeli
- **Tek Sunucu (Agentless Local Root) Mimarisi:**
  - Panel, yalnızca kurulu olduğu yerel sunucuyu (`YUNPANEL_LOCAL_SERVER_ID` ile eşleşen hostu) yönetir.
  - Harici agent, uzak daemon veya ikinci bir privileged servis bulunmaz; yönetim backend'i doğrudan host üzerinde root yetkili systemd servisi olarak çalışır.
  - Uzak/eski server kaydı seçilmez, listelenmez veya onun adına işlem yürütülmez.
  - Plesk kurulu `.44` sunucusu kesinlikle kapsam dışıdır; tüm işlemler yalnızca `.28` test sunucusunda yürütülür.
- **Güvenlik Sınırları ve İzolasyon:**
  - Owner oturumu için Argon2id parola doğrulaması.
  - Sunucu tarafı oturum yönetimi (Server-side session store).
  - Güvenli Cookie politikası: `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` ön eki (veya yerel geliştirmede standart ön ek), IP eşleme doğrulaması.
  - Oturum başına CSRF ve Origin / Sec-Fetch-Site denetimleri.
  - İstek gövdesi limitleri (JSON parser: 256 KB, dosya yükleme: stream/multipart).
  - Güvenilir proxy politikası (`YUNPANEL_TRUSTED_PROXY_IPS`, `X-YunPanel-Client-IP`, `X-YunPanel-Proxy-Token`).
  - Her site için bağımsız Unix kullanıcısı ve grubu (`yun-site-*`), bağımsız ev dizini (`/var/yunpanel/sites/...`), bağımsız log ve geçici dizin izolasyonu.
  - Root yetkisinin web arayüzüne veya barındırılan uygulamalara verilmemesi; işlemlerin backend'in yetkili adapter katmanında yürütülmesi.

---

## 2. KULLANICI YÖNETİMİ, KİMLİK DOĞRULAMA VE OTURUMLAR

### 2.1. Kullanıcı Girişi ve Oturum (Auth)
- **İlk Kurulum (Owner Bootstrap):**
  - Tek kullanımlık, süreli Owner kurulum token'ı ile ilk yönetici hesabı oluşturma.
  - Public kayıt ve varsayılan sabit parola yasağı.
- **Kullanıcı Girişi (Login):**
  - Kullanıcı adı ve parola ile oturum açma formu.
  - Başarısız giriş denemelerinde IP bazlı ve kullanıcı bazlı rate limiting (15 dakikada 10 deneme).
  - İki adımlı doğrulama (MFA/TOTP) etkinse 6 haneli zaman bazlı kod sorgulama.
  - Kurtarma kodu (Recovery Code) ile MFA aşma desteği.
  - Şifrelenmiş cookie ile oturum açma ve sayfa yenilemede otomatik durum senkronizasyonu.
- **Oturum Kapatma (Logout):**
  - Geçerli oturumu sunucu tarafında iptal etme.
  - Tarayıcıdaki oturum çerezlerini temizleme.

### 2.2. Hesap Ayarları (Account Dialog)
- **Parola Değiştirme:**
  - Mevcut parola, yeni parola ve yeni parola tekrarı alanları.
  - Minimum 12 karakter şartı.
  - Parola değiştirildiğinde kullanıcının diğer tüm aktif oturumlarının otomatik olarak sonlandırılması.
- **İki Adımlı Doğrulama (MFA / TOTP) Yönetimi:**
  - MFA durum göstergesi (Kurulu / Kurulu değil).
  - MFA Kurulum Akışı:
    - TOTP gizli anahtarı ve QR kod üretimi (`otpauth://` URI).
    - Kullanıcı tarafından kod doğrulaması (6 haneli TOTP kodu).
    - 8 adet tek kullanımlık kurtarma kodu üretimi ve ekranda güvenli gösterimi.
    - Kurtarma kodlarının kopyalandığına dair teyit butonu.
  - MFA Devre Dışı Bırakma:
    - Güvenlik için mevcut parola doğrulama şartı.
    - MFA kaldırıldığında tüm kurtarma kodlarının geçersiz kılınması.
  - Kurtarma Kodlarını Yenileme (Regenerate Recovery Codes):
    - Mevcut kodları iptal edip yeni 8 kurtarma kodu kümesi oluşturma.
- **Aktif Oturumlar Listesi:**
  - Kullanıcıya ait tüm açık oturumların listesi (oluşturulma zamanı, son işlem zamanı, IP adresi, "Bu oturum" işareti).
  - İstenen oturumu tek tek sonlandırma (Revoke Session).
  - Tüm diğer oturumları sonlandırma (Revoke All Other Sessions).

### 2.3. Kullanıcı Yönetimi (Users Page — Yalnızca Owner)
- **Kullanıcı Envanteri ve Listeleme:**
  - Kullanıcı adı, rol, aktiflik durumu, MFA durumu sütunları.
  - Sayfalama (Pagination: sayfa başına 25 kullanıcı, Önceki/Sonraki butonları).
  - Anlık yenileme (Refresh) butonu.
- **Kullanıcı Ekleme (Add User Dialog):**
  - Kullanıcı adı (3–128 karakter; harf, rakam, `.`, `_`, `@`, `+`, `-`).
  - İlk parola (en az 12 karakter).
  - Rol seçimi:
    - `owner`: Tüm sunucu ve sitelerde tam yönetim yetkisi.
    - `site_manager`: Yalnızca atanmış web sitelerini yönetme yetkisi.
    - `read_only`: Yalnızca kendi hesap ayarlarını görme, panel kaynaklarında salt okunur durum.
  - Hesap durumu: `Aktif` / `Devre dışı`.
  - Site Yöneticisi için Web Sitesi Kapsamı Belirleme (Çoklu seçim checkbox listesi).
- **Kullanıcı Düzenleme (Edit User Dialog):**
  - Kullanıcı adı görüntüleme.
  - Parola sıfırlama (opsiyonel yeni parola tanımlama).
  - Rol değiştirme (`owner`, `site_manager`, `read_only`).
  - Hesap durumu değiştirme (Aktif / Devre dışı toggle).
  - Atanmış web sitelerini güncelleme (Site Yöneticisi rolü için).
  - Düzenleme kaydedildiğinde kullanıcının açık oturumlarının otomatik iptali.
- **Kullanıcı Silme (Delete User Dialog):**
  - Kullanıcı adını yazarak açık teyit alma (`confirmation: username`).
  - Son aktif Owner hesabının silinmesini engelleyen kural.
  - Kullanıcı silindiğinde tüm oturum ve MFA kayıtlarının temizlenmesi, sitelerin korunması.

---

## 3. WEB SİTELERİ VE ALAN ADI YÖNETİMİ (WEBSITES & DOMAINS)

### 3.1. Web Siteleri Listesi (Websites Page)
- Sunucudaki tüm bağımsız Web Sitelerinin kart/tablo görünümü.
- Alan adı, bağlı uygulama/runtime türü, Unix kullanıcısı, SSL durumu, çalışma durumu (Active, Degraded, Offline).
- Arama ve filtreleme çubuğu (isme/alan adına göre).
- Site oluşturma butonuna hızlı erişim (`Site ekle`).
- Her site için detay sayfasına gidiş bağlantısı.

### 3.2. Yeni Web Sitesi Ekleme Akışı (New Website Page)
- **1. Alan Adı Yapılandırması:**
  - Kayıt türü seçimi: `Bağımsız alan adı` veya `Alt alan adı (Subdomain)`.
  - Alt alan adı ise: Üst alan adı (Parent domain) seçimi ve alt alan adı ön eki (`prefix`, örn: `api`).
  - Bağımsız alan adı ise: Birincil alan adı (`primaryDomain`, örn: `example.com`).
  - `www` davranışı seçimi: `www kaydı oluşturma` veya `www aynı siteye alias olsun`.
- **2. Yayın Hedefi ve Runtime Seçimi:**
  - `new_node`: Yeni Node.js 24 / Phusion Passenger uygulaması:
    - GitHub / Git Repository URL.
    - Git Branch (varsayılan: `main`).
    - Başlangıç dosyası (`entryFile`, varsayılan: `server.js`).
    - Sağlık kontrolü yolu (`healthPath`, varsayılan: `/health`).
  - `new_static`: Yeni Statik Web Uygulaması:
    - Git Repository URL.
    - Git Branch (varsayılan: `main`).
    - Build çıktı klasörü (`outputDir`, varsayılan: `dist`).
  - `new_php`: Yeni PHP-FPM Uygulaması (bağımsız Unix user socket).
  - `existing_node`: Panelde kayıtlı ancak henüz bir siteye bağlanmamış mevcut Node.js uygulaması seçimi.
  - `existing_static`: Panelde kayıtlı ancak bağlanmamış mevcut statik uygulama seçimi.
  - `shared_website`: Mevcut bir Website'ın kaynaklarını ve dizinini paylaşan `shared-site` modu (açık teyit modalı ile).
  - `external_proxy`: Gelişmiş yerel ters proxy (hedef port örn: `127.0.0.1:4301`).
- **3. Ek Servis ve Başlangıç Seçenekleri:**
  - İlk veritabanını oluştur (Initial MariaDB database & user toggle).
  - HTTPS modu: `managed` (Let's Encrypt otomatik) veya `off`.
  - Mail modu: `local` (Postfix/Dovecot/Rspamd + Roundcube) veya `none`.
- **4. Otomatik Provisioning Yürütücüsü (Auto-Advance Provisioning):**
  - Web sitesi oluşturma önizlemesi (`/sites/create-preview`) ve onay token'ı ile oluşturma (`/sites`).
  - Adım adım canlı ilerleme gösterimi:
    - Unix kullanıcısı ve grubu oluşturma (`identity`).
    - Workspace ve dizin yapısının hazırlanması (`workspace_directories`).
    - SFTP yetki ve chroot izolasyonunun kurulması (`sftp`).
    - Nginx vhost konfigürasyonunun yazılması ve test edilmesi (`nginx`).
    - PowerDNS yetkili zone ve DNS kayıtlarının açılması (`dns_zone`).
    - Mail domain ve Roundcube webmail kaydının bağlanması (`roundcube`).
    - Let's Encrypt SSL sertifikası talebi (`certificate`).
    - Sağlık kontrolü ve canlıya alma.

### 3.3. Site Detay Sayfası ve Sekmeleri (Site Detail Page)
- **Üst Başlık ve Meta Bilgileri:**
  - Breadcrumb (Web Siteleri / [Parent Domain] / Current Domain).
  - Alan adı başlığı, alt alan adı / ana site türü, sunucu adı.
  - Durum rozetleri: Site durumu (`active`, `warning`, `offline`), SSL durumu (`active`, `expired`, `missing`), Runtime/Port bilgisi.
  - Hızlı işlem butonları: `Siteyi aç` (yeni sekmede external URL), `Yenile` (anlık state yenileme).
- **Sekme Gezintisi (Tabs):**
  - `Genel Bakış` (`overview`)
  - `Kaynaklar` (`resources` - Veritabanı & Mail & Docker)
  - `Node.js` / `Uygulama` (`node` - Yalnızca Node/Python uygulamalarında)
  - `Deploy` (`deploy` - Git yayınlama ve geçmiş)
  - `Alan Adları` (`domains` - Alias, yönlendirme, reparent, silme)
  - `DNS` (`dns` - PowerDNS yetkili zone yönetimi)
  - `SSL` (`ssl` - Sertifika talep, yenileme ve yükleme)
  - `Dosyalar` (`files` - Dosya yöneticisi)
  - `Terminal` (`terminal` - Web terminali)
  - `Loglar` (`logs` - Nginx ve uygulama logları)
  - `Ayarlar` (`settings` - Site kimlik ve meta bilgileri)

### 3.4. Genel Bakış Sekmesi (Overview Tab)
- **Yayın Bilgileri Kartı:**
  - Alan adı, Aliaslar listesi, Hedef (root dizini veya upstream portu).
  - Website runtime türü, Bağlı uygulama adı, Son etkinleştirme tarihi.
- **Hızlı Erişim Butonları:**
  - Dosyalar, Terminal, Veritabanı & Mail, SSL, Alan Adları, Alt Alan Adı Ekle butonları.
- **Site Provisioning & Recovery Paneli (`ProvisioningRecoveryPanel`):**
  - Zorunlu ve opsiyonel provisioning adımlarının listesi (durum: `completed`, `applying`, `failed`, `blocked`, `compensated`).
  - Adım bazlı hata mesajları ve çözüm önerileri (remediation).
  - Adımı tekrar dene (`retry`) butonu.
  - Adımı geri al (`compensate`) butonu (sunucu durumunu temizleyen güvenli geri alma).
  - Provisioning'e devam et (`continue`) butonu.
- **Site İzolasyon Paneli (`WebsiteIsolationPanel`):**
  - İzolasyon denetimi (Audit) sonuçları: Unix identity, Workspace dizinleri, SFTP anahtarları, PHP-FPM pool, Passenger migration durumu.
  - İzolasyon migration'ı uygula butonu (`Apply Website Isolation Migration`).
  - İzolasyon migration'ı geri al butonu (`Rollback Website Isolation Migration` — teyit kodu ile).
  - Passenger migration handoff bildirimi ve tetikleyicisi.
- **Son İşlemler Tablosu:**
  - Bu siteye ait son 8 async job (tür, durum, başlama ve bitiş süreleri).

### 3.5. Alan Adları Sekmesi ve Gelişmiş Araçlar (Domains Tab & Advanced Domains)
- **Alan Adı Güncelleme ve Düzenleme (`DomainOperations`):**
  - Birincil alan adı (Primary domain) değiştirme önizlemesi ve teyidi.
  - Alias alan adları ekleme / çıkarma (virgülle veya satırla ayrılmış liste).
  - HTTPS modu seçimi: `off`, `managed` (Let's Encrypt), `custom`.
  - HTTPS yönlendirmesi toggle (`httpsRedirect`: HTTP -> HTTPS 301 yönlendirmesi).
  - Canonical alan adı yönlendirmesi toggle (`canonicalRedirect`: alias'lardan primary'ye 301).
  - Nginx ayarları özelleştirme (özel gzip, client_max_body_size vb.).
  - Güncelleme önizleme diff'i oluşturma ve digest ile güvenli uygulama.
- **Alt Alan Adı Hiyerarşisi (Reparenting):**
  - Üst alan adını değiştirme veya bağımsız alan adına dönüştürme.
  - Reparenting önizlemesi (`/domains/:domainId/reparent-preview`) ve döngü (circular dependency) kontrolü.
  - Reparenting uygulama (`/domains/:domainId/reparent`).
- **Alan Adı ve Web Sitesi Askıya Alma / Devam Ettirme (Suspension / Resume):**
  - Alan adını askıya alma (trafik durdurulur, Nginx 503 bakım sayfası döner).
  - Alan adını yeniden etkinleştirme (Resume).
  - Web sitesini ve bağlı tüm alt alan adlarını topluca askıya alma.
- **Alan Adı ve Web Sitesi Silme (Removal with Impact Preview):**
  - Bağımlılık ve etki analizi önizlemesi (`/resource-impact`):
    - Etkilenecek alt alan adları, SSL sertifikaları, mail domainleri, posta kutuları, veritabanı bağları, SFTP anahtarları, cron görevleri ve yedekler.
  - Blocker kontrolleri (açık bağımlılıklar varsa silme engellenir).
  - Geri alma sıralı kompanzasyon (Reverse-order compensation):
    - Nginx vhost temizliği, DNS zone arşivleme/silme, mail kutusu temizliği, Unix kullanıcısının kaldırılması.
  - Açık teyit kodu (`confirmation: domainName`) ile silme işlemi.

---

## 4. ÇALIŞMA ZAMANLARI, UYGULAMALAR VE DEPLOY (RUNTIMES & APPS)

### 4.1. Node.js ve Passenger Çalışma Zamanı
- **Nginx + Phusion Passenger İzolasyonu:**
  - `passenger_enabled on`, `passenger_user`, `passenger_group` ile site bazlı Unix izolasyonu.
  - Otomatik `restart.txt` tetiklemesiyle kesintisiz uygulama yeniden başlatma.
- **Node Sürüm Desteği:**
  - Node.js 18, 20, 22, 24 LTS sürümleri.
  - Sunucu üzerinde kurulu Node sürümlerini tarama ve dinamik tespit.
  - Eksik Node sürümünü sunucuya kurma işi (`SYSTEM_NODE_RUNTIME_INSTALL`).
- **Uygulama Süreç Yönetimi (Process Management):**
  - Uygulama durumunu sorgulama (`/applications/:applicationId/status`).
  - Uygulama durumunu yenileme işi (`status/refresh`).
  - Uygulamayı yeniden başlatma işi (`restart`).
  - Passenger migration önizlemesi ve eski direct-systemd uygulamalarını Passenger'a geçirme (`passenger-migration`).

### 4.2. PHP-FPM Çalışma Zamanı
- **Çoklu PHP Sürüm Desteği:**
  - PHP 8.1, 8.2, 8.3, 8.4 sürümleri.
  - Site başına bağımsız PHP-FPM pool konfigürasyonu (`/etc/php/<version>/fpm/pool.d/<site>.conf`).
  - Siteye özel Unix domain socket (`/run/php/php<version>-fpm-<site>.sock`).
  - `listen.owner`, `listen.group`, `user`, `group` ile site Unix kullanıcısına tam izolasyon.
  - Bellek limitleri (`memory_limit`), maksimum yükleme boyutu (`upload_max_filesize`), çalışma süresi (`max_execution_time`) yapılandırması.

### 4.3. Python Çalışma Zamanı
- **WSGI / ASGI Desteği:**
  - Python 3.10, 3.12 desteği.
  - Site kullanıcısı altında bağımsız sanal ortam (`venv`) oluşturma.
  - Gunicorn / Uvicorn süreç yöneticisi entegrasyonu.
  - Giriş modülü (`wsgi.py` / `asgi.py` / `main:app`) yapılandırması.
  - Süreç durumu, yeniden başlatma ve log takibi.

### 4.4. Statik Web Yayınlama
- **Durable Release & Build:**
  - Git repository üzerinden `npm ci` ve `npm run build` ile build alma.
  - Belirtilen çıktı klasörünü (`outputDir`, örn: `dist`, `build`, `public`) web kökü olarak sunma.
  - SPA desteği (Single Page Application: Nginx `try_files $uri $uri/ /index.html`).

### 4.5. Git Deploy ve Rollback Sistemi
- **Deploy İşlemi (`Deploy`):**
  - Git hedefi seçimi (`gitTarget`: branch, tag veya spesifik commit SHA).
  - Dağıtım kuyruğu (`application-deploy-queue`):
    - Git checkout / fetch.
    - Bağımlılık kurulumu (`npm ci`, `composer install`, `pip install`).
    - Build scripti çalıştırma.
    - Yeni release dizini oluşturma (`/var/yunpanel/releases/<app>/<release-id>`).
    - Sembolik link (symlink) atomik güncelleme (`current -> releases/<release-id>`).
    - Servis yeniden başlatma ve HTTP sağlık kontrolü (`healthPath`).
    - Sağlık kontrolü başarısız olursa otomatik önceki release'e geri alma (Rollback).
- **Rollback İşlemi:**
  - Önceki release'e veya geçmiş listeden seçilen spesifik bir release'e dönme.
  - Rollback onay modalı (uygulama adı teyidi ile).
  - Ortam değişkenleri revizyonunu o release'in çalıştığı revizyona geri getirme.
- **Git Kimlik Bilgileri ve Webhook:**
  - Deployment credential (özel deploy SSH anahtarı veya access token) tanımlama, görüntüleme ve silme.
  - GitHub Webhook entegrasyonu: Webhook secret tanımlama, güncelleme, silme (`github-webhook-http.js`).
  - GitHub'dan gelen `push` olayında otomatik deploy tetikleme.

---

## 5. ORTAM DEĞİŞKENLERİ VE GİZLİ VERİ DEPOSU (ENVIRONMENT & SECRETS)

### 5.1. Değişken Yönetimi (`EnvironmentPanel`)
- **Değişken Listesi:**
  - Anahtar (`key`), değer (`value`), görünürlük (`secret` / `plain`), revizyon bilgisi.
  - Gizli (secret) değişkenlerin maskeli gösterimi (`••••••••`).
  - Değişken silme (onay modalı ile).
- **Tekil Değişken Ekleme / Güncelleme:**
  - Değişken adı (`[A-Za-z_][A-Za-z0-9_]*` regex doğrulaması).
  - Değer girişi (gizli ise password input, düz metin ise text input).
  - Görünürlük seçimi: `Gizli` (AES-256-GCM ile diskte şifrelenir) veya `Düz metin`.
- **Toplu .env İçe Aktarma (.env Import):**
  - Çok satırlı `.env` içerik alanı (maksimum 12 KB).
  - İçe aktarma modu seçimi:
    - `merge`: Mevcut değişkenlerle birleştirir, var olanları günceller.
    - `replace`: Mevcut tüm değişkenleri silip sadece yeni listedekileri kaydeder (açık onay teyidi ile).
  - Tümünü gizli veya tümünü düz metin kaydetme tercihi.
  - Katı `KEY=value` parse denetimi (duplicate, reserved, geçersiz karakterler reddedilir).
- **Çalışan Prosese Uygulama Durumu:**
  - Disk revizyonu (`savedRevision`) ile çalışan proses revizyonunun (`appliedRevision`) karşılaştırılması.
  - "Çalışan prosese uygulandı" veya "Yalnız diskte kayıtlı (Restart gerekli)" rozetleri.
  - Son değişiklik özeti (X eklendi, Y güncellendi, Z silindi).

---

## 6. DOSYA YÖNETİCİSİ (FILE MANAGER)

### 6.1. Yerel Dosya Yöneticisi (`FilesPanel`)
- **Dizin Gezintisi:**
  - Site kök dizininde (`/var/yunpanel/sites/<site>`) gezinme.
  - Breadcrumb navigasyonu (her klasör seviyesine tek tıkla dönüş).
  - Klasör içerik tablosu: İsim, dosya türü ikonu, boyut (formatlanmış bayt), son değiştirilme tarihi, izinler.
- **Dosya ve Klasör Seçimi:**
  - Tekil satır checkbox seçimi.
  - Tümünü seç (Select All) checkbox toggle'ı.
  - Seçili dosya sayısı sayacı.
- **Oluşturma İşlemleri:**
  - Yeni dosya oluşturma (`file` modalı: dosya adı girişi).
  - Yeni klasör oluşturma (`mkdir` modalı: klasör adı girişi).
- **Yükleme ve İndirme:**
  - Çoklu dosya yükleme (File upload picker, ArrayBuffer binary aktarımı, üzerine yazma güvenliği).
  - Tekil dosya indirme bağlantısı (`/files/download?path=...`).
- **Dahili Metin ve Kod Düzenleyici (Inline Editor):**
  - Metin ve kod dosyalarını (HTML, JS, CSS, PHP, JSON, ENV, YAML, TXT, LOG vb.) modal içinde açma.
  - Kod düzenleme alanı (monospace font, satır kaydırma, sözdizimi uyumlu).
  - İyimser Eşzamanlılık Kilidi (Optimistic Concurrency Control):
    - Dosya açılırken SHA-256 hash'i alınır.
    - Kaydetme esnasında `expectedSha256` doğrulanır; dosya diskte başkası tarafından değiştirilmişse çakışma hatası verir ve veri kaybını önler.
- **Silme İşlemleri:**
  - Tekil dosya/klasör silme (`delete:${websiteId}:${path}` onay kodu ile).
  - Çoklu seçili dosyaları toplu silme (`batch-delete:${websiteId}` onay kodu ile).
- **Güvenlik ve Sınırlar:**
  - Path traversal (`../`) ve symlink kaçışlarına karşı mutlak sınır denetimi.
  - Yalnızca site Unix kullanıcısı yetkileriyle dosya sistemi işlemleri yapılması.
- **elFinder Entegrasyonu:**
  - elFinder handoff köprüsü ve token tabanlı konnektör erişimi.

---

## 7. WEB TERMİNALİ (TERMINAL)

### 7.1. Terminal Özellikleri (`TerminalPanel` & ttyd / xterm.js)
- **Oturum Kapsamı ve İzolasyon:**
  - **Site Terminali (`scope: site`):**
    - Yalnızca ilgili sitenin Unix kullanıcısı (`yun-site-*`) olarak açılır.
    - Başlangıç dizini sitenin ev / workspace dizinidir.
    - Root yetkisi yoktur; diğer sitelerin veya sistemin dosyalarına erişemez.
  - **Sunucu Terminali (`scope: server` — Yalnızca Owner):**
    - Sunucu üzerinde `root` shell oturumu açar.
    - Tam sunucu yönetimi sağlar.
- **Terminal Yetenekleri:**
  - xterm.js tabanlı ANSI / UTF-8 tam terminal emülasyonu.
  - PTY (Pseudo-terminal) boyutlandırma (Resize: cols/rows pencere boyutuna dinamik uyum).
  - Renkli çıktı, Vim/Nano gibi curses tabanlı interaktif CLI araçları desteği.
  - Ekranı temizle (Clear terminal) butonu.
  - Bağlantıyı kes (Disconnect) ve Yeniden bağlan (Reconnect) butonları.
  - WebSocket üzerinden güvenli, authenticated same-origin veri iletimi.
  - Idle timeout ve oturum sonlandırma koruması (Process group kill).

---

## 8. YETKİLİ DNS YÖNETİMİ (POWERDNS & DNSSEC)

### 8.1. Authoritative DNS Zone Yönetimi (`DnsPanel`)
- **Zone Durumu:**
  - PowerDNS Authoritative motoru üzerinden yerel SQLite / backend zone yönetimi.
  - Zone adı, SOA Serial numarası, DNSSEC durumu, Zone şablon sürümü.
- **DNS Kayıtları (RRsets) Tablosu:**
  - Ad (Owner: `@` veya subdomain ön eki), Tür (A, AAAA, CNAME, MX, TXT, CAA, SRV, NS, SOA), TTL (saniye), Kaynak (`manual`, `template`, `mail`, `webmail`, `acme`), Değerler listesi.
- **Manuel DNS Kaydı Ekleme / Düzenleme Dialogu:**
  - Kayıt adı (`@` kök için veya relative subdomain).
  - TTL (60 – 86400 saniye).
  - Kayıt türü seçici (A, AAAA, CNAME, MX, TXT, CAA, SRV, NS, SOA).
  - Değerler alanı (türe göre ipucu ve validasyon; her satıra bir değer).
  - Serial numarası kontrolü ile eşzamanlı değişiklik koruması.
- **Manuel DNS Kaydı Silme:**
  - Onay dialogu ile manuel kaydı zone'dan kaldırma.
  - Sistem / template tarafından yönetilen kayıtların yanlışlıkla silinmesini engelleyen kural.

### 8.2. Zone Şablonu Senkronizasyonu (Re-apply Panel)
- Sunucu genelinde güncellenen Zone Template ile mevcut zone arasındaki farkı (diff) hesaplama.
- Korunan manuel kayıt sayısı, planlanan ekleme/değiştirme/silme işlemleri.
- Manuel kayıt çakışması (Conflict) tespiti ve otomatik ezilmeyi önleme.
- Blocker denetimleri ve şablonu zone'a güvenli uygulama (`applyDnsReapply`).

### 8.3. DNSSEC Yönetimi (DnssecPanel)
- Yerel imzalama (Local signing) durumu: Açık / Kapalı.
- DNSSEC Aç / Kapat toggle'ı (onay modalı ile).
- Registrar'a girilecek DS (Delegation Signer) kayıtlarının üretilmesi ve ekranda gösterimi (Key Tag, Algorithm, Digest Type, Digest).
- Parent zone'da (kamusal DNS üzerinde) görülen gerçek DS kayıtlarını sorgulama.
- Durum analizi:
  - `secure`: Yerel imzalama ve parent DS tam eşleşiyor.
  - `pending_parent_ds`: Yerel açık ancak parent DS henüz güncellenmemiş.
  - `parent_ds_mismatch`: Parent DS ile yerel anahtar uyuşmuyor (kırmızı uyarı).
  - `signing_material_incomplete`: İmzalama anahtarı eksik veya bozuk.

### 8.4. İkincil DNS ve Delegasyon (Secondary DNS & Delegation)
- **Secondary DNS (AXFR) Transfer Hedefleri:**
  - Zone transferine izin verilen harici DNS IP adresleri yapılandırması.
  - AXFR senkronizasyon durumu takibi (`SecondaryDnsStatusPanel`).
- **Registrar / Delegasyon Denetimi:**
  - Kamusal DNS üzerinden domain NS delegasyonunu sorgulama.
  - Beklenen NS vs Gözlenen NS karşılaştırması.
  - Eksik NS, fazla NS ve Glue record (In-bailiwick) gereksinimlerinin tespiti.
  - Kullanıcıya registrar panelinde yapması gereken işlemleri adım adım bildiren talimat kartı.

---

## 9. SSL / TLS VE GÜVENLİK SERTİFİKALARI (CERTIFICATES)

### 9.1. Sertifika Yönetimi (`SslOperations` & `CertificatesView`)
- **Otomatik Let's Encrypt Sertifikası Talebi (Issue Certificate):**
  - Zorluk türü seçimi:
    - `HTTP-01`: Standart web doğrulaması (Nginx `/.well-known/acme-challenge/`).
    - `DNS-01`: Cloudflare API veya yerel PowerDNS üzerinden wildcard (`*.example.com`) sertifika talebi.
  - İletişim e-posta adresi (`email`).
  - Staging / Test ortamı toggle (`staging: true/false` — rate limit yemeden test için).
  - Sertifika kapsamındaki alan adları (Primary domain + tüm aliaslar).
  - Sertifika düzenleme işlemini async job olarak yürütme (`ssl.issue`).
- **Sertifika Yenileme (Renew Certificate):**
  - Sertifika süresi dolmadan önce manuel yenileme tetikleme.
  - Kuru çalıştırma (`dryRun: true`) ile Let's Encrypt bağlantısını test etme.
  - Canlı yenileme işi (`ssl.renew`).
- **Özel Sertifika Yükleme (Custom Certificate Upload):**
  - Harici satın alınmış sertifika için `Certificate (CRT / Fullchain)` ve `Private Key (KEY)` metinlerini yapıştırarak yükleme.
  - Sertifika SHA-256 parmak izi ve alan adı kapsamı doğrulama.
- **Sertifika Durum Takibi ve Yaşam Döngüsü:**
  - Durum rozetleri: `active`, `issuing`, `renewing`, `expired`, `failed`.
  - Kalan gün sayısı gösterimi.
  - Otomatik yenileme zamanlayıcısı (Süresi dolmaya 30 gün kala günlük kontrol).
  - Kullanılmayan sertifika materyallerinin çöp toplayıcısı (Certificate GC).

---

## 10. E-POSTA VE WEBMAIL (MAIL & ROUNDCUBE)

### 10.1. Mail Domain Yönetimi (`MailDomainsPage`)
- **Mod Seçimi:**
  - `local`: Sunucudaki Postfix/Dovecot/Rspamd motoru tarafından yönetilen tam e-posta domaini.
  - `external`: Harici (Google Workspace, Microsoft 365 vb.) e-posta kullanan domainlerin envanter takibi.
- **Web Domain Bağlantısı:**
  - Web sitesi alan adı ile mail domain kimliğini birbirine bağlama.
- **Mail Durum Rozetleri:** `enabled`, `ready`, `degraded`, `offline`.

### 10.2. Posta Kutuları (Mailboxes Panel)
- **Posta Kutusu Listesi:**
  - E-posta adresi (`user@domain.com`), kota kullanımı (kullanılan / toplam MiB), yönlendirme durumu, durum (`Aktif` / `Devre dışı`).
- **Yeni Posta Kutusu Oluşturma:**
  - Kullanıcı adı / e-posta ön eki.
  - Güvenli parola belirleme (minimum 12 karakter).
  - Kota belirleme (MiB cinsinden, örn: 1024 MiB).
- **Posta Kutusu Düzenleme:**
  - Parola değiştirme / sıfırlama.
  - Kota güncelleme (MiB).
  - Hesabı geçici olarak devre dışı bırakma veya yeniden etkinleştirme toggle'ı.
- **E-posta Yönlendirme (Forwarding):**
  - Gelen postaları başka bir adrese yönlendirme (`destination`).
  - Bir kopyasını yerel gelen kutusunda tutma (`keepCopy: true/false`).
- **Posta Kutusu Silme:**
  - Silme etki analizi (Mail delete impact: dizindeki e-posta verisi, yönlendirmeler).
  - Teyit modalı ile kalıcı silme.

### 10.3. E-Posta Takma Adları (Mail Aliases Panel)
- **Alias Listesi:**
  - Takma ad (`info@domain.com`), hedef adresler listesi, durum (`Aktif` / `Devre dışı`).
- **Yeni Alias Ekleme:**
  - Alias adı ve hedef e-posta adresleri (virgülle ayrılmış birden fazla hedef).
- **Alias Düzenleme ve Silme:**
  - Hedef adresleri güncelleme, aktiflik durumunu değiştirme, silme.

### 10.4. DKIM, SPF, DMARC ve Teşhis Paneli (`MailDkimDiagnosticsPanel`)
- **DKIM Yönetimi:**
  - Domain bazlı 2048-bit RSA DKIM anahtarı üretimi (`mail.dkim.generate`).
  - DKIM Selector belirleme ve rotasyon (Selector rotation).
  - Host Rspamd/Postfix imzalama konfigürasyonuna uygulama.
  - DNS'e girilecek DKIM TXT kaydı metninin ekranda gösterimi.
- **E-Posta Teşhis Kontrolleri (Diagnostics):**
  - **MX Kaydı Kontrolü:** DNS MX kaydının sunucuya işaret edip etmediği.
  - **SPF Kaydı Kontrolü:** `v=spf1 ...` TXT kaydının doğrulanması.
  - **DKIM Kaydı Kontrolü:** Kamusal DNS'teki selector TXT kaydı ile yerel public key eşleşmesi.
  - **DMARC Kaydı Kontrolü:** `_dmarc.<domain>` politikasının varlığı ve geçerliliği.
  - **SRS (Sender Rewriting Scheme) Durumu:** E-posta yönlendirmelerinde SPF kırılmasını önleyen SRS anahtarı ve yapılandırması.
  - **Antivirüs / Rspamd Sağlık Kontrolü:** ClamAV ve Rspamd servislerinin canlı tarama durumu.

### 10.5. Roundcube Webmail Entegrasyonu (`MailWebmailPanel`)
- Otomatik `webmail.<domain>` vhost ve Nginx proxy yapılandırması.
- Webmail SSL sertifikası bağlama.
- Tek Tıkla Webmail Aç (Single Sign-On / Webmail linki: `https://webmail.example.com`).
- Webmail mapping'ini kaldırma veya yeniden bağlama.

### 10.6. Sunucu Mail Konfigürasyonu (`MailConfigurationPanel`)
- Postfix (`main.cf`, `virtual_mailbox_domains`, `virtual_mailbox_maps`), Dovecot (`dovecot.conf`), Rspamd konfigürasyon önizlemesi.
- Diff görüntüleme ve sunucuya uygulama (`mail.config.apply` job'ı).

---

## 11. VERİTABANLARI VE PHPMYADMIN (DATABASES)

### 11.1. Veritabanı Envernteri ve Sunucu Durumu (`DatabasesPage`)
- **Canlı Unix Socket Envanteri:**
  - Yerel MariaDB / MySQL socket'i üzerinden anlık okunan canlı veritabanı listesi.
  - Veritabanı adı, şema boyutu (MiB/GiB), tablo sayısı, karakter seti (charset/collation).
- **Veritabanı Sağlık ve Güvenlik Denetimi:**
  - Engine tespiti (MariaDB veya MySQL sürümü).
  - Native root Unix socket kimlik doğrulaması kontrolü.
  - Anonim hesap (Anonymous accounts) denetimi.
  - Uzak root hesabı (Remote root accounts) denetimi.
  - Test veritabanı (`test` schema) varlık denetimi.
  - Güvenlik aksiyonu gerekli uyarıları.
- **Genel Veritabanı Oluşturma:**
  - Veritabanı adı girişi (1–64 karakter, sistem veritabanı adları engelli).
  - MariaDB üzerinde schema oluşturma işi.
- **Genel Veritabanı Silme:**
  - Veritabanı adı teyidi ile DROP DATABASE işi.

### 11.2. Siteye Bağlı Veritabanı Yönetimi (`SiteResourcesPanel` - Databases)
- **Website - Database Explicit Binding:**
  - Web sitesine açıkça bağlanmış schema ve kullanıcı durumu.
  - Site Unix kullanıcısı, DB kullanıcısı ve atanmış yetkiler (`ALL PRIVILEGES` veya özel grant).
- **Veritabanı Kullanıcı Parolasını Döndürme (Rotate Password):**
  - Ekrana veya loglara parola düşürmeden sunucu tarafında kriptografik rastgele parola üretme.
  - MariaDB kullanıcısının parolasını güncelleme (`ALTER USER`).
  - Bağlı uygulamanın env ayarları ile senkronizasyon uyarısı.
- **Veritabanı Kimlik Bilgisini Kaldırma (Revoke Credential):**
  - Veritabanı kullanıcısını ve grant'lerini hosttan kaldırma (`DROP USER`).
  - Schema ve Website binding'ini koruma.
- **Yerel Vendor Dump Yedeği Alma (Backup Database):**
  - `mariadb-dump` / `mysqldump` ile native şema yedeği alma.
  - Root-private güvenli depolama ve checksum doğrulaması.
- **Veritabanı Yedeğini Geri Yükleme (Restore Database):**
  - Doğrulanmış yedekler listesinden seçim yapma.
  - Geri yükleme önizlemesi (Restore preview: boyut, motor, hedef).
  - Geri yüklemeden hemen önce otomatik pre-restore snapshot alma.
  - Yedeği şemaya geri yükleme ve checksum doğrulaması.
- **Veritabanı Silme Önizlemesi ve Güvenli Silme (Drop with Backup Fence):**
  - Silme etki önizlemesi (`previewDatabaseDrop`):
    - Canlı şema varlığı, bağlı credential varlığı, geçerli yedeğin varlığı, aktif DB işleri.
  - Güvenlik Fencesi (Backup Fence):
    - İlgili şemanın doğrulanmış bir yedeği yoksa silme işlemi engellenir.
    - Önce credential kaldırılmalıdır.
  - DROP işi tamamlandıktan ve canlı şemanın yokluğu teyit edildikten sonra binding finalize edilir.

### 11.3. phpMyAdmin Entegrasyonu
- Güvenli Same-Origin Gateway köprüsü (`/tools/phpmyadmin/`).
- Tek kullanımlık, kısa süreli Handoff Token ile şifresiz/parolasız Single Sign-On girişi.
- Yalnızca ilgili Web sitesinin yetkili olduğu veritabanını görmesini sağlayan kullanıcı izolasyonu.

---

## 12. DOCKER YÖNETİMİ (DOCKER WORKLOADS & COMPOSE)

### 12.1. Managed Docker Compose Projeleri (`DockerProjectsPage`)
- **Proje Envanteri:**
  - Proje adı, servis sayısı, network sayısı, volume sayısı, revizyon numarası.
  - Yeni Compose projesi ekleme dialogu (`DockerProjectCreateDialog`).
- **Proje Detayı ve Durumu:**
  - Runtime durumu rozeti (`running`, `degraded`, `stopped`, `absent`).
  - Çalışan container sayısı ve listesi.
  - Container detayları: İsim, imaj, çalışma durumu, health check durumu, exit code.
- **Hedef ve Port Teşhisi (Diagnosis Panel):**
  - Servislerin TCP published portları listesi.
  - Website / Nginx ters proxy hedefi seçimi (`service:port`).
  - Nginx target hazır olma durumu denetimi.
  - Tespit edilen port çakışmaları ve konfigürasyon hataları tablosu.
- **Depolama ve Volume Politikası (Storage Panel):**
  - Servis storage mount'ları: Named volume, Project bind, Host bind, Ephemeral mount.
  - Yedekleme politikası eşleştirmesi: `Manifest'e dahil`, `Backup dışı`, `Varsayılan reddedilir`.
  - Rastgele host dizini bağlamalarını (arbitrary host bind) güvenlik nedeniyle kısıtlama.
- **Konfigürasyon Düzenleyici (`DockerConfigPanel`):**
  - `docker-compose.yml` metin düzenleyicisi.
  - Projeye özel ortam değişkenleri (`.env`) düzenleyicisi.
  - Konfigürasyon kaydetme ve revizyon artırma.
- **Yaşam Döngüsü Kontrolleri (`DockerLifecyclePanel`):**
  - `Up / Start`: Projeyi derleme ve container'ları başlatma.
  - `Stop`: Container'ları veri kaybı olmadan durdurma.
  - `Restart`: Container'ları yeniden başlatma.
  - `Down`: Container ve geçici ağları kaldırma.
  - `Pull`: Servis imajlarının güncel sürümlerini çekme.
- **Canlı Loglar ve İşlem Geçmişi:**
  - Container loglarını canlı akışla (streaming) izleme.
  - Projeye ait Docker yaşam döngüsü işlerinin geçmişi.

---

## 13. ZAMANLANMIŞ GÖREVLER (CRON JOBS)

### 13.1. Site Bazlı Cron Yönetimi (`website-cron-http.js`)
- **Cron Görevleri Listesi:**
  - Görev adı, zamanlama ifadesi (`schedule`, standart 5 haneli cron örn: `*/5 * * * *`), çalıştırılacak komut (`command`), durum (`Aktif` / `Devre dışı`).
- **Yeni Cron Görevi Ekleme:**
  - Görev adı, cron zamanlaması, komut.
  - Site Unix kullanıcısı bağlamında ve kısıtlı ortamda çalışma güvencesi.
- **Cron Görevi Düzenleme:**
  - Revizyon kontrolü (`expectedRevision`) ile çakışmasız güncelleme.
  - Komut, zamanlama ve aktiflik toggle'ını değiştirme.
- **Cron Görevi Silme:**
  - Beklenen revizyon doğrulaması ile görevi crontab / systemd timer'dan kaldırma.

---

## 14. ÖNBELLEK YÖNETİMİ (REDIS & MEMCACHED CACHE)

### 14.1. Site İzolasyonlu Önbellek (`website-cache-http.js`)
- **Redis Cache:**
  - Siteye özel Redis ACL kullanıcısı ve şifresi oluşturma.
  - Key prefix izolasyonu (`site_<id>:*`).
  - İzin verilen veritabanı numarası kısıtlaması (`allowedDb`).
  - Tehlikeli komut kısıtlaması (ACL ile `-@dangerous`, `-@admin`, `-FLUSHALL`, `-CONFIG` engeli).
  - Redis şifresini döndürme (`rotate-password`).
- **Memcached Cache:**
  - Site bazlı key prefix yapılandırması.
  - Memcached erişimini etkinleştirme.
- **Önbelleği Devre Dışı Bırakma:**
  - Siteye ait önbellek tanımlarını ve ACL kullanıcılarını güvenli temizleme.

---

## 15. GELİŞTİRİCİ ARAÇLARI: WP-CLI VE COMPOSER

### 15.1. WordPress ve PHP Araçları Entegrasyonu (`website-php-tools-http.js`)
- **WP-CLI (WordPress Komut Satırı):**
  - Sitede WordPress kurulu olup olmadığını denetleme (`/wp-cli/status`).
  - Sitenin Unix kullanıcısı altında güvenli WP-CLI komutları çalıştırma (`/wp-cli/run`):
    - Komut adı ve argümanlar listesi.
    - Zaman aşımı (Timeout) sınırı.
    - JSON formatında standart çıktı (stdout), hata çıktısı (stderr) ve çıkış kodu.
- **Composer (PHP Paket Yöneticisi):**
  - Sitede `composer.json` varlığını ve Composer durumunu sorgulama (`/composer/status`).
  - Site dizininde Composer komutları çalıştırma (`/composer/run`):
    - `install`, `update`, `dump-autoload` vb. komutlar.
    - Çıktı ve hata takibi.

---

## 16. WEB ANALİTİĞİ VE SİSTEM İZLEME (ANALYTICS & MONITORING)

### 16.1. GoAccess Erişim Log Analizi (`website-analytics-http.js`)
- **Statik HTML Raporu:**
  - Sitenin Nginx access loglarını GoAccess ile analiz etme.
  - Tek tıkla zengin, interaktif statik HTML analitik raporu üretme ve görüntüleme (`format=html`).
- **Gerçek Zamanlı Analitik Daemon:**
  - Site bazlı realtime GoAccess daemon durumunu denetleme (`/analytics/status`).
  - Canlı WebSocket yayınını başlatma (`/analytics/realtime/start`).
  - Canlı yayını durdurma (`/analytics/realtime/stop`) ve yeniden başlatma.

### 16.2. Netdata ve Donanım Metrikleri
- Sunucu genelinde CPU, RAM, Disk, Ağ ve Çalışma Süresi (Uptime) metrikleri.
- Netdata izleme servisi entegrasyonu ve durum kontrolü.

---

## 17. YEDEKLEME VE GERİ YÜKLEME (RESTIC & RCLONE BACKUPS)

### 17.1. Restic Yedek Depoları (`backup-repository-http.js`)
- **Yedek Deposu (Repository) Yönetimi:**
  - Depo listeleme, oluşturma ve ilklendirme (`restic init`).
  - Depo türü: Yerel disk (`/var/yunpanel/backups/...`) veya Rclone üzerinden uzak hedef.
  - Şifreli yedekleme (Master key ve depo parolası koruması).
  - Depo bütünlük kontrolü (`restic check`).
  - Kilit açma (`restic unlock` — kesintiye uğrayan işlemler için).
  - Saklama politikası uygulama ve budama (`restic prune` / retention).
- **Snapshot (Anlık Görüntü) Listesi:**
  - Alınan yedek anlık görüntülerinin listesi, etiketler (tags), tarih ve boyut bilgisi.

### 17.2. Rclone Uzak Depolama Bağlantıları
- Uzak sağlayıcı ekleme: Amazon S3, Backblaze B2, Google Cloud Storage, SFTP, WebDAV.
- Parametre ve kimlik bilgileri yapılandırması (şifreli saklama).
- Uzak hedef bağlantı testi ve listeleme.

### 17.3. Web Sitesi Yedekleme ve Geri Yükleme Seti
- **Yedek Seti Sağlayıcısı (`WebsiteBackupSet`):**
  - Bir sitenin tüm varlıklarını (dosyalar, veritabanı dump'ı, mail verileri, Nginx/site meta verileri, env değişkenleri) tekilleştirilmiş tek bir yedek seti olarak paketleme.
- **Yedekleme Önizlemesi ve Başlatma:**
  - Hangi bileşenlerin yedekleneceğini gösteren önizleme diff'i (`/backup/preview`).
  - Etiketlerle yedek başlatma (`/backup`).
- **Geri Yükleme ve Sağlık Doğrulaması:**
  - Snapshot'tan geri yükleme önizlemesi (`/restore/preview`).
  - Geri yükleme sonrası otomatik HTTP sağlık kontrolü (`healthPath`).
  - Geri yükleme makbuzu ve raporu üretimi (`WebsiteRestoreReceiptStore`).

---

## 18. PLESK MİGRATION İÇE AKTARICI (PLESK IMPORTER)

### 18.1. Çevrimdışı Dışa Aktarımdan İçe Aktarma (`plesk-importer-http.js`)
- Plesk sunucusundan alınmış offline JSON/XML export verisini analiz etme.
- İçe aktarma önizlemesi (`/importer/plesk/preview`):
  - Tespit edilen alan adları, abonelikler, veritabanları, e-posta hesapları ve yönlendirmeler.
  - YunPanel mimarisine dönüştürme planı ve uyumsuzluk uyarıları.

---

## 19. YÖNETİLEN SİSTEM SERVİSLERİ VE GÜNCELLEMELER (SYSTEM & SERVICES)

### 19.1. Yönetilen Servisler Paneli (`ManagedServicesPanel`)
- **12 Temel Altyapı Servisi:**
  - `nginx`: Web sunucusu ve ters proxy.
  - `mariadb`: İlişkisel veritabanı sunucusu.
  - `docker`: Konteyner motoru ve Compose.
  - `cron`: Zamanlanmış görev zamanlayıcısı.
  - `postfix`: SMTP posta aktarım ajanı (MTA).
  - `dovecot`: IMAP/POP3 posta teslim sunucusu.
  - `rspamd`: E-posta filtreleme, spam ve DKIM imzalama motoru.
  - `powerdns`: Yetkili DNS sunucusu.
  - `netdata`: Gerçek zamanlı sistem ve performans izleme.
  - `goaccess`: Web erişim log analizörü.
  - `crowdsec`: Tehdit algılama ve güvenlik duvarı bouncer'ı.
  - `restic`: Şifreli ve tekilleştirilmiş yedekleme aracı.
- **İşlemler:**
  - Sunucuyu tara (`Sunucuyu tara` butonu — canlı paket ve systemd denetimi).
  - Servis kur (`Kur ve başlat` — APT paket kurulumu ve systemd unit aktivasyonu).
  - Servis kontrolü: `Başlat`, `Durdur`, `Yeniden başlat` (onay modalları ile).

### 19.2. Sunucu DNS Kimliği (`NetworkDnsSettingsPanel`)
- Sunucunun genel IPv4 ve IPv6 adresleri.
- `ns1` ve `ns2` hostname ve IP adresleri tanımlaması (Yerel sunucu veya harici secondary).
- SOA politikası: Responsible name (`hostmaster`), TTL, Refresh, Retry, Expire, Minimum.
- Yeni açılan zonelar için DNSSEC varsayılanı (Açık / Kapalı).
- Değişiklik önizleme ve onay kodu ile uygulama.

### 19.3. Sistem Güncellemeleri Paneli (`SystemUpdatePanel`)
- İşletim sistemi paket güncellemelerini denetleme (`SYSTEM_PACKAGES_INSPECT`).
- Güncellenebilir paketlerin listesi ve güvenlik güncellemeleri rozetleri.
- YunPanel yazılımını güncelleme (`SYSTEM_UPGRADE` — `upgrade-yunpanel` açık teyidi ile).

---

## 20. SİSTEM LOGLARI VE DENETİM İZİ (LOGS & AUDIT)

### 20.1. Site ve Servis Logları (`LogsPanel`)
- **Log Akışları:**
  - Uygulama logları (Node.js/Python konsol çıktıları).
  - Nginx Erişim Logları (`access.log`).
  - Nginx Hata Logları (`error.log`).
- **Arama ve Filtreleme:**
  - Canlı log satırlarında metin araması.
  - Satır sayısı sınırlaması ve log dosyasını tam indirme (Download).

### 20.2. Sistem Denetim Kayıtları (`AuditPage`)
- **Kapsam:**
  - Panel üzerinden yapılan tüm oturum açma, oluşturma, güncelleme, silme, yetkilendirme ve iptal işlemleri.
  - Gizli anahtarlar, parolalar ve terminal çıktıları denetim kütüğüne yazılmaz; yalnızca işlem metadata'sı tutulur.
- **Filtreler:**
  - Actor kimliği (kullanıcı adı / token).
  - İşlem adı (örn: `site.create`, `database.delete`, `user.update`).
  - Sonuç: `Tümü`, `Kabul edildi`, `Başarılı`, `Başarısız`, `Reddedildi`, `İptal edildi`.
  - Kaynak türü (örn: `website`, `domain`, `database`, `certificate`, `user`).
  - Kaynak kimliği.
  - Başlangıç ve bitiş zamanı aralığı (`datetime-local`).
- **Kayıt Tablosu ve Sayfalama:**
  - Zaman, işlem adı, actor, kaynak, sonuç rozeti.
  - Sayfa başına 50 kayıt ve sayfalama gezintisi.

---

## 21. AI YÖNETİM ASİSTANI (AI ASSISTANT)

### 21.1. AI Asistanı Sohbet Çekmecesi (`AiDrawer`)
- **Erişim:**
  - Klavyeden `⌘ + Shift + A` veya üst araç çubuğundaki `AI Asistan` butonu ile her sayfadan açılabilen global modal/drawer.
  - Bulunulan web sitesinin bağlamını (`currentWebsiteId`) otomatik algılama.
- **Sohbet Yönetimi:**
  - Çoklu sohbet oturumu desteği (Yeni sohbet başlatma, geçmiş sohbetleri listeleme, silme).
  - Sohbet geçmişi ve mesajlaşma arayüzü.
- **Sınırlı ve Güvenli Araç Çağrıları (Bounded Tool Calls):**
  - Asistan sunucu işlemlerini yürütmek için 20 adet katı allowlist aracına sahiptir.
  - **Salt Okunur Araçlar:** Site listeleme, detay okuma, dosya listeleme, servis durumu, log okuma, metrik inceleme.
  - **Yazma ve Değişiklik Araçları:** Site oluşturma, dosya yazma, servis yeniden başlatma, veritabanı işlemi vb.
- **Etkileşimli Eylem Öneri Kartları (Interactive Proposal Cards):**
  - Asistan yıkıcı veya değiştirici bir işlem yapmak istediğinde doğrudan çalıştırmaz; ekranda parametreleri ve etkiyi açıklayan bir "Eylem Önerisi" kartı sunar.
  - Kullanıcı karttaki `Onayla ve Çalıştır` butonuna basmadan hiçbir sistem değişikliği yapılamaz.

### 21.2. AI Sağlayıcı ve Model Ayarları (`AiSettingsPanel`)
- **Çoklu Sağlayıcı (Provider) Desteği:**
  - `anthropic`: Claude 3.5 Sonnet, Claude 3 Opus vb.
  - `openai`: GPT-4o, GPT-4o-mini vb.
  - `gemini`: Google Gemini 1.5 Pro / Flash.
  - `ollama`: Yerel veya uzak sunucuda çalışan açık kaynak modeller (Llama 3, Mistral, Qwen vb.).
- **Sağlayıcı Yapılandırması:**
  - Sağlayıcı ID, Sağlayıcı türü, API anahtarı, Base URL (özel endpointler ve Ollama için), Varsayılan model adı.
  - Aktif sağlayıcı olarak belirleme seçeneği.
- **Bağlantı Testi (Test Connection):**
  - `Test Et` butonu ile sağlayıcı API'sine anlık ping atarak anahtar ve model doğrulaması.
- **AI Güvenlik Politikası Gösterimi:**
  - İzin verilen araçlar listesi, tehlikeli araçlar için zorunlu kullanıcı onayı politikası kuralları.

---

## 22. KULLANICI ARAYÜZÜ, NAVİGASYON VE TERCİHLER

### 22.1. Üst Araç Çubuğu ve Global Arama
- **Hızlı Komut Paleti (`CommandPalette` — `⌘ + K`):**
  - Herhangi bir ekrandan tüm siteler, sayfalar ve panel bölümleri arasında hızlı arama ve klavye ile anında geçiş.
- **İşlem Çekmecesi (`JobDrawer`):**
  - Arka planda çalışan tüm asenkron işlemleri (deploy, backup, ssl, package) gerçek zamanlı takip etme.
  - Aktif iş sayısı rozeti ve detaylı log çıktısı.
- **Kullanıcı Tercihleri (`Preferences`):**
  - Tema desteği (Karanlık / Aydınlık mod tercihi).
  - Dil ve erişilebilirlik ayarları.

---

## ÖZET VE KONTROL MATRİSİ

| No | Modül / Alan | Temel Yetenekler | UI Bileşeni / Sayfa | Ana API Endpointleri |
|:---|:---|:---|:---|:---|
| 1 | **Kimlik & Oturum** | Giriş, Çıkış, Argon2id, CSRF, Rate Limit, Cookie | `LoginForm.jsx`, `AuthGate.jsx` | `/api/auth/login`, `/api/auth/logout`, `/api/auth/session` |
| 2 | **Hesabım & MFA** | Parola değiştir, TOTP kur/doğrula, Recovery kod, Oturum kapat | `AccountDialog.jsx`, `MfaSettings.jsx` | `/api/auth/password`, `/api/auth/mfa/*`, `/api/auth/sessions` |
| 3 | **Kullanıcı Yönetimi** | Kullanıcı CRUD, Rol (Owner/SiteMgr/ReadOnly), Site atama | `UsersPage.jsx` | `/api/users`, `/api/users/:id` |
| 4 | **Web Siteleri** | Site listesi, detay, üst/alt alan adı, shared-site | `WebsitesPage.jsx`, `SiteDetailPage.jsx` | `/api/websites`, `/api/websites/:id` |
| 5 | **Yeni Site Sihirbazı** | Node, PHP, Statik, Git, DB, Mail, SSL, Otomatik prov. | `NewWebsitePage.jsx` | `/api/sites`, `/api/sites/create-preview`, `/api/provisioning/*` |
| 6 | **Provisioning Recovery**| Adım tekrarı, kompanzasyon, devam ettirme | `ProvisioningRecoveryPanel.jsx` | `/api/provisioning/:opId/*` |
| 7 | **Site İzolasyonu** | Unix user, SFTP, FPM pool denetimi, migration, rollback | `WebsiteIsolationPanel.jsx` | `/api/websites/:id/isolation/*` |
| 8 | **Alan Adları & Alias** | Domain update diff, Reparenting, Suspend, Removal impact | `DomainOperations.jsx`, `OperationsPages.jsx` | `/api/domains`, `/api/domains/:id/*`, `/api/resource-impact` |
| 9 | **Node.js & Passenger** | Node 18-24, Passenger restart, Status, Process refresh | `SiteDetailPage.jsx`, `ApplicationsPage.jsx` | `/api/applications/:id/*`, `/api/servers/:id/node-runtimes/*` |
| 10 | **PHP & Python** | PHP 8.1-8.4 FPM pool, Python venv Gunicorn/Uvicorn | `SiteResourcesPanel.jsx` | `/api/websites/:id` |
| 11 | **Git Deploy & Rollback**| Commit/branch deploy, Symlink release, Rollback, Webhook | `SiteOperations.jsx`, `ApplicationsPage.jsx` | `/api/applications/:id/deploy`, `/rollback`, `/github-webhook` |
| 12 | **Ortam Değişkenleri** | Key-value CRUD, Şifreli secret, .env merge/replace | `EnvironmentPanel.jsx` | `/api/applications/:id/environment/*` |
| 13 | **Dosya Yöneticisi** | Gezinti, Dosya/Klasör oluştur, Upload, Download, Edit, Sil | `FilesPanel.jsx` | `/api/websites/:id/files/*` |
| 14 | **Web Terminali** | Site user PTY, Server root PTY, xterm.js, WebSocket | `TerminalPanel.jsx`, `LazyTerminalPanel.jsx`| `/api/terminal/sessions`, `/tools/ttyd/*` |
| 15 | **Authoritative DNS** | PowerDNS RRsets CRUD, Re-apply diff, DNSSEC, AXFR | `DnsPanel.jsx`, `SecondaryDnsStatusPanel.jsx` | `/api/dns/zones/:id/*`, `/api/dns/operations/*` |
| 16 | **SSL / TLS** | Let's Encrypt HTTP-01/DNS-01, Custom cert, Auto-renew | `SiteOperations.jsx`, `CertificatesView.jsx` | `/api/certificates`, `/api/domains/:id/certificates/issue` |
| 17 | **E-Posta & Posta Kutusu**| Local/External domain, Mailbox CRUD, Quota, Forwarding | `MailDomainsPage.jsx`, `MailboxesPanel.jsx` | `/api/mail-domains/*`, `/api/mailboxes/*` |
| 18 | **DKIM & Teşhis** | 2048-bit DKIM üretimi, Selector rotasyonu, SPF/DMARC/SRS | `MailDkimDiagnosticsPanel.jsx` | `/api/mail-domains/:id/dkim/*`, `/diagnostics` |
| 19 | **Roundcube Webmail** | webmail.<domain> vhost, SSL bağı, Single Sign-On | `MailWebmailPanel.jsx` | `/api/roundcube/*`, `/tools/roundcube/` |
| 20 | **Veritabanları (MariaDB)**| Canlı socket envanteri, Güvenlik denetimi, Schema CRUD | `DatabasesPage.jsx` | `/api/servers/:id/databases/*` |
| 21 | **Site DB & phpMyAdmin** | Parola döndür, Revoke, Dump backup/restore, PMA SSO | `SiteResourcesPanel.jsx` | `/api/websites/:id/databases/*`, `/tools/phpmyadmin/` |
| 22 | **Docker Compose** | Proje CRUD, YAML/Env editör, Up/Down/Start/Stop, Teşhis | `DockerProjectsPage.jsx`, `DockerConfigPanel.jsx` | `/api/docker/compose/*` |
| 23 | **Zamanlanmış Görevler** | Site cron CRUD, Zamanlama, Komut, Enable/Disable | `website-cron-http.js` | `/api/websites/:id/crons/*` |
| 24 | **Önbellek (Cache)** | Redis ACL, Key prefix, Memcached, Parola döndür | `website-cache-http.js` | `/api/websites/:id/cache/*` |
| 25 | **WP-CLI & Composer** | WordPress CLI komutları, Composer paket yönetimi | `website-php-tools-http.js` | `/api/websites/:id/wp-cli/*`, `/composer/*` |
| 26 | **Web Analitiği** | GoAccess HTML rapor, Realtime daemon WebSocket | `website-analytics-http.js` | `/api/websites/:id/analytics/*`, `/tools/goaccess/*` |
| 27 | **Yedekleme (Restic/Rclone)**| Depo CRUD, Check, Unlock, Prune, Snapshot, Restore | `backup-repository-http.js`, `website-backup-http.js` | `/api/backups/*`, `/api/websites/:id/backup/*` |
| 28 | **Plesk İçe Aktarıcı** | Offline XML/JSON export analizi ve migration preview | `plesk-importer-http.js` | `/api/importer/plesk/preview` |
| 29 | **Yönetilen Servisler** | Nginx, MariaDB, Docker vb. 12 servis tara/kur/yönet | `ManagedServicesPanel.jsx` | `/api/servers/:id/services/*` |
| 30 | **Sunucu DNS Kimliği** | Public IP, ns1/ns2, SOA politikası, Delegasyon testi | `NetworkDnsSettingsPanel.jsx` | `/api/servers/:id/dns-identity/*` |
| 31 | **Sistem Güncellemeleri**| Paket tarama, YunPanel güncelleme işi | `SystemUpdatePanel.jsx` | `/api/servers/:id/system/*` |
| 32 | **Loglar & Denetim İzi** | Site logları indirme, Arama, 50'şerli sayfalı Audit | `LogsPanel.jsx`, `AuditPage.jsx` | `/api/logs/*`, `/api/audit` |
| 33 | **AI Asistanı** | Global drawer, Çoklu model (Claude/OpenAI/Gemini/Ollama)| `AiDrawer.jsx`, `AiSettingsPanel.jsx` | `/api/ai/*` |
| 34 | **Genel Araçlar** | ⌘K Komut paleti, İşlem çekmecesi, Tema tercihleri | `CommandPalette.jsx`, `JobDrawer.jsx`, `Preferences.jsx`| `/api/jobs/*` |
