# EML-08 — SMTP/IMAP/POP3 ve TLS port politikası; kurulum bileşenine göre
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-28 12:00 · Senaryo: `e2e/ozellik/eml-08.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Port durumu tablosu, istemci ayarları ve TLS el sıkışmaları | Geçti | ss -tulpn + OpenSSL TLS 1.3 (25, 465, 587, 143, 993) + Plaintext auth red |
| Sınır durumları: POP3 (110/995) durumu, aktif protokol listesi ve API kontrolü | Geçti | doveconf (imap lmtp) + Port 110/995 refused + GET /api/panel/servers/... 200/404 |
| Plesk Parity: Mail Server Settings port değiştirme ve TLS cipher politikası | Bilinen hata (test.fail) | Port değiştirme formu veya TLS cipher politikası seçici UI'da yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Mail Server Settings eşdeğeri port değiştirme ve TLS cipher politikası seçici arayüzü henüz yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `packages/host-runtime/test/mail-protocol-health-inspector.test.js` | GEÇERLİ | 5 portun ss ile dinleme durumunu ve blocker kontrolünü ölçüyor |
| `apps/api/test/mail-delivery-diagnostics.test.js` | GEÇERLİ | Protocol health, port özeti ve TLS gereksinimleri birim testleri |
| `apps/web/src/workspace/MailOperationsPanel.jsx` | GEÇERLİ | Servis bağlantı ve port durumu tablosu bileşeni |

## Panelde olmayan
- Plesk Tools & Settings / Mail altındaki gibi SMTP/IMAP dinleme portlarını panelden değiştirme
- POP3 (110/995) protokolünü açma/kapatma (kurulum bileşeni gereği dovecot-pop3d kurulu değil)
- Minimum TLS sürümü (TLS 1.2 / TLS 1.3) ve SSL/TLS cipher suite politikası seçici arayüzü

## Temizlenemeyen kaynaklar
—
