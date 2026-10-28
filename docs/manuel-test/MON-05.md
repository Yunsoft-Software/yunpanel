# MON-05 — Servis watchdog/yeniden başlatma ve disk izleme
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-28 12:40 · Senaryo: `e2e/ozellik/mon-05.spec.js` · Koşu: 3/4 geçti, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Servis sağlık denetimi, watchdog durumu sorgulama ve disk izleme | geçti | /servers servis tablosu yenilendi, Dashboard disk %/GB görüntülendi, API watchdog raporu alındı |
| hatalı girdi: Geçersiz parametreler ve eksik onay tokeni ile 400 validation | geçti | Boş gövde, eksik confirmation ve geçersiz targetType 400 ile reddedildi |
| fiziksel kanıt: Canlı sunucu SSH ile df -h / ve systemctl is-active karşılaştırması | geçti | SSH `df -B1 /` (%19) ve `systemctl is-active nginx` panel envanteriyle eşleşti |
| Plesk eşdeğerliği: Watchdog eklentisi ve disk alarm eşikleri arayüzü eksikliği | bilinen hata (test.fail) | BULGU MON-05: Plesk Watchdog eklentisi eşdeğeri UI yapılandırma sayfası eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Watchdog eklentisi eşdeğeri disk kota alarm eşiği ve otomatik servis kurtarma UI yapılandırması eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/system-watchdog.test.js` | GEÇERLİ | Watchdog servis kontrolü, auto-recovery ve HTTP rotaları birim testleri (18/18 geçti) |
| `apps/api/test/watchdog-live-executor.test.js` | GEÇERLİ | Canlı watchdog executor ve recovery transaction birim testleri (2/2 geçti) |
| `e2e/13-system-services.spec.js` | GEÇERLİ | Sistem servisleri listeleme ve durum kontrolleri |

## Panelde olmayan
- Plesk'teki Tools & Settings / Extensions altında yer alan "Watchdog" eklentisi (Disk alarm eşikleri, servis yeniden başlatma kuralı ve e-posta bildirim frekansı yapılandırma arayüzü)

## Temizlenemeyen kaynaklar
—
