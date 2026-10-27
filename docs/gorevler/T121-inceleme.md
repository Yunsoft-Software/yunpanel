# T121 İnceleme Notu — Manuel test: WEB-03

- **İncelenen Görev:** T121 (Manuel test: WEB-03 — Domain alias; web/mail/DNS ve yönlendirme tercihleri)
- **Görevi Yapan:** AGENT_2
- **İnceleyen:** AGENT_3
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/WEB-03.md` raporu 27 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: ÇALIŞIYOR`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - KRİTİK hata bulunmamaktadır.

2. **Playwright Senaryosu (`e2e/ozellik/web-03.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; gerçek backend, Nginx ve `.28` paneline karşı çalışmaktadır.
   - Mutlu yol senaryosu: Yeni web sitesi oluşturma, ek alan adı (alias) taslağa ekleme, inceleme ve kaydetme, onay modalı ile yayına uygulama (`domain.stage` / `domain.activate`), barındırma ayarlarından `canonicalRedirect` tercihini etkinleştirip uygulama ve DNS/Mail panelleri izolasyonunu teyit etme.
   - Fiziksel HTTP kontrolü:
     - `canonicalRedirect: false` iken Nginx vhost cevabının 301 dönmediği (statik vhost cevabı) teyit edilmiş.
     - `canonicalRedirect: true` sonrasında `http://157.180.11.28/sayfa-1` adresine `Host: <aliasDomain>` başlığıyla yapılan istekte `301 Moved Permanently` durum kodu ve `Location: http://<primaryDomain>/sayfa-1` başlığı fiziksel olarak doğrulanmış.
   - Hatalı girdi senaryosu: Protokol içeren girdide "Yalnız alan adını girin" UI uyarısı ve ana alan adı mükerrerliğinde "Ana alan adı veya aynı ek alan adı ikinci kez eklenemez" doğrulanmış.
   - `afterAll` hook'u arayüz üzerinden oluşturulan test sitesini başarıyla temizlemektedir.

3. **Orkestra ve Proje Doğrulamaları:**
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.
   - `python3 orkestra/tasks.py lint` → `131 tasks, lint OK`.

4. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T121 AGENT_3 "WEB-03 Playwright senaryosu, fiziksel HTTP/Nginx doğrulaması ve rapor onaylandı"` komutuyla kabul edilmiş ve `tasks/done/T121.md` durumuna taşınmıştır.
