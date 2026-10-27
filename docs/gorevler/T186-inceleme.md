# T186 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T186 · Manuel test: EML-07 — Webmail, mail istemci ayarları ve otomatik yapılandırma
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/eml-07.spec.js` (Playwright E2E testi)
- `docs/manuel-test/EML-07.md` (Manuel test raporu, 29 satır)
- `tasks/review/T186.md` -> `tasks/done/T186.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API / Nginx / Roundcube / mail discovery servislerine karşı çalışmaktadır.
- `e2e/ozellik/eml-07.spec.js` çalıştırıldı (`AGENT_N=1 npx playwright test e2e/ozellik/eml-07.spec.js --reporter=line`):
  - **Mutlu Yol (`mutlu yol: Webmail görünümü, e-posta istemci bağlantı ayarları tanılama modalı ve fiziksel servis yanıtları`):**
    - `/mail` ve ilgili mail domain yönetim sayfasında posta kutuları listesi ve "Tanılama" modalı üzerinden istemci bağlantı ayarları (kullanıcı adı, IMAP 993, SMTP 587, kimlik doğrulama PLAIN/LOGIN) arayüzde doğrulanıyor.
    - "Webmail" sekmesinde Roundcube webmail eşlemesi ve durumu doğrulanıyor.
    - **Fiziksel Kanıtlar (SSH):**
      - Roundcube Webmail Nginx vhostuna curl ile HTTP 200 OK ve `roundcube_sessid` oturum çerezi teyit ediliyor.
      - Thunderbird Autoconfig XML endpoint'inin Unix soket üzerinden geçerli `<clientConfig version="1.1">` yanıtı ürettiği (IMAP 143, SMTP 587) teyit ediliyor.
      - Microsoft Outlook Autodiscover XML endpoint'inin Unix soket üzerinden geçerli `<Autodiscover>` yanıtı ürettiği (IMAP, SMTP) teyit ediliyor.
  - **Hatalı Girdi ve Sınır Durumları (`hatalı girdi ve sınır durumları: Eksik parametre, geçersiz metod ve malformed XML autodiscover/autoconfig tarafından reddedilir`):**
    - Eksik parametrede HTTP 400.
    - GET metodu ile autodiscover çağrısında HTTP 405 Method Not Allowed.
    - Malformed XML gövdesinde HTTP 400 Bad Request.
    - HTTPS proxy başlığı eksik olduğunda HTTP 404 (mail_discovery_https_required) doğrulanıyor.
  - **Plesk Parity Kontrolü (`Plesk Parity kontrolü: Apple Mail / iOS .mobileconfig indirme ve tek tıkla Roundcube Webmail oturumu (SSO)`):**
    - Apple Mail / iOS .mobileconfig indirme ve Roundcube tek tıkla oturum açma (SSO) butonunun henüz panelde olmaması `test.fail` ile belgelenmiş.
  - **afterAll Temizliği:**
    - Test sırasında oluşturulabilecek test kayıtları için SQLite ve registry temizliği yapılmış.
  - **Çalıştırma Sonucu:** `3 passed (26.9s)` (1 test.fail beklenerek geçti).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/EML-07.md`: 29 satır (≤40 satır kuralına uygun), YONTEM.md şablonuna eksiksiz uyumlu.
- Fiziksel kanıtlar ve mevcut test değerlendirmeleri (`e2e/08-mail-webmail.spec.js`, `apps/web/src/workspace/MailWebmailPanel.jsx`, `apps/api/test/mail-discovery-service.test.js`) yerinde.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`

---

## 3. Karar Özeti
T186 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. EML-07 Webmail, mail istemci ayarları ve otomatik yapılandırma Playwright e2e testi ve dokümantasyonu onaylandı (`accept`).
