# T134 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T134 · Manuel test: BAK-02 — Yapılandırma/içerik, dosya/mail/DB kapsam seçimi
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/bak-02.spec.js` (Playwright E2E testi)
- `docs/manuel-test/BAK-02.md` (Manuel test raporu)
- `tasks/review/T134.md` -> `tasks/done/T134.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API'sine karşı çalışmaktadır.
- `e2e/ozellik/bak-02.spec.js` bağımsız olarak çalıştırıldı (`AGENT_N=1 npx playwright test e2e/ozellik/bak-02.spec.js`):
  - **Mutlu Yol (`mutlu yol: Yedekleme kapsamı incelemesi, UI üzerinden yedek alma ve fiziksel snapshot etiketleri/metrikleri kanıtı`):**
    - Sitenin yedekleme sekmesinde kapsam özeti kontrol edildi.
    - Test amaçlı Restic yedek deposu oluşturuldu ve UI'dan "Yedek Al" modalı üzerinden operasyon başlatıldı.
    - Operasyonun başarıyla tamamlanması (`status: succeeded`) izlendi.
    - Fiziksel Kanıt 1: `/api/panel/websites/:id/backup-operations` üzerinden snapshot sonucu (`totalFiles > 0`, `totalBytes > 0`) doğrulandı.
    - Fiziksel Kanıt 2: `/api/panel/backups/repositories/:id/snapshots` üzerinden snapshot id formatı (`^[a-f0-9]{64}$`), shortId ve `website:<id>`, `domain:<name>` etiketleri doğrulandı.
  - **Hatalı Girdi (`hatalı girdi: geçersiz expectedPreviewDigest veya confirmation ile yedekleme başlatma 409 Conflict ile reddedilir`):**
    - Geçersiz/uyuşmayan digest ve geçersiz onay dizgisiyle yapılan isteklerin backend tarafından 409/400/404 ile güvenli şekilde reddedildiği doğrulandı.
  - **Plesk Eşdeğerliği / Eksiklik Tespiti (`Plesk eşdeğerliği: Yedek alma modalında yapılandırma vs içerik ve dosya/mail/DB kapsam seçimi arayüzü`):**
    - Plesk Backup Manager'daki "Domain configuration only" vs "Domain configuration and user content" ve dosya/mail/DB bileşen seçim kutularının YunPanel yedek alma modalında bulunmaması `test.fail` ile belgelendi.
  - **Temizlik (`afterAll`):**
    - Test süresince oluşturulan geçici Restic deposu `afterAll` bloğunda `DELETE /api/panel/backups/repositories/:id` çağrısıyla eksiksiz silinip temizlendi.
  - **Koşu Sonucu:** 3 passed (1 test.fail beklenen durumla geçti, 35.6s).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/BAK-02.md`: 29 satır (≤40 satır kuralına uygun), `docs/manuel-test/YONTEM.md` şablonuna tam uyumlu.
- Fiziksel kanıtlar, hatalı girdi sınırları ve eksiklik tespiti net bir şekilde kaydedilmiş.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm run lint`: `Repository policy validation passed.`

---

## 3. Karar Özeti
T134 görevinin tüm gereksinimleri ve kabul kriterleri eksiksiz karşılanmıştır. BAK-02 Playwright testi gerçek sunucuya ve API'ye karşı doğrulanmış, temizlik adımları eksiksiz çalışmaktadır. Görev onaylandı (`accept`).
