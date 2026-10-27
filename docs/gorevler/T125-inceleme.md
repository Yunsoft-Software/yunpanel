# T125 İnceleme Notu — Manuel test: DOS-01

- **İncelenen Görev:** T125 (Manuel test: DOS-01 — Global Files ve domain File Manager girişleri)
- **Görevi Yapan:** AGENT_1
- **İnceleyen:** AGENT_3
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/DOS-01.md` raporu 27 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: ÇALIŞIYOR`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - KRİTİK hata bulunmamaktadır.

2. **Playwright Senaryosu (`e2e/ozellik/dos-01.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; doğrudan `.28` canlı panele karşı çalışmaktadır.
   - Mutlu yol senaryosu:
     - Global Files (`/files`) rotasına erişim, başlık ve web siteleri tablosunun doğrulanması.
     - Siteden File Manager'a geçiş (`/websites/:id/files`), domain overview ve site navigasyon sekmelerinden File Manager erişimi.
     - Breadcrumb, klasör ağacı ve dosya listeleme bileşenlerinin doğrulanması.
     - Yeni dosya oluşturma, inline modal editör ile düzenleme ve kaydetme.
     - Fiziksel HTTP indirme (`/api/panel/websites/:websiteId/files/download`) ile 200 GET cevabı ve dosya içeriğinin birebir eşleştiğinin doğrulanması.
     - Dosyanın arayüz modalı üzerinden onaylı kalıcı silinmesi.
   - Hatalı girdi senaryosu:
     - Global Files'ta geçersiz site ID sorgusunda EmptyState ("İstenen siteye erişilemiyor").
     - Path traversal (`../../../../etc/passwd`) girişiminde HTTP 400 Bad Request (`site_file_path_invalid`).
     - Jail dışı absolute path (`/etc/shadow`) koruması ve null byte injection (`test%00.txt`) koruması.
     - Arayüzde geçersiz dosya adı formatlarında (`../`, `..`, boş ad) butonun pasif kalarak engellemesi.
   - `afterAll` hook'u hem API üzerinden hem de arayüz üzerinden test dosyasını temizlemektedir.

3. **Orkestra ve Proje Doğrulamaları:**
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.
   - `python3 orkestra/tasks.py lint` → `131 tasks, lint OK`.

4. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T125 AGENT_3 "DOS-01 Playwright senaryosu, fiziksel dosya indirme doğrulaması ve rapor onaylandı"` komutuyla kabul edilmiş ve `tasks/done/T125.md` durumuna taşınmıştır.
