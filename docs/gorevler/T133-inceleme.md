# T133 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T133 · Manuel test: BAK-01 — Server, reseller/customer, subscription ve site düzeyleri
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/bak-01.spec.js` (Playwright E2E testi)
- `docs/manuel-test/BAK-01.md` (Manuel test raporu)
- `tasks/review/T133.md` -> `tasks/done/T133.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API'sine karşı çalışmaktadır.
- `e2e/ozellik/bak-01.spec.js` içeriği ve çalıştırma sonucu (`AGENT_N=3 npx playwright test e2e/ozellik/bak-01.spec.js`):
  - **Mutlu Yol (`mutlu yol: Server düzeyi depoların listelenmesi, Site düzeyi yedek arayüzü ve fiziksel backup-set kanıtı`):**
    - Server düzeyinde Restic depoları (`/api/panel/backups/repositories`) listeleniyor.
    - Site düzeyi yedekleme sekmesine gidilerek fiziksel backupSet nesnesi (`databaseCount`, `mailCount`, `pathCount`, `repositories`) doğrulanıyor.
  - **Yetki/Sınır Senaryosu (`yetki/sınır senaryosu: site_manager rolünün sunucu düzeyi depolara ve yetkisiz site yedeklerine erişiminin 403 ile engellenmesi`):**
    - Owner oturumuyla test kullanıcısı oluşturuluyor.
    - `site_manager` oturumuyla sunucu düzeyi depo oluşturma (`POST /api/panel/backups/repositories`) ve yetkisiz yedek başlatma (`POST /api/panel/websites/:id/backup-operations`) 403 Forbidden ile engelleniyor.
  - **Plesk Eşdeğerliği / Eksiklik Tespiti (`eksiklik tespiti: Plesk eşdeğeri sunucu geneli (server-wide full backup) ve müşteri/abonelik düzeyinde toplu yedekleme arayüzü`):**
    - Plesk'teki Tools & Settings altındaki sunucu geneli tek tıkla tam yedekleme ve müşteri/abonelik düzeyinde toplu yedekleme UI eksikliği kural gereği `test.fail` ile belgelenmiş.
  - **Temizlik (`afterAll`):**
    - Oluşturulan geçici `site_manager` kullanıcısı `afterAll` bloğunda `/settings/users` üzerinden güvenle silinip temizleniyor.
  - **Koşu Sonucu:** 3 passed (1 test.fail beklenen durumla geçti).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/BAK-01.md`: 29 satır (≤40 satır kuralına uygun), `docs/manuel-test/YONTEM.md` şablonuna tam uyumlu.
- Fiziksel kanıtlar, yetki sınırları ve mevcut test değerlendirmeleri eksiksiz.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm run lint`: `Repository policy validation passed.`

---

## 3. Karar Özeti
T133 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. BAK-01 Playwright senaryosu, server ve site düzeyi kontrolleri ile RBAC sınırları başarıyla doğrulandı (`accept`).
