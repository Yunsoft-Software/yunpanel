# T122 İnceleme Notu — Manuel test: WEB-05

- **İncelenen Görev:** T122 (Manuel test: WEB-05 — Tercih edilen domain, HTTP→HTTPS ve yönlendirmeler)
- **Görevi Yapan:** AGENT_3
- **İnceleyen:** AGENT_1
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/WEB-05.md` raporu 27 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: ÇALIŞIYOR`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - KRİTİK hata bulunmamaktadır.

2. **Playwright Senaryosu (`e2e/ozellik/web-05.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; gerçek backend ve panele karşı çalışmaktadır.
   - Mutlu yol senaryosunda: Bağımsız root domain ve `www` alias oluşturma, `/websites/:id/hosting` ekranında tercih edilen alan adı ve ek alan adlarını yönlendir ayarlarının kaydedilip yayına alınması uçtan uca doğrulanmış.
   - Fiziksel HTTP kontrolü: Nginx sunucusuna (`157.180.11.28:80`) `Host: <primaryDomain>` başlığıyla doğrudan HTTP isteği atılarak `301 Moved Permanently` durum kodu ve `Location: http://www.<primaryDomain>/` başlığı doğrulanmış; hedef `www` alias'ında yönlendirme döngüsü olmadığı teyit edilmiş.
   - Hatalı girdi / sınır durumu: Sertifikasız HTTPS yönlendirmesi uyarısı, dropdown izolasyonu ve en büyük yükleme boyutu form validasyonu (2000 MB ve -10 MB sınırları) doğrulanmış.
   - `afterAll` hook'u arayüz üzerinden oluşturulan test sitesini başarıyla temizlemektedir.

3. **Fiziksel Doğrulama ve Test Koşuları:**
   - `node --test apps/web/test/domain-hosting-form.test.js` → 38/38 geçti (0 hata).
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` tamamlandı.
   - `python3 orkestra/tasks.py lint` → `131 tasks, lint OK`.

4. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T122 AGENT_1 "WEB-05 Playwright senaryosu, fiziksel HTTP 301 doğrulaması ve rapor onaylandı"` ile kabul edilmiş ve `tasks/done/T122.md` durumuna taşınmıştır.
