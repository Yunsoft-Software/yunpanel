# TLS-01 — Ücretsiz ACME issue, renew ve otomatik yenileme
Sonuç: GEÇTİ
Ajan: AGENT_1 · Tarih: 2026-11-04 · Panel sürümü: 0.3.0
Test dosyası: `e2e/ozellik/tls-01.spec.js`

## Özet
Let's Encrypt (ACME) staging doğrulaması (`staging: true`), dry-run yenileme, Nginx `:443` canlı TLS el sıkışması, certbot.timer systemd zamanlayıcısı ve HTTPS yanıtı gerçek `.28` test sunucusunda doğrulandı. Girdi doğrulama ve onay modalı sınırları, CSRF ve Customer kiracı izolasyonu (T800 düzeltmesi sonrası cross-tenant erişim engeli) başarıyla test edildi. Reissue / Multi-SAN UI eksikliği Plesk eşdeğerlik açığı olarak `test.fail` ile işaretlendi.

## Otomasyon ve Koşu Sonuçları
- Test dosyası: `e2e/ozellik/tls-01.spec.js` (4 senaryo, Playwright)
- 1. Koşu: 4 passed (2.3m) — `.28` üzerinde ardışık başarılı
- 2. Koşu: 4 passed (53.3s) — `.28` üzerinde ardışık başarılı
- Mock / fake data: Kesinlikle kullanılmadı; gerçek veritabanı, gerçek backend API ve gerçek Nginx/Certbot çalıştırıldı.

## Fiziksel Kanıtlar (.28 üzerinde doğrulandı)
1. `openssl x509 -in /etc/letsencrypt/live/webrich.news/fullchain.pem`: Let's Encrypt sertifikası doğrulandı.
2. `openssl s_client -connect 127.0.0.1:443 -servername webrich.news`: Canlı TLS handshake başarılı.
3. `systemctl is-active certbot.timer`: Zamanlayıcı servisi `active`.
4. `curl -sI https://webrich.news/`: Canlı HTTPS üzerinden `HTTP/2 200` veya `301` yanıtı alındı.

## Senaryolar ve Durum
| # | Senaryo | Tür | Sonuç |
|---|---|---|---|
| 1 | Yeni web sitesi, SSL formu, staging doğrulaması, dry-run yenileme ve 4 fiziksel kanıt | Mutlu yol + Fiziksel | GEÇTİ |
| 2 | Boş/geçersiz e-posta UI kilidi, API 400 invalid_acme_email, HTTP-01 wildcard 409 ve onay modalı iptali | Hatalı girdi / Sınır | GEÇTİ |
| 3 | CSRF (403), Anonim (401) ve Customer kiracı izolasyonu (Owner sertifikası/alan adına yetkisiz işlem 403/404) | Güvenlik / RBAC | GEÇTİ |
| 4 | Aktif sertifikalı alan adında sertifika kapsamını genişletme (Reissue / Multi-SAN) UI eksikliği | Plesk Parity Gap | GEÇTİ (test.fail) |

## Temizlik Doğrulaması (0 Artık İlkesi)
- `ttls01-*` ön ekiyle açılan test alan adları ve web siteleri silindi: Kalan 0
- Test için açılan müşteri hesapları (`ttls01-*`): Kalan 0
- Nginx sanal sunucu yapılandırmaları ve `/home/` dosya kökleri: Kalan 0
