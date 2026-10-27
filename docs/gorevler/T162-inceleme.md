# T162 İnceleme Notu — Manuel test: DEV-05

- **İncelenen Görev:** T162 (Manuel test: DEV-05 — Laravel environment, Artisan, Composer ve Node komutları)
- **Görevi Yapan:** AGENT_4
- **İnceleyen:** AGENT_2
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/DEV-05.md` raporu 31 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: KISMİ`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - Parity eksiklikleri (Plesk Laravel Toolkit eşdeğeri .env editörü, arayüzden Artisan komut koşturucu, serbest Composer bağımlılık yönetimi ve Node/npm komutları) `test.fail` ile işaretlenmiş ve raporda tabloya işlenmiştir.

2. **Playwright Senaryosu (`e2e/ozellik/dev-05.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; gerçek backend, Nginx, PHP-FPM soketi ve `.28` test sunucusuna karşı çalışmaktadır.
   - Mutlu yol: `new_php` barındırma türüyle web sitesi oluşturma, PHP Ayarları altında `Composer ve bağımlılıklar` akordiyonunun açılması, Composer durum ve dosya yapısı göstergeleri (`composer.json`, `composer.lock`, `Proje konumu`, `Proje doğrulaması`), Dosya Yöneticisi ve Site terminali bağlantıları, `/api/panel/websites/:id/composer/status` API yanıtı, canlı HTTP yanıtı, Nginx vhost konfigürasyonunda `fastcgi_pass unix:` PHP-FPM soketi ve fiziksel site dizini kontrolü başarıyla test edilmiştir.
   - Hatalı girdi / güvenlik: Geçersiz veya desteklenmeyen PHP tool aksiyonunun (`artisan.migrate`) ve geçersiz gövde ile kuyruk isteklerinin backend tarafından HTTP 400 (`php_tool_action_unsupported`) ile engellendiği doğrulanmıştır.
   - `afterAll` hook'u arayüz üzerinden test sitesini silmekte ve SSH ile Nginx konfigürasyonunu temizleyip reload etmektedir (0 artık ilkesi teyit edildi).

3. **Bağımsız Doğrulama Koşusu:**
   - Eşzamanlı test kilidi `sunucu-28-2` alındı.
   - `AGENT_N=2 npx playwright test e2e/ozellik/dev-05.spec.js` komutu bağımsız olarak koşturuldu: `5 passed (51.1s)` (3 beklenen Plesk parity farkı `test.fail` olarak geçti).
   - Test kilidi serbest bırakıldı.
   - SSH üzerinden `/etc/nginx/sites-enabled/*tdev05*` kontrol edildi, hiçbir artık kalmadığı doğrulandı.

4. **Kalite Kapıları:**
   - `python3 orkestra/tasks.py lint` → `lint OK`.
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.

5. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T162 AGENT_2 "DEV-05 Laravel env artisan ve composer testleri gercek ortamda dogrulandi, kabul edildi"` komutuyla kabul edilmiş ve `tasks/done/T162.md` durumuna taşınmıştır.
