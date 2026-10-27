# T188 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T188 · Manuel test: EML-09 — SPF/DKIM/DMARC ve relay/kimlik doğrulama güvenliği
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/eml-09.spec.js` (Playwright E2E testi, 257 satır)
- `docs/manuel-test/EML-09.md` (Manuel test raporu, 31 satır)
- `tasks/review/T188.md` -> `tasks/done/T188.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu, PowerDNS ve Postfix servislerine karşı çalışmaktadır.
- `e2e/ozellik/eml-09.spec.js` içeriği incelendi ve çalıştırıldı (`AGENT_N=4 npx playwright test e2e/ozellik/eml-09.spec.js --reporter=line`):
  - **Mutlu Yol (`mutlu yol: DKIM anahtar oluşturma/önizleme, DNS kayıtları ve Postfix relay politikası fiziksel doğrulaması`):**
    - Panel üzerinden Mail sekmesinde yerel mail alan adı (`yp-form.webrich.news`) tespit edilip yönetimine gidiliyor.
    - "DNS ve DKIM" sekmesi açılıyor; DKIM anahtarı modal üzerinden oluşturuluyor (`mail` selector).
    - UI üzerinde metadata (Selector: `mail`, Algoritma: `rsa-sha256`, DNS tipi: `TXT`, DNS adı: `mail._domainkey...`, DNS değer: `v=DKIM1`) ve "Signing preview" digest doğrulanıyor.
    - Fiziksel Kanıt 1: PowerDNS TXT dig ile SPF kaydı (`v=spf1 mx -all`) doğrulanıyor.
    - Fiziksel Kanıt 2: PowerDNS TXT dig ile DMARC kaydı (`v=DMARC1; p=none`) doğrulanıyor.
    - Fiziksel Kanıt 3: PowerDNS MX dig ile MX kaydı (`mail.webrich.news`) doğrulanıyor.
    - Fiziksel Kanıt 4: Postfix `smtpd_relay_restrictions` (`permit_mynetworks, reject_unauth_destination`) ile açık relay koruması doğrulanıyor.
    - Fiziksel Kanıt 5: Port 25 üzerinde doğrudan anonim kimlik doğrulama kapalılığı (`smtpd_sasl_auth_enable = no`) doğrulanıyor.
    - Fiziksel Kanıt 6: Postfix `master.cf` submission (587) ve submissions (465) bloklarında SASL doğrulama zorunluluğu (`permit_sasl_authenticated,reject`, `smtpd_sasl_auth_enable=yes`) teyit ediliyor.
    - Fiziksel Kanıt 7: Test sunucusundaki `/var/lib/yunpanel/control-plane/mail-dkim/<id>/` dizininde `metadata.json` ve `private.pem` dosyalarının varlığı ve `0600` dosya izinleri doğrulanıyor.
  - **Plesk Parity (`Plesk Parity: DNS Teslimat Gereksinimleri (SPF, DKIM, DMARC) ve İstemci Bağlantı Bilgileri panelleri`):**
    - `delivery-diagnostics` uç noktasının `since` parametresi eksikliği nedeniyle 400 (`invalid_log_query`) dönmesi ve panelin gizlenmesi bilinen eksiklik olarak `test.fail` ile işaretlenmiş.
  - **Hatalı Girdi (`hatalı girdi: Geçersiz DKIM selector adı, boş gövde veya olmayan domain ID reddedilir`):**
    - Geçersiz karakter içeren selector adı için 400 (`invalid_mail_dkim_selector`), boş gövde için 400 ve var olmayan domain ID için 404 yanıtları başarıyla doğrulanıyor.
  - **Plesk Parity (`Plesk Parity: Giden e-posta relay (Smarthost) yapılandırma ve API uç noktası`):**
    - Plesk eşdeğeri Smarthost outbound relay yönetim API'sinin canlı sunucuda henüz deploy edilmemiş olması (404) bilinen eksiklik olarak `test.fail` ile işaretlenmiş.
  - **afterAll Temizliği:**
    - Test sonrasında `/var/lib/yunpanel/control-plane/mail-dkim/*` temizlenip `yunpanel-api` yeniden başlatılıyor.
  - **Çalıştırma Sonucu:** `4 passed (37.8s)` (2 normal test + 2 test.fail beklenen parity hatası).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/EML-09.md`: 31 satır (≤40 satır kuralına tam uygun), `docs/manuel-test/YONTEM.md` şablonuna eksiksiz uyumlu.
- Fiziksel kanıtlar, test durumu ve bilinen kısıtlamalar eksiksiz raporlanmış.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`

---

## 3. Karar Özeti
T188 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. EML-09 SPF/DKIM/DMARC ve relay/kimlik doğrulama güvenliği Playwright e2e testi ve dokümantasyonu onaylandı (`accept`).
