# T192 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T192 · Manuel test: BAK-05 — Yerel ve uzak FTP/cloud/object storage hedefleri
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/bak-05.spec.js` (Playwright E2E testi)
- `docs/manuel-test/BAK-05.md` (Manuel test raporu, 29 satır, <= 40 kuralına uygun)
- `tasks/review/T192.md` -> `tasks/done/T192.md` (Görev teslim / kabul raporu)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Senaryoları (`yunpanel-test` Gerçek Panel & Fiziksel Doğrulama)
- Sıfır mock/stub: doğrudan gerçek backend API, gerçek panel UI ve SSH ile canlı sunucu doğrulaması.
- `AGENT_N=2 npx playwright test e2e/ozellik/bak-05.spec.js --reporter=line` çalıştırıldı:
  - **Mutlu Yol (`mutlu yol: sistem yedekleme motoru doğrulama, yerel ve uzak depolama hedefleri oluşturma, site arayüzünde repo/uzak depo tespiti ve fiziksel disk/ayar kanıtı`):**
    - `/servers` sayfasında "Yedekleme ve depolama" bölümünde `restic`, `rclone` ve `/var/lib/yunpanel/backups` motorlarının yer aldığı doğrulandı.
    - `POST /api/panel/backups/remotes` ile S3 object storage remote oluşturuldu; AES-256 şifreleme ve API yanıtında kimlik bilgisi gizleme teyit edildi.
    - `POST /api/panel/backups/repositories` ile hem Rclone uzak hedefli repo hem de yerel disk tabanlı Restic reposu oluşturuldu ve başlatıldı.
    - `/websites/:id/backup` sayfasında uzak depo durumu, yerel depo sağlık denetimi butonu, uzak depo kartı ve "Plan ve Zamanlama" modalında depo seçimi doğrulandı.
    - Fiziksel kanıtlar: `rclone-remotes.json` (AES-256 ciphertext/iv/tag), `restic-repositories.json` ve `/var/lib/yunpanel/backups/restic/repos/:id/config` fiziksel dosyası SSH ile doğrulandı.
  - **Hatalı Girdi (`hatalı girdi: geçersiz remote türü (FTP reddi), geçersiz karakterli isim, eksik hedef ve yetkisiz erişim kontrolleri`):**
    - Desteklenmeyen FTP türü reddi (400 `rclone_remote_type_unsupported`), geçersiz isim (400 `rclone_remote_name_invalid`), eksik target (400 `restic_target_invalid`), kısa parola (400 `restic_password_invalid`) ve kimlik doğrulamasız istek reddi (401/403) doğrulandı.
  - **Plesk Eşdeğerliği (`Plesk eşdeğerliği: UI üzerinde uzak depolama yapılandırma sihirbazı (Remote Storage Settings / FTP / S3 form)`):**
    - Plesk'teki Backup Manager "Remote Storage Settings" form sihirbazının YunPanel UI'da olmaması ve eski FTP yerine SFTP/S3/B2/WebDAV sunulması tespit edilerek `test.fail` ile belgelendi.
  - **Çalıştırma Sonucu:** `3 passed (39.4s)`.
  - **Sıfır Artık İlkesi:** `afterAll` hook'u sonrasında yapılan SSH denetiminde `rclone-remotes.json` boş ("remotes": []), test amaçlı restic repo ve dizinlerinin tamamen temizlendiği (0 artık) teyit edildi.

### B. Rapor Formatı ve İçerik Kontrolü
- `docs/manuel-test/BAK-05.md`: 29 satır (≤40 satır kuralına tam uygun), `docs/manuel-test/YONTEM.md` şablonuna eksiksiz uyumlu.
- Fiziksel kanıtlar ve mevcut test değerlendirmeleri yerinde.

### C. Kod Kalitesi ve Orkestra Kontrolleri
- `npm run lint`: `Repository policy validation passed.`
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`
- `python3 orkestra/tasks.py lint`: `lint OK`

---

## 3. Karar Özeti
T192 görevinin tüm gereksinimleri ve kabul kriterleri eksiksiz karşılanmıştır. BAK-05 Yerel ve uzak FTP/cloud/object storage hedefleri Playwright testi ve dokümantasyonu onaylandı (`accept`).
