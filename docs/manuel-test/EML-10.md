# EML-10 — Giden posta limitleri, kuyruk ve teslimat tanılama
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-28 12:02 · Senaryo: `e2e/ozellik/eml-10.spec.js` · Koşu: 4/4, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Posta kuyruğu izleme, teslimat takibi, loglar ve Postfix çıktısı | Geçti | `postqueue -p` çıktısı + API queue/tracking/logs HTTP 200 |
| Hatalı girdi: Sınır aşımı (limit > 200, geçersiz ISO, 100+ karakter ara) | Geçti | HTTP 400 (`invalid_delivery_tracking_query`), 404, form required |
| Teslimat takibinde çok sayfalı logda --since ve --cursor çakışması | Bilinen hata (test.fail) | HTTP 503 (`journal_log_read_failed` - journalctl cursor/since çakışması) |
| Plesk Parity: Giden posta limitleri ve kuyruk boşaltma/silme | Bilinen hata (test.fail) | Outbound rate limit ayarı, flush/delete queue butonları ve API yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | `journalLogReader` çok sayfalı Postfix logunda `--since` ve `--cursor` birlikte göndererek journalctl 503 hatasına yol açıyor | — |
| NORMAL | Plesk eşdeğeri Outbound Mail Control (saatlik/günlük kota) ve kuyruk boşaltma/silme (Flush/Delete) henüz yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `packages/host-runtime/test/mail-queue-inspector.test.js` | GEÇERLİ | Postfix postqueue JSON çıktısını ayrıştırma ve sayfalama birim testi |
| `apps/api/test/mail-delivery-diagnostics.test.js` | GEÇERLİ | Teslimat takibi, kuyruk filtreleme ve log sorgulama servis testleri |
| `apps/web/test/mail-delivery-tracking-panel.test.js` | GEÇERLİ | Teslimat takip tablosu, durum rozetleri ve filtre durum testleri |

## Panelde olmayan
- Plesk Outbound Mail Control: Alan adı veya posta kutusu bazında saatlik/günlük giden posta gönderim limitleri
- Posta kuyruğunu zorla gönderme/boşaltma (Flush Queue / `postqueue -f`) ve kuyruktan posta silme (Delete / `postsuper -d`)

## Temizlenemeyen kaynaklar
—
