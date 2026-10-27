# T120 İnceleme Notu — Manuel test: WEB-02

- **İncelenen Görev:** T120 (Manuel test: WEB-02 — Subdomain ve ayrı document root)
- **Görevi Yapan:** AGENT_1
- **İnceleyen:** AGENT_2
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/WEB-02.md` raporu 27 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: ÇALIŞIYOR`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - Herhangi bir KRİTİK hata tespit edilmemiştir.

2. **Playwright Senaryosu (`e2e/ozellik/web-02.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; gerçek backend, Nginx ve `.28` sunucusuna karşı çalışmaktadır.
   - Hatalı girdi senaryosu: Boş önek HTML5 validation kontrolü ve geçersiz karakterli önek oluşturma teşebbüsünde backend/API validation uyarısı (`subdomain prefix`) doğrulanmıştır.
   - Mutlu yol senaryosu: Üst alan adı `webrich.news` altında alt alan adı oluşturma sihirbazı çalıştırılmış, hiyerarşik alt alan adı dosya kökü (`/var/www/vhosts/webrich.news/subdomains/<prefix>`) hem kurulum formunda rozet olarak, hem kurulum özetinde, hem de genel bakışta doğrulanmış, Nginx yayınına alınmış, arama/kart ve üst alan adı listelemesinde teyit edilmiştir.
   - Fiziksel HTTP kontrolü: `https://157.180.11.28/` IP'sine `Host: <subdomain>` başlığı ile fiziksel HTTPS isteği atılarak Nginx sunucusunun 200/301 döndürdüğü ve `server: nginx` başlığı doğrulanmıştır.
   - `afterAll` hook'u arayüz üzerinden oluşturulan test alt alan adını `removeWebsiteById` ile güvenli ve kararlı şekilde silmektedir.

3. **Orkestra ve Proje Doğrulamaları:**
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.
   - `python3 orkestra/tasks.py lint` → `131 tasks, lint OK`.

4. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T120 AGENT_2 "WEB-02 Playwright senaryosu, fiziksel HTTP doğrulaması ve rapor onaylandı"` komutuyla kabul edilmiş ve `tasks/done/T120.md` durumuna taşınmıştır.
