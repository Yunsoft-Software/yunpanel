# T180 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T180 · Manuel test: EML-01 — Mailbox oluşturma/düzenleme/silme, parola ve kota
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/eml-01.spec.js` (Playwright E2E testi)
- `docs/manuel-test/EML-01.md` (Manuel test raporu, 24 satır)
- `tasks/review/T180.md` -> `tasks/done/T180.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle kullanılmamıştır.
- Tamamen gerçek `.28` test paneline, backend API ve SQLite / systemd servislerine karşı çalışmaktadır.
- **Mutlu Yol (`mutlu yol: Mailbox CRUD, kota belirleme, parola güncelleme ve Dovecot fiziksel doğrulama`):**
  - Mail sayfasında yerel mail domain tespiti ve yönetimi.
  - Yeni posta kutusu oluşturma (Adres, parola).
  - Fiziksel SQLite doğrulaması (`virtual_mailboxes` tablosunda `address` ve `enabled=1`, `/etc/yunpanel/mail/sql/virtual-mail.sql` dosyasında kayıt).
  - Posta kutusu parolası güncelleme (argon2id hash doğrulaması).
  - Kota tanımlama (256 MiB -> `quota_bytes` = 268435456 bayt teyidi).
  - Kota kaldırma (NULL / boş quota_bytes teyidi).
  - Çok adımlı güvenli silme akışı (kapatma, yedekleme, veri silme, hesap kaydını kaldırma).
  - SQLite tablosundan ve panelden posta kutusunun tamamen silindiğinin fiziksel teyidi.
- **Hatalı Girdi (`hatalı girdi: geçersiz e-posta formatı reddedilir ve hesap oluşturulmaz`):**
  - Geçersiz e-posta formatı (ardışık nokta vb.) girildiğinde UI uyarı bildirimi, modalın açık kalması ve veritabanına yazılmaması teyidi.
- **afterAll Temizliği:**
  - `mailbox-registry.json` ve `virtual-mail.sqlite3` üzerinden test prefix'li kayıtların otomatik temizlenmesi garanti altına alınmış.
- **Test Sonucu:** `2 passed (1.6m)` (AGENT_1 tarafından tam yeşil koşturulup raporlanmıştır).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/EML-01.md`: 24 satır (≤40 satır kuralına uygun), YONTEM.md şablonuna eksiksiz uyumlu.
- Fiziksel kanıtlar ve ilgili mevcut testler (`e2e/08-mail-webmail.spec.js`, `apps/api/test/mailbox-http.test.js`, `apps/api/test/mailbox-quota-http.test.js`) listelenmiştir.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/tasks.py lint`: `lint OK`
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok`

---

## 3. Karar Özeti
T180 görevinin tüm gereksinimleri ve kabul kriterleri eksiksiz karşılanmıştır. EML-01 Mailbox oluşturma/düzenleme/silme, parola ve kota manuel test paketi ve dokümantasyonu onaylandı (`accept`).
