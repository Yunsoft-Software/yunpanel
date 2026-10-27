# T161 İnceleme Notu — Manuel test: DEV-04

- **İncelenen Görev:** T161 (Manuel test: DEV-04 — Laravel oluşturma, repository'den kurma ve mevcut app tarama)
- **Görevi Yapan:** AGENT_3
- **İnceleyen:** AGENT_2
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/DEV-04.md` raporu 28 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: KISMİ`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - Parity eksiklikleri (Install Laravel sihirbazı, Git'ten Laravel kurma, Mevcut Laravel uygulamasını tarama/bağlama) `test.fail` ile işaretlenmiş ve raporda tabloya işlenmiştir.

2. **Playwright Senaryosu (`e2e/ozellik/dev-04.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; gerçek backend, Nginx, PHP-FPM ve `.28` test sunucusuna karşı çalışmaktadır.
   - Mutlu yol: `new_php` barındırma türüyle Laravel/PHP web sitesi oluşturma, `public/` docroot yapılandırması, Nginx vhost konfigürasyonunda `fastcgi_pass unix:` PHP-FPM soketi, canlı HTTP 200/403 yanıtı, SSH üzerinden fiziksel site dizini kontrolü ve PHP Ayarları altında Composer panelinin açılması başarıyla test edilmiştir.
   - Hatalı girdi / API: Henüz backend'de implemente edilmemiş `/api/websites/:id/framework/laravel` uç noktasına HTTP 404 yanıtı, geçersiz PHP tool eylemi için 400 yanıtı ve arayüzde boş alan adı ile form gönderiminin HTML5 doğrulamasıyla engellenmesi test edilmiştir.
   - `afterAll` hook'u arayüz üzerinden test sitesini silmekte ve SSH ile Nginx konfigürasyonunu temizleyip reload etmektedir (0 artık ilkesi teyit edildi).

3. **Bağımsız Doğrulama Koşusu:**
   - Eşzamanlı test kilidi `sunucu-28-2` alındı.
   - `AGENT_N=2 npx playwright test e2e/ozellik/dev-04.spec.js` komutu bağımsız olarak koşturuldu: `5 passed (37.9s)` (3 beklenen Plesk parity farkı `test.fail` olarak geçti).
   - Test kilidi serbest bırakıldı.
   - SSH üzerinden `/etc/nginx/sites-enabled/*tdev04*` kontrol edildi, hiçbir artık kalmadığı doğrulandı.

4. **Kalite Kapıları:**
   - `python3 orkestra/tasks.py lint` → `lint OK`.
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.

5. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T161 AGENT_2 "DEV-04 Laravel olusturma ve app tarama testleri gercek ortamda dogrulandi, kabul edildi"` komutuyla kabul edilmiş ve `tasks/done/T161.md` durumuna taşınmıştır (Projede 80. görev tamamlanmıştır).
