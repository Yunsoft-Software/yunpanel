# T123 İnceleme Notu — Manuel test: WEB-06

- **İncelenen Görev:** T123 (Manuel test: WEB-06 — Domain askıya alma, kapatma, etkinleştirme ve güvenli silme)
- **Görevi Yapan:** AGENT_4
- **İnceleyen:** AGENT_3
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/WEB-06.md` raporu 25 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: KISMİ`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - SFTP temizlik engeli nedeniyle normal hata olarak raporlanmış, bilinen hata `test.fail` olarak işlenmiş.

2. **Playwright Senaryosu (`e2e/ozellik/web-06.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; doğrudan `.28` canlı panele karşı çalışmaktadır.
   - Mutlu yol senaryosu:
     - Yeni web sitesi oluşturma (`/websites/new`), barındırma ayarlarını uygulama (`/websites/:id/hosting`).
     - Yayını doğrulama: Nginx sunucusuna HTTP isteği atılarak sitenin canlı olduğu doğrulanmış.
     - Sitenin ayarlar sekmesinden (`/websites/:id/settings`) onay diyaloğuna alan adını girerek askıya alınması.
     - UI üzerinde durumun "Askıda" rozetine dönüştüğü ve sitede "Yayını Etkinleştir" butonunun belirdiği doğrulanmış.
     - Fiziksel Nginx kontrolü: Askıya alma sonucu Nginx vhost pasifleşmesi ve yayının durduğu doğrulanmış.
     - "Yayını Etkinleştir" butonu ile sitenin tekrar aktif edilmesi ve Nginx vhost üzerinden HTTP yanıtının normale döndüğünün fiziksel doğrulaması.
   - Güvenli silme senaryosu:
     - Güvenli silme modalı ve alan adı onay adımları test edilmiş.
     - Sunucudaki `website_cleanup_sftp_unverified` engeli nedeniyle işlemin blocked kaldığı doğru şekilde tespit edilip `test.fail` ile işaretlenmiş.
   - Hatalı girdi / sınır durumu senaryosu:
     - Yanlış alan adı girildiğinde askıya alma ve silme butonlarının devre dışı (disabled) kalması.
     - Askıdaki sitenin barındırma ayarlarının kilitlenmesi ve formun pasifleşmesi.
     - Test sonunda `removeWebsiteById` temizlik rutini çalıştırılmıştır.

3. **Orkestra ve Proje Doğrulamaları:**
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.
   - `python3 orkestra/tasks.py lint` → `131 tasks, lint OK`.

4. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T123 AGENT_3 "WEB-06 Playwright senaryosu, fiziksel HTTP/Nginx doğrulaması ve rapor onaylandı"` komutuyla kabul edilmiş ve `tasks/done/T123.md` durumuna taşınmıştır.
