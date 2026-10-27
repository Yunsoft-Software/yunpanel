# T151 İnceleme Notu — Manuel test: DOS-08

- **İncelenen Görev:** T151 (Manuel test: DOS-08 — Kod/metin/HTML düzenleme, kaydetme ve değişiklik uyarısı)
- **Görevi Yapan:** AGENT_4
- **İnceleyen:** AGENT_1
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/DOS-08.md` raporu 27 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: ÇALIŞIYOR`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - Herhangi bir KRİTİK hata tespit edilmemiştir.

2. **Playwright Senaryosu (`e2e/ozellik/dos-08.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; gerçek panele, backend API'ye ve `.28` test sunucusuna karşı çalışmaktadır.
   - Mutlu yol senaryosu: Global Files sayfasından site dosya yöneticisine erişim, yeni HTML dosyası oluşturma, editör modalında açma, dosya meta ve satır numaralarını kontrol etme, HTML kod düzenleme, kaydedilmemiş değişiklikler rozet ve bildirim kontrolü, vazgeçme uyarısı (`ConfirmDialog`) iptal doğrulaması, kaydetme ve fiziksel sunucu doğrulaması (HTTP GET `/api/panel/websites/:id/files/text` ile dönen içerik ve sunucuda SSH `find ... -exec cat` kontrolü).
   - Hatalı girdi / çakışma senaryoları:
     - Değişiklikleri bırakma (`discard changes`): Düzenleme sonrası kapatıp değişiklikleri bırakma ve dosya tekrar açıldığında değişikliğin kaydedilmediğinin kanıtlanması.
     - Eşzamanlı değişiklik çakışması (optimistic concurrency / 409 Conflict): Editör açıkken arka planda SSH ile dosya değiştirildikten sonra editörden kaydetmeye çalışıldığında HTTP 409 `site_file_changed` hatasının UI'da yakalanması.
     - İkili (binary) dosya koruması: Geçersiz UTF-8 binary byte'lar içeren dosya editörde açılmaya çalışıldığında HTTP 409 `site_file_not_text` / UTF-8 metin hatasının UI'da doğrulanması.
   - `afterAll` hook'u hem API (`DELETE /api/panel/websites/:id/files`) hem de SSH (`find ... -name 'tdos08-a4-*' -exec rm -rf`) ile oluşturulan test dosyalarını temizlemektedir.

3. **Orkestra ve Proje Doğrulamaları:**
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.
   - `python3 orkestra/tasks.py lint` → `132 tasks, lint OK`.

4. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T151 AGENT_1 "DOS-08 Playwright senaryosu, dosya editörü doğrulaması ve rapor onaylandı"` komutuyla kabul edilmiş ve `tasks/done/T151.md` durumuna taşınmıştır.
