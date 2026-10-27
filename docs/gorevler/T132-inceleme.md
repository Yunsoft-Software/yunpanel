# T132 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T132 · Manuel test: DB-06 — Veritabanı denetimi/onarımı; desteklenen engine sınırı
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/db-06.spec.js` (Playwright E2E testi)
- `docs/manuel-test/DB-06.md` (Manuel test raporu)
- `tasks/review/T132.md` -> `tasks/done/T132.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API'sine karşı çalışmaktadır.
- `e2e/ozellik/db-06.spec.js` içeriği ve çalıştırma sonucu (`AGENT_N=2 npx playwright test e2e/ozellik/db-06.spec.js --reporter=line`):
  - **Mutlu Yol (`mutlu yol: Veritabanları sayfasında MariaDB/MySQL motoru, versiyon ve DB güvenlik baseline denetiminin doğrulanması; canlı API sağlık yanıtı`):**
    - `/databases` sayfasında MariaDB/MySQL motoru, sürüm, DB güvenlik baseline ("Hazır") ve admin socket auth bilgilerinin arayüzde görünürlüğü doğrulandı.
    - Canlı API üzerinden (`GET /api/panel/servers/:id/databases`) fiziksel motor (`engine === 'mariadb' || 'mysql'`), canlı sağlık (`health.available === true`, `health.ready === true`, socket connection, native socket auth, hygiene kontrolleri) ve fiziksel veritabanı listesi doğrulandı.
  - **Hatalı Girdi ve Motor Sınırı Senaryosu (`hatalı girdi ve desteklenmeyen motor sınırı: Geçersiz DB adı ve desteklenmeyen motor isteklerinin reddedilmesi`):**
    - UI düzeyinde geçersiz DB adı girildiğinde HTML5 pattern doğrulaması başarısızlığı kontrol edildi.
    - API düzeyinde geçersiz DB adı gönderildiğinde HTTP 400 `invalid_database_name`, onaysız isteklerde HTTP 400 `database_confirmation_required` dönüldüğü doğrulandı.
    - Desteklenmeyen motor sınırı kontrolü: YunPanel'in yalnızca MariaDB/MySQL motorlarını desteklediği, postgresql/mongodb/sqlite gibi motorların sınırlandırıldığı doğrulandı.
  - **Plesk Eşdeğerliği / Eksiklik Tespiti (`Plesk eşdeğeri veritabanı tablo denetimi ve onarımı (Check & Repair) arayüz ve işlem desteği`):**
    - Plesk'te veritabanı kartlarında bulunan "Check and Repair" (`CHECK TABLE` / `REPAIR TABLE`) tablo onarım/denetim butonu ve endpoint eksikliği kural gereği `test.fail` ile belgelendi.
  - **Temizlik (`afterAll`):**
    - Oluşturulan kaynakların oturum/CSRF token ile DELETE API üzerinden temizlenmesini sağlayan `afterAll` temizlik bloğu mevcut.
  - **Koşu Sonucu:** 3 passed (16.0s) (1 test.fail beklenen durumla geçti).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/DB-06.md`: 25 satır (≤40 satır kuralına uygun), `docs/manuel-test/YONTEM.md` şablonuna tam uyumlu.
- Fiziksel kanıtlar, senaryolar, hatalar ve panelde olmayan kısımlar açıkça belirtilmiş.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm test`: 70 unit/contract test suitinin tamamı başarılı (`pass 70`).

---

## 3. Karar Özeti
T132 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. DB-06 Playwright testi ve raporu, MariaDB motoru ve DB güvenlik baseline kontrollerini, motor sınırlarını ve Plesk Check/Repair eksikliğini kuralına uygun doğrulamaktadır (`accept`).
