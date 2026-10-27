# T178 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T178 · Manuel test: TLS-04 — Panel, website ve mail servisine doğru sertifika atama
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/tls-04.spec.js` (Playwright E2E testi)
- `docs/manuel-test/TLS-04.md` (Manuel test raporu, 29 satır)
- `tasks/review/T178.md` -> `tasks/done/T178.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API / Nginx / Postfix / Dovecot bileşenlerine karşı çalışmaktadır.
- `e2e/ozellik/tls-04.spec.js` içeriği incelendi ve `sunucu-28-4` kilidi altında çalıştırıldı (`AGENT_N=4 npx playwright test e2e/ozellik/tls-04.spec.js --reporter=line`):
  - **Mutlu Yol (`mutlu yol: Website ve Mail servisine doğru sertifika atama ve fiziksel doğrulama`):**
    - `webrich.news` sitesinin SSL sekmesinde sertifika adı, kapsamı, başlangıç/bitiş tarihleri ve HTTPS tercihi arayüz üzerinden doğrulanıyor.
    - Mail servisi (`/api/panel/mail-service-identity`) üzerinden `mail.webrich.news` sertifika ataması, ready durumu ve blocker olmaması doğrulanıyor.
    - Webmail sekmesinde (`/websites/:id/mail`) hostname ve sertifika kimliği doğrulanıyor.
    - **Fiziksel Kanıtlar (SSH):**
      - Nginx: `/etc/nginx/sites-enabled/yunpanel-webrich.news.conf` içinde `ssl_certificate` Let's Encrypt yolları.
      - Postfix: `postconf -n smtpd_tls_cert_file smtpd_tls_key_file` çıktısında `mail.webrich.news` Let's Encrypt yolları.
      - Dovecot: `/etc/dovecot/conf.d/99-yunpanel-mail.conf` içinde `ssl_cert` ve `ssl_key` atamaları.
      - Canlı TLS Handshake: `openssl s_client -connect 127.0.0.1:993` ile canlı IMAPS portunda `CN=mail.webrich.news` sunumu.
  - **Hatalı Girdi (`hatalı girdi: Geçersiz parametreler, var olmayan domain veya revizyon çakışması reddedilir`):**
    - Var olmayan domain atamasında `404 domain_not_found`.
    - Geçersiz gövde ile atamada `400 mail_service_identity_bind_input_invalid`.
    - Çakışan revizyonda `409 mail_service_identity_revision_conflict`.
    - Var olmayan sertifika atama önizlemesinde 404/409 hata kodları.
  - **Parity / Bilinen Eksiklik Kontrolü (`panel sertifikası ve web sitesi sertifika seçici: Plesk eşdeğerlik eksiklikleri`):**
    - Plesk'teki panel Nginx sertifikasını seçme/atama ve sitede sertifika seçici arayüzünün olmaması `test.fail` ile belgelenmiş.
  - **afterAll ve Yan Etki Temizliği:**
    - Test sırasında yeni kalıcı veri/yapılandırma oluşturulmadığı için ortam kirletilmemiştir.
  - **Çalıştırma Sonucu:** `3 passed (29.4s)` (1 test.fail beklenerek geçti).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/TLS-04.md`: 29 satır (≤40 satır kuralına uygun), yöntem şablonuna eksiksiz uyumlu.
- Fiziksel kanıtlar ve mevcut test değerlendirmeleri (`apps/api/test/certificate-http.test.js`, `apps/api/test/certificate-mail-reload.test.js`, `apps/api/test/mail-service-identity-http.test.js`) yerinde.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm run lint`: `Repository policy validation passed.`

---

## 3. Karar Özeti
T178 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. TLS-04 Panel, website ve mail servisine doğru sertifika atama Playwright e2e testi ve dokümantasyonu onaylandı (`accept`).
