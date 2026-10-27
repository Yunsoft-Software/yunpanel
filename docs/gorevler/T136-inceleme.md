# T136 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T136 · Manuel test: BAK-06 — Seçici geri yükleme, indir/yükle ve parola koruması
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/bak-06.spec.js` (Playwright E2E testi)
- `docs/manuel-test/BAK-06.md` (Manuel test raporu, 29 satır)
- `tasks/review/T136.md` -> `tasks/done/T136.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`.28` Gerçek Panel & Fiziksel Doğrulama)
- Mock, `page.route` veya sahte veri kesinlikle bulunmamaktadır; doğrudan `.28` test sunucusu ve backend API / Restic / Nginx bileşenlerine karşı çalışmaktadır.
- `e2e/ozellik/bak-06.spec.js` içeriği incelendi ve `sunucu-28-4` kilidi altında çalıştırıldı (`AGENT_N=4 npx playwright test e2e/ozellik/bak-06.spec.js --reporter=line`):
  - **Mutlu Yol (`mutlu yol: parola korumalı repo oluşturma, UI üzerinden seçici geri yükleme başlatma, progress takibi ve fiziksel restore kanıtı`):**
    - Parola korumalı (AES-256 şifreli) yerel Restic yedek deposu oluşturuldu (`/api/panel/backups/repositories`).
    - UI (`/websites/:id/backup`) üzerinden "Yedek Al" modalı ile ilk snapshot alındı, progress ve başarı rozeti (`Başarılı`) doğrulandı.
    - Snapshot tablosundan "Geri Yükle" modalı açıldı, "Seçici Geri Yükleme" seçeneği işaretlenerek DNS/barındırma/ortam kutuları kapatıldı ve yalnızca site dosyaları seçildi.
    - Önizleme ve onay metni doldurularak seçici geri yükleme tetiklendi ve işlemin başarıyla tamamlandığı izlendi.
    - **Fiziksel Kanıtlar:**
      1. Yedekleme operasyon kaydında (`/api/panel/websites/:id/backup-operations`) `selective: true` ve seçilen dosya yolları (`include`) doğrulandı.
      2. Geri yükleme öncesinde otomatik güvenlik yedeği (`pre-restore` tag'li snapshot) alındığı doğrulandı.
      3. Geri yükleme sonrası web sitesinin (`yp-node.webrich.news`) HTTP 200 ile canlı çalıştığı doğrulandı.
  - **Hatalı Girdi (`hatalı girdi: parolasız repo oluşturma ve seçici geri yüklemede tüm kapsamın kaldırılması reddedilir`):**
    - Parolasız repo oluşturma girişimi 400 (`restic_password_invalid` / `restic_password_required`) ile reddedildi.
    - UI seçici geri yükleme modalında tüm kapsam kutuları kaldırıldığında hata uyarısı verildi ve onay/başlat butonu engellendi.
    - API seviyesinde zararlı path traversal (`..`) içeren seçici geri yükleme önizlemesi 400+ ile reddedildi.
  - **Parity / Bilinen Eksiklik Kontrolü (`Plesk eşdeğerliği: UI üzerinde yedek arşivi indir/yükle (download/upload) butonu`):**
    - Plesk Backup Manager'daki .tar/.zip yedek arşivini yerel bilgisayara indirme veya bilgisayardan yükleme özelliğinin olmaması `test.fail` ile belgelendi.
  - **afterAll ve Yan Etki Temizliği:**
    - `test.afterAll` bloğunda test için oluşturulan Restic reposu ve snapshot'lar `/api/panel/backups/repositories/:id` üzerinden fiziksel olarak temizlendi.
  - **Çalıştırma Sonucu:** `3 passed (1.3m)` (1 test.fail beklenerek geçti).

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/BAK-06.md`: 29 satır (≤40 satır kuralına uygun), yöntem şablonuna eksiksiz uyumlu.
- Fiziksel kanıtlar ve mevcut test değerlendirmeleri (`apps/api/test/website-restore-selection.test.js`, `apps/api/test/website-restore-service.test.js`, `apps/api/test/website-restore-http.test.js`) yerinde.

### C. Orkestra ve Bütünlük Kontrolleri
- `python3 orkestra/tasks.py lint`: `lint OK`
- `npm run lint`: `Repository policy validation passed.`
- `npm test`: Tüm birim ve entegrasyon testleri başarıyla tamamlandı (67/67 protocol, 234/234 config-templates, tüm api/web paketleri geçti).

---

## 3. Karar Özeti
T136 görevinin tüm kabul kriterleri eksiksiz karşılanmıştır. BAK-06 Seçici geri yükleme, indir/yükle ve parola koruması Playwright e2e testi ve dokümantasyonu onaylandı (`accept`).
