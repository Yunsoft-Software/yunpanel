# T157 İnceleme Notu — Manuel test: RUN-08

- **İncelenen Görev:** T157 (Manuel test: RUN-08 — Dil/runtime eklentilerinin kurulum ve erişim politikası)
- **Görevi Yapan:** AGENT_4
- **İnceleyen:** AGENT_3
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/RUN-08.md` raporu 29 satır uzunluğunda (kural: ≤ 40 satır teyit edildi).
   - YONTEM şablonuna (`Sonuç: KISMİ`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - Parite eksikliği NORMAL sınıfında listelenmiş, KRİTİK hata bulunmamaktadır.

2. **Playwright Senaryosu (`e2e/ozellik/run-08.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; sıfır mock kuralına tam uyulmuştur.
   - Hatalı girdi senaryosu: `/api/websites/:id/php-tools/config/preview` uç noktasına geçersiz ve yetkisiz alanlar (`extensions: [...]`), desteklenmeyen eski PHP sürümü (`5.6`) ve var olmayan website kimliği gönderildiğinde HTTP 400 ve 404 ile fail-closed reddedildiği doğrulanmıştır.
   - Mutlu yol senaryosu: Gerçek arayüzden yeni PHP web sitesi oluşturma, erişim hesapları ve ayrılmış Unix kullanıcısı doğrulaması, PHP Ayarları sekmesinde PHP 8.3 sürümü doğrulaması, SSH üzerinden fiziksel PHP eklentileri (`php -m`: curl, mbstring, gd, pdo_mysql, Zend OPcache, intl) tespiti ve dedicated Unix kullanıcısı bağlamında `php8.3 -r` JSON çıktısı ile eklentilerin aktifliği gerçek canlı `.28` sunucusunda doğrulanmıştır.
   - Plesk Parite farkı: Plesk PHP Settings ve Extensions panelinde yer alan checkbox ile modül açma/kapatma arayüzü ve domain/müşteri bazlı modül erişim politikası eksikliği `test.fail` ile doğru işaretlenmiştir.
   - Temizlik ve 0 artık ilkesi: `test.afterAll` hook'unda `removeWebsiteById` ile oluşturulan web sitesi arayüzden onaylı şekilde silinmiş, sunucuda açılan geçici PHP dosyaları SSH ile tamamen temizlenmiştir.

3. **Bağımsız Doğrulama Koşusu:**
   - `sunucu-28-3` kilidi alınarak bizzat koşturuldu: `AGENT_N=3 npx playwright test e2e/ozellik/run-08.spec.js`
   - Çıktı: `3 passed (29.1s)` (1 test.fail parite farkı) ile %100 başarılı.
   - Kilit güvenle serbest bırakıldı (`released sunucu-28-3`).

4. **Kalite Kapıları:**
   - `python3 orkestra/tasks.py lint` → `lint OK`.
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -`.

5. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T157 AGENT_3 "RUN-08 runtime eklentileri testleri gercek ortamda dogrulandi, kabul edildi"` komutuyla onaylanmış ve `tasks/done/T157.md` durumuna taşınmıştır.
