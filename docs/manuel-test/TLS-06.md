# TLS-06 — Geçerlilik, gerçek sunulan sertifika, durum ve uyarılar

- **Durum:** TAMAMLANDI
- **Tarih:** 2026-10-26
- **Test eden:** AGENT_3
- **Görev:** T103
- **Hedef:** `https://server.cryptoraichu.website` (`.local/test-server.env`, `.28` host)
- **Sonuç:** KISMİ

## Özet

| Alan | Durum | Kısa not |
|---|---|---|
| E1. Kod ve mevcut testler | GEÇTİ | İlgili backend (`certificate-http.js`, `certificate-registry.js`, `operational-notification-service.js`) ve frontend (`SiteOperations.jsx`, `SslRenewalPanel.jsx`, `NotificationCenterDrawer.jsx`, `site-model.js`) kodları ve 21 test dosyası incelendi ve koşturuldu. |
| E2. UI/UX ve gerçek kullanıcı akışı | KISMİ | `/websites` ve `/websites/:id/ssl` ekranlarında geçerlilik tarihleri (`Başlangıç`, `Bitiş`), kalan gün rozetleri (`88 gün`, `10 gün`, `Sertifika bekliyor`, `SSL kapalı`) ve `Bildirim ve Görev Merkezi` (`Sistem Uyarıları`) düzgün çalışıyor; ancak varsayılan SSL sekmesinde `fingerprint256`, `issuer`, `subject`, `diagnosis`, `lastReloadOutcome` ve canlı sunulan sertifika doğrulaması gösterilmiyor. |
| E3. Backend / API / doğrulama | KISMİ | `GET/POST .../verify-tls`, `POST .../renewal-outcome` ve `POST .../reload-outcome` uç noktaları çalışıyor; ancak `certificate-http.js` içinde `POST .../verify-tls` rotaları iki kez tanımlandığı için ikinci tanımlanan `handleVerifyTls` POST işleyicisi gölgeleniyor. |
| E4. Sistem / host / gerçek etki | GEÇTİ | `.28` sunucusunda `:443` portuna gerçek SNI TLS el sıkışmaları (`tls.connect`) yapılarak hem mevcut 6 üretim domaininin Let's Encrypt sertifikalarının hem de test için yüklenen 10 günlük özel X.509 sertifikanın (`ttls06-a3.webrich.news`) Nginx tarafından fiziksel olarak birebir aynı SHA-256 parmak iziyle sunulduğu doğrulandı. |
| E5. Hata ve sınır durumları | GEÇTİ | Aktif olmayan domainde ACME isteği (`409 http_domain_not_active`), geçersiz/boş ACME e-postası (`400 invalid_acme_email`), uyuşmayan özel anahtar (`409 certificate_private_key_mismatch`), yanlış domain kapsamı (`409 certificate_domain_mismatch`), canlı TLS parmak izi/tarih uyuşmazlığı (`matches: false`) ve kısmi servis reload teşhisi (`certificate_reload_partial`) doğrulandı. |
| E6. Güvenlik ve yetki | KISMİ | `certificate-http.js` ve `tenant-boundary.js` üzerinde CSRF, oturum doğrulaması ve Customer/Reseller RBAC izolasyonu çalışıyor; ancak arka uç `checkCertificateExpirations()` (`operational-notification-service.js:840-870`) bildirim üretirken `websiteId` geçirmediği için süre dolumu bildirimleri yalnızca Owner'a gidiyor. |
| E7. Temizlik ve kalıntı | GEÇTİ | Test için oluşturulan `ttls06-a3.webrich.news` alan adı `domain-removal` iş akışıyla, özel sertifika materyali ise `POST /api/panel/certificates/gc/sweep` (`retentionDays: 0`) ile tamamen temizlendi; mevcut sitelere dokunulmadı. |
| E8. Mevcut testlerin kalitesi | KISMİ | Birim ve API testlerinin tamamı geçti; ancak `e2e/07-ssl-certificates.spec.js` içindeki 3 testten 2'si eski tablo seçicisi (`table.ws-table`) yüzünden `KIRMIZI` durumda ve bazı web testleri `readFileSync` + regex (`YÜZEYSEL`) veya bellek içi sahte backend (`MOCK`) kullanıyor. |

---

## Senaryolar

### S1: Mevcut sitelerde geçerlilik tarihleri, kalan gün rozetleri ve `:443` üzerinde fiziksel sunulan X.509 sertifika karşılaştırması
- **Adımlar:**
  1. Tarayıcıda Owner hesabıyla `/websites` sayfasına git ve site kartlarındaki SSL durum rozetlerini incele.
  2. `webrich.news` sitesinin `/websites/09efa3a3-81ed-5764-b925-3a6770516a6f` (Genel Bakış) ve `/websites/09efa3a3-81ed-5764-b925-3a6770516a6f/ssl` (SSL/TLS Sertifikaları) sekmelerini aç.
  3. `/api/panel/domains` ve `/api/panel/certificates` kayıtlarını oku; `.28` sunucusunun `443` portuna her alan adı için SNI ile gerçek `tls.connect` bağlantısı kurarak sunulan fiziksel X.509 sertifikasının `fingerprint256`, `validFrom`, `validTo`, `issuer`, `subject` ve `subjectaltname` alanlarını karşılaştır.
  4. `GET /api/panel/domains/:domainId/certificates/:certId/verify-tls` ve `POST /api/panel/domains/:domainId/certificates/:certId/verify-tls` uç noktalarını gerçek TLS verisiyle çağır.
- **Beklenen:**
  - Kalan süresi 30 günden fazla olan aktif sertifikalarda yeşil (`ws-badge-good`) `<N> gün` rozeti gösterilmeli.
  - SSL sekmesinde sertifika adı, kapsam, başlangıç/bitiş tarihleri, sağlayıcı (`issuer`), konu (`subject`), SHA-256 parmak izi (`fingerprint256`) ve sunulan gerçek sertifika doğrulama durumu görünmeli.
  - `:443` portundan sunulan fiziksel sertifika ile panel veritabanındaki kayıt birebir eşleşmeli (`matches: true`, `verified: true`).
- **Gerçekleşen:**
  - `/websites` kartlarında `webrich.news` için `88 gün` (`ws-badge-good`), `yp-node.webrich.news`, `yp-wp.webrich.news`, `yp-staging.webrich.news`, `git-route.yp-node.webrich.news` için `76 gün` (`ws-badge-good`), `yp-form.webrich.news` için `75 gün` (`ws-badge-good`) rozetleri doğru hesaplanarak gösterildi (`site-model.js:51-62`).
  - `:443` portuna yapılan fiziksel TLS bağlantılarında 6 aktif domainin tamamında TLSv1.3 üzerinden Let's Encrypt (`C=US, O=Let's Encrypt, CN=YE1/YE2`) sertifikalarının sunulduğu ve SHA-256 parmak izlerinin `/api/panel/certificates` kayıtlarıyla %100 eşleştiği doğrulandı (ör. `webrich.news` -> `55:16:63:1A:08:2D:6A:4E:CE:E1:B8:B1:78:E5:A6:29:E8:C2:C1:43:0D:D3:24:2B:96:CC:85:5D:C9:C5:0D:A5`, `matches: true`, `code: "tls_verified"`).
  - **Eksik/Kısmi:** `/websites/:id/ssl` sekmesinde yalnızca `Sertifika adı` (`webrich.news`), `Kapsam` (`webrich.news, www.webrich.news`), `Başlangıç` (`24.10.2026 03:15`), `Bitiş` (`22.01.2027 03:15`) ve `HTTPS tercihi` (`Yönetilen`) gösteriliyor. API yanıtında mevcut olan `issuer`, `subject`, `fingerprint256`, `source`, `lastReloadOutcome` ve `diagnosis` alanları varsayılan SSL görünümünde yer almıyor; ayrıca ön yüz `verify-tls` uç noktasını hiç çağırmıyor (`fingerprint256` yalnızca aynı oturumda yenileme/dry-run tetiklendikten sonra `SslRenewalPanel` altında beliriyor).
- **Durum:** KISMİ
- **Kanıt:** `.local/manuel-test/TLS-06/01-websites-ssl-badges.png`, `.local/manuel-test/TLS-06/02-webrich-overview-ssl.png`, `.local/manuel-test/TLS-06/03-webrich-ssl-tab.png`, `.local/manuel-test/TLS-06/tls06-results.json` (`scenarios.scenario1`).

### S2: `SSL kapalı` ve `Sertifika bekliyor` durum rozetleri ile Bildirim ve Görev Merkezi (`Sistem Uyarıları`) entegrasyonu
- **Adımlar:**
  1. İzole test alan adı `ttls06-a3.webrich.news` (`targetType: "proxy"`, `upstreamPort: 4399`, `httpsMode: "off"`) oluştur.
  2. `/websites` listesinde `ttls06-a3.webrich.news` kartının SSL rozetini kontrol et.
  3. Üst bardaki `Bildirimler` (`button[aria-label="Bildirim ve Görev Merkezi"]`) çekmecesini aç, `Sistem Uyarıları` sekmesine geç ve `ttls06-a3.webrich.news` için üretilen uyarı kartını ve `SSL'i incele` bağlantısını test et.
  4. `httpsMode === "managed"` olup henüz sertifikası olmayan alan adında (`ttls01-a2.webrich.news`) rozet durumunu kontrol et.
- **Beklenen:**
  - `httpsMode: "off"` ve sertifikasız alan adında gri `SSL kapalı` (`ws-badge-neutral`) rozeti, `httpsMode: "managed"` ve sertifikasız alan adında sarı `Sertifika bekliyor` (`ws-badge-warn`) rozeti gösterilmeli.
  - `Bildirim ve Görev Merkezi` -> `Sistem Uyarıları` sekmesinde `SSL · ttls06-a3.webrich.news` (`Uyarı` / `SSL kapalı`) satırı listelenmeli ve `SSL'i incele` tıklandığında `/websites/:id/ssl` adresine yönlendirmeli.
- **Gerçekleşen:**
  - `ttls06-a3.webrich.news` kartında `SSL kapalı` (`ws-badge ws-badge-neutral`), sertifikasız yönetilen domainde ise `Sertifika bekliyor` (`ws-badge ws-badge-warn`) rozeti görüntülendi.
  - `Bildirim ve Görev Merkezi` -> `Sistem Uyarıları` sekmesinde `SSL · ttls06-a3.webrich.news · Uyarı · SSL kapalı` uyarısı listelendi ve `SSL'i incele` butonu doğrudan `/websites/7b606485-4743-429a-b75b-8a5917e30038/ssl` sayfasına yönlendirdi.
- **Durum:** GEÇTİ
- **Kanıt:** `.local/manuel-test/TLS-06/04-ttls06-ssl-off-card.png`, `.local/manuel-test/TLS-06/05-notification-center-ssl-off.png`, `.local/manuel-test/TLS-06/08-websites-ttls06-warning-badge.png`, `.local/manuel-test/TLS-06/tls06-results.json` (`scenarios.scenario2`).

### S3: Geçersiz girdi, önkoşul ve özel sertifika doğrulama kontrolleri (Validation & Edge Cases)
- **Adımlar:**
  1. Henüz Nginx üzerinde etkinleştirilmemiş (`draft`) `ttls06-a3.webrich.news` alan adında `/websites/:id/ssl` sekmesine git, `ACME hesap e-postası` alanına `gecersiz-eposta-format` yaz ve buton durumlarını kontrol et.
  2. Etkinleştirilmemiş alan adı için `POST /api/panel/domains/:id/certificates/issue` çağrısı yap.
  3. Alan adını HTTP olarak stage ve activate ettikten sonra `POST /api/panel/domains/:id/certificates/issue` uç noktasını geçersiz e-posta (`gecersiz-eposta-format`) ve boş e-posta ile çağır.
  4. `POST /api/panel/domains/:id/certificates/custom-preview` uç noktasını (a) sertifika ile uyuşmayan private key, (b) farklı bir alan adı (`wrong-domain.example.com`) için üretilmiş sertifika ile çağır.
- **Beklenen:**
  - Ön yüzde geçersiz e-posta girildiğinde `input[type="email"]` `typeMismatch: true` olmalı ve `SSL sertifikası al` / `ACME doğrulamasını test et` butonları devre dışı (`disabled: true`) kalmalı.
  - Arka uçta aktif olmayan domainde `409 http_domain_not_active`, geçersiz/eksik e-postada `400 invalid_acme_email`, uyuşmayan özel anahtarda `409 certificate_private_key_mismatch`, alan adı kapsam uyuşmazlığında `409 certificate_domain_mismatch` dönmeli.
- **Gerçekleşen:**
  - Ön yüzde `gecersiz-eposta-format` girildiğinde `validity.typeMismatch === true`, `validity.valid === false` oldu ve `SSL sertifikası al` ile `ACME doğrulamasını test et` butonları `disabled: true` kaldı.
  - Arka uç yanıtları beklendiği gibi döndü:
    - Aktif olmayan domainde ACME isteği: `409` (`code: "http_domain_not_active"`)
    - Geçersiz/boş e-posta ile ACME isteği: `400` (`code: "invalid_acme_email"`, `"ACME account email is invalid"`)
    - Uyuşmayan private key ile özel sertifika önizlemesi: `409` (`code: "certificate_private_key_mismatch"`)
    - Farklı domain (`wrong-domain.example.com`) sertifikası ile önizleme: `409` (`code: "certificate_domain_mismatch"`)
- **Durum:** GEÇTİ
- **Kanıt:** `.local/manuel-test/TLS-06/06-ssl-invalid-email.png`, `.local/manuel-test/TLS-06/tls06-results.json` (`scenarios.scenario3`).

### S4: Yakında süresi dolacak (`<= 30 gün`) sertifika durumu, uyarı rozeti, bildirim çekmecesi ve `:443` fiziksel sunum doğrulaması
- **Adımlar:**
  1. `ttls06-a3.webrich.news` için OpenSSL ile 10 gün geçerli (`validFrom: 2026-10-26T16:45:21.000Z`, `validTo: 2026-11-05T16:45:21.000Z`) gerçek bir X.509 sertifikası üret.
  2. `POST /api/panel/domains/:id/certificates/custom-preview` ve `POST /api/panel/domains/:id/certificates/custom` ile sertifikayı içe aktar, ardından domaini `stage` ve `activate` ederek Nginx'e uygula.
  3. `/websites/:id/ssl` ve `/websites` sayfalarında rozet rengini ve metnini (`10 gün`), manuel sertifika bilgi mesajını ve üst bardaki `Bildirim ve Görev Merkezi` -> `Sistem Uyarıları` sekmesini kontrol et.
  4. `.28` sunucusunun `443` portuna `servername: "ttls06-a3.webrich.news"` (SNI) ile gerçek TLS el sıkışması yap ve Nginx'in sunduğu sertifikayı hem `GET /api/panel/certificates/:id` hem de `GET/POST .../verify-tls` ile karşılaştır.
- **Beklenen:**
  - Kalan gün `<= 30` olduğu için hem `/websites` kartında hem `/websites/:id/ssl` sekmesinde sarı uyarı rozeti (`ws-badge-warn`) ile `10 gün` yazmalı.
  - `Bildirim ve Görev Merkezi` -> `Sistem Uyarıları` altında `SSL · ttls06-a3.webrich.news` için `Uyarı` (`10 gün`) kaydı oluşmalı.
  - API sertifika kaydında `diagnosis: { severity: "warning", code: "certificate_expiring" }` ve `verify-tls` yanıtında `presentationChecks.isExpiringSoon: true` dönmeli.
  - Nginx `:443` üzerinde fiziksel olarak bu sertifikayı (`A9:B4:3E:90:67:F1:72:C5:B6:E8:CA:DF:AA:E4:71:B9:24:83:23:76:BE:20:45:DE:AC:CA:D7:13:1B:14:87:88`) sunmalı.
- **Gerçekleşen:**
  - `/websites` ve `/websites/:id/ssl` üzerinde sarı `10 gün` (`ws-badge ws-badge-warn`) rozeti gösterildi; özel sertifika olduğu için ACME yenileme butonları devre dışı bırakılıp `"Bu sertifika elle yönetiliyor; ACME yenilemesi başlatılamaz."` açıklaması gösterildi.
  - `Bildirim ve Görev Merkezi` -> `Sistem Uyarıları` sekmesinde `SSL · ttls06-a3.webrich.news · Uyarı · 10 gün` uyarısı görüntülendi.
  - `:443` portuna yapılan fiziksel TLS bağlantısında Nginx'in TLSv1.3 üzerinden `CN=ttls06-a3.webrich.news`, `fingerprint256: "A9:B4:3E:90:67:F1:72:C5:B6:E8:CA:DF:AA:E4:71:B9:24:83:23:76:BE:20:45:DE:AC:CA:D7:13:1B:14:87:88"` sertifikasını sunduğu ve `verify-tls` ile tam eşleştiği (`matches: true`, `isExpiringSoon: true`) doğrulandı.
  - **Eksik/Kısmi:** API'nin döndürdüğü `diagnosis` (`"The active certificate expires within 30 days. Import or select a replacement certificate before expiry."`) metni `/websites/:id/ssl` sayfasında kullanıcıya gösterilmiyor.
- **Durum:** KISMİ
- **Kanıt:** `.local/manuel-test/TLS-06/07-ttls06-ssl-warning-10d.png`, `.local/manuel-test/TLS-06/08-websites-ttls06-warning-badge.png`, `.local/manuel-test/TLS-06/09-notification-center-10d-warning.png`, `.local/manuel-test/TLS-06/tls06-results.json` (`scenarios.scenario4And5`).

### S5: Canlı sunulan sertifika uyuşmazlığı (`verify-tls` mismatch) ve kısmi servis reload (`certificate_reload_partial`) teşhisi
- **Adımlar:**
  1. `POST /api/panel/domains/:domainId/certificates/:certId/verify-tls` uç noktasına farklı bir `fingerprint256` ve farklı bir `validTo` tarihi göndererek uyuşmazlık tespitini test et.
  2. `POST /api/panel/certificates/:certId/reload-outcome` uç noktasına `{ service: "nginx", status: "partial", stage: "reload", error: "nginx reload warning on secondary worker" }` gönder.
  3. API yanıtındaki `certificate.diagnosis` nesnesini incele ve ardından tarayıcıda `/websites/:id/ssl` sayfasını yenileyerek bu kısmi reload uyarısının arayüzde gösterilip gösterilmediğini kontrol et.
- **Beklenen:**
  - `verify-tls` farklı parmak izinde `{ matches: false, reason: "fingerprint_mismatch" }`, farklı bitiş tarihinde `{ matches: false, reason: "valid_to_mismatch" }` döndürmeli.
  - `reload-outcome` sonrasında API `diagnosis: { severity: "warning", code: "certificate_reload_partial" }` üretmeli ve kullanıcı `/websites/:id/ssl` ekranında veya bildirim merkezinde Nginx reload işleminin kısmi/hatalı kaldığına dair uyarı görmeli.
- **Gerçekleşen:**
  - `POST .../verify-tls` parmak izi uyuşmazlığında `{ matches: false, reason: "fingerprint_mismatch", expected: "A9:B4:...", actual: "00:11:..." }`, bitiş tarihi uyuşmazlığında `{ matches: false, reason: "valid_to_mismatch" }` döndürdü.
  - `POST .../reload-outcome` çağrısı sertifika kaydında `diagnosis: { severity: "warning", code: "certificate_reload_partial", message: "Certificate is valid, but nginx reload completed partially.", action: "Inspect service configuration logs and retry reload without regenerating certificate." }` üretti.
  - **Eksik/Kısmi:** Sertifikanın `state` alanı `"active"` kaldığı için `/websites/:id/ssl` ekranında ve `Bildirim ve Görev Merkezi`nde (`computeWorkspaceAlerts`) `certificate.diagnosis` veya `certificate.lastReloadOutcome` hiç kontrol edilmedi ve kullanıcıya hiçbir reload uyarısı gösterilmedi (`partialReloadShownInUi: false`).
- **Durum:** KISMİ
- **Kanıt:** `.local/manuel-test/TLS-06/10-ttls06-partial-reload-ui.png`, `.local/manuel-test/TLS-06/tls06-results.json` (`scenarios.scenario4And5`).

### S6: Yetki sınırları (RBAC & CSRF) ve süre dolumu bildirimlerinin tenant kapsamı
- **Adımlar:**
  1. Oturumsuz/CSRF'siz ve farklı tenant kapsamındaki sertifika okuma, yenileme ve `verify-tls` isteklerinin erişim kontrolünü (`apps/api/test/certificate-http.test.js`, `apps/api/test/ssl-renewal-wiring.test.js` ve canlı API) doğrula.
  2. `apps/api/src/operational-notification-service.js` içindeki `checkCertificateExpirations()` fonksiyonunun süre dolumu (`<= 30 gün`, `<= 7 gün`, `<= 0 gün`) ve reload hatası bildirimlerini hangi tenant kapsamıyla (`websiteId`/`domainId`) dağıttığını incele.
- **Beklenen:**
  - Yetkisiz veya başka müşteriye ait sertifika üzerinde `verify-tls`, `renewal-outcome`, `reload-outcome` ve `renew` işlemleri `401`/`403`/`404` ile reddedilmeli.
  - Süresi dolmak üzere olan sertifika bildirimleri (`SSL_CERTIFICATE_EXPIRING`, `SSL_CERTIFICATE_CRITICAL`, `SSL_CERTIFICATE_EXPIRED`) ilgili web sitesinin sahibi olan Customer ve Reseller hesaplarına da iletilmeli.
- **Gerçekleşen:**
  - HTTP API katmanında (`certificate-http.js` ve `tenant-boundary.js`) oturumsuz erişim `401`, salt-okunur (`read_only`) veya kapsam dışı müşteri/bayi erişimi `403` ile engelleniyor.
  - **Hata/Eksik:** `apps/api/src/operational-notification-service.js:840-870` içindeki `checkCertificateExpirations()` fonksiyonu `dispatch(type, severity, title, message, { domain, daysRemaining, validTo, certificateId })` çağrısında `websiteId` (veya `domainId`) parametresi geçirmiyor (`options.websiteId = null`). `dispatch()` fonksiyonu (`satır 526-531`) `websiteId` olmadığında bildirimi global kabul edip yalnızca `owner` rolündeki kullanıcılara gönderiyor; dolayısıyla Customer ve Reseller hesapları kendi sitelerinin SSL süre dolumu uygulama-içi/e-posta bildirimlerini alamıyor.
- **Durum:** KISMİ
- **Kanıt:** `apps/api/src/operational-notification-service.js:526-545`, `apps/api/src/operational-notification-service.js:840-870`, `apps/api/test/certificate-http.test.js`.

---

## Hatalar

| # | Seviye | Başlık | Adımlar | Beklenen | Gerçekleşen | Dosya:Satır | Kanıt |
|---|---|---|---|---|---|---|---|
| 1 | NORMAL | `/websites/:id/ssl` sekmesinde özel sertifika yükleme/seçme arayüzü ve sertifika kimlik/teşhis detayları (`fingerprint256`, `issuer`, `subject`, `diagnosis`, `lastReloadOutcome`) gösterilmiyor | 1. `/websites/:id/ssl` sekmesini aç.<br>2. Mevcut sertifika bilgilerini ve kısmi reload teşhisini (`certificate_reload_partial`) incele. | Kullanıcı sertifikanın sağlayıcısını (`issuer`), konusunu (`subject`), SHA-256 parmak izini (`fingerprint256`), sertifika kaynağını (`acme`/`custom`) ve varsa `diagnosis` / `lastReloadOutcome` uyarılarını doğrudan SSL sekmesinde görmeli. | `SslOperationForm` yalnızca 5 alanı (`Sertifika adı`, `Kapsam`, `Başlangıç`, `Bitiş`, `HTTPS tercihi`) render ediyor. `fingerprint256` yalnızca aynı oturumda ACME yenileme işi bittikten sonra `SslRenewalPanel` içinde görünüyor; `issuer`, `subject`, `diagnosis` ve `lastReloadOutcome` hiç gösterilmiyor. | `apps/web/src/workspace/SiteOperations.jsx:344-353`, `apps/web/src/workspace/SslRenewalPanel.jsx:68-78` | `.local/manuel-test/TLS-06/03-webrich-ssl-tab.png`, `.local/manuel-test/TLS-06/10-ttls06-partial-reload-ui.png` |
| 2 | NORMAL | Ön yüzde gerçek sunulan sertifika (`verify-tls`) kontrolü hiç çağrılmıyor ve gösterilmiyor | 1. `/websites/:id/ssl` sayfasını aç.<br>2. Ağ isteklerini ve ekranı incele. | Panel, kayıtlı sertifika ile sunucunun `:443` portunda/diskte sunduğu sertifikanın eşleşip eşleşmediğini (`verify-tls`) göstermeli veya doğrulama aksiyonu sunmalı. | Arka uçta `/api/domains/:domainId/certificates/:certificateId/verify-tls` mevcut olmasına rağmen `apps/web/src/` altında hiçbir bileşen bu uç noktayı çağırmıyor. | `apps/web/src/workspace/SiteOperations.jsx:341-405`, `apps/api/src/certificate-http.js:576-604` | `.local/manuel-test/TLS-06/03-webrich-ssl-tab.png` |
| 3 | NORMAL | `certificate-http.js` içinde `POST .../verify-tls` rotaları iki kez kaydedildiği için ikinci `handleVerifyTls` POST işleyicisi gölgeleniyor | 1. `POST /api/panel/domains/:domainId/certificates/:certificateId/verify-tls` isteğini gövdesiz (`{}`) gönder.<br>2. `GET /api/panel/domains/:domainId/certificates/:certificateId/verify-tls` isteğini gönder. | `verifyTlsRoutes` (satır 832-840) hem `GET` hem `POST` için `handleVerifyTls` bağlamayı amaçlıyor. | Satır 576 ve 593'te aynı yollara (`POST /api/certificates/:certificateId/verify-tls` ve `POST /api/domains/:domainId/certificates/:certificateId/verify-tls`) `certificateRegistry.verifyLiveTls` bağlandığı için Express ilk rotayı çalıştırıyor; gövdesiz `POST` isteği `handleVerifyTls` yerine `{ matches: false, reason: "live_tls_missing" }` döndürüyor. | `apps/api/src/certificate-http.js:576-604`, `apps/api/src/certificate-http.js:832-840` | `.local/manuel-test/TLS-06/tls06-results.json` (`verifyGet` vs `verifyPost`) |
| 4 | NORMAL | `NotificationCenterDrawer` (`computeWorkspaceAlerts`) kısmi veya başarısız servis reload (`lastReloadOutcome` / `diagnosis`) durumlarında uyarı üretmiyor | 1. Aktif bir sertifikada `POST /api/panel/certificates/:id/reload-outcome` ile `status: "partial"` veya `"failed"` kaydet.<br>2. `Bildirim ve Görev Merkezi` -> `Sistem Uyarıları` sekmesini aç. | Sertifika aktif olsa bile Nginx veya mail servisi reload işlemi kısmi/başarısız olduğunda (`certificate_reload_partial` / `certificate_reload_failed`) sistem uyarısı gösterilmeli. | `computeWorkspaceAlerts` yalnızca `certificateState` değerinin `['warning', 'expired', 'error', 'none', 'off']` olmasına bakıyor; `certificate.diagnosis` ve `certificate.lastReloadOutcome` alanlarını kontrol etmiyor. | `apps/web/src/workspace/NotificationCenterDrawer.jsx:38-63` | `.local/manuel-test/TLS-06/10-ttls06-partial-reload-ui.png` |
| 5 | NORMAL | `checkCertificateExpirations()` bildirim üretirken `websiteId` geçirmediği için SSL süre dolumu bildirimleri Customer/Reseller hesaplarına gitmiyor | 1. `apps/api/src/operational-notification-service.js` içinde `checkCertificateExpirations()` (`satır 765-874`) kodunu incele. | Bir web sitesine bağlı alan adının SSL sertifikası 30/7/0 gün eşiğine girdiğinde ilgili sitenin Customer ve Reseller hesaplarına da bildirim/e-posta gitmeli. | `dispatch(...)` çağrılarında (`satır 804, 829, 845, 862`) `websiteId` parametresi verilmiyor. `dispatch()` (`satır 526-531`) `websiteId` olmadığında bildirimi global sayarak yalnızca `owner` kullanıcılarına gönderiyor. | `apps/api/src/operational-notification-service.js:526-545`, `apps/api/src/operational-notification-service.js:804-870` | Kod incelemesi (`operational-notification-service.js`) |
| 6 | NORMAL | `e2e/07-ssl-certificates.spec.js` içindeki 7.1 ve 7.2 testleri eski tablo seçicisi (`table.ws-table`) nedeniyle başarısız oluyor (`KIRMIZI`) | 1. `npx playwright test e2e/07-ssl-certificates.spec.js` komutunu çalıştır. | 3 E2E testin tamamı güncel `/websites` kart görünümüyle (`article.ws-website-task-card`) geçmeli. | `e2e/helpers.js:67` içindeki `openFirstWebsiteWorkspace` hala `table.ws-table tbody tr a[href^="/websites/"]` aradığı için 7.1 ve 7.2 testleri timeout ile kırılıyor (`2 failed, 1 passed`). | `e2e/helpers.js:67-69`, `e2e/07-ssl-certificates.spec.js:5-69` | `npx playwright test e2e/07-ssl-certificates.spec.js` çıktısı |

---

## Mevcut testler

| Test dosyası | Koşum sonucu | Sınıf | Not |
|---|---|---|---|
| `e2e/07-ssl-certificates.spec.js` | FAIL (1/3 geçti, 2/3 kaldı, 41.0s) | KIRMIZI | 7.3 (`/settings?section=dns`) geçiyor; 7.1 ve 7.2 `e2e/helpers.js:67` içinde kaldırılmış olan `table.ws-table` seçicisini beklediği için kırılıyor. Ayrıca gerçek sunulan sertifika (`verify-tls`), kalan gün uyarısı (`<=30 gün`) ve bildirim çekmecesini test etmiyor. |
| `apps/api/test/certificate-http.test.js` | PASS (7/7) | GEÇERLİ | Özel sertifika preview/import/select, `verify-tls`, `renewal-outcome`, `reload-outcome` (`certificate_reload_partial`) ve RBAC sınırlarını gerçek Express + SQLite üzerinde doğruluyor (Test 3'te GC nesnesi mock). |
| `apps/api/test/ssl-renewal.test.js` | PASS (128/128) | GEÇERLİ | `compareTlsPresentation`, `verifyRenewalOutcome`, `verifyCertificateRenewalOutcome`, `verifyTlsPresentation`, `checkReloadOutcome` ve React durum geçişlerini kapsamlı doğruluyor. |
| `apps/api/test/ssl-renewal-wiring.test.js` | PASS (8/8) | YÜZEYSEL | Arka uç HTTP RBAC/auth testi geçerli ancak web wiring testlerini (`readFile` + regex) içerdiği için kısmen yüzeysel. |
| `apps/api/test/certificate-renewal-scheduler.test.js` | PASS (3/3) | GEÇERLİ | Otomatik yenileme zamanlayıcısının kilit, zamanlama ve hata kurtarma davranışını doğruluyor. |
| `apps/api/test/certificate-nginx-reload.test.js` | PASS (6/6) | MOCK | `execFn` ve `acmeManager` stub'ları ile Nginx reload ve rollback mantığını birim düzeyinde test ediyor. |
| `apps/api/test/certificate-mail-reload.test.js` | PASS (10/10) | MOCK | Postfix/Dovecot reload ve rollback adımlarını sahte callback'lerle birim düzeyinde test ediyor. |
| `apps/api/test/operational-notifications.test.js` | PASS (29/29) | MOCK | `createMockCertificateRegistry` ve `createMockAuthMailer` kullanarak `<=30 gün`, `<=7 gün`, `<=0 gün` ve reload hatası bildirimlerini test ediyor; gerçek DB/website tenant bağlantısını test etmediği için `websiteId` eksikliğini yakalayamamış. |
| `apps/api/test/ssl-job-refresh.test.js` | PASS (11/11) | GEÇERLİ | SSL iş tamamlandığında sertifika ve domain koleksiyonlarının yenilenmesini doğruluyor. |
| `apps/api/test/certificate-material-manager.test.js` | PASS (3/3) | GEÇERLİ | Gerçek `/usr/bin/openssl` ile X.509 sertifika/anahtar çifti üretip doğrulama ve atomik kurulum/rollback akışını test ediyor. |
| `apps/web/test/ssl-renewal.test.js` | PASS (42/42) | MOCK | İstemci yenileme durum makinesini bellek içi sahte `backend` fonksiyonu ile test ediyor. |
| `apps/web/test/ssl-renewal-wiring.test.js` | PASS (6/6) | YÜZEYSEL | `fs.readFile` + regex ile kaynak kodda metin arıyor. |
| `apps/web/test/ssl-renewal-panel-render.test.js` | PASS (3/3) | YÜZEYSEL | `renderToString` ile statik metin kontrolü yapıyor; gerçek DOM/tarayıcı etkileşimi yok. |
| `apps/web/test/ssl-job-refresh.test.js` | PASS (7/7) | GEÇERLİ | Saf fonksiyon düzeyinde SSL job deduplication ve refresh tetiklemesini doğruluyor. |
| `apps/web/test/workspace-model.test.js` | PASS (13/13) | GEÇERLİ | `certificateState` (`unknown`, `pending`, `staging`, `expired`, `warning`, `active`) ve gecikmeli poll korumalarını (`mergeCollectionItem`) birim düzeyinde doğruluyor. |
| `apps/web/test/aapanel-notification-and-live-telemetry.test.js` | PASS (5/5) | YÜZEYSEL | İlk testler `fs.readFileSync` + regex kullanıyor; son testler `computeWorkspaceAlerts` ve `NotificationCenterDrawer` SSR çıktısını kontrol ediyor. |
| `apps/web/test/scenarios-telemetry-alerts-rbac-resources.test.js` | PASS (37/37) | GEÇERLİ | `certificateState` ve `computeWorkspaceAlerts` fonksiyonlarının sınır değerlerini (0, 7, 15, 30, 60 gün, staging, error, off) birim düzeyinde doğruluyor. |
| `apps/web/test/ssl-operations-ui-wiring.test.js` | PASS (2/2) | YÜZEYSEL | `fs.readFile` + regex ile `SiteOperations.jsx` içinde metin arıyor. |
| `apps/web/test/ssl-accessibility-and-tolerance.test.js` | PASS (7/7) | YÜZEYSEL | `fs.readFile` + regex ve simüle edilmiş focus kontrolü yapıyor. |
| `packages/host-runtime/test/acme-renewal-result.test.js` | PASS (4/4) | MOCK | `inspectCertificateFn` ve `run` stub'ları ile ACME yenileme sonucu ayrıştırmasını test ediyor. |
| `packages/host-runtime/test/acme-certificate-pair.test.js` | PASS (2/2) | GEÇERLİ | Gerçek `openssl` ile sertifika-anahtar çifti eşleşmesini ve parmak izi okumasını doğruluyor. |

### Eksik test senaryoları (`EKSİK`)
1. **EKSİK:** Gerçek tarayıcıda (Playwright) `/websites` kart görünümü üzerinden `/websites/:id/ssl` sekmesine gidip `<= 30 gün` (`warning`), `Süresi dolmuş` (`expired`), `Sertifika bekliyor` (`pending`) ve `SSL kapalı` (`off`) rozetlerini ve `Bildirim ve Görev Merkezi` uyarılarını doğrulayan uçtan uca E2E testi.
2. **EKSİK:** Gerçek Nginx `:443` SNI TLS el sıkışması (`tls.connect`) ile sunulan fiziksel X.509 sertifikasını `/api/panel/certificates` ve `verify-tls` uç noktalarıyla karşılaştıran entegrasyon testi.
3. **EKSİK:** Kısmi veya başarısız servis reload (`certificate_reload_partial` / `certificate_reload_failed`) durumunda arayüzde uyarı gösterildiğini doğrulayan UI testi.
4. **EKSİK:** `OperationalNotificationService.checkCertificateExpirations()` fonksiyonunun gerçek veritabanı üzerinde Customer ve Reseller hesaplarına kendi sitelerinin SSL süre dolumu bildirimlerini ilettiğini doğrulayan entegrasyon testi.

---

## Panelde olmayan / bulunamayan

| Özellik | Beklenen yer | Gerçekte ne var | Kaynak |
|---|---|---|---|
| Gerçek sunulan sertifika (Live TLS Presentation) doğrulama göstergesi | `/websites/:id/ssl` (`SSL/TLS Sertifikaları` sekmesi) | Arka uçta `GET/POST /api/panel/domains/:domainId/certificates/:certificateId/verify-tls` uç noktası var ancak ön yüzde hiç çağrılmıyor ve sunucunun `:443` portunda fiilen sunduğu sertifikanın kayıtlı sertifikayla eşleşip eşleşmediği ekranda gösterilmiyor. | `docs/plesk-feature-parity.md` (`TLS-06`), `plan.md:277` |
| Sertifika kimlik detayları (`issuer`, `subject`, `fingerprint256`, `source`) | `/websites/:id/ssl` (`SSL sertifikası` bilgi kartı) | Varsayılan görünümde yalnızca `Sertifika adı`, `Kapsam`, `Başlangıç`, `Bitiş` ve `HTTPS tercihi` yer alıyor; `issuer` (Let's Encrypt / Özel), `subject` ve `fingerprint256` (yenileme yapılmadıkça) gösterilmiyor. | `docs/plesk-feature-parity.md` (`TLS-06`), `apps/web/src/workspace/SiteOperations.jsx:344-353` |
| Sertifika teşhis ve servis reload durumu (`diagnosis`, `lastReloadOutcome`) | `/websites/:id/ssl` ve `Bildirim ve Görev Merkezi` | Arka uç `diagnosis` (`certificate_expiring`, `certificate_reload_partial`, `certificate_reload_failed`) ve `lastReloadOutcome` üretiyor ancak ön yüz bunları ne SSL sekmesinde ne de `NotificationCenterDrawer` içinde gösteriyor. | `docs/plesk-feature-parity.md` (`TLS-06`), `apps/api/src/certificate-http.js:65-169` |

---

## Oluşturulan ve temizlenen kaynaklar

| Kaynak | Tür | Oluşturma | Silme | Kalan kontrolü |
|---|---|---|---|---|
| `ttls06-a3.webrich.news` (`7b606485-4743-429a-b75b-8a5917e30038`) | Domain (Yönlendirme / Proxy, `websiteId: null`) | `POST /api/panel/domains` (`201 Created`) | `POST /api/panel/domains/:id/removal-preview` + `POST /api/panel/domains/:id/removal` (`finalStatus: "removed"`) | `GET /api/panel/domains` -> `testDomainStillPresent: false` (`.local/manuel-test/TLS-06/12-cleanup-verified.png`) |
| `ttls06-a3.webrich.news` 10 günlük özel X.509 sertifikası (`73a054dd-7316-4cf0-be58-fc479d1b8d1e`) | Custom SSL Certificate (`source: "custom"`) | `POST /api/panel/domains/:id/certificates/custom-preview` + `POST /api/panel/domains/:id/certificates/custom` (`201 Created`) | Domain silme ile `retired` durumuna alındı, ardından `POST /api/panel/certificates/gc/sweep` (`retentionDays: 0, dryRun: false`) ile diskten temizlendi (`sweptCount: 1`) | `GET /api/panel/certificates` ve GC sweep (`status: 200, sweptCount: 1`) |
