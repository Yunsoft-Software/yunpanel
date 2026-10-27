# T152 İnceleme Notu — Manuel test: DOS-09

- **İncelenen Görev:** T152 (Manuel test: DOS-09 — Dosya adı/içerik araması, gizli dosyalar, izinler)
- **Görevi Yapan:** AGENT_4
- **İnceleyen:** AGENT_1
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/DOS-09.md` raporu 28 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: KISMİ`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - Parity açığı (`Plesk dosya içerik araması (full-text content search) panelde bulunmuyor; arama yalnızca dosya adıyla sınırlı`) NORMAL hata sınıfında ve `test.fail` ile doğru biçimde işaretlenmiş.

2. **Playwright Senaryosu (`e2e/ozellik/dos-09.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı bulunmamaktadır; doğrudan `.28` test sunucusunda çalışan gerçek arayüz ve API üzerinde çalışmaktadır.
   - Mutlu yol senaryosu: Dosya adı filtrelemesi, gizli dosya (`.env`) toggle filtresi, modal üzerinden izin değiştirme (0640 -> 0644) ve SSH üzerinden `stat -c '%a'` ile canlı sunucuda `644` fiziksel izin doğrulaması teyit edilmiştir.
   - Hatalı girdi / sınır senaryosu: UI üzerinde world-writable izninin kilitli ve güvenlik açıklamalı olması; API düzeyinde güvensiz izin (`0777`), geçersiz izin formatı (`999`) ve path traversal (`../../etc/passwd`) denemelerinin HTTP 400 ile reddedildiği ve dosyanın sunucuda güvenli modda (`640`) kaldığı doğrulanmıştır.
   - Parity gap: Plesk içerik araması (full-text search / grep) YunPanel dosya yöneticisinde henüz yer almadığı için `test.fail` olarak tanımlanmış ve başarıyla raporlanmıştır.
   - Temizlik: `afterAll` hook'unda hem API DELETE (`resolvedWebsiteId` ile `testFolder`), hem de SSH `find ... -name 'tdos09-a*-*' -exec rm -rf {} +` temizliği eksiksiz yapılmakta, sunucuda artık kaynak kalmamaktadır.

3. **Bağımsız Çalıştırma ve Doğrulama Kanıtı:**
   - `python3 orkestra/locks.py acquire sunucu-28-1 AGENT_1` ile kilit alındı.
   - `AGENT_N=1 npx playwright test e2e/ozellik/dos-09.spec.js --reporter=line` -> `3 passed (27.8s)` bizzat çalıştırılarak doğrulandı.
   - `python3 orkestra/locks.py release sunucu-28-1 AGENT_1` ile kilit bırakıldı.
   - SSH temizlik teyidi yapıldı: `find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name 'tdos09-a1-*'` boş çıktı.
   - Kalite kapıları:
     - `python3 orkestra/tasks.py lint` -> `136 tasks, lint OK`.
     - `python3 orkestra/orchestrator.py verify --quick` -> `doğrulama: ok; yeniden açılan: -; bulgu: -`.

4. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T152 AGENT_1 "DOS-09 dosya arama, gizli dosyalar ve izinler testleri gercek ortamda dogrulandi, kabul edildi"` komutuyla kabul edilmiş ve `tasks/done/T152.md` durumuna taşınmıştır.
