# T156 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T156 · Manuel test: RUN-07 — Composer bağımlılık yönetimi
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/run-07.spec.js` (Playwright E2E testi)
- `docs/manuel-test/RUN-07.md` (Manuel test raporu, 28 satır)
- `tasks/done/T156.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Mock / Sahte Veri Kontrolü
- `e2e/ozellik/run-07.spec.js` incelendi: Sıfır mock ilkesine tam uyumlu. `page.route`, sahte HTTP yanıtı veya stub veri bulunmuyor.
- Tüm testler gerçek backend API'lerine (`page.request.post`, `page.request.get`), gerçek DOM elemanlarına ve canlı `.28` test sunucusuna karşı çalışmaktadır.

### B. Senaryo Kapsamı ve Fiziksel Kanıtlar
1. **Hatalı Girdi / Güvenlik Senaryosu:**
   - `/api/websites/:websiteId/composer/run` uç noktasına eksik payload (`{}`), enjeksiyon amaçlı zararlı komut (`rm -rf /; cat /etc/shadow`), geçersiz argüman türü (array yerine string) ve var olmayan site UUID'si gönderilerek HTTP 400 ve 404 ile güvenli şekilde reddedildiği doğrulandı.
2. **Mutlu Yol (Site Kurulumu, UI Durum Tespiti & Canlı Algılama):**
   - Panel üzerinden (`/websites/new`) yeni PHP sitesi oluşturuldu, provisioning adımları ve ayrılmış Unix kullanıcısı (`yunapp-*`, uid!=0) SSH ile doğrulandı.
   - Nginx + PHP-FPM web sunucusu HTTP yanıtı (301 HTTPS yönlendirmesi) doğrulandı.
   - PHP Ayarları altında yer alan "Composer ve bağımlılıklar" panelinde başlangıçta `composer.json: Yok` durumu tespit edildi.
   - Site kök dizinine fiziksel SSH ile `composer.json` yerleştirildi, dosya izinleri ve sahipliği Unix kullanıcısına verildi.
   - Panel arayüzünde "Durumu kontrol et" eylemi tetiklenerek `composer.json: Var` ve Proje konumu: `Uygulama kökü` durumlarının dinamik olarak algılandığı teyit edildi.
3. **Plesk Eşdeğerlik Eksikliği Senaryosu:**
   - Plesk PHP Composer uzantısında yer alan arayüzden paket yönetimi ("Composer Install", "Composer Update", "Paket Ekle/Require", paket arama/kurma ve yerleşik editor) YunPanel'de bulunmadığından `test.fail` ile işaretlendi ve belgelendi.

### C. İncelemeci Tarafından Bizzat Çalıştırılan Test Kanıtı
- Eşzamanlı test kilidi alındı (`sunucu-28-1` AGENT_1).
- Test çalıştırıldı: `AGENT_N=1 npx playwright test e2e/ozellik/run-07.spec.js`
- Test çıktısı:
  ```
  Running 3 tests using 1 worker
  ✓  1 …r komut parametreleri, eksik argüman ve yetkisiz işlem reddedilir (2.9s)
  ✓  2 … durumunun tespiti ve composer.json varlığının canlı algılanması (10.1s)
  ✘  3 …r bağımlılık kurulumu (composer install/update) ve paket yönetimi (7.3s)
  3 passed (26.6s)
  ```
- Kilit serbest bırakıldı (`sunucu-28-1`).
- Sunucuda artık kontrolü: `find /var/www/yunpanel/apps /var/lib/yunpanel/apps /etc/nginx/sites-enabled -name '*trun07*'` -> 0 artık (tamamen temiz).

### D. Rapor ve Kalite Kapıları
- `docs/manuel-test/RUN-07.md`: 28 satır (≤40 satır kuralına uygun).
- `python3 orkestra/tasks.py lint`: lint OK.
- `python3 orkestra/orchestrator.py verify --quick`: doğrulama: ok; yeniden açılan: -; bulgu: -.

---

## 3. Karar Özeti
T156 görevi tüm kabul kriterlerini, sıfır mock ilkesini, güvenlik kontrollerini ve fiziksel doğrulama gereksinimlerini eksiksiz karşılamaktadır. Görev ONAYLANMIŞTIR (`accept`).
