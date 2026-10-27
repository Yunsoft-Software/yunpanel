# T191 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T191 · Manuel test: BAK-04 — Zamanlama, rotasyon, saklama ve hariç tutmalar
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/bak-04.spec.js` (Playwright E2E testi)
- `docs/manuel-test/BAK-04.md` (Manuel test raporu, 24 satır)
- `tasks/review/T191.md` -> `tasks/done/T191.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API'sine karşı çalışmaktadır.
- `e2e/ozellik/bak-04.spec.js` içeriği incelendi ve çalıştırıldı (`AGENT_N=4 npx playwright test e2e/ozellik/bak-04.spec.js --reporter=line`):
  - **Mutlu Yol (`mutlu yol: otomatik yedekleme zamanlaması ve saklama politikası yapılandırma, UI doğrulaması ve fiziksel schedule/exclusion kanıtı`):**
    - `POST /api/panel/backups/repositories` ile test amaçlı Restic yedek deposu oluşturuluyor (11 Ekim kuralına uygun).
    - Web siteleri altındaki `yp-node.webrich.news` için "Plan ve Zamanlama" modalı açılıyor, günlük `03:30`, son 5, günlük 5, haftalık 3 retention ayarları yapılandırılıp kaydediliyor.
    - Durable operation takibi ile işlemin "Başarılı" sonuçlandığı bekleniyor.
    - Fiziksel Kanıt 1: Panel API `/api/panel/websites/:id/backups` üzerinden `schedule` (expression `30 3 * * *`, enabled `true`) ve `retentionPolicy` teyit ediliyor.
    - Fiziksel Kanıt 2: Test sunucusundaki `/var/lib/yunpanel/control-plane/website-backup-schedules.json` dosyası SSH ile okunup zamanlama ve saklama politikasının diske yazıldığı doğrulanıyor.
    - Fiziksel Kanıt 3: `/api/panel/websites/:id/backup-set` endpointinden dışlama kalıplarının (`.git`, `node_modules/.cache` veya `tmp`) uygulandığı teyit ediliyor.
  - **Hatalı Girdi (`hatalı girdi: geçersiz saklama sayısı ve geçersiz cron zamanlaması reddedilir`):**
    - Saklama sayısı 0 girildiğinde doğrulama hatası alınması ve modalın açık kalması teyit ediliyor.
    - Özel zamanlamada geçersiz cron formatı (`99 99 * * *`) girildiğinde doğrulama hatası alınması doğrulanıyor.
  - **afterAll Temizliği:**
    - Test amaçlı açılan Restic reposu API (`DELETE /api/panel/backups/repositories/:id`) ile, oluşturulan site zamanlama kaydı ise SSH ile `website-backup-schedules.json` içerisinden filtrelenerek temizleniyor.
  - **Çalıştırma Sonucu:** `2 passed (46.1s)`, Restic test reposu temizlendi.

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/BAK-04.md`: 24 satır (≤40 satır kuralına tam uygun), `docs/manuel-test/YONTEM.md` şablonuna eksiksiz uyumlu.
- Fiziksel kanıtlar ve mevcut test değerlendirmeleri yerinde.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm run lint`: `Repository policy validation passed.`

---

## 3. Karar Özeti
T191 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. BAK-04 zamanlama, rotasyon, saklama ve hariç tutmalar Playwright e2e testi ve dokümantasyonu onaylandı (`accept`).
