# T160 İnceleme Notu — Manuel test: DEV-03

- **İncelenen Görev:** T160 (Manuel test: DEV-03 — Deploy anahtarı/webhook/ek komut ve işlem sonucu)
- **Görevi Yapan:** AGENT_1
- **İnceleyen:** AGENT_2
- **Tarih:** 2026-10-27
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/DEV-03.md` raporu 31 satır uzunluğunda (kural: ≤ 40 satır).
   - YONTEM şablonuna (`Sonuç: KISMİ`, `Ajan / Tarih / Senaryo / Koşu`, `## Senaryolar`, `## Hatalar`, `## Mevcut testler`, `## Panelde olmayan`, `## Temizlenemeyen kaynaklar`) eksiksiz uyulmuş.
   - Parity eksiklikleri (SSH Deploy Anahtarı, Dağıtım Sonrası Ek Komutlar, Webhook Secret / UUID parametresi) `test.fail` ile işaretlenmiş ve raporda tabloya işlenmiştir.

2. **Playwright Senaryosu (`e2e/ozellik/dev-03.spec.js`):**
   - Mock veri, `page.route` veya sahte API cevabı kullanılmamış; gerçek backend, Nginx ve `.28` test sunucusuna karşı çalışmaktadır.
   - Mutlu yol: Yeni Git/Node.js web sitesi oluşturma, Git & Deploy sekmesinde webhook ve kopyalama butonunun doğrulanması, manuel deploy başlatma, release geçmişi bölümü, fiziksel HTTP isteği, SSH ile Nginx sites-enabled konfigürasyonu ve release dizini kontrolü eksiksiz yapılmıştır.
   - Hatalı girdi / güvenlik: GitHub Webhook uç noktasına imzasız/geçersiz istek gönderildiğinde backend'in `github_webhook_headers_invalid` hata koduyla HTTP 400 Bad Request döndüğü ve yetkisiz dağıtımların engellendiği fiziksel olarak doğrulanmıştır.
   - `afterAll` hook'u arayüz üzerinden oluşturulan test sitesini `removeWebsiteById` ile güvenli şekilde silmektedir (0 artık ilkesi).

3. **Bağımsız Doğrulama Koşusu:**
   - Eşzamanlı test kilidi `sunucu-28-2` alındı.
   - `AGENT_N=2 npx playwright test e2e/ozellik/dev-03.spec.js` komutu bağımsız olarak koşturuldu: `5 passed (46.5s)` (3 beklenen Plesk parity farkı `test.fail` olarak geçti).
   - Test kilidi serbest bırakıldı.

4. **Kalite Kapıları:**
   - `python3 orkestra/tasks.py lint` → `lint OK`.
   - `python3 orkestra/orchestrator.py verify --quick` → `doğrulama: ok; yeniden açılan: -; bulgu: -` başarıyla tamamlandı.

5. **Sonuç:**
   - Görev kabul kriterlerini eksiksiz karşılamaktadır. `python3 orkestra/tasks.py accept T160 AGENT_2 "DEV-03 deploy anahtari ve webhook testleri gercek ortamda dogrulandi, kabul edildi"` komutuyla kabul edilmiş ve `tasks/done/T160.md` durumuna taşınmıştır.
