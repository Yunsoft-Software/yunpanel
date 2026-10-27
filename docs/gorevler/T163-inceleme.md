# T163 İnceleme Notu — Manuel test: DEV-06

- **İncelenen Görev:** T163 (Manuel test: DEV-06 — Laravel scheduled task, log ve deployment senaryosu)
- **Görevi Yapan:** AGENT_1
- **İnceleyen:** AGENT_2
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/DEV-06.md` raporu 31 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: KISMİ`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) tam olarak uyulmuş.
   - Parity eksiklikleri (Plesk Laravel Toolkit eşdeğeri hazır Schedule yöneticisi / artisan schedule:run entegrasyonu, Laravel uygulama logları görüntüleyici/filtreleme ve hazır deployment senaryosu otomasyonu) `test.fail` ile işaretlenmiş ve raporda tabloya işlenmiştir.

2. **Playwright Senaryosu (`e2e/ozellik/dev-06.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı bulunmamaktadır; gerçek backend, Nginx, PHP-FPM ve `.28` test sunucusuna karşı çalışmaktadır.
   - Mutlu yol: Web sitesi oluşturma, site canlı HTTP yanıtı, Zamanlanmış Görevler sekmesinde Laravel `schedule:run` cron görevinin oluşturulması (`* * * * *`, `php .../artisan schedule:run >> /dev/null 2>&1`), sunucuda `/etc/cron.d/yunpanel-*` dosyasının fiziksel varlığı ve içeriğinin SSH ile teyidi, ardından görevin panelden silinmesi ve sunucudan dosyanın kaldırıldığının (0 artık ilkesi) doğrulanması eksiksiz test edilmiştir.
   - Hatalı girdi / güvenlik: Geçersiz veya eksik gövde parametreleriyle cron oluşturma isteklerinin HTTP 400 (`cron_create_input_invalid`) ve var olmayan site kimliğinin 404/503 ile reddedildiği doğrulanmıştır.
   - `afterAll` hook'u arayüz üzerinden test sitesini silmekte ve SSH ile cron/Nginx artıklarını temizlemektedir.

3. **Bağımsız Doğrulama Koşusu:**
   - Eşzamanlı test kilidi `sunucu-28-2` alındı.
   - `AGENT_N=2 npx playwright test e2e/ozellik/dev-06.spec.js` komutu bağımsız olarak koşturuldu: `5 passed (1.5m)` (3 beklenen Plesk parity farkı `test.fail` olarak geçti).
   - Test kilidi serbest bırakıldı (`released sunucu-28-2`).

4. **Kalite Kapıları:**
   - `python3 orkestra/tasks.py lint` → `lint OK`.
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.

5. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T163 AGENT_2 "DEV-06 Laravel scheduled task ve deploy testleri gercek ortamda dogrulandi, kabul edildi"` komutuyla kabul edilmiş ve `tasks/done/T163.md` durumuna taşınmıştır.
