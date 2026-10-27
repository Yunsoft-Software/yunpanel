# T179 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T179 · Manuel test: TLS-05 — HTTPS yönlendirme, HSTS ve desteklenen TLS seçenekleri
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/tls-05.spec.js` (Playwright E2E testi)
- `docs/manuel-test/TLS-05.md` (Manuel test raporu, 29 satır)
- `tasks/done/T179.md` (Kabul edilen görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API / Nginx / OpenSSL bileşenlerine karşı çalışmaktadır.
- `e2e/ozellik/tls-05.spec.js` içeriği incelendi:
  - **Mutlu Yol (`mutlu yol: HTTPS yönlendirme, HSTS başlığı yapılandırması ve canlı TLS fiziksel kanıtı`):**
    - `webrich.news` sitesinde arayüzden HTTP -> HTTPS yönlendirmesi checkbox durumu doğrulanıyor.
    - Fiziksel Kanıt 1: Nginx `yunpanel-webrich.news.conf` konfigürasyonunda `return 301 https://$host$request_uri;` direktifi doğrulanıyor.
    - Fiziksel Kanıt 2: Port 80 canlı HTTP isteğiyle 301 Moved Permanently ve `Location: https://webrich.news/test-tls` başlığı doğrulanıyor.
    - Yeni test sitesi (`ttls05-a2-...`) oluşturularak arayüz üzerinden `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` yanıt başlığı eklenip kaydediliyor.
    - Fiziksel Kanıt 3: Nginx yapılandırmasında `add_header Strict-Transport-Security ... always;` direktifi doğrulanıyor.
    - Fiziksel Kanıt 4: Canlı HTTP isteğinde `strict-transport-security` başlığı doğrulanıyor.
    - Fiziksel Kanıt 5 & 6: Port 443 canlı OpenSSL el sıkışmasında TLSv1.2 ve TLSv1.3 başarıyla doğrulanıyor.
    - Fiziksel Kanıt 7: Eski/güvensiz TLS 1.0 protokolünün sunucu tarafından reddedildiği doğrulanıyor.
  - **Hatalı Girdi (`hatalı girdi: Geçersiz HSTS başlık değerleri ve SSL olmadan HTTPS yönlendirmesi kural ihlali`):**
    - SSL bağlı olmayan sitede arayüzde uyarı mesajı kontrolü.
    - Geçersiz karakter enjeksiyonu içeren HSTS başlığında `400 invalid_nginx_header`.
    - Yasaklı/korunan başlık ismi ekleme denemesinde `400 blocked_nginx_header`.
    - 256 karakteri aşan aşırı uzun başlıkta `400 invalid_nginx_header`.
    - `httpsMode: 'off'` iken `httpsRedirect: true` zorlamasında `400 invalid_redirect_policy / hosting_target_invalid`.
  - **Parity / Bilinen Eksiklik Kontrolü (`Plesk eşdeğerlik eksiklikleri: Yerleşik HSTS anahtarı ve TLS protokol/şifre seçenekleri arayüzü`):**
    - Plesk SSL It! yerleşik HSTS anahtarı ve Tools & Settings TLS sürüm/şifre seçici arayüzü eksikliği `test.fail` ile belgelenmiş.
  - **afterAll ve Yan Etki Temizliği:**
    - `test.afterAll` bloğunda oluşturulan `ttls05` alan adı `removeWebsiteById` ile silinmekte, ayrıca test başında olası artıklar temizlenmektedir.

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/TLS-05.md`: 29 satır (≤40 satır kuralına uygun), yöntem şablonuna eksiksiz uyumlu.
- Fiziksel kanıtlar, hatalar, mevcut test değerlendirmeleri (`packages/config-templates/test/nginx.test.js`, `packages/shared/test/nginx-performance.test.js`, `e2e/ozellik/web-05.spec.js`) ve panelde olmayan maddeler eksiksiz listelenmiş.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm run lint`: `Repository policy validation passed.`

---

## 3. Karar Özeti
T179 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. TLS-05 HTTPS yönlendirme, HSTS ve desteklenen TLS seçenekleri e2e testi ve dokümantasyonu onaylandı (`accept`).
