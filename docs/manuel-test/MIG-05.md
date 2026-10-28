# MIG-05 — Site/mail import; kısıtlar ve veri kaybı uyarısı
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-28 13:35 · Senaryo: `e2e/ozellik/mig-05.spec.js` · Koşu: 6/6, test.fail 4

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Tekil site ve e-posta import önizlemesi, kısıt/uyarı ayrıştırması | geçti | HTTP 200, summary doğrulaması, SSH ile readOnly ve servis sağlığı teyidi |
| hatalı girdi ve kısıtlar: .44 yasaklı sunucu engeli, boş yük ve kısıt uyarıları | geçti | HTTP 403 (.44 forbidden), HTTP 400 (no websites/invalid json), HTTP 401/403 |
| eksiklik 1: Tekil Site Import (FTP/SSH ile tekil site çekme) rotası yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/site/remote-import` 404 dönüyor |
| eksiklik 2: Tekil Mailbox Import (Uzak IMAP ile posta kutusu çekme) rotası yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/mail/imap-sync` 404 dönüyor |
| eksiklik 3: Mevcut site üzerine yazma kısıtları ve veri kaybı uyarısı yokluğu | bilinen hata (test.fail) | POST `/api/panel/importer/plesk/check-conflicts` 404 dönüyor |
| eksiklik 4: Ön yüzde Site/Mail Import ve Veri Kaybı Onay modalı yokluğu | bilinen hata (test.fail) | Ön yüz siteler/posta arayüzünde import butonları ve onay modalı yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Site Import eşdeğeri tekil site çekme ve aktarma rotası bulunmuyor | — |
| NORMAL | Plesk Mail Import eşdeğeri uzak IMAP posta kutusu senkronizasyon rotası bulunmuyor | — |
| NORMAL | Hedefte mevcut site/posta çakışmalarını tespit eden ve veri kaybı uyarısı üreten rota yok | — |
| NORMAL | Ön yüzde Tekil Site/Mail Import ve Veri Kaybı Riski Onay modalı bulunmuyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/plesk-importer.test.js` | GEÇERLİ | Çevrimdışı dışa aktarım ayrıştırıcı, kısıt/uyarılar ve .44 güvenlik engeli |
| `apps/api/test/plesk-importer-http.test.js` | GEÇERLİ | `/api/importer/plesk/preview` rotası ve RBAC denetimleri |

## Panelde olmayan
- Plesk Site Import aracı ve uzak FTP/SSH üzerinden tekil site içeriğini çeken API rotası.
- Plesk Mail Import aracı ve harici IMAP sunucusundan posta kutusu kopyalayan senkronizasyon rotası.
- Hedef sunucuda mevcut site veya posta kutusu çakışmalarında veri kaybı uyarısı ve onay kısıtı.
- Ön yüzde Tekil Site/Mail Import ve Veri Kaybı Riski Onayı arayüz kontrolleri.

## Temizlenemeyen kaynaklar
—
