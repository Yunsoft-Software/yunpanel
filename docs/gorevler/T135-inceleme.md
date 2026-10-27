# T135 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T135 · Manuel test: BAK-03 — Tam ve artımlı yedekleme
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/bak-03.spec.js` (Playwright E2E testi)
- `docs/manuel-test/BAK-03.md` (Manuel test raporu)
- `tasks/review/T135.md` -> `tasks/done/T135.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API'sine karşı çalışmaktadır.
- `e2e/ozellik/bak-03.spec.js` içeriği incelendi:
  - **Mutlu Yol (`mutlu yol: tam ve ardışık artımlı (deduplicated) site yedeği oluşturma, job takibi ve fiziksel restic snapshot kanıtı`):**
    - `POST /api/panel/backups/repositories` ile test amaçlı Restic yedek deposu oluşturuluyor (11 Ekim kuralına uygun).
    - Web siteleri altındaki `yp-node.webrich.news` için ilk tam yedek ve ardışık artımlı yedek alma akışı UI üzerinden çalıştırılıyor.
    - Durable operation kartı üzerinden "Başarılı" durumu bekleniyor.
    - Fiziksel Sonuç 1: Restic deposundaki snapshot'ların varlığı (`/api/panel/backups/repositories/${createdRepoId}/snapshots`), 64 karakter hex ID, `website:${targetWebsiteId}` ve `domain:${targetDomainName}` etiketleri doğrulanıyor.
    - Fiziksel Sonuç 2: İkinci yedekte Restic deduplication kanıtı olarak `filesUnmodified > 0`, `totalFiles > 0` ve farklı snapshot ID'leri teyit ediliyor.
  - **Hatalı Girdi (`hatalı girdi: geçersiz depo ID veya sahte operasyon türü ile yedekleme başlatma 400/404 hatasıyla reddedilir`):**
    - Geçersiz repo ID ile yapılan istekte HTTP 400 (`invalid_repository_id`) kontrol ediliyor.
    - Geçersiz operasyon türü ile yapılan istekte HTTP 400 (`invalid_operation_kind`) kontrol ediliyor.
  - **Plesk Eşdeğerliği (`Plesk eşdeğerliği: UI üzerinde tam vs artımlı yedekleme tipi seçimi modalı`):**
    - Plesk'teki Backup Type seçimi (Full vs Incremental radio buttons) arayüzde bulunmadığı için kural gereği `test.fail` ile belgelenmiş.
  - **afterAll Temizliği:**
    - Test amaçlı açılan Restic reposu ve snapshot'lar `DELETE /api/panel/backups/repositories/${createdRepoId}` ile temizleniyor.

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/BAK-03.md`: 28 satır (≤40 satır kuralına uygun), `docs/manuel-test/YONTEM.md` şablonuna tam uyumlu.
- Fiziksel kanıtlar ve mevcut test değerlendirmeleri eksiksiz.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `132 tasks, lint OK`
- `npm run lint`: `Repository policy validation passed.`

---

## 3. Karar Özeti
T135 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. BAK-03 Playwright senaryosu, tam/artımlı yedekleme ve Restic snapshot doğrulaması onaylandı (`accept`).
