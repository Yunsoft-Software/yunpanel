# EML-09 — SPF/DKIM/DMARC ve relay/kimlik doğrulama güvenliği
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 13:56 · Senaryo: `e2e/ozellik/eml-09.spec.js` · Koşu: 4/4, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: DKIM anahtar oluşturma/önizleme, DNS ve Postfix relay politikası | Geçti | PowerDNS SPF/DMARC dig + Postfix smtpd_relay_restrictions + DKIM private key 0600 |
| Plesk Parity: DNS Teslimat Gereksinimleri ve İstemci Bağlantı Bilgileri paneli | Bilinen hata (test.fail) | delivery-diagnostics uç noktası 400 invalid_log_query dönüyor, panel render olmuyor |
| Hatalı girdi: Geçersiz DKIM selector, boş gövde veya olmayan domain ID reddi | Geçti | HTTP 400 (invalid_mail_dkim_selector) + HTTP 404 |
| Plesk Parity: Giden e-posta relay (Smarthost) yapılandırma ve API uç noktası | Bilinen hata (test.fail) | /api/servers/:id/mail/smarthost uç noktası canlı sunucuda henüz deploy edilmemiş (404) |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | delivery-diagnostics journal sorgusunda since eksikliği nedeniyle 400 dönmesi ve paneli gizlemesi | — |
| NORMAL | Plesk eşdeğeri giden posta Smarthost relay API uç noktasının canlıda 404 dönmesi | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/mail-console.test.js` | GEÇERLİ | DKIM ve teslimat tanılamaları arayüz bileşen testleri |
| `packages/config-templates/test/mail-security.test.js` | GEÇERLİ | Postfix smtpd_relay_restrictions fail-closed politikası |
| `apps/api/test/mail-delivery-diagnostics.test.js` | GEÇERLİ | SPF, DKIM, DMARC ve MX gereksinim doğrulamaları |

## Panelde olmayan
- Canlı sunucuda çalışan Smarthost giden relay yönetim motoru
- UI üzerinde SPF/DMARC kayıtlarını doğrudan düzenleme sihirbazı (DNS zone üzerinden yapılıyor)

## Temizlenemeyen kaynaklar
—
