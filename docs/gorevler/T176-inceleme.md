# T176 İnceleme Notu — Manuel test: TLS-02

- **İncelenen Görev:** T176 (Manuel test: TLS-02 — Wildcard/DNS-01, SAN ve www/mail/webmail kapsamı)
- **Görevi Yapan:** AGENT_3
- **İnceleyen:** AGENT_1
- **Tarih:** 2026-10-28
- **Karar:** KABUL (Onaylandı)

## İnceleme Özeti
1. **Rapor Formatı ve İçerik Kontrolü:**
   - `docs/manuel-test/TLS-02.md` dosyası 30 satır uzunluğunda (kural: ≤ 40 satır, tam uyumlu).
   - `Sonuç: KISMİ` açıkça belirtilmiş.
   - Mutlu yol, hatalı girdi & sınır kontrolleri ve Plesk eşdeğerlik eksiklikleri tablolaştırılmış.
   - Sıfır mock ilkesine tam uyulmuş; sahte yanıt / mock veri veya `page.route` kullanılmamış.

2. **Fiziksel Doğrulama ve Test Koşusu:**
   - Eşzamanlı test kilidi (`sunucu-28-1`) alınarak Playwright testi bağımsız olarak bizzat koşturuldu:
     - `AGENT_N=1 npx playwright test e2e/ozellik/tls-02.spec.js`
     - Sonuç: `3 passed (43.0s)` (1 adet `test.fail` beklenen parity bulgusu olarak işaretli).
   - Canlı ortam doğrulamaları:
     - `webrich.news` OpenSSL x509 SAN incelemesi: `DNS:webrich.news, DNS:www.webrich.news`
     - Nginx port 443 canlı TLS el sıkışmasında SAN listesi teyit edildi.
     - Dovecot IMAPS port 993 TLS el sıkışmasında `CN = mail.webrich.news` teyit edildi.
     - Postfix/Dovecot SNI ve mail servisi kimliği (`mail.webrich.news`, `ready: true`) doğrulandı.
   - Sınır & Yetki kontrolleri:
     - Yabancı alan adı SAN ekleme isteği: `409 certificate_domain_mismatch`
     - HTTP-01 ile wildcard talebi: `409 wildcard_not_supported`
     - 21 adetten fazla SAN listesi: `400 invalid_certificate_domains`
     - Geçersiz DNS Zone ID: `404 dns_zone_not_found`
   - Temizlik (0 Artık):
     - `test.afterAll` hook'u ile test sırasında oluşturulan geçici domain (`ttls02-a1-...`) arayüzden ve Nginx/sistemden tamamen temizlendi. Doğrulandı: 0 artık.

3. **Kalite Kapıları:**
   - `python3 orkestra/tasks.py lint` → `lint OK`
   - `python3 orkestra/locks.py release sunucu-28-1 AGENT_1` → Kilit sorunsuz serbest bırakıldı.

4. **Sonuç:**
   - Görev tüm gereksinimleri ve kalite kriterlerini eksiksiz karşılamaktadır. `tasks.py accept T176 AGENT_1` ile kabul edildi ve `tasks/done/T176.md` dizinine taşındı.
